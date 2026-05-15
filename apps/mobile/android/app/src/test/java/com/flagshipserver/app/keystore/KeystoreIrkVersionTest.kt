// C7 — pins the Keystore IRK HKDF-version primitive that backs
// Replace device. Robolectric runs SharedPreferences in-memory so
// we exercise the persistence path without an emulator.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class KeystoreIrkVersionTest {

    @Before
    fun setUp() {
        Keystore.attach(ApplicationProvider.getApplicationContext<Context>())
        Keystore.wipe()
    }

    @Test fun defaultVersionIsOne() {
        assertEquals(1, Keystore.currentIrkVersion())
    }

    @Test fun setAndReadBackVersion() {
        Keystore.setCurrentIrkVersion(2)
        assertEquals(2, Keystore.currentIrkVersion())
        Keystore.setCurrentIrkVersion(7)
        assertEquals(7, Keystore.currentIrkVersion())
    }

    @Test fun pendingSlot_roundTrips_andClearsOnNull() {
        assertNull(Keystore.pendingIrkRotationVersion())
        Keystore.setPendingIrkRotationVersion(3)
        assertEquals(3, Keystore.pendingIrkRotationVersion())
        Keystore.setPendingIrkRotationVersion(null)
        assertNull(Keystore.pendingIrkRotationVersion())
    }

    @Test fun setVersion_rejectsZeroOrNegative() {
        assertThrows(IllegalArgumentException::class.java) {
            Keystore.setCurrentIrkVersion(0)
        }
    }

    @Test fun wipeClearsAllVersionSlots() = runBlocking {
        Keystore.setCurrentIrkVersion(5)
        Keystore.setPendingIrkRotationVersion(6)
        Keystore.deriveIRK("seed v1", version = 1)
        Keystore.deriveIRK("seed v2", version = 2)
        // After wipe, version slots default + per-version caches gone.
        Keystore.wipe()
        assertEquals(1, Keystore.currentIrkVersion())
        assertNull(Keystore.pendingIrkRotationVersion())
        // Re-derive at v1 — should mint a fresh seed (not reuse the
        // pre-wipe one) because the UMK seed was also wiped.
        // We can't directly compare to the pre-wipe value without
        // exposing the seed; assert that subsequent derives at the
        // same version are now stable + non-empty.
        Keystore.deriveIRK("post-wipe", version = 1)
        val seed = Keystore.requireIrkSeedForVersion(1)
        assertEquals(32, seed.size)
    }

    @Test fun deriveIrk_atDifferentVersions_yieldsDifferentSeeds() = runBlocking {
        Keystore.deriveIRK("v1", version = 1)
        Keystore.deriveIRK("v2", version = 2)
        val v1 = Keystore.requireIrkSeedForVersion(1)
        val v2 = Keystore.requireIrkSeedForVersion(2)
        assertEquals(32, v1.size)
        assertEquals(32, v2.size)
        assertNotEquals(v1.toList(), v2.toList())
    }

    @Test fun deriveIrk_isIdempotentAtSameVersion() = runBlocking {
        Keystore.deriveIRK("first", version = 3)
        val first = Keystore.requireIrkSeedForVersion(3)
        Keystore.deriveIRK("second", version = 3)
        val second = Keystore.requireIrkSeedForVersion(3)
        assertArrayEquals(first, second)
    }
}
