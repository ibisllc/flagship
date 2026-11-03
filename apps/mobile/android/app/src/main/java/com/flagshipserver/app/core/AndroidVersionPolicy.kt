// What the app does differently on Android 10 to 12 (API 29 to 32), in one place.
//
// The phone app's floor is Android 10 (owner, 2026-11-02: reach over the security-feature floor).
// Android 13 (API 33) has three security features the app leans on: the Recents screenshot block
// for the app lock, the sensitive-clipboard flag for copied secrets and the runtime notification
// permission; Android 11 (API 30) added biometric-or-PIN Keystore keys. Below those levels the app
// uses the stand-ins decided here (AGENTS.md "Minimum OS"), and tells the person once in the top
// sliver, and always in Settings, that their Android version no longer gets security updates.
// Pure so every branch is unit-tested with an explicit API level.

package com.flagshipserver.app.core

object AndroidVersionPolicy {
    /** Android 13: the oldest version with every security feature the app was built around. */
    const val SECURITY_FEATURE_FLOOR = 33

    /** Android 11: biometric-or-credential Keystore keys and prompts that carry a key. */
    const val KEY_AUTH_PARAMETERS_API = 30

    /** Seconds a key that needs authentication on every use stays open after the prompt on
     *  Android 10, where only a fingerprint (never the PIN) can authorize a single use. */
    const val PER_USE_WINDOW_ON_API_29 = 15

    /** Show the "no longer gets security updates" notice. */
    fun warnOutdatedAndroid(sdk: Int): Boolean = sdk < SECURITY_FEATURE_FLOOR

    /** `Activity.setRecentsScreenshotEnabled` exists; below it the app lock uses FLAG_SECURE. */
    fun hasRecentsScreenshotControl(sdk: Int): Boolean = sdk >= 33

    /** No sensitive-clipboard flag the system honours: clear a copied secret after a minute. */
    fun clipboardNeedsAutoClear(sdk: Int): Boolean = sdk < 33

    /** POST_NOTIFICATIONS is a runtime permission; below 33 it is granted at install. */
    fun notificationPermissionIsRuntime(sdk: Int): Boolean = sdk >= 33

    /** Haptic CONFIRM / REJECT exist (API 30); below, the nearest older constants. */
    fun hasConfirmRejectHaptics(sdk: Int): Boolean = sdk >= 30

    /** Keystore can hold an X25519 agreement key (API 31). */
    fun keystoreHasX25519(sdk: Int): Boolean = sdk >= 31

    /** `PendingIntent.FLAG_MUTABLE` exists (API 31); before it every PendingIntent was mutable. */
    fun hasMutablePendingIntentFlag(sdk: Int): Boolean = sdk >= 31

    /** How a Keystore key that needs the person's authentication is bound. */
    sealed class KeyAuth {
        /** API 30+: `setUserAuthenticationParameters(seconds, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`. */
        data class Parameters(val seconds: Int) : KeyAuth()
        /** API 29: `setUserAuthenticationValidityDurationSeconds(seconds)`, any strong unlock. */
        data class Window(val seconds: Int) : KeyAuth()
    }

    /**
     * [seconds] 0 means "every use needs its own authentication". On API 30+ that is kept as is
     * (a prompt carrying the key's cipher, fingerprint or PIN). On API 29 a per-use key can only be
     * authorized by a fingerprint with a CryptoObject, which would take the PIN away from people
     * without one, so it becomes a short window ([PER_USE_WINDOW_ON_API_29]) opened by the prompt.
     */
    fun keyAuth(sdk: Int, seconds: Int): KeyAuth = when {
        sdk >= KEY_AUTH_PARAMETERS_API -> KeyAuth.Parameters(seconds)
        seconds <= 0 -> KeyAuth.Window(PER_USE_WINDOW_ON_API_29)
        else -> KeyAuth.Window(seconds)
    }

    /** The system prompt may carry a key's cipher (a CryptoObject) and still offer the PIN. */
    fun promptCanCarryKey(sdk: Int): Boolean = sdk >= KEY_AUTH_PARAMETERS_API

    /**
     * The authenticators the system prompt allows: a strong biometric or the device PIN, pattern or
     * password. androidx.biometric refuses BIOMETRIC_STRONG | DEVICE_CREDENTIAL on API 28-29 and
     * takes BIOMETRIC_WEAK | DEVICE_CREDENTIAL there instead (Android 10's prompt only offers the
     * biometrics the platform lets apps use, and a key window is opened only by a strong one or the PIN).
     */
    fun promptAuthenticators(sdk: Int): Int =
        if (sdk >= KEY_AUTH_PARAMETERS_API) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL

    // androidx.biometric.BiometricManager.Authenticators, copied so this stays plain JVM.
    const val BIOMETRIC_STRONG = 0x000F
    const val BIOMETRIC_WEAK = 0x00FF
    const val DEVICE_CREDENTIAL = 0x8000
}
