package com.flagshipserver.app.keystore

import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class BiometricCancelled : Exception("biometric prompt cancelled")
class BiometricFailed(val code: Int, val errString: CharSequence) :
    Exception("biometric failed: $code $errString")

object BiometricGate {
    suspend fun evaluate(activity: FragmentActivity, title: String, subtitle: String) {
        suspendCancellableCoroutine<Unit> { cont ->
            val executor = Executors.newSingleThreadExecutor()
            val prompt = BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        cont.resume(Unit)
                    }
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                        ) {
                            cont.resumeWithException(BiometricCancelled())
                        } else {
                            cont.resumeWithException(BiometricFailed(errorCode, errString))
                        }
                    }
                }
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(info)
        }
    }
}
