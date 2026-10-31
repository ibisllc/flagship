// This admin device's serving renewal key (docs/architecture-v2/serving-wiring.md section 4): an
// ECDSA P-256 key in the Android Keystore that signs the serving lease each time the app opens,
// with no prompt. The admin root delegates it once (`renewal-key-delegation/v1`); removing the
// device revokes it.
//
// - StrongBox when the phone has one, else the TEE; never exportable.
// - No user authentication (setUserAuthenticationRequired(false)), so it signs in the background.
// - Keystore keys are deleted with the app and never restored from a backup, so a fresh install
//   starts without one (owner rule) with nothing to clean up.
// - The Keystore signs DER; ServingAuthority turns it into compact low-S `r‖s`.

package com.flagshipserver.app.keystore

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.flagshipserver.app.core.ServingAuthority
import com.flagshipserver.app.core.SignedRenewalDelegation
import kotlinx.serialization.json.Json
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** A key that signs leases: its compressed public key, and a DER ECDSA-SHA256 signer. */
class RenewalSigner(val publicKeyHex: String, val signDer: (ByteArray) -> ByteArray)

object RenewalKey {
    private const val STORE = "AndroidKeyStore"
    private const val DELEGATED_PREFIX = "serving.delegation."

    private fun alias(account: String) = "flagship.renewal-key.${account.lowercase()}"

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    /** The key for `account`, without creating one. */
    fun load(account: String): RenewalSigner? = runCatching {
        val ks = keyStore()
        val a = alias(account)
        val priv = ks.getKey(a, null) as? PrivateKey ?: return null
        val pub = ks.getCertificate(a)?.publicKey as? ECPublicKey ?: return null
        signer(priv, pub)
    }.getOrNull()

    /** The key for `account`, made now if there is none. Null where the Keystore can't make one. */
    fun loadOrCreate(account: String): RenewalSigner? {
        load(account)?.let { return it }
        return runCatching {
            try {
                generate(account, strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
                generate(account, strongBox = false)
            }
            load(account)
        }.getOrNull()
    }

    private fun generate(account: String, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias(account), KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .setIsStrongBoxBacked(strongBox)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(spec) }.generateKeyPair()
    }

    private fun signer(priv: PrivateKey, pub: ECPublicKey) = RenewalSigner(ServingAuthority.compressedHex(pub)) { msg ->
        Signature.getInstance("SHA256withECDSA").run {
            initSign(priv)
            update(msg)
            sign()
        }
    }

    /** Sign-out / account removal. */
    fun delete(account: String, prefs: SharedPreferences? = null) {
        runCatching { keyStore().deleteEntry(alias(account)) }
        prefs?.edit()?.remove(DELEGATED_PREFIX + account.lowercase())?.apply()
    }

    // ---- delegation bookkeeping (non-secret) --------------------------------

    private val json = Json { ignoreUnknownKeys = true }

    /** The delegation `.com` accepted for this key on `account`, so it is signed once. */
    fun delegation(prefs: SharedPreferences, account: String, currentPub: String?): SignedRenewalDelegation? {
        val raw = prefs.getString(DELEGATED_PREFIX + account.lowercase(), null) ?: return null
        val d = runCatching { json.decodeFromString(SignedRenewalDelegation.serializer(), raw) }.getOrNull() ?: return null
        return d.takeIf { currentPub != null && it.record.renewalPub == currentPub }
    }

    fun recordDelegation(prefs: SharedPreferences, d: SignedRenewalDelegation) {
        prefs.edit().putString(DELEGATED_PREFIX + d.record.account.lowercase(), json.encodeToString(SignedRenewalDelegation.serializer(), d)).apply()
    }
}
