// The account seed's move from the old storage (EncryptedSharedPreferences, no user authentication)
// to the session key the unlock prompt opens (SeedVault). Never lose the seed: every step leaves a
// readable copy; a sealed seed is never read, minted over or deleted while the session is locked.

package com.flagshipserver.app.keystore

import android.content.SharedPreferences
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SeedVaultMigrationTest {
    /** In-memory SharedPreferences; [failCommits] makes every commit fail, [corruptSealed] changes
     *  each sealed value as it is stored (a write that doesn't read back). */
    private class FakePrefs : SharedPreferences {
        val m = LinkedHashMap<String, Any?>()
        var failCommits = false
        var corruptSealed = false

        override fun getAll(): MutableMap<String, *> = LinkedHashMap(m)
        override fun getString(key: String, defValue: String?) = (m[key] as? String) ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?) = defValues
        override fun getInt(key: String, defValue: Int) = defValue
        override fun getLong(key: String, defValue: Long) = defValue
        override fun getFloat(key: String, defValue: Float) = defValue
        override fun getBoolean(key: String, defValue: Boolean) = (m[key] as? Boolean) ?: defValue
        override fun contains(key: String) = m.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun edit(): SharedPreferences.Editor = E()

        inner class E : SharedPreferences.Editor {
            private val puts = LinkedHashMap<String, Any?>()
            private val removes = HashSet<String>()
            private var clear = false
            override fun putString(key: String, value: String?) = apply { puts[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { puts[key] = values }
            override fun putInt(key: String, value: Int) = apply { puts[key] = value }
            override fun putLong(key: String, value: Long) = apply { puts[key] = value }
            override fun putFloat(key: String, value: Float) = apply { puts[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { puts[key] = value }
            override fun remove(key: String) = apply { removes += key }
            override fun clear() = apply { clear = true }
            override fun commit(): Boolean {
                if (failCommits) return false
                if (clear) m.clear()
                removes.forEach { m.remove(it) }
                for ((k, v) in puts) {
                    m[k] = if (corruptSealed && k.startsWith(SeedVault.SEALED_PREFIX) && v is String) v.dropLast(2) + "00" else v
                }
                return true
            }
            override fun apply() { commit() }
        }
    }

    private val kek = ByteArray(32) { (it + 1).toByte() }
    private val otherKek = ByteArray(32) { 0x55 }
    private val umk = ByteArray(32) { 0x11 }
    private val root = ByteArray(32) { 0x22 }
    private lateinit var prefs: FakePrefs

    @Before fun setUp() {
        prefs = FakePrefs()
        BiometricAuthority.set(null)
        PqSessionKek.clear()
        SeedVault.markLost(false)
        Keystore.attachForTest(prefs)
        Keystore.setActiveProfileInMemory(null)
    }

    @After fun tearDown() {
        PqSessionKek.clear()
        SeedVault.markLost(false)
    }

    private fun legacy(slot: String, v: ByteArray) { prefs.m[slot] = HexUtil.encode(v) }

    /** What an unlock does: the prompt's cipher opens the KEK, then the seeds move under it. */
    private fun unlock(k: ByteArray = kek) {
        PqSessionKek.openForTest(k)
        Keystore.sessionKekOpened(k)
    }

    private fun lock() = PqSessionKek.clear()

    // ---- The state machine on its own -----------------------------------

    @Test fun legacyOnly_movesUnderTheKek_andTheOldCopyGoes() {
        legacy("umk.seed", umk)
        val steps = SeedVault.migrate(prefs, kek)
        assertEquals(mapOf("umk.seed" to SeedVault.Step.MOVED), steps)
        assertNull("old copy deleted", prefs.m["umk.seed"])
        assertNotNull(prefs.m["sealed.umk.seed"])
        assertArrayEquals(umk, (SeedVault.read(prefs, "umk.seed", kek) as SeedVault.Read.Opened).bytes)
        assertEquals(SeedVault.Read.Locked, SeedVault.read(prefs, "umk.seed", null))
    }

    @Test fun interruptedAfterSealing_theOldCopyStillWins_andTheNextUnlockFinishes() {
        legacy("umk.seed", umk)
        // A crash after the sealed copy was committed, before the old one was deleted.
        prefs.m["sealed.umk.seed"] = HexUtil.encode(SeedVault.seal(umk, "umk.seed", kek))
        assertArrayEquals(umk, (SeedVault.read(prefs, "umk.seed", null) as SeedVault.Read.Legacy).bytes)
        assertEquals(SeedVault.Step.MOVED, SeedVault.migrate(prefs, kek)["umk.seed"])
        assertNull(prefs.m["umk.seed"])
    }

    @Test fun sealedCopyThatDoesNotReadBack_isDropped_andTheOldCopyKept() {
        legacy("umk.seed", umk)
        prefs.corruptSealed = true
        assertEquals(SeedVault.Step.VERIFY_FAILED, SeedVault.migrate(prefs, kek)["umk.seed"])
        assertEquals(HexUtil.encode(umk), prefs.m["umk.seed"])
        assertNull(prefs.m["sealed.umk.seed"])
    }

    @Test fun sealedCopyThatCannotBeWritten_keepsTheOldCopy() {
        legacy("umk.seed", umk)
        prefs.failCommits = true
        assertEquals(SeedVault.Step.WRITE_FAILED, SeedVault.migrate(prefs, kek)["umk.seed"])
        assertEquals(HexUtil.encode(umk), prefs.m["umk.seed"])
    }

    @Test fun everyProfile_andTheAdminRoot_move() {
        legacy("umk.seed", umk)
        legacy("umk.seed.family", ByteArray(32) { 3 })
        legacy("admin.root.seed.family", root)
        legacy("push.x25519.priv", ByteArray(32) { 4 })
        val steps = SeedVault.migrate(prefs, kek)
        assertEquals(setOf("umk.seed", "umk.seed.family", "admin.root.seed.family"), steps.keys)
        assertTrue(steps.values.all { it == SeedVault.Step.MOVED })
        assertNotNull("device-local keys stay where iOS keeps them", prefs.m["push.x25519.priv"])
    }

    @Test fun recordsAreBoundToTheirSlot() {
        legacy("umk.seed", umk)
        legacy("admin.root.seed", root)
        SeedVault.migrate(prefs, kek)
        val a = prefs.m["sealed.umk.seed"]
        prefs.m["sealed.umk.seed"] = prefs.m["sealed.admin.root.seed"]
        prefs.m["sealed.admin.root.seed"] = a
        assertEquals(SeedVault.Read.Unreadable, SeedVault.read(prefs, "umk.seed", kek))
    }

    @Test fun oldIrkSeedCaches_goOnlyForAProfileWhoseUmkIsHeld() {
        legacy("umk.seed", umk)
        prefs.m["irk.seed.v1"] = "aa"
        prefs.m["irk.seed"] = "aa"
        prefs.m["irk.seed.orphan.v2"] = "bb"
        SeedVault.migrate(prefs, kek)
        assertNull(prefs.m["irk.seed.v1"])
        assertNull(prefs.m["irk.seed"])
        assertEquals("bb", prefs.m["irk.seed.orphan.v2"])
    }

    // ---- Through the Keystore ---------------------------------------------

    @Test fun upgradedInstall_firstUnlockMovesTheSeed_lockedReadsThrowAndNeverMint() {
        legacy("umk.seed", umk)
        legacy("admin.root.seed", root)
        // Before the first unlock after the update: the old storage still answers.
        assertArrayEquals(umk, Keystore.currentUmkSeed())

        unlock()
        assertTrue(Keystore.seedsAreSealed())
        assertNull(prefs.m["umk.seed"])
        assertNull(prefs.m["admin.root.seed"])
        assertArrayEquals(umk, Keystore.currentUmkSeed())
        assertArrayEquals(root, Keystore.adminRootSeed())
        val rootPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(root).publicKey)

        lock()
        val before = prefs.m["sealed.umk.seed"]
        assertThrows(SessionLockedException::class.java) { Keystore.loadOrCreateUmkSeed() }
        assertThrows(SessionLockedException::class.java) { Keystore.adminRootSeed() }
        assertEquals("a locked seed is never minted over", before, prefs.m["sealed.umk.seed"])
        // What needs no secret still works while locked.
        assertTrue(Keystore.hasUmkSeed())
        assertTrue(Keystore.hasAdminRoot())
        assertEquals("public half recorded at migration", rootPub, Keystore.adminRootPubHex())

        unlock()
        assertArrayEquals("the same seed at the next unlock", umk, Keystore.currentUmkSeed())
    }

    @Test fun lockedBackgroundDerive_throws_andTheIrkPubStaysReadable() = runBlocking {
        legacy("umk.seed", umk)
        unlock()
        val pub = Keystore.irkPubHex()
        lock()
        assertThrows(SessionLockedException::class.java) { runBlocking { Keystore.deriveIRK("background") } }
        assertThrows(SessionLockedException::class.java) { Keystore.requireIrkSeedForVersion(1) }
        assertEquals(pub, Keystore.irkPubHex())
        unlock()
        val seed = Keystore.requireIrkSeedForVersion(1)
        assertEquals(pub, HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey))
        assertFalse("no IRK seed on disk", prefs.m.keys.any { it.startsWith("irk.seed") })
    }

    @Test fun newAccountWithTheSessionOpen_isSealedFromBirth() {
        unlock()
        val seed = Keystore.loadOrCreateUmkSeed()
        val pub = Keystore.generateAdminRoot()
        assertNull(prefs.m["umk.seed"])
        assertNull(prefs.m["admin.root.seed"])
        assertTrue(Keystore.seedsAreSealed())
        lock()
        assertEquals(pub, Keystore.adminRootPubHex())
        unlock()
        assertArrayEquals(seed, Keystore.loadOrCreateUmkSeed())
    }

    @Test fun phoneWithoutAScreenLock_keepsTheOldStorage() {
        // The session key can't be made without a secure lock screen, so it never opens.
        val seed = Keystore.loadOrCreateUmkSeed()
        Keystore.generateAdminRoot()
        assertEquals(HexUtil.encode(seed), prefs.m["umk.seed"])
        assertFalse(Keystore.seedsAreSealed())
        assertArrayEquals(seed, Keystore.currentUmkSeed())
        assertNotNull(Keystore.adminRootSeed())
    }

    @Test fun installWhileLocked_goesToTheOldStorage_andMovesAtTheNextUnlock() {
        legacy("umk.seed", umk)
        unlock(); lock()
        val recovered = ByteArray(32) { 0x77 }
        Keystore.installUmk(recovered)
        assertNull("the stale sealed copy is dropped", prefs.m["sealed.umk.seed"])
        assertArrayEquals(recovered, Keystore.currentUmkSeed())
        unlock()
        assertTrue(Keystore.seedsAreSealed())
        assertArrayEquals(recovered, Keystore.currentUmkSeed())
    }

    @Test fun screenLockRemoved_theSeedIsReportedLost_keptUntilThePersonChooses() {
        legacy("umk.seed", umk)
        legacy("admin.root.seed", root)
        unlock(); lock()
        // The Keystore key was invalidated: the next unlock opens a NEW session key.
        unlock(otherKek)
        assertTrue(SeedVault.lost.value)
        assertThrows(AccountKeyUnreadableException::class.java) { Keystore.currentUmkSeed() }
        assertNotNull("nothing deleted on its own", prefs.m["sealed.umk.seed"])
        assertTrue(Keystore.hasUmkSeed())

        assertTrue(Keystore.forgetUnreadableSeeds())
        assertFalse(SeedVault.lost.value)
        assertFalse(Keystore.hasUmkSeed())
        assertFalse(Keystore.hasAdminRoot())
        assertNull(prefs.m["admin.root.pub"])
    }

    @Test fun wipe_removesSealedAndOldCopies() {
        legacy("umk.seed", umk)
        unlock()
        Keystore.generateAdminRoot()
        Keystore.wipe()
        assertFalse(prefs.m.keys.any { it.contains("umk.seed") || it.contains("admin.root") })
    }
}
