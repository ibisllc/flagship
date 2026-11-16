package com.flagshipserver.app.ui.shell

import androidx.fragment.app.FragmentActivity
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.BiometricFailed
import com.flagshipserver.app.keystore.BiometricGate

// Biometric or device PIN before an action that erases this device's account
// key from a screen that sits above the app lock (the lock screen's Sign out,
// the update-required screen's Sign out).

internal sealed class SignOutAuth {
    data object Ok : SignOutAuth()
    data object Cancelled : SignOutAuth()
    data class Failed(val message: String) : SignOutAuth()
}

/** Ok also when the device has nothing to authenticate with (no screen
 *  lock), where the sign-out is the only way out of this screen. */
internal suspend fun authenticateForSignOut(activity: FragmentActivity): SignOutAuth =
    authenticateDestructive(activity, FSStrings.get(R.string.sign_out_of_flagship))

/**
 * Delete = forget for a voi.ci conversation (docs/voici-calls.md "Deleting a conversation"): it goes from every device
 * of the account, so biometric or the device PIN first. True only when it passed (or the phone has no screen lock, as
 * for sign-out); a failure is handed to [onFailed], a cancel says nothing. Nothing may be deleted or sent unless true.
 */
internal suspend fun confirmConversationDelete(activity: FragmentActivity?, onFailed: (String) -> Unit): Boolean {
    if (activity == null) {
        onFailed(FSStrings.get(R.string.lost_activity_context_restart_and_retry))
        return false
    }
    return when (val r = authenticateDestructive(activity, FSStrings.get(R.string.voici_delete_prompt_title))) {
        SignOutAuth.Ok -> true
        SignOutAuth.Cancelled -> false
        is SignOutAuth.Failed -> {
            onFailed(r.message)
            false
        }
    }
}

private suspend fun authenticateDestructive(activity: FragmentActivity, title: String): SignOutAuth = try {
    BiometricGate.evaluate(activity, title = title, subtitle = FSStrings.get(R.string.confirm_its_you))
    SignOutAuth.Ok
} catch (e: BiometricFailed) {
    if (e.code in setOf(
            androidx.biometric.BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
            androidx.biometric.BiometricPrompt.ERROR_NO_BIOMETRICS,
            androidx.biometric.BiometricPrompt.ERROR_HW_NOT_PRESENT,
        )
    ) SignOutAuth.Ok
    else SignOutAuth.Failed(NetworkErrorHumanizer.humanize(e, "app-lock"))
} catch (_: BiometricCancelled) {
    SignOutAuth.Cancelled
}
