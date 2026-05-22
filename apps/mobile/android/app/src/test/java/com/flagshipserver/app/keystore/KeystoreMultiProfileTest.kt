// W3 — pins the per-profile keying primitive on the Keystore. Multiple
// cloud PROFILES can live on one phone (personal / family / work); each
// must own its OWN device key. setActiveProfile(id) selects which
// profile's slot every per-profile method operates on; the DEFAULT
// (null/empty) profile reuses the historical un-suffixed slots so legacy
// single-profile installs are byte-for-byte unchanged (covered by the
// existing KeystoreWipeTest / KeystoreIrkVersionTest, which never call
// setActiveProfile). Robolectric runs SharedPreferences in-memory so we
// exercise the persistence path without an emulator.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class KeystoreMultiProfileTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        // A fresh prefs file per run; attachForTest re-hydrates the
        // active-profile pointer (absent ⇒ default), so each test starts
        // on the default/legacy profile.
        Keystore.attachForTest(ctx.getSharedPreferences("keystore-multi-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    // ── selection ───────────────────────────────────────────────────

    @Test fun defaultProfilePointer_isNull() {
        assertNull(Keystore.activeProfile())
    }

    @Test fun setActiveProfile_normalizesAndPersists() {
        Keystore.setActiveProfile("Alice")
        assertEquals("alice", Keystore.activeProfile())
        Keystore.setActiveProfile("  WORK  ")
        assertEquals("work", Keystore.activeProfile())
        // null / empty selects the default (legacy) profile.
        Keystore.setActiveProfile(null)
        assertNull(Keystore.activeProfile())
        Keystore.setActiveProfile("   ")
        assertNull(Keystore.activeProfile())
    }

    // ── distinct device keys per profile ─────────────────────────────

    @Test fun twoProfiles_haveDistinctUmkSeeds() {
        Keystore.setActiveProfile("alice")
        val aliceUmk = Keystore.loadOrCreateUmkSeed()

        Keystore.setActiveProfile("bob")
        val bobUmk = Keystore.loadOrCreateUmkSeed()

        assertEquals(32, aliceUmk.size)
        assertEquals(32, bobUmk.size)
        assertNotEquals(aliceUmk.toList(), bobUmk.toList())

        // Switching back yields the SAME (stable) seed — the slot wasn't
        // clobbered by creating B.
        Keystore.setActiveProfile("alice")
        assertArrayEquals(aliceUmk, Keystore.loadOrCreateUmkSeed())
    }

    @Test fun setActiveProfile_switchesIrkDerivation() = runBlocking {
        Keystore.setActiveProfile("alice")
        Keystore.deriveIRK("alice", version = 1)
        val aliceIrk = Keystore.requireIrkSeedForVersion(1)

        Keystore.setActiveProfile("bob")
        Keystore.deriveIRK("bob", version = 1)
        val bobIrk = Keystore.requireIrkSeedForVersion(1)

        assertNotEquals(aliceIrk.toList(), bobIrk.toList())

        // Re-select alice — derivation returns alice's seed, not bob's.
        Keystore.setActiveProfile("alice")
        assertArrayEquals(aliceIrk, Keystore.requireIrkSeedForVersion(1))
    }

    @Test fun installUmk_onProfileB_doesNotClobberProfileA() {
        Keystore.setActiveProfile("alice")
        val aliceUmk = Keystore.loadOrCreateUmkSeed()

        // B takes over with a known seed; A must survive untouched.
        Keystore.setActiveProfile("bob")
        val bobSeed = ByteArray(32) { 0x11 }
        Keystore.installUmk(bobSeed)
        assertArrayEquals(bobSeed, Keystore.loadOrCreateUmkSeed())

        Keystore.setActiveProfile("alice")
        assertArrayEquals(aliceUmk, Keystore.loadOrCreateUmkSeed())
    }

    // ── per-profile version slots ────────────────────────────────────

    @Test fun irkVersionSlots_areIndependentPerProfile() {
        Keystore.setActiveProfile("alice")
        Keystore.setCurrentIrkVersion(3)
        Keystore.setPendingIrkRotationVersion(4)

        Keystore.setActiveProfile("bob")
        // Bob is untouched ⇒ defaults.
        assertEquals(1, Keystore.currentIrkVersion())
        assertNull(Keystore.pendingIrkRotationVersion())
        Keystore.setCurrentIrkVersion(7)

        Keystore.setActiveProfile("alice")
        assertEquals(3, Keystore.currentIrkVersion())
        assertEquals(4, Keystore.pendingIrkRotationVersion())
    }

    @Test fun pushKeyAndToken_areIndependentPerProfile() {
        Keystore.setActiveProfile("alice")
        val alicePush = Keystore.loadOrCreatePushX25519()
        Keystore.setPushTokenId("alice-token")

        Keystore.setActiveProfile("bob")
        val bobPush = Keystore.loadOrCreatePushX25519()
        Keystore.setPushTokenId("bob-token")
        assertNotEquals(alicePush.privateKey.toList(), bobPush.privateKey.toList())

        Keystore.setActiveProfile("alice")
        assertArrayEquals(alicePush.privateKey, Keystore.loadOrCreatePushX25519().privateKey)
        assertEquals("alice-token", Keystore.pushTokenId())

        Keystore.setActiveProfile("bob")
        assertEquals("bob-token", Keystore.pushTokenId())
    }

    // ── wipe is per-profile; wipeAllProfiles is global ───────────────

    @Test fun wipe_clearsOnlyActiveProfile() {
        Keystore.setActiveProfile("alice")
        val aliceUmk = Keystore.loadOrCreateUmkSeed()
        Keystore.setPushTokenId("alice-token")

        Keystore.setActiveProfile("bob")
        val bobUmk = Keystore.loadOrCreateUmkSeed()
        Keystore.setPushTokenId("bob-token")

        // Wipe bob only.
        Keystore.wipe()
        assertNull(Keystore.pushTokenId())
        // Re-deriving bob mints a FRESH seed (the old one was wiped).
        assertNotEquals(bobUmk.toList(), Keystore.loadOrCreateUmkSeed().toList())

        // Alice survived the bob wipe.
        Keystore.setActiveProfile("alice")
        assertArrayEquals(aliceUmk, Keystore.loadOrCreateUmkSeed())
        assertEquals("alice-token", Keystore.pushTokenId())
    }

    @Test fun wipe_onDefaultProfile_leavesOtherProfilesIntact() {
        // Default (legacy) profile.
        Keystore.setActiveProfile(null)
        val defaultUmk = Keystore.loadOrCreateUmkSeed()

        Keystore.setActiveProfile("alice")
        val aliceUmk = Keystore.loadOrCreateUmkSeed()

        // Wipe the default slot only.
        Keystore.setActiveProfile(null)
        Keystore.wipe()
        assertNotEquals(defaultUmk.toList(), Keystore.loadOrCreateUmkSeed().toList())

        // Alice's suffixed slot is untouched.
        Keystore.setActiveProfile("alice")
        assertArrayEquals(aliceUmk, Keystore.loadOrCreateUmkSeed())
    }

    @Test fun wipeAllProfiles_clearsEveryProfileAndResetsToDefault() = runBlocking {
        Keystore.setActiveProfile(null)
        Keystore.loadOrCreateUmkSeed()
        Keystore.setPushTokenId("default-token")

        Keystore.setActiveProfile("alice")
        Keystore.loadOrCreateUmkSeed()
        Keystore.deriveIRK("alice", version = 1)
        Keystore.setCurrentIrkVersion(5)
        Keystore.setPushTokenId("alice-token")

        Keystore.setActiveProfile("bob")
        Keystore.loadOrCreateUmkSeed()
        Keystore.setPushTokenId("bob-token")

        Keystore.wipeAllProfiles()

        // The active pointer reset to default.
        assertNull(Keystore.activeProfile())
        // Every profile's per-profile state is gone — tokens null, IRK
        // version back to default, fresh UMK on re-derive.
        assertNull(Keystore.pushTokenId())

        Keystore.setActiveProfile("alice")
        assertNull(Keystore.pushTokenId())
        assertEquals(1, Keystore.currentIrkVersion())

        Keystore.setActiveProfile("bob")
        assertNull(Keystore.pushTokenId())
    }

    // ── default profile == legacy slots (backward-compat) ────────────

    @Test fun defaultProfile_reusesLegacyUnsuffixedSlots() {
        // Write under the default profile…
        Keystore.setActiveProfile(null)
        val seed = ByteArray(32) { 0x22 }
        Keystore.installUmk(seed)

        // …read it back through the RAW legacy key name. This is the
        // load-bearing backward-compat invariant: the default profile
        // does NOT suffix its keys.
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val raw = ctx.getSharedPreferences("keystore-multi-test", Context.MODE_PRIVATE)
        val legacyUmkHex = raw.getString("umk.seed", null)
        assertNotNull("default profile must write the un-suffixed umk.seed", legacyUmkHex)
        // And no suffixed alice slot leaked in.
        assertNull(raw.getString("umk.seed.alice", null))
    }
}
