// BootApprovalWatcher is now DIRECTORY-DRIVEN (no biometric): a `pollAwaiting`
// closure reads the unauthenticated `/pods` `awaitingUnlock` flags and the
// watcher publishes the resulting set on AppState. (The old version derived the
// IRK every 5s, firing Face ID on a timer.) Kotlin mirror of the iOS tests.

package com.flagshipserver.app.core

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BootApprovalWatcherTest {
    private val domain = "home.demo1234.flagship.services"

    @Test fun publishesAwaitingSetsFromDirectory() = runTest {
        val app = AppState()
        val w = BootApprovalWatcher(
            app = app,
            pollAwaiting = { PendingApprovalSets(unlock = setOf(domain), entitlement = setOf(domain)) },
        )
        val sets = w.pollOnce()
        assertEquals(setOf(domain), sets.unlock)
        assertEquals(setOf(domain), sets.entitlement)
        assertEquals(setOf(domain), app.serversAwaitingApproval.value)
        // The entitlement lane is the new Box Request Inbox surfacing.
        assertEquals(setOf(domain), app.serversAwaitingEntitlement.value)
    }

    @Test fun emptyDirectoryClearsSets() = runTest {
        val app = AppState()
        app.setServersAwaitingApproval(setOf(domain))
        app.setServersAwaitingEntitlement(setOf(domain))
        val w = BootApprovalWatcher(app = app, pollAwaiting = { PendingApprovalSets() })
        val sets = w.pollOnce()
        assertTrue(sets.unlock.isEmpty())
        assertTrue(app.serversAwaitingApproval.value.isEmpty())
        assertTrue(app.serversAwaitingEntitlement.value.isEmpty())
    }

    @Test fun blipReturningPriorSetsLeavesThemUntouched() = runTest {
        // The closure is best-effort: on a fetch blip it returns the prior sets,
        // so the published sets are unchanged — no thrash.
        val app = AppState()
        app.setServersAwaitingApproval(setOf(domain))
        val prior = PendingApprovalSets(
            unlock = app.serversAwaitingApproval.value,
            entitlement = app.serversAwaitingEntitlement.value,
        )
        val w = BootApprovalWatcher(app = app, pollAwaiting = { prior })
        assertEquals(setOf(domain), w.pollOnce().unlock)
    }
}
