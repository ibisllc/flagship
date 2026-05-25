// Graceful detection of whether THIS device can register a PRF-capable
// passkey for cloud backup.
//
// PRF over androidx.credentials is surfaced only on API 34+ (Android 14)
// with a recent Google Play Services. On anything older we treat cloud
// backup as unavailable and steer the user to a backup file / skip —
// we never crash or block when it's missing (see PasskeyRecoveryManager,
// which throws PrfUnavailable as the runtime backstop).
//
// This is a cheap, side-effect-free probe used to decide the DEFAULT
// selection on the "Secure your account" step. The real ceremony still
// fails closed if it turns out the authenticator can't do PRF.

package com.flagshipserver.app.keystore

import android.content.Context
import android.os.Build
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

object PasskeyAvailability {

    /** True when the platform looks capable of a PRF passkey ceremony:
     *  Android 14+ AND Google Play Services available. */
    fun isAvailable(context: Context): Boolean =
        isSupportedApi(Build.VERSION.SDK_INT) && hasPlayServices(context)

    /** Pure, testable API-level gate. Android 14 (API 34) is the floor
     *  for reliable CredentialManager PRF. */
    fun isSupportedApi(sdkInt: Int): Boolean = sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    private fun hasPlayServices(context: Context): Boolean =
        runCatching {
            GoogleApiAvailability.getInstance()
                .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
        }.getOrDefault(false)
}
