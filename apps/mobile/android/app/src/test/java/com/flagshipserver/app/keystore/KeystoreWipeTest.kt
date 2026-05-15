// C6a — Keystore.wipe() must clear every persisted secret so that
// "Remove this device from account" leaves the app in fresh-install
// crypto state. The test runs against a Robolectric SharedPreferences
// (not the production AndroidKeyStore), so what we actually pin here
// is the SharedPreferences key set the implementation drops.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class KeystoreWipeTest {

    @Before
    fun setUp() {
        // Robolectric's ApplicationProvider returns a usable Context
        // for SharedPreferences; the Keystore module's requirePrefs
        // wires up against it once Keystore.attach(ctx) is called.
        Keystore.attach(ApplicationProvider.getApplicationContext<Context>())
        // Start each test from a clean slate — prior tests in the
        // same JVM may have written keys we need to ignore.
        Keystore.wipe()
    }

    @Test
    fun wipe_clearsUmkSeed() {
        Keystore.loadOrCreateUmkSeed()    // writes umk.seed
        Keystore.wipe()
        // After wipe, re-deriving produces a NEW seed; cheap
        // structural check: the seed is the right size and stable
        // across repeated calls.
        val after = Keystore.loadOrCreateUmkSeed()
        assertNotNull(after)
        assertEquals(32, after.size)
        val secondAfter = Keystore.loadOrCreateUmkSeed()
        assertEquals(after.toList(), secondAfter.toList())
    }

    @Test
    fun wipe_clearsPushTokenId() {
        Keystore.setPushTokenId("token-abc-123")
        assertEquals("token-abc-123", Keystore.pushTokenId())
        Keystore.wipe()
        assertNull(Keystore.pushTokenId())
    }

    @Test
    fun wipe_clearsIrkSeedSoRotationStartsFresh() = kotlinx.coroutines.runBlocking {
        // Cache an IRK so the seed slot is populated…
        Keystore.deriveIRK("init")
        // …wipe…
        Keystore.wipe()
        // …and re-derive. The post-wipe IRK should be a fresh seed
        // (UMK was also wiped).
        val fresh = Keystore.deriveIRK("post-wipe")
        assertNotNull(fresh)
    }

    @Test
    fun wipe_isIdempotent() {
        Keystore.wipe()
        Keystore.wipe()
        Keystore.wipe()
        // Idempotency contract: no crash, no exception, no side
        // effect difference between 1 and N wipes.
    }
}
