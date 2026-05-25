// The API-level gate for PRF passkey availability. Pure-JVM.

package com.flagshipserver.app.keystore

import android.os.Build
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PasskeyAvailabilityTest {

    @Test fun api34AndAbove_isSupported() {
        assertTrue(PasskeyAvailability.isSupportedApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE))
        assertTrue(PasskeyAvailability.isSupportedApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE + 1))
    }

    @Test fun below34_isNotSupported() {
        assertFalse(PasskeyAvailability.isSupportedApi(Build.VERSION_CODES.TIRAMISU)) // 33
        assertFalse(PasskeyAvailability.isSupportedApi(Build.VERSION_CODES.S)) // 31
    }
}
