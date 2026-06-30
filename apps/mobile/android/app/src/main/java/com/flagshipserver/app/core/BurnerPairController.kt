package com.flagshipserver.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Drives a phone↔burner pairing session and delivers a freshly-minted
 * recipe. Kotlin mirror of the iOS BurnerPairViewModel: parse the scanned
 * QR / typed code → connect → learn the burner pubkey → derive the SAS →
 * (user confirms) → mint + seal + deliver over the live session. Minting
 * is injected (`mint`) so this stays unit-testable; the screen wires it to
 * the create-server minter (byte-identical recipe to share/copy).
 *
 * RESUME: the session is PERSISTED (EncryptedSharedPreferences via [store]) so
 * it survives the phone briefly locking → the app being suspended (or even the
 * process being killed). On the next foreground/launch we reconnect to the SAME
 * relay `sid` reusing the SAME ephemeral keypair; the Mac burner holds the
 * session and auto-resumes on an identical `phone-hello` pubkey (no second SAS).
 * `peer-gone` is ADVISORY (the burner stepped/holds) — NOT a wipe; only an
 * explicit disconnect, an incoming `session-ended`, or `expired` wipes + leaves.
 *
 * The 600ms anti-double-tap gate on the confirm button is a UI concern
 * (the screen disables the button) — this controller proceeds on confirm
 * whenever it's in Matching.
 */
class BurnerPairController(
    private val client: BurnerPairClient,
    private val scope: CoroutineScope,
    /**
     * Phase 4 consent — sign an owner-IRK debug-access grant behind biometric.
     * Returns the signature hex, or null if the user cancelled/denied the
     * biometric. Injected so the controller stays unit-testable; the screen
     * wires it to `Keystore.deriveIRK` + `DebugAccess.sign`. Default no-op
     * (returns null ⇒ a consent-request can only be denied). Placed BEFORE
     * `mint` so the existing trailing-lambda call sites still bind to `mint`.
     */
    private val signConsentGrant: suspend (DebugAccess.Grant) -> String? = { null },
    /** Durable session store for resume across lock/suspend/process-death. Null
     *  (default) ⇒ no persistence (the demo/mock path never persists). */
    private val store: BurnerPairingStore? = null,
    /** Produces the on-wire recipe JSON + its server domain + serial. A resumed
     *  session re-delivers the STORED recipe wire and never mints, so the
     *  default throws (it must not be reached on the resume path). */
    private val mint: suspend () -> MintedRecipe = { error("no recipe minter (resumed session)") },
) {
    data class MintedRecipe(val json: String, val serverDomain: String, val serial: String)

    /** A pending burner consent the screen surfaces as a security-warning
     *  dialog. Mirrors the iOS BurnerPairViewModel.PendingConsent. */
    data class PendingConsent(val setting: String, val serverDomain: String, val warning: String)

    /** Why the screen is being left — surfaced so the host can show a brief
     *  note. Mirror of iOS BurnerPairViewModel.LeaveReason. */
    enum class LeaveReason { UserDisconnected, SessionEnded, Expired }

    sealed interface Phase {
        data object Scan : Phase
        data object EnterCode : Phase
        data object Connecting : Phase
        data class Matching(val matchCode: String) : Phase
        data object Delivering : Phase
        data class Delivered(val serverDomain: String) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Scan)
    val phase: StateFlow<Phase> = _phase

    var lastDeliveredSerial: String? = null
        private set

    private val _pendingConsent = MutableStateFlow<PendingConsent?>(null)
    val pendingConsent: StateFlow<PendingConsent?> = _pendingConsent

    /** ADVISORY — true while the burner has momentarily stepped away
     *  (`peer-gone`); the session is held open, not wiped. */
    private val _burnerStepped = MutableStateFlow(false)
    val burnerStepped: StateFlow<Boolean> = _burnerStepped

    /** Session deadline (ms since epoch) from the relay `accepted` frame. */
    private val _expiresAtMs = MutableStateFlow<Long?>(null)
    val expiresAtMs: StateFlow<Long?> = _expiresAtMs

    /** "Auto-locks in mm:ss" next to the Disconnect button — re-evaluated every
     *  second by the countdown ticker. null before a deadline is known. */
    private val _countdownText = MutableStateFlow<String?>(null)
    val countdownText: StateFlow<String?> = _countdownText

    /** Non-null ⇒ the host should dismiss the screen (with the given reason). */
    private val _leaveRequest = MutableStateFlow<LeaveReason?>(null)
    val leaveRequest: StateFlow<LeaveReason?> = _leaveRequest

    /** True once a live session exists (connecting/matching/delivering/
     *  delivered) — the host shows the session footer (countdown + Disconnect). */
    val hasActiveSession: Boolean
        get() = when (_phase.value) {
            Phase.Scan, Phase.EnterCode, is Phase.Failed -> false
            else -> true
        }

    private var sessionId: String? = null
    private var session: QrSession? = null
    private var burnerPub: ByteArray? = null
    private var matchCode: String? = null
    private var confirmed = false
    private var recipeDelivered = false
    private var deliveredDomain: String? = null
    /** Unsealed recipe wire JSON — persisted so a resumed session can re-seal +
     *  re-deliver without re-minting. */
    private var recipeWire: String? = null

    private var consumeJob: Job? = null
    private var countdownJob: Job? = null
    /** True between a successful connect and a close/error. */
    private var connected = false
    /** We received at least one `accepted` (or resumed a real persisted session)
     *  — distinguishes "session was live, socket dropped" (reconnect) from
     *  "never connected" (fail). */
    private var everAccepted = false
    private var reconnecting = false

    fun switchToEnterCode() { _phase.value = Phase.EnterCode }
    fun switchToScan() { _phase.value = Phase.Scan }

    /** Begin a session from a scanned QR or a typed short code. */
    suspend fun begin(raw: String) {
        if (consumeJob != null) return
        _phase.value = Phase.Connecting
        val scanned = BurnerPairing.parse(raw)
        if (scanned == null) { _phase.value = Phase.Failed("That code isn't valid."); return }
        sessionId = BurnerPairing.sessionId(scanned.codeBytes)
        burnerPub = scanned.burnerPublicKey
        session = QrSession.fresh()
        openStream()
    }

    /** (Re)open the relay stream for the current [sessionId], reusing whatever
     *  keys we already hold. Shared by the first connect AND every reconnect. */
    private suspend fun openStream() {
        val sid = sessionId ?: return
        consumeJob?.cancel()
        connected = true
        val ch = client.connect(sid)
        consumeJob = scope.launch { for (ev in ch) onInbound(ev) }
        // If we already have the burner pubkey (scanned QR / resume), greet
        // immediately; otherwise we wait for burner-hello.
        sendHelloIfReady()
    }

    /** Handle one inbound relay event (also called directly by tests). */
    suspend fun onInbound(ev: BurnerInbound) {
        when (ev) {
            is BurnerInbound.Accepted -> {
                everAccepted = true
                reconnecting = false
                if (ev.expiresAtMs > 0) _expiresAtMs.value = ev.expiresAtMs
                startCountdown()
                persist()
            }
            is BurnerInbound.PeerPresent, is BurnerInbound.PeerJoined -> {
                _burnerStepped.value = false
                sendHelloIfReady()
            }
            is BurnerInbound.BurnerHello -> {
                if (burnerPub == null) burnerPub = Base64URL.decode(ev.burnerPkB64)
                sendHelloIfReady()
            }
            is BurnerInbound.ConsentRequest ->
                _pendingConsent.value = PendingConsent(ev.setting, ev.serverDomain, ev.warning)
            is BurnerInbound.SessionEnded -> {
                // The burner wiped its half — wipe ours + leave.
                wipeAndClose()
                _leaveRequest.value = LeaveReason.SessionEnded
            }
            is BurnerInbound.PeerGone ->
                // ADVISORY: the burner stepped away / holds. Keep the session.
                _burnerStepped.value = true
            is BurnerInbound.Expired -> {
                wipeAndClose()
                _leaveRequest.value = LeaveReason.Expired
            }
            is BurnerInbound.RelayError -> {
                connected = false
                if (isResumable()) scheduleReconnect() else fail(ev.message)
            }
            is BurnerInbound.Pong -> { /* liveness */ }
        }
    }

    /** Derive the SAS once we have both keys, greet the burner, and advance.
     *  The hello is (re)sent on every (re)connect because the burner keys off
     *  the identical phone-hello. */
    private suspend fun sendHelloIfReady() {
        val s = session ?: return
        val pub = burnerPub ?: return
        if (matchCode == null) matchCode = s.pair(pub)
        client.send(BurnerOutbound.PhoneHello(Base64URL.encode(s.phonePubKey)))
        advanceAfterHello()
    }

    /** Pick the phase after a (re)connect's hello, based on what's already done. */
    private fun advanceAfterHello() {
        if (confirmed) {
            if (recipeDelivered) {
                _phase.value = Phase.Delivered(deliveredDomain ?: "")
            } else {
                // Resumed a confirmed-but-undelivered session → re-deliver.
                scope.launch { redeliverIfPossible() }
            }
            return
        }
        val code = matchCode ?: return
        if (_phase.value is Phase.Matching) return
        _phase.value = Phase.Matching(code)
    }

    /** The user confirmed the SAS matches: unlock the burner, mint, deliver. */
    suspend fun confirmAndDeliver() {
        val s = session ?: return
        if (_phase.value !is Phase.Matching) return
        client.send(BurnerOutbound.ConfirmPairing)
        confirmed = true
        _phase.value = Phase.Delivering
        persist()
        try {
            val minted = mint()
            lastDeliveredSerial = minted.serial
            deliveredDomain = minted.serverDomain
            recipeWire = minted.json
            persist()
            val sealed = s.seal(minted.json.toByteArray())
            client.send(BurnerOutbound.Deliver(sealed.ciphertextB64u, sealed.nonceB64u))
            recipeDelivered = true
            _phase.value = Phase.Delivered(minted.serverDomain)
            persist()
        } catch (t: Throwable) {
            fail(t.message ?: "Delivery failed.")
        }
    }

    /** Re-seal + re-deliver the stored recipe after a resume (no re-mint). */
    private suspend fun redeliverIfPossible() {
        val s = session ?: return
        val wire = recipeWire ?: return
        try {
            val sealed = s.seal(wire.toByteArray())
            client.send(BurnerOutbound.Deliver(sealed.ciphertextB64u, sealed.nonceB64u))
            recipeDelivered = true
            _phase.value = Phase.Delivered(deliveredDomain ?: "")
            persist()
        } catch (_: Throwable) {
            // Leave it undelivered; a later reconnect / burner re-ask retries.
        }
    }

    // ── Resume ──────────────────────────────────────────────────────

    /** Reconnect a live session whose socket dropped (return-to-foreground /
     *  unlock). No-op if there's nothing to resume or we're already connected. */
    suspend fun reconnectIfNeeded() {
        if (!isResumable() || connected || reconnecting) return
        reconnecting = true
        try { openStream() } finally { reconnecting = false }
    }

    /** Rehydrate from the persisted record (cold launch). Returns true iff a
     *  fresh, unexpired session was found + a reconnect was started. */
    suspend fun resumeFromStore(): Boolean {
        val store = store ?: return false
        val rec = store.load() ?: return false
        if (rec.expiresAtMs <= System.currentTimeMillis()) { store.clear(); return false }
        val priv = Base64URL.decode(rec.phoneSkB64) ?: run { store.clear(); return false }
        sessionId = rec.sid
        session = QrSession.fromPrivate(priv)
        burnerPub = rec.burnerPkB64?.let { Base64URL.decode(it) }
        confirmed = rec.confirmed
        recipeDelivered = rec.recipeDelivered
        deliveredDomain = rec.serverDomain.ifEmpty { null }
        recipeWire = rec.recipeWire
        lastDeliveredSerial = rec.serial
        _expiresAtMs.value = rec.expiresAtMs
        everAccepted = true   // it WAS a real, accepted session
        _phase.value = if (confirmed) {
            if (recipeDelivered) Phase.Delivered(rec.serverDomain) else Phase.Delivering
        } else {
            Phase.Connecting
        }
        startCountdown()
        openStream()
        return true
    }

    private fun isResumable(): Boolean {
        if (!everAccepted) return false
        if (sessionId == null || session == null) return false
        val exp = _expiresAtMs.value ?: return false
        if (_phase.value is Phase.Failed) return false
        if (_leaveRequest.value != null) return false
        return exp > System.currentTimeMillis()
    }

    private fun scheduleReconnect() {
        if (reconnecting) return
        reconnecting = true
        scope.launch {
            delay(600)
            reconnecting = false
            reconnectIfNeeded()
        }
    }

    // ── Disconnect / countdown ──────────────────────────────────────

    /** "Disconnect from burner" — the user's explicit "I'm done / changed my
     *  mind". Tell the burner to wipe its half (best-effort), wipe ours, leave. */
    suspend fun disconnect() {
        client.send(BurnerOutbound.SessionEnded)
        wipeAndClose()
        _leaveRequest.value = LeaveReason.UserDisconnected
    }

    private fun startCountdown() {
        if (countdownJob != null) return
        recomputeCountdown()
        countdownJob = scope.launch {
            while (true) {
                val exp = _expiresAtMs.value
                if (exp != null && System.currentTimeMillis() >= exp) {
                    wipeAndClose()
                    _leaveRequest.value = LeaveReason.Expired
                    return@launch
                }
                recomputeCountdown()
                delay(1000)
            }
        }
    }

    private fun recomputeCountdown() {
        val exp = _expiresAtMs.value
        if (exp == null) { _countdownText.value = null; return }
        val remaining = maxOf(0L, exp - System.currentTimeMillis())
        val secs = (remaining / 1000).toInt()
        _countdownText.value = "Auto-locks in %02d:%02d".format(secs / 60, secs % 60)
    }

    // ── Consent (unchanged crypto) ──────────────────────────────────

    /**
     * Approve the pending consent: biometric → sign the owner-IRK debug-access
     * grant → send it back over the session for the burner to embed. A
     * cancelled/failed biometric (signConsentGrant returns null) falls through
     * to a deny so the burner isn't left hanging.
     */
    suspend fun approveConsent() {
        val pending = _pendingConsent.value ?: return
        val grant = DebugAccess.Grant(pending.serverDomain, "", System.currentTimeMillis())
        val sigHex = try { signConsentGrant(grant) } catch (_: Throwable) { null }
        if (sigHex == null) { denyConsent(); return }
        val envelope = DebugAccess.envelopeJson(grant, sigHex)
        client.send(BurnerOutbound.Raw(consentResultJson(pending.setting, envelope)))
        _pendingConsent.value = null
    }

    /** Deny the pending consent: tell the burner it was declined (no grant). */
    suspend fun denyConsent() {
        val pending = _pendingConsent.value ?: return
        client.send(BurnerOutbound.Raw(consentResultJson(pending.setting, null)))
        _pendingConsent.value = null
    }

    /** `{"kind":"consent-result","setting":...[,"grant":<envelope>]}` — the
     *  grant (when present) is the parsed DebugAccess envelope object, not a
     *  string. Mirrors the iOS consent-result frame. */
    private fun consentResultJson(setting: String, grantEnvelope: String?): String =
        buildJsonObject {
            put("kind", "consent-result")
            put("setting", setting)
            if (grantEnvelope != null) put("grant", Json.parseToJsonElement(grantEnvelope))
        }.toString()

    // ── Teardown ────────────────────────────────────────────────────

    /** Legacy cancel entry (back/cancel buttons): close + reset to scan WITHOUT
     *  telling the burner — used by the create flow's own Cancel. */
    fun cancel() {
        wipeAndClose()
        _pendingConsent.value = null
        _phase.value = Phase.Scan
    }

    /** Cancel timers/stream, close the socket, wipe the persisted + in-memory
     *  session material. Idempotent. */
    private fun wipeAndClose() {
        countdownJob?.cancel(); countdownJob = null
        consumeJob?.cancel(); consumeJob = null
        connected = false
        store?.clear()
        session = null
        recipeWire = null
        client.close()
    }

    private fun persist() {
        val store = store ?: return
        val sid = sessionId ?: return
        val s = session ?: return
        val exp = _expiresAtMs.value ?: return
        store.save(
            PersistedBurnerPairing(
                sid = sid,
                phoneSkB64 = Base64URL.encode(s.phonePrivateKey),
                burnerPkB64 = burnerPub?.let { Base64URL.encode(it) },
                confirmed = confirmed,
                recipeDelivered = recipeDelivered,
                serverDomain = deliveredDomain ?: "",
                recipeWire = recipeWire,
                serial = lastDeliveredSerial,
                expiresAtMs = exp,
            ),
        )
    }

    private fun fail(message: String) {
        wipeAndClose()
        _phase.value = Phase.Failed(message)
    }
}
