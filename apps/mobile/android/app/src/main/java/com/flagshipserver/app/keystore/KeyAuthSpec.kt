package com.flagshipserver.app.keystore

import android.annotation.SuppressLint
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import com.flagshipserver.app.core.AndroidVersionPolicy
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory

/**
 * Binds a Keystore key to the person's authentication (strong biometric or device PIN, pattern or
 * password), the same way on every Android version the app runs on.
 *
 * Android 11+: `setUserAuthenticationParameters(seconds, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`.
 * Android 10: `setUserAuthenticationValidityDurationSeconds`. Weaker there: a per-use key
 * ([seconds] 0) becomes a [AndroidVersionPolicy.PER_USE_WINDOW_ON_API_29]-second window, so for
 * those seconds after any strong unlock (the app's prompt, or unlocking the phone itself) the key
 * works for any code in the app's process, not only for the one operation the prompt carried.
 */
object KeyAuthSpec {
    @SuppressLint("NewApi", "InlinedApi") // each call is behind its own API-level branch
    fun require(builder: KeyGenParameterSpec.Builder, seconds: Int, sdk: Int = Build.VERSION.SDK_INT): KeyGenParameterSpec.Builder {
        builder.setUserAuthenticationRequired(true)
        when (val a = AndroidVersionPolicy.keyAuth(sdk, seconds)) {
            is AndroidVersionPolicy.KeyAuth.Parameters -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setUserAuthenticationParameters(
                    a.seconds,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            }
            is AndroidVersionPolicy.KeyAuth.Window -> {
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(a.seconds)
            }
        }
        return builder
    }

    /** True when [key] opens for a window after a prompt (an Android 10 key), so the prompt
     *  must not carry it as a CryptoObject; false for a per-use key. */
    fun isWindowKey(key: SecretKey): Boolean = runCatching {
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        @Suppress("DEPRECATION")
        info.userAuthenticationValidityDurationSeconds > 0
    }.getOrDefault(false)
}
