package com.flagshipserver.app.keystore

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import com.flagshipserver.app.core.AndroidVersionPolicy
import com.flagshipserver.app.core.AndroidVersionPolicy.KeyBinding
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory

/**
 * Binds a Keystore key to the person's authentication (strong biometric or device PIN, pattern or
 * password), as close to the same way on every Android version the app runs on as the OS allows.
 *
 * Android 11+: `setUserAuthenticationParameters(seconds, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`.
 * Android 10, a per-use key ([seconds] 0) with a strong biometric enrolled: authentication for
 * every use (no validity window), opened only by a prompt carrying the key's cipher and answered
 * with that biometric. Android 10 without one: a [AndroidVersionPolicy.PER_USE_WINDOW_ON_API_29]-second
 * window, so for those seconds after any strong unlock (the app's prompt, or unlocking the phone
 * itself) the key works for any code in the app's process; the outdated-Android notice then
 * suggests enrolling a fingerprint, and the next unlock after one is enrolled moves a key that can
 * be moved (the PQ session key, [KeystorePqKekVault]) to per use.
 */
object KeyAuthSpec {
    /** Test seam: force the answer of [strongBiometricEnrolled]. */
    @Volatile internal var strongBiometricOverride: Boolean? = null

    /** A strong (class 3) biometric is enrolled and usable right now. */
    fun strongBiometricEnrolled(context: Context): Boolean = strongBiometricOverride ?: runCatching {
        BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS
    }.getOrDefault(false)

    @SuppressLint("NewApi", "InlinedApi") // each call is behind its own API-level branch
    fun require(
        builder: KeyGenParameterSpec.Builder,
        seconds: Int,
        strongBiometric: Boolean,
        sdk: Int = Build.VERSION.SDK_INT,
    ): KeyGenParameterSpec.Builder {
        builder.setUserAuthenticationRequired(true)
        when (val a = AndroidVersionPolicy.keyAuth(sdk, seconds, strongBiometric)) {
            is AndroidVersionPolicy.KeyAuth.Parameters -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setUserAuthenticationParameters(
                    a.seconds,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            }
            // setUserAuthenticationRequired(true) alone: validity -1, every use needs a biometric
            // CryptoObject. Generation fails if no biometric is enrolled (the caller checked one is).
            AndroidVersionPolicy.KeyAuth.PerUseBiometric -> Unit
            is AndroidVersionPolicy.KeyAuth.Window -> {
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(a.seconds)
            }
        }
        return builder
    }

    /** How [key] opens, decided from the key as it was made (a key made on Android 10 keeps its
     *  binding after the phone moves to Android 11+). Null when the key can't be read. */
    @SuppressLint("NewApi")
    fun binding(key: SecretKey, sdk: Int = Build.VERSION.SDK_INT): KeyBinding? = runCatching {
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        @Suppress("DEPRECATION")
        val validity = info.userAuthenticationValidityDurationSeconds
        val credential = if (sdk >= Build.VERSION_CODES.R) {
            info.userAuthenticationType and KeyProperties.AUTH_DEVICE_CREDENTIAL != 0
        } else {
            null
        }
        AndroidVersionPolicy.keyBinding(sdk, validity, credential)
    }.getOrNull()

    /** True when [key] opens for a window after a prompt (made on Android 10 without a strong
     *  biometric), so the prompt must not carry it as a CryptoObject; false for a per-use key. */
    fun isWindowKey(key: SecretKey): Boolean = binding(key) == KeyBinding.WINDOW
}
