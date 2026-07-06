// Phase 2 (Android) multi-pod fixes — mirror of iOS MultipodLivenessTests.
//
// Fix A — honest liveness mapping (live/unreachable/never -> status + classifier,
//         plus the legacy fallback when .com omits the field).
// Fix B — the per-pod session-token store + the legacy-single-token migration +
//         activatePod (a 2nd box can't overwrite the 1st's token).
// Fix C — sticky + deterministic leadership (a new box never seizes the leader;
//         a dangling leader re-anchors to the OLDEST remaining pod).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.InMemorySessionStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MultipodLivenessTest {

    private val now = 1_000_000_000_000L

    private fun signedInApp(user: String = "harry"): AppState =
        AppState().also { it.completeOnboarding(user, emptyList()) }

    // ---------------------------------------------------------------------
    // Fix A — honest liveness
    // ---------------------------------------------------------------------

    @Test fun liveness_live_mapsToOnline() {
        val app = signedInApp()
        app.upsertRegisteredPod(
            fqdn = "home.harry.flagship.services", name = "Home",
            cameOnline = true, registeredAt = now, liveness = PodInfo.Liveness.LIVE,
        )
        val pod = app.pods.value.first()
        assertEquals(PodInfo.Status.ONLINE, pod.status)
        assertEquals(PodInfo.LivenessState.ONLINE, pod.livenessState(hasLiveUnlockRequest = false, now = now))
    }

    @Test fun liveness_unreachable_mapsToOfflineWithLastSeen() {
        val app = signedInApp()
        app.upsertRegisteredPod(
            fqdn = "home.harry.flagship.services", name = "Home",
            cameOnline = true, registeredAt = now,
            liveness = PodInfo.Liveness.UNREACHABLE, lastSeenMsAgo = 2 * 60 * 60 * 1000,
        )
        val pod = app.pods.value.first()
        assertEquals(PodInfo.Status.OFFLINE, pod.status)
        assertEquals(PodInfo.LivenessState.OFFLINE, pod.livenessState(hasLiveUnlockRequest = false, now = now))
        assertEquals("2 hours ago", pod.humanizedLastSeen())
    }

    @Test fun liveness_unreachable_butWaiting_surfacesApproval() {
        val app = signedInApp()
        app.upsertRegisteredPod(
            fqdn = "home.harry.flagship.services", name = "Home",
            liveness = PodInfo.Liveness.UNREACHABLE,
        )
        val pod = app.pods.value.first()
        // A box stuck waiting for an owner approval is actively trying to come up.
        assertEquals(
            PodInfo.LivenessState.WAITING_FOR_APPROVAL,
            pod.livenessState(hasLiveUnlockRequest = true, now = now),
        )
    }

    @Test fun liveness_never_mapsToUnknownAndComingOnline() {
        val app = signedInApp()
        app.upsertRegisteredPod(
            fqdn = "home.harry.flagship.services", name = "Home",
            cameOnline = false, registeredAt = now - 60 * 60 * 1000, // old reg
            liveness = PodInfo.Liveness.NEVER,
        )
        val pod = app.pods.value.first()
        assertEquals(PodInfo.Status.UNKNOWN, pod.status)
        // never + no request => still coming up (NOT dead), regardless of reg age.
        assertEquals(
            PodInfo.LivenessState.COMING_ONLINE,
            pod.livenessState(hasLiveUnlockRequest = false, now = now),
        )
    }

    @Test fun liveness_absent_fallsBackToRegistrationDerivedOnline() {
        // No liveness field (pre-field Worker) => legacy behaviour: registered
        // box reads ONLINE so existing tests/paths are unaffected.
        val app = signedInApp()
        app.upsertRegisteredPod(
            fqdn = "home.harry.flagship.services", name = "Home",
            cameOnline = true, registeredAt = now, // liveness = null
        )
        val pod = app.pods.value.first()
        assertEquals(PodInfo.Status.ONLINE, pod.status)
        assertNull(pod.liveness)
        assertEquals(PodInfo.LivenessState.ONLINE, pod.livenessState(hasLiveUnlockRequest = false, now = now))
    }

    @Test fun liveness_unreachable_isNotSessionEligible() {
        // sessionPod must prefer a genuinely-live pod, never an unreachable one.
        val app = signedInApp()
        app.upsertRegisteredPod(fqdn = "old.harry.flagship.services", name = "Old", liveness = PodInfo.Liveness.UNREACHABLE)
        app.upsertRegisteredPod(fqdn = "new.harry.flagship.services", name = "New", liveness = PodInfo.Liveness.LIVE)
        // Leader (oldest) is the unreachable one, but sessionPod lands on the live box.
        assertEquals("pod-old.harry.flagship.services", app.leaderPodId.value)
        assertEquals("pod-new.harry.flagship.services", app.sessionPod?.podId)
    }

    @Test fun humanizeAge_buckets() {
        assertEquals("just now", PodInfo.humanizeAge(5_000))
        assertEquals("1 minute ago", PodInfo.humanizeAge(60_000))
        assertEquals("3 minutes ago", PodInfo.humanizeAge(3 * 60_000))
        assertEquals("1 hour ago", PodInfo.humanizeAge(60 * 60_000))
        assertEquals("2 days ago", PodInfo.humanizeAge(2L * 24 * 60 * 60_000))
    }

    // ---------------------------------------------------------------------
    // Fix B — per-pod session-token store + migration + activate
    // ---------------------------------------------------------------------

    @Test fun perPodToken_keyedByPodId_secondBoxDoesNotOverwriteFirst() = runTest {
        val s = InMemorySessionStore()
        val pod1 = PodInfo.podId("home.harry.flagship.services")
        val pod2 = PodInfo.podId("work.harry.flagship.services")
        s.setSessionToken("aa".repeat(16), forPodId = pod1)
        s.setSessionToken("bb".repeat(16), forPodId = pod2)
        // Each box keeps its own token; pairing a 2nd never clobbered the 1st.
        assertEquals("aa".repeat(16), s.sessionToken(forPodId = pod1))
        assertEquals("bb".repeat(16), s.sessionToken(forPodId = pod2))
        assertEquals(2, s.podTokenIds().size)
    }

    @Test fun perPodToken_keyIsCaseInsensitive() = runTest {
        val s = InMemorySessionStore()
        s.setSessionToken("cc".repeat(16), forPodId = "POD-Home.Harry.Flagship.Services")
        assertEquals("cc".repeat(16), s.sessionToken(forPodId = "pod-home.harry.flagship.services"))
    }

    @Test fun migrateSingleTokenToPod_attributesLegacyTokenOnce() = runTest {
        val s = InMemorySessionStore()
        val pod = PodInfo.podId("home.harry.flagship.services")
        s.setSessionToken("dd".repeat(16))            // legacy single token
        assertNull(s.sessionToken(forPodId = pod))

        s.migrateSingleTokenToPod(pod)
        assertEquals("dd".repeat(16), s.sessionToken(forPodId = pod))

        // Idempotent — re-running with a different legacy token never re-attributes.
        s.setSessionToken("ee".repeat(16))
        s.migrateSingleTokenToPod(pod)
        assertEquals("dd".repeat(16), s.sessionToken(forPodId = pod))
    }

    @Test fun activatePod_pointsActiveSlotsAtPerPodToken() = runTest {
        val s = InMemorySessionStore()
        val pod = PodInfo.podId("home.harry.flagship.services")
        s.setSessionToken("ff".repeat(16), forPodId = pod)
        s.activatePod(pod, "https://home.harry.flagship.services")
        assertEquals("https://home.harry.flagship.services", s.podBaseUrl.first())
        assertEquals("ff".repeat(16), s.sessionToken.first())
    }

    @Test fun activatePod_withNoStoredToken_activatesNullNotAnotherPodsToken() = runTest {
        val s = InMemorySessionStore()
        val paired = PodInfo.podId("home.harry.flagship.services")
        val unpaired = PodInfo.podId("work.harry.flagship.services")
        s.setSessionToken("11".repeat(16), forPodId = paired)
        // Activate the box that has NO token — it must NOT borrow the paired one.
        s.activatePod(unpaired, "https://work.harry.flagship.services")
        assertEquals("https://work.harry.flagship.services", s.podBaseUrl.first())
        assertNull(s.sessionToken.first())
    }

    // ---------------------------------------------------------------------
    // Fix C — sticky + deterministic leadership
    // ---------------------------------------------------------------------

    private fun pod(id: String): PodInfo =
        PodInfo(podId = id, name = id, fqdn = "$id.harry.flagship.services")

    @Test fun addPod_newBoxNeverSeizesLeadership() {
        val s = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a")),
            leaderPodId = "a", currentPodId = "a")
        s.addPod(pod("b")) // a brand-new box arrives
        // The leader / default pod is UNCHANGED — the new box is just selectable.
        assertEquals("a", s.leaderPodId.value)
        assertEquals("a", s.currentPodId.value)
    }

    @Test fun removePod_danglingLeaderReanchorsToOldest() {
        // .com returns oldest-first, so pods.first() is the oldest.
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("oldest"), pod("middle"), pod("newest")),
            leaderPodId = "oldest", currentPodId = "oldest")
        s.removePod("oldest") // the leader is removed -> dangles
        // Re-anchors to the OLDEST remaining ("middle"), never the newest.
        assertEquals("middle", s.leaderPodId.value)
        assertEquals("middle", s.currentPodId.value)
    }

    @Test fun removePod_nonLeaderRemoval_leavesLeaderUntouched() {
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("a"), pod("b"), pod("c")),
            leaderPodId = "a", currentPodId = "a")
        s.removePod("c") // a non-leader box
        assertEquals("a", s.leaderPodId.value)
        assertEquals("a", s.currentPodId.value)
    }

    @Test fun currentPod_fallsBackToOldestNotNewest() {
        // currentPodId dangles (points at nothing); resolution must land on the
        // leader, and a missing leader on the OLDEST pod — never the newest.
        val s = AppState(isPaired = true, currentUser = "u",
            pods = listOf(pod("oldest"), pod("newest")),
            leaderPodId = null, currentPodId = "ghost")
        assertEquals("oldest", s.currentPod?.podId)
    }
}
