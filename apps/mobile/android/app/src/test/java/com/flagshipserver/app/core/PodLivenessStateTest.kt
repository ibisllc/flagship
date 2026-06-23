// Mirror of FlagshipMobileTests/PodLivenessStateTests.swift. The three states
// of a registered-but-not-yet-online server, plus the online short-circuit. A
// box actively trying to boot (a live unlock request) or freshly registered
// must NOT read as "dead"; only a genuinely-stale box (no request, past the
// grace window) is DEAD and thus deletable.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PodLivenessStateTest {
    private val now = 1_000_000_000_000L

    private fun pod(
        status: PodInfo.Status = PodInfo.Status.ONLINE,
        cameOnline: Boolean = false,
        registeredAt: Long = 0,
    ): PodInfo = PodInfo(
        podId = "pod-x",
        name = "X",
        fqdn = "box.harry.flagship.services",
        status = status,
        cameOnline = cameOnline,
        registeredAt = registeredAt,
    )

    @Test fun online_whenCheckedIn() {
        val p = pod(cameOnline = true, registeredAt = now)
        assertEquals(PodInfo.LivenessState.ONLINE, p.livenessState(hasLiveUnlockRequest = false, now = now))
    }

    @Test fun waitingForApproval_whenLiveUnlockRequestExists() {
        // Registered long ago (would otherwise be dead) but a live unlock
        // request overrides: the box is actively waiting for the owner.
        val p = pod(registeredAt = now - 60 * 60 * 1000)
        assertEquals(
            PodInfo.LivenessState.WAITING_FOR_APPROVAL,
            p.livenessState(hasLiveUnlockRequest = true, now = now),
        )
    }

    @Test fun comingOnline_withinGraceWindow() {
        val p = pod(registeredAt = now - 5 * 60 * 1000)
        assertEquals(
            PodInfo.LivenessState.COMING_ONLINE,
            p.livenessState(hasLiveUnlockRequest = false, now = now),
        )
    }

    @Test fun dead_pastGraceWindowWithNoRequest() {
        val p = pod(registeredAt = now - (PodInfo.COMING_ONLINE_GRACE_MS + 1000))
        assertEquals(
            PodInfo.LivenessState.DEAD,
            p.livenessState(hasLiveUnlockRequest = false, now = now),
        )
    }

    @Test fun pendingPod_isComingOnlineNeverDead() {
        val p = pod(status = PodInfo.Status.PENDING, registeredAt = 0)
        assertEquals(
            PodInfo.LivenessState.COMING_ONLINE,
            p.livenessState(hasLiveUnlockRequest = false, now = now),
        )
    }

    @Test fun appState_livenessUsesAwaitingSet() {
        val s = AppState(currentUser = "harry")
        s.addPod(pod(registeredAt = now - 60 * 60 * 1000))
        // No waiting set ⇒ dead. Use a fixed now via the pod's classifier path:
        // AppState.liveness uses System time, so assert directly on the pod for
        // the time-sensitive case and on AppState for the override case.
        assertEquals(
            PodInfo.LivenessState.DEAD,
            s.pods.value[0].livenessState(hasLiveUnlockRequest = false, now = now),
        )
        // Mark it waiting ⇒ waitingForApproval regardless of time.
        s.setBoxRequestInbox(mapOf("box.harry.flagship.services" to listOf(BoxRequest(
            nonceHex = "n", serverDomain = "box.harry.flagship.services",
            type = SecretPurpose.UNLOCK_KEY, issuedAt = 1, expiresAt = now + 60_000,
        ))))
        assertEquals(PodInfo.LivenessState.WAITING_FOR_APPROVAL, s.liveness(s.pods.value[0]))
        assertTrue(s.hasLiveUnlockRequest("BOX.harry.flagship.services"))
    }

    @Test fun upsertRegisteredPod_threadsRegisteredAt() {
        val s = AppState(currentUser = "harry")
        s.upsertRegisteredPod(
            fqdn = "box.harry.flagship.services",
            name = "Box",
            cameOnline = false,
            registeredAt = now,
        )
        assertEquals(now, s.pods.value.first().registeredAt)
    }
}
