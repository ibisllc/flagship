// docs/account-key-rotation.md on the phone's key store: a new account key retires the old one with the same
// custody, the IRK starts again in the rotator's scheme, a staged hop survives until it is promoted or dropped,
// the receive key is sealed like the account key, and a removed device keeps none of it.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.AccountKeyRotation
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.pq.PqHybrid
import org.junit.After
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
@Config(sdk = [34])
class KeystoreAccountKeyRotationTest {
    private lateinit var prefs: android.content.SharedPreferences

    @Before fun setUp() {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        FSStrings.init(ctx)
        prefs = ctx.getSharedPreferences("akr-keystore", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        Keystore.attachForTest(prefs)
        PqSessionKek.openForTest(ByteArray(32) { 9 })
        Keystore.setActiveProfile("plucky-avocet")
    }

    @After fun tearDown() {
        PqSessionKek.openForTest(null)
        Keystore.setActiveProfile(null)
    }

    @Test fun aNewAccountKeyRetiresTheOldOneAndRestartsTheIrkInTheRotatorsScheme() {
        val old = Keystore.loadOrCreateUmkSeed().copyOf()
        Keystore.setCurrentIrkVersion(3)
        val new = ByteArray(32) { 5 }
        Keystore.installRotatedUmk(new, IrkLineage.Scheme.WEB, toEpoch = 1)
        assertArrayEquals(new, Keystore.currentUmkSeed())
        assertEquals(1, Keystore.currentIrkVersion())
        assertEquals(1L, Keystore.accountKeyEpoch())
        assertEquals(listOf(0L), Keystore.retiredUmkEpochs())
        assertArrayEquals(old, Keystore.retiredUmkSeed(0))
        // Retired with the same custody: sealed under the session key, never in the old plain storage.
        assertTrue(prefs.all.keys.any { it.startsWith(SeedVault.SEALED_PREFIX + "umk.retired.e0") })
        assertFalse(prefs.all.keys.any { it.startsWith("umk.retired.e0") })
        // The IRK is the webapp's derivation of the new key, version 1.
        val webIrk = HexUtil.encode(PqHybrid.ed25519PublicKey(AccountKeyRotation.irkSeed(new, AccountKeyRotation.IrkScheme.WEB)))
        assertEquals(webIrk, Keystore.irkPubHexIfKnown())
    }

    @Test fun aStagedHopStaysUntilItIsCleared() {
        Keystore.loadOrCreateUmkSeed()
        val umk = ByteArray(32) { 6 }
        val root = ByteArray(32) { 7 }
        Keystore.stagePendingRotation(umk, root, """{"rotation":{}}""")
        assertEquals("""{"rotation":{}}""", Keystore.pendingRotationBody())
        assertArrayEquals(umk, Keystore.pendingRotationUmk())
        assertArrayEquals(root, Keystore.pendingRotationAdminRoot())
        PqSessionKek.openForTest(null)
        assertNotNull("the body needs no unlock", Keystore.pendingRotationBody())
        PqSessionKek.openForTest(ByteArray(32) { 9 })
        Keystore.clearPendingRotation()
        assertNull(Keystore.pendingRotationBody())
        assertNull(Keystore.pendingRotationUmk())
    }

    @Test fun theReceiveKeyIsMadeOnlyWhileTheSessionIsOpen() {
        Keystore.loadOrCreateUmkSeed()
        PqSessionKek.openForTest(null)
        assertNull(Keystore.ensureReceiveKey())
        PqSessionKek.openForTest(ByteArray(32) { 9 })
        val pub = Keystore.ensureReceiveKey()!!
        assertEquals(pub, Keystore.ensureReceiveKey())
        val seed = Keystore.receiveKeySeed()!!
        assertEquals(pub, HexUtil.encode(PqHybrid.hybridSealKeygen(seed).publicKey))
        assertTrue(prefs.all.keys.any { it.startsWith(SeedVault.SEALED_PREFIX + SeedVault.RECEIVE_KEY) })
    }

    @Test fun aNewDeviceKeyIsRandomAndTheSameOnARetry() {
        Keystore.loadOrCreateUmkSeed()
        val id = "a".repeat(32)
        val k1 = Keystore.loadOrCreateAccountDeviceSeed(id)
        assertArrayEquals(k1, Keystore.loadOrCreateAccountDeviceSeed(id))
        val umk = Keystore.currentUmkSeed()
        val pub = HexUtil.encode(PqHybrid.ed25519PublicKey(k1))
        assertFalse(AccountKeyRotation.deviceKeyIsUmkDerived(umk, "plucky-avocet", id, pub))
        assertEquals(pub, Keystore.sessionAccountDeviceKey("plucky-avocet", id)!!.pubHex)
    }

    @Test fun wipeDropsEveryRotationSlot() {
        Keystore.loadOrCreateUmkSeed()
        Keystore.ensureReceiveKey()
        Keystore.installRotatedUmk(ByteArray(32) { 5 }, IrkLineage.Scheme.ANDROID, toEpoch = 1)
        Keystore.stagePendingRotation(ByteArray(32) { 6 }, null, "{}")
        Keystore.setAdminRootPin("ab".repeat(32))
        Keystore.wipe()
        assertTrue(prefs.all.keys.none { it.contains("retired") || it.contains("pending") || it.contains("receive") || it.contains("account.key") || it.contains("admin.root.pin") })
        assertEquals(0L, Keystore.accountKeyEpoch())
    }
}
