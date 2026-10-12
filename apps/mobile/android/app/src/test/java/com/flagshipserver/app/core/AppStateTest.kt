// Mirror of FlagshipMobileTests/AppStateTests.swift. Same invariants,
// Kotlin StateFlow surface.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStateTest {

    private fun pod(id: String, name: String = id.replaceFirstChar { it.uppercase() }): PodInfo =
        PodInfo(podId = id, name = name, fqdn = "$id.u.flagship.services")

    @Test fun completeOnboarding_setsLeaderAndCurrentToFirstPod() {
        val s = AppState()
        s.completeOnboarding("harry", listOf(pod("a"), pod("b")))
        assertTrue(s.isPaired.value)
        assertEquals("harry", s.currentUser.value)
        assertEquals("a", s.leaderPodId.value)
        assertEquals("a", s.currentPodId.value)
    }

    @Test fun restorePersistedSession_pairsWithUsernameAndNoPods() {
        // Cold-launch restore: the Keystore still holds an identity, so
        // the shell rebinds instead of forcing a fresh sign-in. Pods are
        // empty — the tabs refetch them.
        val s = AppState()
        assertFalse(s.isPaired.value)
        s.restorePersistedSession("harry")
        assertTrue(s.isPaired.value)
        assertEquals("harry", s.currentUser.value)
        assertEquals("harry", s.activeCloudName.value)
        assertTrue(s.pods.value.isEmpty())
    }

    @Test fun restorePersistedSession_isNoOpWhenAlreadyPaired() {
        // A live pairing / smoke mode must win over a stale restore.
        val s = AppState()
        s.completeOnboarding("alice", listOf(pod("p")))
        s.restorePersistedSession("mallory")
        assertEquals("alice", s.currentUser.value)
        assertEquals("p", s.leaderPodId.value)
    }

    @Test fun addPod_setsLeaderWhenNonePresent() {
        val s = AppState()
        s.completeOnboarding("u", emptyList())
        assertNull(s.leaderPodId.value)
        s.addPod(pod("first"))
        assertEquals("first", s.leaderPodId.value)
        assertEquals("first", s.currentPodId.value)
    }

    @Test fun setLeader_alsoMovesCurrent() {
        // docs/app-placement.md §1: new apps follow the current server, so
        // making a server leader makes it current too.
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("a"), pod("b")),
            leaderPodId = "a", currentPodId = "a")
        s.setLeader("b")
        assertEquals("b", s.leaderPodId.value)
        assertEquals("b", s.currentPodId.value)
        assertEquals("b", s.currentPod?.podId)
    }

    @Test fun setLeader_unknownPodChangesNothing() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("a")), leaderPodId = "a", currentPodId = "a")
        s.setLeader("ghost")
        assertEquals("a", s.leaderPodId.value)
        assertEquals("a", s.currentPodId.value)
    }

    private fun online(id: String) = pod(id).copy(status = PodInfo.Status.ONLINE)

    @Test fun currentPod_prefersAnOnlineLeaderWithASession() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(online("a"), online("b")),
            leaderPodId = "b", currentPodId = "a")
        assertEquals("b", s.currentPod?.podId)
    }

    @Test fun currentPod_keepsTheSelectionWhenTheLeaderHasNoSession() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(online("a"), online("b")),
            leaderPodId = "b", currentPodId = "a")
        s.hasSession = { it != "b" }
        assertEquals("a", s.currentPod?.podId)
    }

    @Test fun currentPod_keepsTheSelectionWhenTheLeaderIsOffline() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(online("a"), pod("b").copy(status = PodInfo.Status.OFFLINE)),
            leaderPodId = "b", currentPodId = "a")
        assertEquals("a", s.currentPod?.podId)
        assertEquals("a", s.sessionPod?.podId)
    }

    @Test fun setCurrentPod_rejectsUnknown() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("a")), leaderPodId = "a", currentPodId = "a")
        s.setCurrentPod("nope")
        assertEquals("a", s.currentPodId.value)
    }

    @Test fun removePod_reassignsLeaderAndCurrent() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("a"), pod("b")),
            leaderPodId = "a", currentPodId = "a")
        s.removePod("a")
        assertEquals("b", s.leaderPodId.value)
        assertEquals("b", s.currentPodId.value)
    }

    @Test fun signOut_clearsEverything() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("a")), leaderPodId = "a")
        s.signOut()
        assertFalse(s.isPaired.value)
        assertNull(s.currentUser.value)
        assertTrue(s.pods.value.isEmpty())
        assertNull(s.leaderPodId.value)
    }

    @Test fun slugUtil_normalizesNames() {
        assertEquals("music-projects", SlugUtil.slugify("Music Projects"))
        assertEquals("harrys-mac", SlugUtil.slugify("Harry's Mac!"))
        assertEquals("server", SlugUtil.slugify(""))
        assertEquals("server-42", SlugUtil.slugify("Server 42"))
    }

    // An explicit Settings → Lock must make the lock screen WAIT for a tap
    // (awaitingManualUnlock) rather than auto-prompt and instantly undo the
    // lock. markUnlocked() clears the latch so launch / return-from-background
    // still auto-prompt. Mirror of iOS test_lock_armsManualUnlock_*.
    @Test fun lock_armsManualUnlock_andMarkUnlockedClearsIt() {
        val s = AppState()
        s.markUnlocked()
        assertTrue(s.isUnlocked.value)
        assertFalse(s.awaitingManualUnlock.value)

        s.lock()
        assertFalse(s.isUnlocked.value)
        assertTrue(s.awaitingManualUnlock.value)

        s.markUnlocked()
        assertTrue(s.isUnlocked.value)
        assertFalse(s.awaitingManualUnlock.value)
    }
}
