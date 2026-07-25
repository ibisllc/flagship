package com.flagshipserver.app.keystore

import androidx.biometric.BiometricManager.Authenticators
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
            // Accept ANY strong device unlock — fingerprint / face / iris OR the
            // device PIN / pattern / password (DEVICE_CREDENTIAL). This is
            // device-agnostic (no modality preference) and lets a phone with a
            // screen lock but no enrolled biometric still authenticate. When
            // DEVICE_CREDENTIAL is allowed the system supplies its own cancel
            // affordance, so a negative button must NOT be set (the two are
            // mutually exclusive).
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(
                    Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL
                )
                .build()
            prompt.authenticate(info)
        }
    }
}
