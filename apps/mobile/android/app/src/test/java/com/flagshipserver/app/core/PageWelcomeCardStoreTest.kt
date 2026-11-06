// Home's voi.ci page welcome card. Mirror of FlagshipMobileTests/PageWelcomeCardTests.swift and the webapp's
// homePageWelcome.test.ts: same truth table, dismissal kept per account.

package com.flagshipserver.app.core

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PageWelcomeCardStoreTest {

    private val prefsName = "test.pageWelcome.${System.nanoTime()}"

    private fun store(): PageWelcomeCardStore {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        return PageWelcomeCardStore(ctx.getSharedPreferences(prefsName, android.content.Context.MODE_PRIVATE))
    }

    private fun show(hasAccount: Boolean = true, checked: Boolean = true, published: Boolean = false, pending: Int = 0, dismissed: Boolean = false) =
        PageWelcomeCardStore.shouldShow(hasAccount, checked, published, pending, dismissed)

    @Test fun showsForAnAccountWithNoPage() = assertTrue(show())

    @Test fun hiddenOnceThePageIsPublished() = assertFalse(show(published = true))

    @Test fun hiddenWhileAChangeWaitsToBePublished() = assertFalse(show(pending = 1))

    @Test fun hiddenAfterDismiss() = assertFalse(show(dismissed = true))

    @Test fun hiddenForASampleAccountOrNoAccount() = assertFalse(show(hasAccount = false))

    /** A failed or not-yet-made read is not "no page". */
    @Test fun hiddenUntilThePageWasRead() = assertFalse(show(checked = false))

    @Test fun dismissIsPerAccountAndPersists() {
        val a = store()
        assertFalse(a.isDismissed("jolly-quince"))
        a.dismiss("Jolly-Quince")
        assertTrue(a.isDismissed("jolly-quince"))
        assertTrue("jolly-quince" in a.dismissed.value)
        assertFalse("another account on this device still sees it", a.isDismissed("plucky-avocet"))
        assertTrue("a new launch remembers it", store().isDismissed("jolly-quince"))
    }

    @Test fun noAccountCountsAsDismissed() {
        val s = store()
        assertTrue(s.isDismissed(null))
        assertTrue(s.isDismissed(""))
    }
}
