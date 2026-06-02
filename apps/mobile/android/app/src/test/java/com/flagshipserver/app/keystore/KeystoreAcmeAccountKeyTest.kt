// #28 — the exportable ACME account-key scalar in the Keystore. Stored as a
// raw 32-byte scalar in EncryptedSharedPreferences (NOT AndroidKeyStore — it
// must be exportable for escrow) and read without a biometric prompt, like
// the push + watch-delegate keys. Robolectric runs SharedPreferences
// in-memory so we exercise the persistence path. Mirrors
// KeystoreWatchDelegateTest.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.AcmeAccountKey
import org.junit.Assert.assertArrayEquals
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
class KeystoreAcmeAccountKeyTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("keystore-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    @Test
    fun acmeKey_absentUntilCreated_thenStable() {
        assertFalse(Keystore.hasAcmeAccountKey())
        assertNull(Keystore.acmeAccountKeyScalar())

        val first = Keystore.loadOrCreateAcmeAccountKeyScalar()
        assertEquals(32, first.size)
        assertTrue(Keystore.hasAcmeAccountKey())
        assertNotNull(Keystore.acmeAccountKeyScalar())

        // Re-load returns the SAME persisted scalar, not a fresh random one.
        val again = Keystore.loadOrCreateAcmeAccountKeyScalar()
        assertArrayEquals(first, again)
        assertArrayEquals(first, Keystore.acmeAccountKeyScalar())
    }

    @Test
    fun importAcmeKey_roundTrips_andIsExportable() {
        // A recovered scalar (e.g. unwrapped from the recovery envelope).
        val recovered = AcmeAccountKey.generateScalar()
        Keystore.importAcmeAccountKeyScalar(recovered)
        assertTrue(Keystore.hasAcmeAccountKey())
        assertArrayEquals(recovered, Keystore.acmeAccountKeyScalar())
        // Imported value overrides any prior key; loadOrCreate returns it.
        assertArrayEquals(recovered, Keystore.loadOrCreateAcmeAccountKeyScalar())
    }

    @Test
    fun importAcmeKey_rejectsWrongLength() {
        try {
            Keystore.importAcmeAccountKeyScalar(ByteArray(16))
            org.junit.Assert.fail("expected a 32-byte requirement")
        } catch (_: IllegalArgumentException) { /* ok */ }
    }

    @Test
    fun clearAcmeKey_removesIt() {
        Keystore.loadOrCreateAcmeAccountKeyScalar()
        Keystore.clearAcmeAccountKey()
        assertFalse(Keystore.hasAcmeAccountKey())
        assertNull(Keystore.acmeAccountKeyScalar())
    }

    @Test
    fun wipe_clearsAcmeKey() {
        Keystore.loadOrCreateAcmeAccountKeyScalar()
        assertTrue(Keystore.hasAcmeAccountKey())
        Keystore.wipe()
        assertFalse(Keystore.hasAcmeAccountKey())
        assertNull(Keystore.acmeAccountKeyScalar())
    }

    @Test
    fun acmeKey_isProfileScoped() {
        // Default profile gets one key…
        Keystore.setActiveProfile(null)
        val defaultKey = Keystore.loadOrCreateAcmeAccountKeyScalar()

        // …a second profile gets its OWN independent key.
        Keystore.setActiveProfile("family")
        assertFalse(Keystore.hasAcmeAccountKey())
        val familyKey = Keystore.loadOrCreateAcmeAccountKeyScalar()
        assertEquals(32, familyKey.size)
        assertFalse(familyKey.contentEquals(defaultKey))

        // Switching back surfaces the original, untouched.
        Keystore.setActiveProfile(null)
        assertArrayEquals(defaultKey, Keystore.acmeAccountKeyScalar())
    }

    @Test
    fun wipeAllProfiles_clearsEveryProfilesAcmeKey() {
        Keystore.setActiveProfile(null)
        Keystore.loadOrCreateAcmeAccountKeyScalar()
        Keystore.setActiveProfile("family")
        Keystore.loadOrCreateAcmeAccountKeyScalar()

        Keystore.wipeAllProfiles()

        // Active profile resets to default; both slots are gone.
        assertFalse(Keystore.hasAcmeAccountKey())
        Keystore.setActiveProfile("family")
        assertFalse(Keystore.hasAcmeAccountKey())
    }
}
