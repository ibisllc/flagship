// Phase 3b — INCOMING side of cross-device QR pairing.
//
// A collaborator's OWN phone joins a multi-device account by scanning the
// admin's pairing QR (or opening the App-Links deeplink). It is the
// doorway that receives the account keys out-of-band:
//
//   1. parse the JoinLink (sid + admin ephemeral X25519 pub) from the
//      scanned QR / deeplink.
//   2. mint a FRESH ephemeral X25519 keypair (for the SAS) AND a FRESH
//      device Ed25519 keypair (its device identity — what the admit
//      binds). Connect to the relay + send the hello
//      [x25519 pub || device pub].
//   3. derive the SAS from the two ephemeral pubkeys; show it; the USER
//      verifies it matches the admin's screen, then calls [verifyAndJoin].
//   4. await the sealed bundle; AEAD-open it; VERIFY the admit signature
//      under the account's CURRENT IRK pub (resolved via
//      getUsernameRecord → irkPub) and that it binds OUR device pubkey.
//   5. install the recovered UMK into a NEW per-profile slot (NEVER
//      clobbering an existing profile), register push, POST the admit to
//      .com (lands QUARANTINED), and addProfile(setActive = true).
//      Surface the 14-day quarantine.
//
// The new device is NON-ADMIN (server enforces revoke-others + admin
// reach via the quarantine window). Both pairing windows are FLAG_SECURE
// + carry a risk warning. Mock relay seam in tests; live Credential
// Manager is NOT involved.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.DeviceAdmitRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PushTokenRegisterRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DeviceAdmit
import com.flagshipserver.app.core.DeviceAdmitClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.IncomingPairingRelay
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.PairingBundle
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Incoming join state machine. */
sealed interface JoinDevicePhase {
    /** Connecting to the relay + sending hello; waiting for the SAS. */
    data object Connecting : JoinDevicePhase

    /** SAS derived. The USER verifies it matches the admin's screen,
     *  then calls [JoinDeviceViewModel.verifyAndJoin]. */
    data class VerifySas(val matchCode: String) : JoinDevicePhase

    /** Receiving + opening the bundle, installing the UMK, admitting. */
    data object Joining : JoinDevicePhase

    /** Joined — the account is open as a fresh, QUARANTINED, non-admin
     *  device. Carries the quarantine deadline so the host surfaces the
     *  countdown. */
    data class Joined(val quarantineUntil: Long?) : JoinDevicePhase

    /** A real failure (bad QR, MitM tag-fail, forged admit, …). */
    data class Failed(val message: String) : JoinDevicePhase
}

/**
 * Drives the incoming join. Construct with the parsed [joinLink], the
 * relay transport, the server client, and the AppState.
 */
class JoinDeviceViewModel(
    private val joinLink: JoinLink,
    private val relay: IncomingPairingRelay,
    private val server: FlagshipServerClient,
    private val app: AppState,
    /** FCM provider token. On a real device this is the OS-issued token;
     *  tests pass a placeholder. */
    private val providerToken: String = "",
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    private val _phase = MutableStateFlow<JoinDevicePhase>(JoinDevicePhase.Connecting)
    val phase: StateFlow<JoinDevicePhase> = _phase.asStateFlow()

    /** Our ephemeral X25519 session (for the SAS + kEnc). */
    private val session = QrSession.fresh()

    /** Our FRESH device identity keypair (Ed25519). The admit binds its
     *  pubkey; we generate it independent of any profile so the join is a
     *  genuinely new device. */
    private val deviceKeyPair = Ed25519Sign.KeyPair.newKeyPair()
    private val devicePubHex: String get() = HexUtil.encode(deviceKeyPair.publicKey)

    /**
     * Connect to the relay, send the hello (x25519 pub || device pub),
     * derive the SAS, and surface it for the user to verify.
     */
    suspend fun start() {
        _phase.value = JoinDevicePhase.Connecting
        try {
            val hello = session.phonePubKey + deviceKeyPair.publicKey  // 32 || 32
            relay.connectAndHello(joinLink.sid, hello)
            val matchCode = session.pair(joinLink.adminPubKey)
            _phase.value = JoinDevicePhase.VerifySas(matchCode)
        } catch (t: Throwable) {
            _phase.value = JoinDevicePhase.Failed(humanize(t))
        }
    }

    /**
     * The user confirmed the SAS matches. Receive + open the sealed
     * bundle, verify the admit, install the UMK into a NEW profile, and
     * admit this device to .com.
     */
    suspend fun verifyAndJoin() {
        _phase.value = JoinDevicePhase.Joining
        try {
            val (ct, nonce) = relay.awaitDelivery()
            // AEAD-open under the relay kEnc. A bad tag throws — that's a
            // MitM / wrong-peer; we surface it as a failure (NOT a join).
            val plain = session.open(ct, nonce)
            val bundle = PairingBundle.fromJsonBytes(plain)

            // 1. The admit MUST bind OUR fresh device pubkey — a captured
            //    admit can't be re-aimed at us.
            if (!bundle.admit.newDevicePubHex.equals(devicePubHex, ignoreCase = true)) {
                _phase.value = JoinDevicePhase.Failed(
                    "This invite was issued for a different device. Start over.",
                )
                return
            }

            // 2. VERIFY the admit signature under the account's CURRENT
            //    IRK pub (the vouch). Resolve it from .com — the admin
            //    holds that key. A forged / wrong-key admit fails closed.
            val record = server.getUsernameRecord(bundle.admit.username)
            val irkPub = HexUtil.decode(record.irkPub)
                ?: throw IllegalStateException("account IRK pub is not valid hex")
            val admitSig = HexUtil.decode(bundle.admitSig)
                ?: throw IllegalStateException("admit signature is not valid hex")
            val admitForVerify = DeviceAdmit(
                username = bundle.admit.username,
                newDevicePubHex = bundle.admit.newDevicePubHex.lowercase(),
                issuedAt = bundle.admit.issuedAt,
            )
            if (!DeviceAdmitClaim.verify(admitForVerify, admitSig, irkPub)) {
                _phase.value = JoinDevicePhase.Failed(
                    "Couldn't verify the invite. This device was NOT added.",
                )
                return
            }

            val umkSeed = HexUtil.decode(bundle.umkSeedHex)
                ?: throw IllegalStateException("UMK seed is not valid hex")
            require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }

            // 3. Multi-profile keystore (#9): point the Keystore at THIS
            //    account's per-profile slot BEFORE installing the UMK, so
            //    a phone that already holds OTHER profiles keeps them
            //    intact. installUmk into the new slot ⇒ never clobbers.
            val cloudName = bundle.admit.username
            Keystore.setActiveProfile(cloudName)
            Keystore.installUmk(umkSeed)

            // 4. Register push for the new profile, then POST the admit to
            //    .com. The Worker verifies the admit under the account IRK
            //    and admits us QUARANTINED. The register signature is
            //    carried (the admit is the IRK's consent).
            val push = Keystore.loadOrCreatePushX25519()
            val pushPubHex = HexUtil.encode(push.publicKey)
            val issuedAt = now()
            val label = "${cloudName} (new device)"
            val canonical = com.flagshipserver.app.core.PushTokenRegister.canonicalBytes(
                username = cloudName,
                platform = "fcm",
                providerToken = providerToken,
                pushX25519PubHex = pushPubHex,
                label = label,
                issuedAt = issuedAt,
            )
            val irk = Keystore.deriveIRK("Register this device")
            val registerSig = HexUtil.encode(irk.sign(canonical))

            val resp = server.admitDevice(
                account = cloudName,
                req = DeviceAdmitRequest(
                    admit = DeviceAdmitRequest.AdmitEnvelope(
                        username = bundle.admit.username,
                        newDevicePubHex = bundle.admit.newDevicePubHex.lowercase(),
                        issuedAt = bundle.admit.issuedAt,
                    ),
                    admitSig = bundle.admitSig.lowercase(),
                    request = PushTokenRegisterRequest.Inner(
                        username = cloudName,
                        platform = "fcm",
                        providerToken = providerToken,
                        pushX25519Pub = pushPubHex,
                        label = label,
                        issuedAt = issuedAt,
                    ),
                    signature = registerSig,
                ),
            )
            Keystore.setPushTokenId(resp.tokenId)

            // 5. Add the profile alongside any existing ones + make it
            //    active. The new device is NON-ADMIN (no admin label);
            //    the server enforces the quarantine.
            app.addProfile(
                Profile(
                    cloudName = cloudName,
                    deviceLabel = label,
                    createdAt = now(),
                ),
                setActive = true,
            )

            _phase.value = JoinDevicePhase.Joined(resp.quarantineUntil)
        } catch (t: Throwable) {
            _phase.value = JoinDevicePhase.Failed(humanize(t))
        } finally {
            relay.close()
        }
    }

    fun cancel() {
        relay.close()
    }

    private fun humanize(t: Throwable): String {
        val m = t.message?.lowercase().orEmpty()
        return when {
            m.contains("tag mismatch") || m.contains("aead") || m.contains("bad") && m.contains("tag") ->
                "Couldn't decrypt the invite — the codes may not have matched. Start over."
            m.contains("401") || m.contains("invalid admit") ->
                "The account rejected this invite. Ask the admin to generate a fresh code."
            else -> t.message ?: "Couldn't join. Start over."
        }
    }
}
