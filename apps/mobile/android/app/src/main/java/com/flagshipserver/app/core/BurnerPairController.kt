package com.flagshipserver.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
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
    /** Produces the on-wire recipe JSON + its server domain + serial. */
    private val mint: suspend () -> MintedRecipe,
) {
    data class MintedRecipe(val json: String, val serverDomain: String, val serial: String)

    /** A pending burner consent the screen surfaces as a security-warning
     *  dialog. Mirrors the iOS BurnerPairViewModel.PendingConsent. */
    data class PendingConsent(val setting: String, val serverDomain: String, val warning: String)

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

    private var session: QrSession? = null
    private var burnerPub: ByteArray? = null
    private var helloSent = false
    private var consumeJob: Job? = null

    fun switchToEnterCode() { _phase.value = Phase.EnterCode }
    fun switchToScan() { _phase.value = Phase.Scan }

    /** Begin a session from a scanned QR or a typed short code. */
    suspend fun begin(raw: String) {
        if (consumeJob != null) return
        _phase.value = Phase.Connecting
        val scanned = BurnerPairing.parse(raw)
        if (scanned == null) { _phase.value = Phase.Failed("That code isn't valid."); return }
        val sid = BurnerPairing.sessionId(scanned.codeBytes)
        burnerPub = scanned.burnerPublicKey
        session = QrSession.fresh()
        val ch = client.connect(sid)
        consumeJob = scope.launch { for (ev in ch) onInbound(ev) }
        if (scanned.burnerPublicKey != null) deriveAndHello()
    }

    /** Handle one inbound relay event (also called directly by tests). */
    suspend fun onInbound(ev: BurnerInbound) {
        when (ev) {
            is BurnerInbound.PeerPresent, is BurnerInbound.PeerJoined -> deriveAndHello()
            is BurnerInbound.BurnerHello -> {
                if (burnerPub == null) burnerPub = Base64URL.decode(ev.burnerPkB64)
                deriveAndHello()
            }
            is BurnerInbound.ConsentRequest ->
                _pendingConsent.value = PendingConsent(ev.setting, ev.serverDomain, ev.warning)
            is BurnerInbound.PeerGone -> fail("The computer's burner app disconnected.")
            is BurnerInbound.Expired -> fail("The pairing session timed out.")
            is BurnerInbound.RelayError -> fail(ev.message)
            is BurnerInbound.Pong -> { /* liveness */ }
        }
    }

    private suspend fun deriveAndHello() {
        if (helloSent) return
        val pub = burnerPub ?: return
        val s = session ?: return
        val code = s.pair(pub)
        helloSent = true
        client.send(BurnerOutbound.PhoneHello(Base64URL.encode(s.phonePubKey)))
        _phase.value = Phase.Matching(code)
    }

    /** The user confirmed the SAS matches: unlock the burner, mint, deliver. */
    suspend fun confirmAndDeliver() {
        val s = session ?: return
        if (_phase.value !is Phase.Matching) return
        client.send(BurnerOutbound.ConfirmPairing)
        _phase.value = Phase.Delivering
        try {
            val minted = mint()
            lastDeliveredSerial = minted.serial
            val sealed = s.seal(minted.json.toByteArray())
            client.send(BurnerOutbound.Deliver(sealed.ciphertextB64u, sealed.nonceB64u))
            _phase.value = Phase.Delivered(minted.serverDomain)
        } catch (t: Throwable) {
            fail(t.message ?: "Delivery failed.")
        }
    }

    /**
     * Approve the pending consent: biometric → sign the owner-IRK debug-access
     * grant → send it back over the session for the burner to embed. A
     * cancelled/failed biometric (signConsentGrant returns null) falls through
     * to a deny so the burner isn't left hanging. Mirrors the iOS
     * BurnerPairViewModel.approveConsent.
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

    fun cancel() {
        consumeJob?.cancel()
        consumeJob = null
        client.close()
        _pendingConsent.value = null
        _phase.value = Phase.Scan
    }

    private fun fail(message: String) {
        consumeJob?.cancel()
        consumeJob = null
        client.close()
        _phase.value = Phase.Failed(message)
    }
}
