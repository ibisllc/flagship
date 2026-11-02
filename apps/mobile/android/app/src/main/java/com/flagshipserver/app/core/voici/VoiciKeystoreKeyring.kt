// VoiciCenter's keys on a real device: the UMK and account device key from the Keystore, the sensitive key (admin
// root, else the IRK) behind the biometric session, the account from AppState.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.R
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.Keystore

class VoiciKeystoreKeyring(
    private val app: AppState,
    private val forceAdmin: () -> Boolean = { false },
    /** A debug gym run on mock clients: its demo session gets a UMK and a device id like a real account's. */
    private val mockRun: Boolean = false,
) : VoiciKeyring {
    /** Demo accounts have no account key of their own (`.com` holds their IRK), so they have no page. */
    override fun username(): String? = app.currentUser.value?.takeIf { it.isNotEmpty() && (mockRun || !app.isDemoAccountNow()) }

    override fun umk(): ByteArray? = when {
        Keystore.hasUmkSeed() -> runCatching { Keystore.currentUmkSeed() }.getOrNull()
        mockRun -> Keystore.loadOrCreateUmkSeed()
        else -> null
    }

    override fun holdsSensitiveKey(account: VoiciAccountKeys): Boolean {
        val root = Keystore.adminRootPubHex()
        if (account.adminRootPub != null) return root == account.adminRootPub || forceAdmin()
        return umk() != null
    }

    override fun sensitiveNeedsPrompt(): Boolean = Keystore.sensitiveSigningNeedsPrompt()

    override suspend fun sensitiveSeed(reason: String): Pair<ByteArray, String> {
        val why = reason.ifEmpty { FSStrings.get(R.string.voici_publish_reason) }
        return if (Keystore.hasAdminRoot()) {
            Keystore.adminRootKey(why)
            requireNotNull(Keystore.adminRootSeed()) to "admin-root"
        } else {
            Keystore.deriveIRK(why)
            Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion()) to "irk"
        }
    }

    override fun device(): VoiciDeviceSigner? {
        val u = username() ?: return null
        val deviceId = app.activeProfile?.deviceId?.takeIf { DEVICE_ID.matches(it) } ?: (if (mockRun) "d0".repeat(16) else return null)
        val umk = umk() ?: return null
        return VoiciDeviceSigner(deviceId, HexUtil.encode(Keystore.accountDevicePublicKey(umk, u, deviceId)), Keystore.accountDeviceSigner(umk, u, deviceId))
    }

    override suspend fun confirm(reason: String) {
        BiometricAuthority.confirmNow(reason)
    }

    override fun displayName(): String = app.activeProfile?.accountDisplayName?.takeIf { it.isNotBlank() } ?: (app.currentUser.value ?: "")

    private companion object {
        val DEVICE_ID = Regex("^[0-9a-f]{32}$")
    }
}
