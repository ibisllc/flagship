// What the app does differently on Android 10 to 12 (API 29 to 32), in one place.
//
// The phone app's floor is Android 10 (owner, 2026-11-02: reach over the security-feature floor).
// Android 13 (API 33) has three security features the app leans on: the Recents screenshot block
// for the app lock, the sensitive-clipboard flag for copied secrets and the runtime notification
// permission; Android 11 (API 30) added biometric-or-PIN Keystore keys (on Android 10 a per-use
// key needs a strong biometric, see [keyAuth]). Below those levels the app
// uses the stand-ins decided here (AGENTS.md "Minimum OS"), and tells the person once in the top
// sliver, and always in Settings, that their Android version no longer gets security updates.
// Pure so every branch is unit-tested with an explicit API level.

package com.flagshipserver.app.core

object AndroidVersionPolicy {
    /** Android 13: the oldest version with every security feature the app was built around. */
    const val SECURITY_FEATURE_FLOOR = 33

    /** Android 11: biometric-or-credential Keystore keys, and prompts that carry a key and still offer the PIN. */
    const val KEY_AUTH_PARAMETERS_API = 30

    /** Seconds a key that needs authentication on every use stays open after the prompt on
     *  Android 10 when the phone has no strong biometric (fingerprint) enrolled: there only a strong
     *  biometric can authorize a single use, so without one the key opens for this window instead. */
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

    /** How a Keystore key that needs the person's authentication is made. */
    sealed class KeyAuth {
        /** API 30+: `setUserAuthenticationParameters(seconds, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`. */
        data class Parameters(val seconds: Int) : KeyAuth()
        /** API 29 with a strong biometric enrolled: authentication for every use, no window. Only a
         *  prompt that carries the key's cipher (a CryptoObject) and is answered with a strong
         *  biometric opens it, and only for that one operation. */
        data object PerUseBiometric : KeyAuth()
        /** API 29: `setUserAuthenticationValidityDurationSeconds(seconds)`, any strong unlock. */
        data class Window(val seconds: Int) : KeyAuth()
    }

    /**
     * [seconds] 0 means "every use needs its own authentication". On API 30+ that is kept as is
     * (a prompt carrying the key's cipher, strong biometric or PIN). On API 29 a per-use key can
     * only be authorized by a strong biometric through a CryptoObject: with one enrolled
     * ([strongBiometric]) the key is made that way; without one it becomes a short window
     * ([PER_USE_WINDOW_ON_API_29]) that any strong unlock opens, including the lock screen's,
     * and the app suggests enrolling a fingerprint ([suggestAddingFingerprint]).
     */
    fun keyAuth(sdk: Int, seconds: Int, strongBiometric: Boolean): KeyAuth = when {
        sdk >= KEY_AUTH_PARAMETERS_API -> KeyAuth.Parameters(seconds)
        seconds > 0 -> KeyAuth.Window(seconds)
        strongBiometric -> KeyAuth.PerUseBiometric
        else -> KeyAuth.Window(PER_USE_WINDOW_ON_API_29)
    }

    /** How an existing key opens, read from the key itself (it may predate an OS upgrade). */
    enum class KeyBinding {
        /** Opens for a while after any strong unlock; a prompt must not carry it. */
        WINDOW,
        /** Per use, through a CryptoObject; a strong biometric or the device PIN (API 30+ keys). */
        PER_USE_BIOMETRIC_OR_PIN,
        /** Per use, through a CryptoObject answered by a strong biometric only (made on API 29). */
        PER_USE_BIOMETRIC_ONLY,
    }

    /**
     * [validitySeconds] is the key's `KeyInfo` validity (-1 or 0 for per use); [credentialAllowed]
     * whether its authentication types include the device credential (`KeyInfo.getUserAuthenticationType`,
     * API 30+; null when the running OS cannot say, i.e. API 29, where every per-use key is
     * biometric only). A key made on API 29 keeps its binding after the phone moves to Android 11+.
     */
    fun keyBinding(sdk: Int, validitySeconds: Int, credentialAllowed: Boolean?): KeyBinding = when {
        validitySeconds > 0 -> KeyBinding.WINDOW
        sdk < KEY_AUTH_PARAMETERS_API -> KeyBinding.PER_USE_BIOMETRIC_ONLY
        credentialAllowed == false -> KeyBinding.PER_USE_BIOMETRIC_ONLY
        else -> KeyBinding.PER_USE_BIOMETRIC_OR_PIN
    }

    /** A per-use key can be made now (so a window key made earlier should be replaced by one). */
    fun canMakePerUseKey(sdk: Int, strongBiometric: Boolean): Boolean =
        sdk >= KEY_AUTH_PARAMETERS_API || strongBiometric

    /** The system prompt may carry a key's cipher (a CryptoObject). On API 29 only with a strong
     *  biometric enrolled, and then the prompt takes that biometric only. */
    fun promptCanCarryKey(sdk: Int, strongBiometric: Boolean): Boolean = canMakePerUseKey(sdk, strongBiometric)

    /**
     * The authenticators the system prompt allows.
     *  - A prompt carrying a [KeyBinding.PER_USE_BIOMETRIC_ONLY] key: BIOMETRIC_STRONG (the PIN
     *    would never authorize that key).
     *  - API 30+: a strong biometric or the device PIN, pattern or password.
     *  - API 29 with a strong biometric enrolled: BIOMETRIC_STRONG only. androidx refuses
     *    BIOMETRIC_STRONG | DEVICE_CREDENTIAL there, and BIOMETRIC_WEAK | DEVICE_CREDENTIAL would let
     *    a weak (2D) face answer the app's gate, so the PIN is not offered while a fingerprint can be.
     *  - API 29 without one: BIOMETRIC_WEAK | DEVICE_CREDENTIAL, so the PIN still works (a weak face
     *    passes the app's gate there but opens no key: only a strong unlock opens a key window).
     */
    fun promptAuthenticators(sdk: Int, strongBiometric: Boolean, keyBinding: KeyBinding? = null): Int = when {
        keyBinding == KeyBinding.PER_USE_BIOMETRIC_ONLY -> BIOMETRIC_STRONG
        sdk >= KEY_AUTH_PARAMETERS_API -> BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        strongBiometric -> BIOMETRIC_STRONG
        else -> BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    }

    /** API 29 with no strong biometric: per-use keys fall back to a window, so the outdated-Android
     *  notice adds that enrolling a fingerprint makes approvals stronger. */
    fun suggestAddingFingerprint(sdk: Int, strongBiometric: Boolean): Boolean =
        sdk < KEY_AUTH_PARAMETERS_API && !strongBiometric

    // androidx.biometric.BiometricManager.Authenticators, copied so this stays plain JVM.
    const val BIOMETRIC_STRONG = 0x000F
    const val BIOMETRIC_WEAK = 0x00FF
    const val DEVICE_CREDENTIAL = 0x8000
}
