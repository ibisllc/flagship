// The watch's boot-only X25519 key (docs/watch-boot-approval-without-unlock.md, option (a)), kept
// in the AndroidKeyStore: generated there, never exportable, bound to this device. Every agreement
// runs inside the Keystore. The servers holding a copy for it are remembered in the profile's
// encrypted prefs so the switches and the watch path need no network read.
//
// The Keystore can't require user presence here: the phone may be locked in a pocket and the
// presence is the owner's tap on the watch, which reaches the phone as a Data Layer request.

package com.flagshipserver.app.keystore

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.flagshipserver.app.core.BootDecryptKey
import com.flagshipserver.app.core.WatchBootCopy
import com.flagshipserver.app.core.WatchBootKeyStore
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement

class KeystoreWatchBootKeys : WatchBootKeyStore {
    private val alias: String get() = "com.flagship.watchboot.${Keystore.activeProfileTag()}"

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    override fun existing(): BootDecryptKey? {
        val ks = keyStore()
        val priv = ks.getKey(alias, null) as? PrivateKey ?: return null
        val pub = ks.getCertificate(alias)?.publicKey ?: return null
        return Hardware(priv, rawX25519(pub.encoded))
    }

    override fun loadOrCreate(): BootDecryptKey {
        existing()?.let { return it }
        val gen = KeyPairGenerator.getInstance("XDH", ANDROID_KEY_STORE)
        gen.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_AGREE_KEY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("x25519"))
                .build(),
        )
        val pair = gen.generateKeyPair()
        return Hardware(pair.private, rawX25519(pair.public.encoded))
    }

    override fun copies(): Map<String, WatchBootCopy> = Keystore.watchBootCopies()

    override fun setCopy(serverDomain: String, copy: WatchBootCopy?) = Keystore.setWatchBootCopy(serverDomain, copy)

    override fun clear() {
        runCatching { keyStore().deleteEntry(alias) }
        Keystore.clearWatchBootCopies()
    }

    private class Hardware(private val priv: PrivateKey, override val publicKey: ByteArray) : BootDecryptKey {
        override fun agree(peerPublicKey: ByteArray): ByteArray {
            require(peerPublicKey.size == 32) { "X25519 public key must be 32 bytes" }
            val peer = KeyFactory.getInstance("XDH").generatePublic(X509EncodedKeySpec(X25519_SPKI_PREFIX + peerPublicKey))
            val ka = KeyAgreement.getInstance("XDH", ANDROID_KEY_STORE)
            ka.init(priv)
            ka.doPhase(peer, true)
            return ka.generateSecret()
        }
    }

    companion object {
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        /** DER SubjectPublicKeyInfo header for an X25519 key (RFC 8410). */
        private val X25519_SPKI_PREFIX = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
        )

        fun rawX25519(spki: ByteArray): ByteArray {
            require(spki.size == 44 && spki.copyOfRange(0, 12).contentEquals(X25519_SPKI_PREFIX)) { "not an X25519 key" }
            return spki.copyOfRange(12, 44)
        }
    }
}
