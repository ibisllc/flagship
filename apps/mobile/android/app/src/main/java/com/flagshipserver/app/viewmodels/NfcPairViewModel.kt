// C3 Wave 2 (Android) — NFC retail-tier pairing view model.
//
// State machine (mirrors the iOS sibling):
//
//   Idle
//     ─ startTap(activity) ─►  ReadingTag
//                                ├─ ok ─► AskingForWifi(confirmation)
//                                └─ err ─► Failure(message, fallback?)
//
//   AskingForWifi
//     ─ sendSealedWifi() ─►  Sealing
//                              ─► Depositing
//                                   ├─ ok ─► Success(message)
//                                   └─ err ─► Failure(message)
//     ─ >30 s after the tap ─► Failure (session-lock expired; the box
//                              has rolled its keys — re-tap required)
//
//   Failure(fallback available) ─ startLedSasFallback() ─► LedSasFallback
//
// LedSasFallback is the Q2-locked degrade seam: NFC read failed or is
// unavailable, so pairing continues over LAN/cloud confirmed by the
// box's LED-SAS blink pattern. The capture/decode UI is N-PHONE-6; this
// phase is its mount point. Security failures (signature mismatch)
// NEVER route here — fail-closed is for security, absent hardware is
// just UX.
//
// The view model holds the freshly-minted X25519 ephemeral private key
// alongside the verified payload between ReadingTag and Sealing so the
// post-tap UI can capture credentials without the network channel ever
// seeing the box's eBoxPub-derived key. K_session is derived once on
// the Sealing edge — never cached anywhere durable.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.NfcRendezvousClient
import com.flagshipserver.app.core.NfcPairHex
import com.flagshipserver.app.core.NfcPairReader
import com.flagshipserver.app.core.NfcPairReaderError
import com.flagshipserver.app.core.NfcPairReaderException
import com.flagshipserver.app.core.PAIR_SESSION_LOCK_MS
import com.flagshipserver.app.core.PairPayload
import com.flagshipserver.app.core.WiFiConfig
import com.flagshipserver.app.core.buildWifiDepositBlob
import com.flagshipserver.app.core.deriveSAS
import com.flagshipserver.app.core.deriveSessionKey
import com.flagshipserver.app.core.deriveSharedSecret
import com.flagshipserver.app.core.encodeLedSas
import com.flagshipserver.app.core.encodeSasForDisplay
import com.flagshipserver.app.core.isWellFormedGlance
import com.flagshipserver.app.core.ledSasGlances
import com.flagshipserver.app.core.verifyLedSas
import com.flagshipserver.app.core.sealWiFiConfig
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Everything the post-tap confirmation screen shows. `sasDisplay` +
 * `sasLed` are the optional SAS glance (design refinement §10):
 * proximity already authenticated the key, but in a noisy room (three
 * boxes in pairing mode) the user can match the LED pattern. `suffix6`
 * is the two-box disambiguation hint (refinement §9).
 */
data class PairConfirmation(
    val boxLabel: String,
    val suffix6: String,
    /** First 6 hex chars of the SAS — on-screen glance. */
    val sasDisplay: String,
    /** 9-pulse RGBY sequence the box's LED blinks for the same SAS. */
    val sasLed: String,
    /** Wall-clock ms when the box's 30 s session lock expires. */
    val sessionExpiresAtMs: Long,
)

/**
 * N-PHONE-6 — drives the glance-by-glance LED-SAS verify shown alongside
 * the Wi-Fi form (the active "optional SAS glance"). The expected
 * sequence is derived locally; the user (or, in a later build, the camera
 * decoder) records what the box's LED actually blinked, one glance at a
 * time, and the strict 3-of-3 verdict comes from the protocol mirror's
 * `verifyLedSas`. A single mismatched glance fails the whole check — the
 * LED-SAS is the authenticator on the degraded path, so it can't be
 * best-of-3.
 */
data class LedSasCapture(
    /** Per-glance expected sub-sequences ("RGB", "YYB", "GRB"). */
    val expectedGlances: List<String>,
    /** What the user recorded so far (index-aligned with expectedGlances). */
    val observed: List<String> = emptyList(),
    val verdict: Verdict = Verdict.PENDING,
) {
    enum class Verdict { PENDING, CONFIRMED, MISMATCH }

    /** The glance index awaited, or null when every glance is recorded. */
    val currentGlance: Int?
        get() = if (observed.size < expectedGlances.size) observed.size else null
    val isComplete: Boolean
        get() = observed.size == expectedGlances.size
}

/** UI-driving state machine. */
sealed interface NfcPairPhase {
    data object Idle : NfcPairPhase
    data object ReadingTag : NfcPairPhase
    data class AskingForWifi(val confirmation: PairConfirmation) : NfcPairPhase
    data object Sealing : NfcPairPhase
    data object Depositing : NfcPairPhase
    data class Success(val message: String) : NfcPairPhase
    data class Failure(
        val message: String,
        /** Q2: offer the LED-SAS degrade path for hardware/read
         *  problems; never for security verdicts or a user cancel. */
        val ledSasFallbackAvailable: Boolean = false,
    ) : NfcPairPhase
    /** Q2 fallback seam — N-PHONE-6 mounts the LED capture flow here. */
    data object LedSasFallback : NfcPairPhase
}

/**
 * Default keypair generator — uses Tink X25519 in production. Tests
 * pass a deterministic generator so the sealed blob round-trips through
 * a known box-side private key.
 */
internal fun defaultEphemeralX25519KeyPair(): Pair<ByteArray, ByteArray> {
    val priv = X25519.generatePrivateKey()
    val pub = X25519.publicFromPrivate(priv)
    return priv to pub
}

class NfcPairViewModel(
    private val reader: NfcPairReader,
    private val rendezvous: NfcRendezvousClient,
    private val ephemeralKeyGen: () -> Pair<ByteArray, ByteArray> = ::defaultEphemeralX25519KeyPair,
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    private val _phase = MutableStateFlow<NfcPairPhase>(NfcPairPhase.Idle)
    val phase: StateFlow<NfcPairPhase> = _phase.asStateFlow()

    // N-PHONE-6 capture — observable so the confirmation composable can
    // render the glance-by-glance verify. Null until beginLedSasCapture().
    private val _ledCapture = MutableStateFlow<LedSasCapture?>(null)
    val ledCapture: StateFlow<LedSasCapture?> = _ledCapture.asStateFlow()

    // Captured between ReadingTag → AskingForWifi → Sealing. Cleared on
    // reset() / Success / Failure so the materials never linger past a
    // completed (or failed) attempt.
    private var verifiedPayload: PairPayload? = null
    private var ephemeralPriv: ByteArray? = null
    private var ephemeralPub: ByteArray? = null
    /** The SAS bytes for the active pairing — held so the LED-SAS capture
     *  can verify observed glances against the locally derived sequence. */
    private var sasBytes: ByteArray? = null

    /** Wall-clock ms of the verified tap — anchors the session-lock window. */
    private var tapAtMs: Long? = null

    // ── Form inputs (bound from the AskingForWifi composable). ────────
    var ssid: String = ""
    var psk: String = ""
    var regulatoryRegion: String = ""

    /**
     * Drive a single-shot NFC read. Activity is required so the live
     * reader can call enableReaderMode against the foreground host;
     * tests pass a no-op activity (MockNfcPairReader ignores it).
     */
    fun startTap(activity: ComponentActivity) {
        if (_phase.value is NfcPairPhase.ReadingTag) return
        _phase.value = NfcPairPhase.ReadingTag
        viewModelScope.launch {
            doRead(activity)
        }
    }

    // Internal hop the test exercises directly via a fake scope. Keeps
    // the public surface (startTap) wired to viewModelScope.
    internal suspend fun doRead(activity: ComponentActivity) {
        val outcome = reader.readPair(activity)
        outcome.fold(
            onSuccess = { result ->
                val confirmation = try {
                    val (priv, pub) = ephemeralKeyGen()
                    // Complete the ECDH right away so the SAS glance can
                    // show alongside the Wi-Fi form.
                    val ss = deriveSharedSecret(priv, result.payload.eBoxPub)
                    val sas = deriveSAS(
                        sharedSecret = ss,
                        stkPub = result.payload.stkPub,
                        eBoxPub = result.payload.eBoxPub,
                        ePhonePub = pub,
                        nonce = result.payload.nonce,
                        sessionId = result.payload.sessionId,
                        v = result.payload.v,
                    )
                    val tapped = now()
                    verifiedPayload = result.payload
                    ephemeralPriv = priv
                    ephemeralPub = pub
                    sasBytes = sas
                    _ledCapture.value = null
                    tapAtMs = tapped
                    PairConfirmation(
                        boxLabel = result.payload.hint.mdnsName,
                        suffix6 = result.payload.hint.suffix6,
                        sasDisplay = encodeSasForDisplay(sas),
                        sasLed = runCatching { encodeLedSas(sas) }.getOrDefault(""),
                        sessionExpiresAtMs = tapped + PAIR_SESSION_LOCK_MS,
                    )
                } catch (t: Throwable) {
                    wipeCaptured()
                    _phase.value = NfcPairPhase.Failure(
                        FSStrings.get(R.string.couldnt_generate_the_pairing_key_try),
                    )
                    return
                }
                _phase.value = NfcPairPhase.AskingForWifi(confirmation)
            },
            onFailure = { t ->
                wipeCaptured()
                _phase.value = NfcPairPhase.Failure(
                    message = humanize(t),
                    ledSasFallbackAvailable = ledSasFallbackAvailable(t),
                )
            },
        )
    }

    /**
     * Seal the captured WiFiConfig under K_session + deposit the
     * ePhonePub-prefixed blob at the box's cloud-rendezvous slot.
     * Idempotent: the Worker overwrites any prior deposit at the same
     * slot (so a typo-then-retry works without a separate clear step).
     */
    fun sendSealedWifi() {
        val payload = verifiedPayload ?: run {
            _phase.value = NfcPairPhase.Failure(FSStrings.get(R.string.no_paired_tag_tap_your_box))
            return
        }
        val priv = ephemeralPriv ?: run {
            _phase.value = NfcPairPhase.Failure(FSStrings.get(R.string.pairing_session_was_reset_tap_your))
            return
        }
        val pub = ephemeralPub ?: run {
            _phase.value = NfcPairPhase.Failure(FSStrings.get(R.string.pairing_session_was_reset_tap_your))
            return
        }
        if (ssid.isBlank()) {
            _phase.value = NfcPairPhase.Failure(FSStrings.get(R.string.wi_fi_name_is_required))
            return
        }
        // Session-lock window: the box latched this sessionId for 30 s
        // at the tap and has rolled a fresh keypair since. Depositing
        // against the dead session would silently never be consumed —
        // fail with a re-tap prompt instead.
        val tapped = tapAtMs
        if (tapped == null || now() - tapped > PAIR_SESSION_LOCK_MS) {
            wipeCaptured()
            _phase.value = NfcPairPhase.Failure(
                FSStrings.get(R.string.the_pairing_session_expired_tap_your),
            )
            return
        }
        _phase.value = NfcPairPhase.Sealing
        viewModelScope.launch {
            doSeal(payload, priv, pub)
        }
    }

    internal suspend fun doSeal(payload: PairPayload, priv: ByteArray, pub: ByteArray) {
        val sealed: com.flagshipserver.app.core.SealedWiFiConfig
        val depositBlob: ByteArray
        try {
            val ss = deriveSharedSecret(priv, payload.eBoxPub)
            val kSession = deriveSessionKey(
                sharedSecret = ss,
                stkPub = payload.stkPub,
                eBoxPub = payload.eBoxPub,
                ePhonePub = pub,
                nonce = payload.nonce,
                sessionId = payload.sessionId,
                v = payload.v,
            )
            val wifi = WiFiConfig(
                ssid = ssid,
                psk = psk,
                regulatoryRegion = regulatoryRegion,
                issuedAt = now(),
            )
            sealed = sealWiFiConfig(wifi, kSession)
            // The box can't derive K_session without our ephemeral pub —
            // prefix it (protocol deposit-blob format; tamper-evident
            // because ePhonePub is bound into the K_session transcript).
            depositBlob = buildWifiDepositBlob(pub, sealed)
        } catch (t: Throwable) {
            // Don't surface the raw exception (could leak field shape);
            // map to a generic copy + clear any captured state so retry
            // re-derives from a fresh tap.
            wipeCaptured()
            _phase.value = NfcPairPhase.Failure(FSStrings.get(R.string.couldnt_seal_wi_fi_credentials_tap))
            return
        }

        _phase.value = NfcPairPhase.Depositing
        val outcome = rendezvous.depositSealedWifi(
            rendezvousId = payload.hint.cloudRendezvousId,
            sealedHex = NfcPairHex.encode(depositBlob),
            nonceHex = NfcPairHex.encode(sealed.nonce),
        )
        outcome.fold(
            onSuccess = {
                wipeCaptured()
                _phase.value = NfcPairPhase.Success(
                    FSStrings.get(R.string.sent_wi_fi_to_the_box, payload.hint.mdnsName),
                )
            },
            onFailure = { t ->
                // Don't cache the sealed blob anywhere — retry must
                // re-derive + re-seal so a stale K_session can't ship
                // outdated credentials.
                wipeCaptured()
                _phase.value = NfcPairPhase.Failure(humanize(t))
            },
        )
    }

    /** Q2 fallback entry — only reachable from a Failure that offered
     *  it. N-PHONE-6 replaces the destination's stub body with the LED
     *  capture + decode flow; the transition contract stays as-is. */
    fun startLedSasFallback() {
        val cur = _phase.value
        if (cur is NfcPairPhase.Failure && cur.ledSasFallbackAvailable) {
            _phase.value = NfcPairPhase.LedSasFallback
        }
    }

    // ── N-PHONE-6: LED-SAS capture API (active "optional SAS glance"). ──

    /** Begin the glance-by-glance LED-SAS verify. Requires an active
     *  pairing (the SAS bytes are derived at the verified tap). No-ops if
     *  the SAS can't be expanded. */
    fun beginLedSasCapture() {
        val sas = sasBytes ?: return
        val glances = try {
            ledSasGlances(encodeLedSas(sas))
        } catch (_: Throwable) {
            return
        }
        _ledCapture.value = LedSasCapture(expectedGlances = glances)
    }

    /** Record one observed glance. When the final glance lands, run the
     *  strict 3-of-3 verify and publish the verdict. A malformed glance is
     *  ignored (a garbled read shouldn't advance) so the screen re-prompts
     *  the same glance. */
    fun recordLedGlance(glance: String) {
        val capture = _ledCapture.value ?: return
        if (capture.isComplete) return
        if (!isWellFormedGlance(glance)) return
        val observed = capture.observed + glance
        val next = if (observed.size == capture.expectedGlances.size) {
            val ok = verifyLedSas(sasBytes ?: ByteArray(0), observed)
            capture.copy(
                observed = observed,
                verdict = if (ok) LedSasCapture.Verdict.CONFIRMED else LedSasCapture.Verdict.MISMATCH,
            )
        } else {
            capture.copy(observed = observed)
        }
        _ledCapture.value = next
    }

    /** Discard the capture so the user can re-run from the first glance. */
    fun resetLedSasCapture() {
        _ledCapture.value = null
    }

    /** Reset back to Idle. Clears any captured pairing material so a
     *  fresh tap starts a fresh handshake. */
    fun reset() {
        wipeCaptured()
        ssid = ""
        psk = ""
        regulatoryRegion = ""
        _phase.value = NfcPairPhase.Idle
    }

    private fun wipeCaptured() {
        verifiedPayload = null
        ephemeralPriv?.fill(0)
        ephemeralPriv = null
        ephemeralPub = null
        sasBytes?.fill(0)
        sasBytes = null
        _ledCapture.value = null
        tapAtMs = null
    }

    /** Pure helper exposed for tests — maps a thrown error into the
     *  user-facing copy without going through the coroutine machinery. */
    internal fun humanize(t: Throwable): String {
        if (t is NfcPairReaderException) {
            return when (t.error) {
                NfcPairReaderError.NfcUnavailable ->
                    FSStrings.get(R.string.nfc_isnt_available_on_this_device)
                NfcPairReaderError.UserCanceled ->
                    FSStrings.get(R.string.pairing_cancelled_tap_again_when_ready)
                NfcPairReaderError.TagFormatUnrecognized ->
                    FSStrings.get(R.string.that_doesnt_look_like_a_flagship)
                is NfcPairReaderError.MalformedPayload ->
                    FSStrings.get(R.string.couldnt_read_the_tag_try_again, (t.error as NfcPairReaderError.MalformedPayload).reason)
                NfcPairReaderError.SignatureMismatch ->
                    FSStrings.get(R.string.the_tags_signature_didnt_check_out)
                NfcPairReaderError.Timeout ->
                    FSStrings.get(R.string.no_tap_detected_hold_your_phone)
            }
        }
        return t.message ?: FSStrings.get(R.string.something_went_wrong_try_again)
    }

    /** Q2: a failed/unavailable NFC *read* degrades to the LED-SAS
     *  path. Security verdicts do NOT — a tampered tag must dead-end
     *  (fail-closed is security-only); a user cancel is benign and just
     *  retries the tap. */
    internal fun ledSasFallbackAvailable(t: Throwable): Boolean {
        if (t !is NfcPairReaderException) return false
        return when (t.error) {
            NfcPairReaderError.NfcUnavailable,
            NfcPairReaderError.TagFormatUnrecognized,
            is NfcPairReaderError.MalformedPayload,
            NfcPairReaderError.Timeout,
            -> true
            NfcPairReaderError.UserCanceled,
            NfcPairReaderError.SignatureMismatch,
            -> false
        }
    }
}
