package com.flagship.keystore

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Generates and holds the User Master Key inside Android Keystore, with
 * StrongBox when available. Derived keys (BAK, IRK, SWK) are produced via
 * HKDF; only the wrapped UMK is persisted.
 *
 * Production: wrap UMK with a KeyStore-protected AES key gated by
 * BiometricPrompt.CryptoObject so the OS enforces user presence on every use.
 */
object Keystore {
    private const val UMK_ALIAS = "com.flagship.umk"
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"

    fun generateUMK(useStrongBox: Boolean = true): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val spec = KeyGenParameterSpec.Builder(
            UMK_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setIsStrongBoxBacked(useStrongBox)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }
}
