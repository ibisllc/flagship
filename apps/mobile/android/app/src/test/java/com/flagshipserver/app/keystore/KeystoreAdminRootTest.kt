// Slice D — the ADMIN MASTER ROOT in the Keystore (docs/device-admin-tier-
// spec.md §1). A fresh random Ed25519 keypair minted at account creation, NOT
// UMK-derived, sealed device-local, escrowable under the recovery credential.
// Robolectric runs SharedPreferences in-memory so the persistence path runs
// without an emulator.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.AdminRootEscrow
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.SecureRandom

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class KeystoreAdminRootTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("keystore-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    @Test
    fun adminRoot_absentUntilGenerated_thenStable() {
        assertNull(Keystore.adminRootPubHex())
        assertNull(Keystore.adminRootSeed())
        assertFalse(Keystore.hasAdminRoot())

        val pub1 = Keystore.generateAdminRoot()
        assertNotNull(pub1)
        assertTrue(Keystore.hasAdminRoot())
        assertEquals(pub1, Keystore.adminRootPubHex())

        // Idempotent — a second generate never clobbers the existing root.
        val pub2 = Keystore.generateAdminRoot()
        assertEquals(pub1, pub2)
        assertEquals(pub1, Keystore.adminRootPubHex())
    }

    @Test
    fun adminRoot_seedIs32Bytes_andPubMatchesSeed() {
        val pub = Keystore.generateAdminRoot()
        val seed = Keystore.adminRootSeed()
        assertNotNull(seed)
        assertEquals(32, seed!!.size)
        // The published pub is exactly this seed's Ed25519 public half.
        val derivedPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        assertEquals(derivedPub, pub)
    }

    @Test
    fun adminRoot_isNotUmkDerived_differsFromIrk() = runBlocking {
        // The whole point of the split: the admin root is a fresh random key,
        // NOT a UMK derivation, so it must differ from the membership IRK.
        Keystore.loadOrCreateUmkSeed()
        val adminPub = Keystore.generateAdminRoot()
        // Derive the IRK pub via the versioned-seed path (OpenAccount's path).
        Keystore.deriveIRK("test")
        val irkSeed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
        val irkPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed).publicKey)
        assertNotEquals(irkPub, adminPub)
    }

    @Test
    fun adminRootKey_signsUnderThePublishedPub() = runBlocking {
        Keystore.generateAdminRoot()
        val pub = HexUtil.decode(Keystore.adminRootPubHex()!!)!!
        val msg = "flagship/test/admin-root".toByteArray()
        val sig = Keystore.adminRootKey("test").sign(msg)
        // Verifies under the admin-root pub (throws on mismatch).
        com.google.crypto.tink.subtle.Ed25519Verify(pub).verify(sig, msg)
    }

    @Test
    fun adminRootKey_errorsWhenAbsent() {
        assertThrows(IllegalStateException::class.java) {
            runBlocking { Keystore.adminRootKey("test") }
        }
    }

    @Test
    fun importAdminRoot_roundTrips() {
        val seed = ByteArray(32).also { SecureRandom().nextBytes(it) }
        Keystore.importAdminRoot(seed)
        assertTrue(Keystore.hasAdminRoot())
        assertArrayEquals(seed, Keystore.adminRootSeed())
        val expectedPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        assertEquals(expectedPub, Keystore.adminRootPubHex())
    }

    @Test
    fun importAdminRoot_rejectsWrongSize() {
        assertThrows(IllegalArgumentException::class.java) {
            Keystore.importAdminRoot(ByteArray(16))
        }
    }

    @Test
    fun wipe_clearsAdminRoot() {
        Keystore.generateAdminRoot()
        assertTrue(Keystore.hasAdminRoot())
        Keystore.wipe()
        assertFalse(Keystore.hasAdminRoot())
        assertNull(Keystore.adminRootPubHex())
        assertNull(Keystore.adminRootSeed())
    }

    @Test
    fun escrow_wrapUnwrapRoundTrips_andRejectsWrongSecret() {
        val seed = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val prf = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val wrapped = AdminRootEscrow.wrapForEscrow(seed, prf)
        assertArrayEquals(seed, AdminRootEscrow.unwrapFromEscrow(wrapped, prf))

        val wrongPrf = ByteArray(32).also { SecureRandom().nextBytes(it) }
        assertThrows(Exception::class.java) {
            AdminRootEscrow.unwrapFromEscrow(wrapped, wrongPrf)
        }
    }
}
