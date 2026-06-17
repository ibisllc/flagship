// Phase 3b — ADMIN side of cross-device QR pairing.
//
// Settings → Devices → Add device. The admin (an existing device that
// holds the account IRK) vouches for a collaborator's OWN phone:
//
//   1. mint a relay session id + a fresh ephemeral X25519 keypair;
//      render the join universal link as a QR
//      (https://flagshipserver.com/join?sid=…&pk=…).
//   2. open the relay; BLOCK until the incoming device connects + sends
//      its fresh device pubkey + its ephemeral X25519 pubkey.
//   3. derive the SAS from the two ephemeral pubkeys; show it; the admin
//      verbally confirms it matches the incoming device's screen.
//   4. on confirm: build a DeviceAdmit binding the incoming device's
//      FRESH device pubkey, sign it with the ACCOUNT IRK, seal
//      { umkSeedHex, admit, admitSig } under the relay kEnc, and deliver.
//
// The QR + scan windows are FLAG_SECURE (no screenshots) and the relay
// session is short-lived + single-use; both surfaces carry a risk
// warning. The vouched device joins QUARANTINED (server-enforced 14-day
// non-admin window) — see the incoming JoinDeviceViewModel + the v1.2
// quarantine.
//
// Mock relay seam only in tests; live CredentialManager is NOT involved.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.core.AdminPairingRelay
import com.flagshipserver.app.core.DeviceAdmit
import com.flagshipserver.app.core.DeviceAdmitClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.PairingBundle
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** L10 — anti-double-tap window (ms) before the "codes match" Confirm un-gates.
 *  Mirrors the iOS AddDeviceViewModel 600ms `gateExpired` window. */
const val SAS_CONFIRM_GATE_MS: Long = 600

/** Admin add-device state machine. */
sealed interface AddDevicePhase {
    /** QR rendered; waiting for the incoming device to scan + connect. */
    data class ShowingQr(val joinUrl: String) : AddDevicePhase

    /** The incoming device connected; SAS derived. Admin verbally
     *  confirms it matches the other screen, then calls [confirmAndSeal].
     *  [gateExpired] flips true after the [SAS_CONFIRM_GATE_MS] anti-double-tap
     *  window so a reflexive double-tap can't confirm a code the human hasn't
     *  compared (parity with iOS AddDeviceViewModel.Phase.confirmMatch). */
    data class ConfirmSas(val matchCode: String, val gateExpired: Boolean = false) : AddDevicePhase

    /** Sealing + delivering the key bundle. */
    data object Delivering : AddDevicePhase

    /** Done — the bundle is delivered; the incoming device will register
     *  + admit itself. The admin device is unchanged. */
    data object Delivered : AddDevicePhase

    /** A real failure (relay down, missing IRK, …). */
    data class Failed(val message: String) : AddDevicePhase
}

/**
 * Drives the admin add-device flow. Construct with the relay transport,
 * the signed-in account [username], and a way to read the account IRK.
 * [start] renders the QR + opens the relay; once the peer connects it
 * advances to [AddDevicePhase.ConfirmSas]; [confirmAndSeal] seals +
 * delivers.
 */
class AddDeviceViewModel(
    private val relay: AdminPairingRelay,
    private val username: String,
    /** Reads (or derives) the account UMK seed — the secret the new
     *  device needs to join the same identity. Injectable so tests don't
     *  touch the live Keystore. Defaults to the active profile's seed. */
    private val umkSeed: suspend () -> ByteArray = { Keystore.currentUmkSeed() },
    /** Derives + returns the account IRK keypair public + a signer.
     *  Defaults to the active profile's current IRK. */
    private val signAdmit: suspend (DeviceAdmit) -> ByteArray = { admit ->
        val irk = Keystore.deriveIRK("Vouch for a new device")
        DeviceAdmitClaim.sign(admit, irk)
    },
    /** Mints the relay session id. Random by default; injectable for
     *  deterministic tests. */
    private val sessionIdGen: () -> String = { com.flagshipserver.app.core.SerialGen.random() },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Anti-double-tap window (ms) before Confirm un-gates. Injectable so
     *  tests can drive the gate without a real 600ms wait. */
    private val confirmGateMs: Long = SAS_CONFIRM_GATE_MS,
) : ViewModel() {

    private val _phase = MutableStateFlow<AddDevicePhase>(
        AddDevicePhase.Failed("not started"),
    )
    val phase: StateFlow<AddDevicePhase> = _phase.asStateFlow()

    /** The relay session id (for the deliver leg). */
    private lateinit var sid: String

    /** Admin's ephemeral X25519 session (the QR carries its pubkey; the
     *  SAS + kEnc derive from it ⊕ the incoming device's ephemeral pub). */
    private val session = QrSession.fresh()

    /** The incoming device's FRESH device pubkey (Ed25519, hex) the admit
     *  binds. Captured from the peer hello. */
    private var incomingDevicePubHex: String? = null

    /** The join URL rendered as the QR. */
    val joinUrl: String by lazy {
        sid = sessionIdGen()
        JoinLink.build(sid, session.phonePubKey)
    }

    /**
     * Render the QR, open the relay, and BLOCK until the incoming device
     * connects. The incoming hello carries BOTH its ephemeral X25519
     * pubkey (for the SAS) AND its fresh device pubkey (what the admit
     * binds), concatenated: [32-byte x25519 pub || 32-byte device pub].
     */
    suspend fun start() {
        _phase.value = AddDevicePhase.ShowingQr(joinUrl)
        try {
            val helloBytes = relay.awaitPeerHello(sid)
            require(helloBytes.size == 64) {
                "peer hello must be 64 bytes (x25519 pub || device pub)"
            }
            val peerX25519 = helloBytes.copyOfRange(0, 32)
            val peerDevicePub = helloBytes.copyOfRange(32, 64)
            incomingDevicePubHex = HexUtil.encode(peerDevicePub)
            val matchCode = session.pair(peerX25519)
            _phase.value = AddDevicePhase.ConfirmSas(matchCode, gateExpired = false)
            // Un-gate Confirm after the anti-double-tap window (parity with
            // iOS). Don't clobber a phase that has already moved on.
            viewModelScope.launch {
                delay(confirmGateMs)
                val p = _phase.value
                if (p is AddDevicePhase.ConfirmSas && !p.gateExpired) {
                    _phase.value = p.copy(gateExpired = true)
                }
            }
        } catch (t: Throwable) {
            _phase.value = AddDevicePhase.Failed(humanize(t))
        }
    }

    /**
     * The admin confirmed the SAS matches the incoming device's screen.
     * Build + sign the DeviceAdmit (account IRK), seal the
     * { umkSeedHex, admit, admitSig } bundle under the relay kEnc, and
     * deliver it.
     */
    suspend fun confirmAndSeal() {
        // Anti-double-tap gate (parity with iOS confirmMatch): ignore a confirm
        // that arrives before the SAS-compare window elapses, or one fired from
        // any state other than ConfirmSas.
        val current = _phase.value
        if (current !is AddDevicePhase.ConfirmSas || !current.gateExpired) return
        val devicePubHex = incomingDevicePubHex ?: run {
            _phase.value = AddDevicePhase.Failed("Incoming device key missing — start over.")
            return
        }
        _phase.value = AddDevicePhase.Delivering
        try {
            val admit = DeviceAdmit(
                username = username,
                newDevicePubHex = devicePubHex.lowercase(),
                issuedAt = now(),
            )
            val sig = signAdmit(admit)
            val seed = umkSeed()
            require(seed.size == 32) { "account UMK seed must be 32 bytes" }
            val bundle = PairingBundle(
                umkSeedHex = HexUtil.encode(seed),
                admit = admit,
                admitSig = HexUtil.encode(sig),
            )
            val sealed = session.seal(bundle.toJsonBytes())
            relay.deliver(sealed.ciphertextB64u, sealed.nonceB64u)
            _phase.value = AddDevicePhase.Delivered
        } catch (t: Throwable) {
            _phase.value = AddDevicePhase.Failed(humanize(t))
        } finally {
            relay.close()
        }
    }

    fun cancel() {
        relay.close()
    }

    private fun humanize(t: Throwable): String =
        t.message ?: "Pairing failed. Generate a fresh code and try again."
}
