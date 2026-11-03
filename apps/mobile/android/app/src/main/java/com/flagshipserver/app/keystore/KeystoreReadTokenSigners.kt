// Which keys can mint an account read token right now without a prompt
// (docs/account-read-token.md). The account device key never needs one once
// it is kept on the device (joined devices; others keep it at their first
// unlock, as iOS does); the IRK only when the session is open (the account
// seed is sealed behind the unlock, SeedVault). A poll calls this, so it must
// never raise BiometricPrompt, and a locked session simply yields fewer signers.

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
        device: (umk: ByteArray?, deviceId: String) -> ReadTokenSigner.Device? = { _, deviceId ->
            Keystore.sessionAccountDeviceKey(username, deviceId)?.let { key ->
                ReadTokenSigner.Device(deviceId = deviceId, signer = key.signer, pubHex = key.pubHex)
            }
        },
        umk: () -> ByteArray? = { null },
        irk: suspend () -> IrkMaterial = { KeystoreIrkAccess().resolve(FSStrings.get(R.string.refresh_server_status)) },
    ): List<ReadTokenSigner> {
        if (!hasUmk() || !username.equals(currentUser, ignoreCase = true)) return emptyList()
        val out = ArrayList<ReadTokenSigner>(2)
        val deviceId = profile?.deviceId.orEmpty()
        if (DEVICE_ID.matches(deviceId)) runCatching { device(umk(), deviceId) }.getOrNull()?.let(out::add)
        val gate = authority()
        if (gate == null || gate.isFresh()) {
            // Locked (the seed is sealed and the session key closed): no IRK signer this time.
            val m = try {
                irk()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Throwable) {
                null
            }
            m?.let { out.add(ReadTokenSigner.Irk(it.signer, it.pubHex)) }
        }
        return out
    }
}
