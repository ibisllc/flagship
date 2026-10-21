// Which keys can mint an account read token right now without a prompt
// (docs/account-read-token.md). The account device key never needs one on
// Android; the IRK only when the biometric session is already fresh (or no
// activity is bound, where deriveIRK skips the gate anyway). A poll calls
// this, so it must never raise BiometricPrompt.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.IrkMaterial
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.core.ReadTokenSigner

object KeystoreReadTokenSigners {
    private val DEVICE_ID = Regex("^[0-9a-f]{32}$")

    suspend fun resolve(
        username: String,
        currentUser: String?,
        profile: Profile?,
        hasUmk: () -> Boolean = Keystore::hasUmkSeed,
        authority: () -> BiometricAuthority? = BiometricAuthority::current,
        device: (umk: ByteArray, deviceId: String) -> ReadTokenSigner.Device = { umk, deviceId ->
            ReadTokenSigner.Device(
                deviceId = deviceId,
                signer = Keystore.accountDeviceSigner(umk, username, deviceId),
                pubHex = HexUtil.encode(Keystore.accountDevicePublicKey(umk, username, deviceId)),
            )
        },
        umk: () -> ByteArray = Keystore::currentUmkSeed,
        irk: suspend () -> IrkMaterial = { KeystoreIrkAccess().resolve(FSStrings.get(R.string.refresh_server_status)) },
    ): List<ReadTokenSigner> {
        if (!hasUmk() || !username.equals(currentUser, ignoreCase = true)) return emptyList()
        val out = ArrayList<ReadTokenSigner>(2)
        val deviceId = profile?.deviceId.orEmpty()
        if (DEVICE_ID.matches(deviceId)) out.add(device(umk(), deviceId))
        val gate = authority()
        if (gate == null || gate.isFresh()) {
            val m = irk()
            out.add(ReadTokenSigner.Irk(m.signer, m.pubHex))
        }
        return out
    }
}
