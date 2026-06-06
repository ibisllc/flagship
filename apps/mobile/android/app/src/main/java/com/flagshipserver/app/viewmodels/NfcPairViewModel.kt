// C3 Wave 2 (Android) — NFC retail-tier pairing view model.
//
// State machine (mirrors the iOS sibling):
//
//   Idle
//     ─ startTap(activity) ─►  ReadingTag
//                                ├─ ok ─► AskingForWifi(boxLabel)
//                                └─ err ─► Failure(message)
//
//   AskingForWifi
//     ─ sendSealedWifi() ─►  Sealing
//                              ─► Depositing
//                                   ├─ ok ─► Success(message)
//                                   └─ err ─► Failure(message)
//
// The view model holds the freshly-minted X25519 ephemeral private key
// alongside the verified payload between ReadingTag and Sealing so the
// post-tap UI can capture credentials without the network channel ever
// seeing the box's eBoxPub-derived key. K_session is derived once on
// the Sealing edge — never cached anywhere durable.

package com.flagshipserver.app.viewmodels

import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.NfcRendezvousClient
import com.flagshipserver.app.core.NfcPairReader
import com.flagshipserver.app.core.NfcPairReaderError
import com.flagshipserver.app.core.NfcPairReaderException
import com.flagshipserver.app.core.PairPayload
import com.flagshipserver.app.core.WiFiConfig
import com.flagshipserver.app.core.deriveSessionKey
import com.flagshipserver.app.core.deriveSharedSecret
import com.flagshipserver.app.core.sealWiFiConfig
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** UI-driving state machine. */
sealed interface NfcPairPhase {
    data object Idle : NfcPairPhase
    data object ReadingTag : NfcPairPhase
    data class AskingForWifi(val boxLabel: String) : NfcPairPhase
    data object Sealing : NfcPairPhase
    data object Depositing : NfcPairPhase
    data class Success(val message: String) : NfcPairPhase
    data class Failure(val message: String) : NfcPairPhase
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

    // Captured between ReadingTag → AskingForWifi → Sealing. Cleared on
    // reset() / Success / Failure so the materials never linger past a
    // completed (or failed) attempt.
    private var verifiedPayload: PairPayload? = null
    private var ephemeralPriv: ByteArray? = null
    private var ephemeralPub: ByteArray? = null

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
                val (priv, pub) = try {
                    ephemeralKeyGen()
                } catch (t: Throwable) {
                    _phase.value = NfcPairPhase.Failure(
                        "Couldn't generate the pairing key. Try again.",
                    )
                    return
                }
                verifiedPayload = result.payload
                ephemeralPriv = priv
                ephemeralPub = pub
                _phase.value = NfcPairPhase.AskingForWifi(result.payload.hint.mdnsName)
            },
            onFailure = { t ->
                _phase.value = NfcPairPhase.Failure(humanize(t))
            },
        )
    }

    /**
     * Seal the captured WiFiConfig under K_session + deposit it at the
     * box's cloud-rendezvous slot. Idempotent: the Worker overwrites
     * any prior deposit at the same slot (so a typo-then-retry works
     * without a separate clear step).
     */
    fun sendSealedWifi() {
        val payload = verifiedPayload ?: run {
            _phase.value = NfcPairPhase.Failure("No paired tag — tap your box first.")
            return
        }
        val priv = ephemeralPriv ?: run {
            _phase.value = NfcPairPhase.Failure("Pairing session was reset. Tap your box again.")
            return
        }
        val pub = ephemeralPub ?: run {
            _phase.value = NfcPairPhase.Failure("Pairing session was reset. Tap your box again.")
            return
        }
        if (ssid.isBlank()) {
            _phase.value = NfcPairPhase.Failure("Wi-Fi name is required.")
            return
        }
        _phase.value = NfcPairPhase.Sealing
        viewModelScope.launch {
            doSeal(payload, priv, pub)
        }
    }

    internal suspend fun doSeal(payload: PairPayload, priv: ByteArray, pub: ByteArray) {
        val sealed = try {
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
            sealWiFiConfig(wifi, kSession)
        } catch (t: Throwable) {
            // Don't surface the raw exception (could leak field shape);
            // map to a generic copy + clear any captured state so retry
            // re-derives from a fresh tap.
            wipeCaptured()
            _phase.value = NfcPairPhase.Failure("Couldn't seal Wi-Fi credentials. Tap your box again.")
            return
        }

        _phase.value = NfcPairPhase.Depositing
        val outcome = rendezvous.depositSealedWifi(payload.hint.cloudRendezvousId, sealed)
        outcome.fold(
            onSuccess = {
                wipeCaptured()
                _phase.value = NfcPairPhase.Success(
                    "Sent Wi-Fi to ${payload.hint.mdnsName}. The box should join your network in a moment.",
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
    }

    /** Pure helper exposed for tests — maps a thrown error into the
     *  user-facing copy without going through the coroutine machinery. */
    internal fun humanize(t: Throwable): String {
        if (t is NfcPairReaderException) {
            return when (t.error) {
                NfcPairReaderError.NfcUnavailable ->
                    "NFC isn't available on this device. You can pair from the box's LED instead."
                NfcPairReaderError.UserCanceled ->
                    "Pairing cancelled. Tap again when ready."
                NfcPairReaderError.TagFormatUnrecognized ->
                    "That doesn't look like a Flagship box tag. Try tapping again."
                is NfcPairReaderError.MalformedPayload ->
                    "Couldn't read the tag (${(t.error as NfcPairReaderError.MalformedPayload).reason}). Try again."
                NfcPairReaderError.SignatureMismatch ->
                    "The tag's signature didn't check out. This may not be a genuine box."
                NfcPairReaderError.Timeout ->
                    "No tap detected. Hold your phone to the back of the box and try again."
            }
        }
        return t.message ?: "Something went wrong. Try again."
    }
}
