// This device's call-only key, for answering voi.ci calls while Flagship is locked (docs/voici-calls.md, owner
// decisions 2026-11-15; the setting "Answer calls while Flagship is locked", off by default). Same rules as iOS
// VoiciCallKey.swift.
//
// A P-256 key in the Android Keystore without user authentication (StrongBox where the phone has it), so a ringing
// phone can sign while the app is locked. It is bound once under the owner messages key (`flagship/voici-call-key/v1`)
// and signs only a call's room join, answer and owner end order; `.com` and the caller's browser refuse it for
// anything else. What a locked call needs (account, device, page, the ownerSignPub the binding verifies under, the
// binding) sits beside it in plain preferences: none of it is secret (the page is public).

package com.flagshipserver.app.calls

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.flagshipserver.app.core.ServingAuthority
import com.flagshipserver.app.core.voici.VoiciCalls
import com.flagshipserver.app.core.voici.VoiciJs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** A P-256 key that signs only call records: [sign] returns IEEE P1363 r‖s (64 bytes). */
interface CallKeySigner {
    val pubHex: String
    fun sign(bytes: ByteArray): ByteArray
}

/** A bound call key and the public facts a locked call needs. */
class VoiciCallKey(
    val username: String,
    val deviceId: String,
    val pageId: String,
    val ownerSignPub: String,
    val proof: JsonObject,
    val signer: CallKeySigner,
) {
    val pubHex: String get() = signer.pubHex
    val deviceRef: String get() = VoiciCalls.deviceRef(pubHex)

    /** The room join headers (`flagship/voici-call-join/v1`) for one call. */
    fun joinHeaders(callId: String, now: Long): Map<String, String> {
        val sig = signer.sign(VoiciCalls.canonicalCallJoin(username, callId, deviceId, pubHex, now))
        return mapOf(
            "x-flagship-call-key-device" to deviceId,
            "x-flagship-call-key-pub" to pubHex,
            "x-flagship-call-key-at" to now.toString(),
            "x-flagship-call-key-sig" to VoiciJs.hex(sig),
        )
    }

    /** The revocation the key signs itself (when the owner key is not at hand): `{revoke, signature}`. */
    fun selfRevokeBody(at: Long): JsonObject {
        val sig = signer.sign(VoiciCalls.canonicalCallKeyRevoke(username, deviceId, pubHex, at))
        return JsonObject(mapOf("revoke" to VoiciCalls.revokeJson(username, deviceId, pubHex, at), "signature" to kotlinx.serialization.json.JsonPrimitive(VoiciJs.hex(sig))))
    }
}

/** Where call keys live: the Keystore on a phone, memory in tests. */
interface VoiciCallKeyVault {
    /** A fresh key for [username], not yet bound (replaces any earlier unbound one). */
    fun generate(username: String): CallKeySigner
    fun save(key: VoiciCallKey)
    fun load(username: String): VoiciCallKey?
    fun delete(username: String)
    /** A generated key that was never bound (its registration failed). */
    fun discard(signer: CallKeySigner) {}
    /** The account whose key a locked phone uses when a call arrives. */
    fun currentAccount(): String? = null
}

class KeystoreCallKeyVault(context: Context) : VoiciCallKeyVault {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("flagship.voici.callkey", Context.MODE_PRIVATE)
    private val ks: KeyStore by lazy { KeyStore.getInstance("AndroidKeyStore").apply { load(null) } }

    private class KeystoreSigner(val alias: String, private val priv: PrivateKey, override val pubHex: String) : CallKeySigner {
        override fun sign(bytes: ByteArray): ByteArray {
            val der = Signature.getInstance("SHA256withECDSA").run {
                initSign(priv)
                update(bytes)
                sign()
            }
            return ServingAuthority.derToRaw(der) ?: throw IllegalStateException("call key: bad signature")
        }
    }

    private fun pubHexOf(alias: String): String? {
        val pub = ks.getCertificate(alias)?.publicKey as? ECPublicKey ?: return null
        fun b32(n: java.math.BigInteger): ByteArray = n.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else ByteArray(32 - it.size) + it }
        return VoiciJs.hex(byteArrayOf(4) + b32(pub.w.affineX) + b32(pub.w.affineY))
    }

    private fun signerFor(alias: String): KeystoreSigner? {
        val priv = ks.getKey(alias, null) as? PrivateKey ?: return null
        return KeystoreSigner(alias, priv, pubHexOf(alias) ?: return null)
    }

    override fun generate(username: String): CallKeySigner {
        val a = "flagship.voici.callkey.${username.lowercase()}.${System.currentTimeMillis()}"
        fun make(strongBox: Boolean) {
            val spec = KeyGenParameterSpec.Builder(a, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .apply { if (strongBox) setIsStrongBoxBacked(true) }
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        }
        val strongBox = android.os.Build.VERSION.SDK_INT >= 28 && app.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        try {
            make(strongBox)
        } catch (e: StrongBoxUnavailableException) {
            make(false)
        }
        return signerFor(a) ?: throw IllegalStateException("call key: not created")
    }

    override fun discard(signer: CallKeySigner) {
        (signer as? KeystoreSigner)?.let { runCatching { ks.deleteEntry(it.alias) } }
    }

    override fun save(key: VoiciCallKey) {
        val u = key.username.lowercase()
        val alias = (key.signer as? KeystoreSigner)?.alias ?: throw IllegalArgumentException("call key: not a Keystore key")
        prefs.getString("$u.alias", null)?.takeIf { it != alias }?.let { runCatching { ks.deleteEntry(it) } }
        prefs.edit()
            .putString("$u.alias", alias)
            .putString("$u.deviceId", key.deviceId)
            .putString("$u.pageId", key.pageId)
            .putString("$u.ownerSignPub", key.ownerSignPub)
            .putString("$u.proof", key.proof.toString())
            .putString("account", u)
            .apply()
    }

    override fun load(username: String): VoiciCallKey? {
        val u = username.lowercase()
        val a = prefs.getString("$u.alias", null) ?: return null
        val signer = runCatching { signerFor(a) }.getOrNull() ?: return null
        val proof = runCatching { Json.parseToJsonElement(prefs.getString("$u.proof", "") ?: "") as? JsonObject }.getOrNull() ?: return null
        return VoiciCallKey(u, prefs.getString("$u.deviceId", null) ?: return null, prefs.getString("$u.pageId", null) ?: return null,
            prefs.getString("$u.ownerSignPub", null) ?: return null, proof, signer)
    }

    override fun delete(username: String) {
        val u = username.lowercase()
        prefs.getString("$u.alias", null)?.let { runCatching { ks.deleteEntry(it) } }
        prefs.edit().remove("$u.alias").remove("$u.deviceId").remove("$u.pageId").remove("$u.ownerSignPub").remove("$u.proof").apply()
    }

    override fun currentAccount(): String? = prefs.getString("account", null)
}

/** In memory, software P-256 (unit tests). */
class MemoryCallKeyVault : VoiciCallKeyVault {
    private val keys = HashMap<String, VoiciCallKey>()
    var seed: Byte = 0x71

    class Software(private val priv: ByteArray) : CallKeySigner {
        override val pubHex: String = VoiciJs.hex(VoiciJs.p256PublicKey(priv))
        override fun sign(bytes: ByteArray) = VoiciJs.p256Sign(priv, bytes)
    }

    override fun generate(username: String): CallKeySigner = Software(ByteArray(32) { seed++ })
    override fun save(key: VoiciCallKey) { keys[key.username.lowercase()] = key }
    override fun load(username: String) = keys[username.lowercase()]
    override fun delete(username: String) { keys.remove(username.lowercase()) }
    override fun currentAccount(): String? = keys.keys.firstOrNull()
}
