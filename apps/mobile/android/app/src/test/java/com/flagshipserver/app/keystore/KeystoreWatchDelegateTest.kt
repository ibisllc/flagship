// Phase Android-B — the watch-delegate key in the Keystore. A per-device
// Ed25519 key minted WITHOUT the biometric gate (unlike deriveIRK) so a
// later watch-driven boot approval is silent. Robolectric runs
// SharedPreferences in-memory so we exercise the persistence path.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class KeystoreWatchDelegateTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("keystore-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    @Test
    fun delegateKey_absentUntilCreated_thenStable() {
        assertNull(Keystore.watchDelegatePubHex())
        assertFalse(Keystore.hasWatchDelegateKey())
        Keystore.loadOrCreateWatchDelegateKey()
        assertTrue(Keystore.hasWatchDelegateKey())
        val pub1 = Keystore.watchDelegatePubHex()
        assertNotNull(pub1)
        // Re-load returns the SAME key (persisted, not a fresh random).
        Keystore.loadOrCreateWatchDelegateKey()
        assertEquals(pub1, Keystore.watchDelegatePubHex())
    }

    @Test
    fun grantId_roundTrips() {
        assertNull(Keystore.watchDelegateGrantId())
        Keystore.setWatchDelegateGrantId("grant-xyz")
        assertEquals("grant-xyz", Keystore.watchDelegateGrantId())
        Keystore.setWatchDelegateGrantId(null)
        assertNull(Keystore.watchDelegateGrantId())
    }

    @Test
    fun clearWatchDelegate_removesKeyAndGrantId() {
        Keystore.loadOrCreateWatchDelegateKey()
        Keystore.setWatchDelegateGrantId("grant-xyz")
        Keystore.clearWatchDelegate()
        assertNull(Keystore.watchDelegatePubHex())
        assertNull(Keystore.watchDelegateGrantId())
        assertFalse(Keystore.hasWatchDelegateKey())
    }

    @Test
    fun wipe_clearsWatchDelegate() {
        Keystore.loadOrCreateWatchDelegateKey()
        Keystore.setWatchDelegateGrantId("grant-xyz")
        Keystore.wipe()
        assertNull(Keystore.watchDelegatePubHex())
        assertNull(Keystore.watchDelegateGrantId())
    }
}
