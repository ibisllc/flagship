// The owner's "Make leader" choice survives a cold launch, per account
// (docs/app-placement.md §1). Mirror of FlagshipSharedTests/LeaderMemoryTests.swift.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class LeaderMemoryTest {
    private lateinit var prefs: SharedPreferences

    private val fqdnA = "home.alice.flagship.services"
    private val fqdnB = "work.alice.flagship.services"
    private val idA get() = PodInfo.podId(fqdnA)
    private val idB get() = PodInfo.podId(fqdnB)

    @Before fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        prefs = ctx.getSharedPreferences("test.leader.${System.nanoTime()}", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
    }

    private fun memory() = PrefsLeaderMemory(prefs)

    /** A fresh launch: a new AppState over the same on-device store, the
     *  session restored, then `/pods` reconciled oldest-first. */
    private fun launch(user: String = "alice", revokedB: Boolean = false, includeB: Boolean = true): AppState {
        val s = AppState()
        s.leaderMemory = memory()
        s.restorePersistedSession(user)
        s.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        if (includeB) {
            s.upsertRegisteredPod(
                fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE,
                revokedAt = if (revokedB) 1_700_000_000_000 else null,
                revocationReason = if (revokedB) "lost" else null,
            )
        }
        return s
    }

    @Test fun setLeader_persistsTheChoice() {
        val s = launch()
        assertEquals("Without a remembered choice the oldest server leads.", idA, s.leaderPodId.value)
        s.setLeader(idB)
        assertEquals(idB, memory().leaderPodId("alice"))
    }

    @Test fun relaunch_restoresTheLeaderAndMakesItCurrent() {
        launch().setLeader(idB)
        val s = launch()
        assertEquals(idB, s.leaderPodId.value)
        assertEquals(idB, s.currentPodId.value)
        assertEquals("New apps go to the restored leader, not the oldest server.", idB, s.currentPod?.podId)
    }

    @Test fun relaunch_restoresWhicheverOrderThePodsArriveIn() {
        launch().setLeader(idB)
        val s = AppState()
        s.leaderMemory = memory()
        s.restorePersistedSession("alice")
        s.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        assertEquals(idB, s.leaderPodId.value)
        assertEquals(idB, s.currentPodId.value)
    }

    @Test fun relaunch_ignoresARememberedLeaderThatIsGone() {
        launch().setLeader(idB)
        val s = launch(includeB = false)
        assertEquals(idA, s.leaderPodId.value)
        assertEquals(idA, s.currentPodId.value)
    }

    @Test fun relaunch_ignoresARememberedLeaderThatIsRevoked() {
        launch().setLeader(idB)
        val s = launch(revokedB = true)
        assertEquals(idA, s.leaderPodId.value)
        assertEquals(idA, s.currentPodId.value)
    }

    @Test fun restore_keepsAnExplicitCurrentPick() {
        launch().setLeader(idB)
        val third = "third.alice.flagship.services"
        val s = AppState()
        s.leaderMemory = memory()
        s.restorePersistedSession("alice")
        s.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = third, name = "third", liveness = PodInfo.Liveness.LIVE)
        s.setCurrentPod(PodInfo.podId(third))
        s.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        assertEquals(idB, s.leaderPodId.value)
        assertEquals(PodInfo.podId(third), s.currentPodId.value)
    }

    @Test fun signOut_forgetsTheChoice() {
        val s = launch()
        s.setLeader(idB)
        s.signOut()
        assertNull(memory().leaderPodId("alice"))
        assertEquals(idA, launch().leaderPodId.value)
    }

    @Test fun removingTheRememberedLeader_forgetsIt() {
        val s = launch()
        s.setLeader(idB)
        s.removePod(idB)
        assertNull(memory().leaderPodId("alice"))
        assertEquals(idA, s.leaderPodId.value)
    }

    @Test fun theChoiceIsPerAccount() {
        launch("alice").setLeader(idB)
        val bob = AppState()
        bob.leaderMemory = memory()
        bob.restorePersistedSession("bob")
        bob.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        bob.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        assertEquals("Another account on this device doesn't inherit alice's leader.", idA, bob.leaderPodId.value)
        bob.signOut()
        assertEquals("Signing bob out leaves alice's choice alone.", idB, launch("alice").leaderPodId.value)
    }

    @Test fun switchingProfiles_restoresEachAccountsOwnLeader() {
        val bobA = "home.bob.flagship.services"
        val bobB = "work.bob.flagship.services"
        val s = AppState()
        s.leaderMemory = memory()
        s.addProfile(Profile(cloudName = "alice"))
        s.addProfile(Profile(cloudName = "bob"))
        s.upsertRegisteredPod(fqdn = bobA, name = "home", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = bobB, name = "work", liveness = PodInfo.Liveness.LIVE)
        assertEquals(PodInfo.podId(bobA), s.leaderPodId.value)
        s.setActiveProfile("alice")
        s.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        s.setLeader(idB)
        s.setActiveProfile("bob")
        s.upsertRegisteredPod(fqdn = bobA, name = "home", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = bobB, name = "work", liveness = PodInfo.Liveness.LIVE)
        assertEquals(PodInfo.podId(bobA), s.leaderPodId.value)
        s.setActiveProfile("alice")
        s.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        assertEquals(idB, s.leaderPodId.value)
    }

    @Test fun noMemory_keepsTodaysOldestFallback() {
        val s = AppState()
        s.restorePersistedSession("alice")
        s.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        s.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        s.setLeader(idB)
        val next = AppState()
        next.restorePersistedSession("alice")
        next.upsertRegisteredPod(fqdn = fqdnA, name = "home", liveness = PodInfo.Liveness.LIVE)
        next.upsertRegisteredPod(fqdn = fqdnB, name = "work", liveness = PodInfo.Liveness.LIVE)
        assertEquals(idA, next.leaderPodId.value)
    }
}
