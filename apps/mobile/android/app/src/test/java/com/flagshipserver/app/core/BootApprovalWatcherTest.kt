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

    @Test fun publishesAwaitingSetFromDirectory() = runTest {
        val app = AppState()
        val w = BootApprovalWatcher(app = app, pollAwaiting = { setOf(domain) })
        val set = w.pollOnce()
        assertEquals(setOf(domain), set)
        assertEquals(setOf(domain), app.serversAwaitingApproval.value)
    }

    @Test fun emptyDirectoryClearsSet() = runTest {
        val app = AppState()
        app.setServersAwaitingApproval(setOf(domain))
        val w = BootApprovalWatcher(app = app, pollAwaiting = { emptySet() })
        assertTrue(w.pollOnce().isEmpty())
        assertTrue(app.serversAwaitingApproval.value.isEmpty())
    }

    @Test fun blipReturningPriorSetLeavesItUntouched() = runTest {
        // The closure is best-effort: on a fetch blip it returns the prior set,
        // so the published set is unchanged — no thrash.
        val app = AppState()
        app.setServersAwaitingApproval(setOf(domain))
        val prior = app.serversAwaitingApproval.value
        val w = BootApprovalWatcher(app = app, pollAwaiting = { prior })
        assertEquals(setOf(domain), w.pollOnce())
    }
}
