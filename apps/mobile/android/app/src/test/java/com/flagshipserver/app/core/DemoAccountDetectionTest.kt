// A demo account is recognised from the ACCOUNT (its profile or pods carry a
// demoServer block), never from the developer live/mock toggle — a reviewer
// on a real live build is still on a demo account. Mirrors the iOS
// DemoServerBlockTests for AppState.isDemoAccount.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoAccountDetectionTest {
    private val demoBlock = DemoServerBlock(fqdn = "home.bright-maple.flagship.services", status = "up")
    private val realPod = PodInfo(podId = "home", name = "Home", fqdn = "home.bright-maple.flagship.services", status = PodInfo.Status.ONLINE)

    @Test fun aRealAccountIsNotDemo() {
        assertFalse(AppState.isDemoAccount(Profile(cloudName = "bright-maple"), listOf(realPod)))
        assertFalse(AppState.isDemoAccount(null, emptyList()))
    }

    @Test fun theProfilesDemoBlockMarksTheAccount() {
        assertTrue(AppState.isDemoAccount(Profile(cloudName = "bright-maple", demoServer = demoBlock), emptyList()))
    }

    @Test fun aDemoPodMarksTheAccount() {
        assertTrue(AppState.isDemoAccount(null, listOf(realPod.copy(demoServer = demoBlock))))
    }

    @Test fun aDemoAccountNeverShowsTheRecoveryNudge() {
        val app = AppState(
            isPaired = true,
            currentUser = "bright-maple",
            pods = listOf(realPod.copy(demoServer = demoBlock)),
            hasCloudRecovery = false,
        )
        assertTrue(app.isDemoAccountNow())
        assertFalse(app.shouldShowRecoveryNudgeNow())
    }
}
