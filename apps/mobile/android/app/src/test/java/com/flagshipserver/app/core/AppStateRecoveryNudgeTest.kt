// Mirror of FlagshipMobileTests/AppStateRecoveryNudgeTests.swift.
// Pins each branch of shouldShowRecoveryNudgeNow() so a regression
// reveals itself as a named failure rather than a stale banner in
// the emulator.

package com.flagshipserver.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStateRecoveryNudgeTest {

    private fun onlinePod(id: String = "a"): PodInfo =
        PodInfo(podId = id, name = id.uppercase(), fqdn = "$id.u.flagship.services", status = PodInfo.Status.ONLINE)

    private fun pendingPod(id: String = "p"): PodInfo =
        PodInfo(podId = id, name = id.uppercase(), fqdn = "$id.u.flagship.services", status = PodInfo.Status.PENDING)

    @Test fun noNudge_whenAlreadyEnrolled() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(onlinePod()),
            hasCloudRecovery = true,
        )
        assertFalse(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun noNudge_whenNoOnlinePodYet() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(pendingPod()),
            hasCloudRecovery = false,
        )
        assertFalse(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun noNudge_whenDismissedThisSession() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(onlinePod()),
            hasCloudRecovery = false,
            recoveryNudgeDismissedThisSession = true,
        )
        assertFalse(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun nudge_whenOnlinePodAndNotEnrolledAndNotDismissed() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(onlinePod()),
            hasCloudRecovery = false,
            recoveryNudgeDismissedThisSession = false,
        )
        assertTrue(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun nudge_appearsAfterOfflinePodFlipsToOnline() {
        val offline = PodInfo(podId = "z", name = "Z", fqdn = "z.u.flagship.services", status = PodInfo.Status.OFFLINE)
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(offline),
            hasCloudRecovery = false,
        )
        assertFalse(s.shouldShowRecoveryNudgeNow())
        s.removePod("z")
        s.addPod(PodInfo(podId = "z", name = "Z", fqdn = "z.u.flagship.services", status = PodInfo.Status.ONLINE))
        assertTrue(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun defaultHasCloudRecoveryIsTrue() {
        // Default suppresses the nudge so it doesn't flash on first
        // launch before the .com lookup completes.
        val s = AppState(isPaired = true, currentUser = "u", pods = listOf(onlinePod()))
        assertFalse(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun dismiss_setsSessionFlag() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(onlinePod()),
            hasCloudRecovery = false,
        )
        assertTrue(s.shouldShowRecoveryNudgeNow())
        s.dismissRecoveryNudgeForSession()
        assertFalse(s.shouldShowRecoveryNudgeNow())
    }

    @Test fun setHasCloudRecovery_clearsNudge() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(onlinePod()),
            hasCloudRecovery = false,
        )
        assertTrue(s.shouldShowRecoveryNudgeNow())
        s.setHasCloudRecovery(true)
        assertFalse(s.shouldShowRecoveryNudgeNow())
    }
}
