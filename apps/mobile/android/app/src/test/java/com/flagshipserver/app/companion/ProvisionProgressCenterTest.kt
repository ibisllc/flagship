// A push (which never names the server) reads the name the install screen
// saw, crossing updates are dropped, and every listener hears the same.

package com.flagshipserver.app.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ProvisionProgressCenterTest {
    private val ctx = ApplicationProvider.getApplicationContext<Context>()
    private val heard = mutableListOf<ProvisionUpdate>()

    @Before fun setUp() {
        ProvisionProgressCenter.resetForTest()
        ProvisionProgressCenter.listener = { _, u -> heard += u }
    }

    @After fun tearDown() { ProvisionProgressCenter.listener = null }

    @Test fun pushesBorrowTheRememberedNameAndNeverStepBack() {
        assertTrue(ProvisionProgressCenter.report(ctx, ProvisionUpdate("S1", "S1", "Office", "booting")))
        assertTrue(ProvisionProgressCenter.report(ctx, ProvisionUpdate("S1", "S1", null, "sealing")))
        assertFalse(ProvisionProgressCenter.report(ctx, ProvisionUpdate("S1", "S1", null, "installing")))
        assertTrue(ProvisionProgressCenter.report(ctx, ProvisionUpdate("S1", "S1", null, "live", serverDomain = "office.u.flagship.services")))
        assertEquals(listOf("booting", "sealing", "live"), heard.map { it.phase })
        assertEquals(listOf("Office", "Office", "Office"), heard.map { it.podName })
        assertEquals(null, ProvisionNames.from(ctx).name("S1"))
    }
}
