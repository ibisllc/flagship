// OfflineControlViewModel against the gym's in-process box (GymRescue): the real hello checks under
// the pinned key, the signed session and offline orders, and the resumable backup download. Mirrors
// the iOS OfflineControlViewModelTests; the scenarios are the journal's A4 list.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.GymRescue
import com.flagshipserver.app.core.Rescue
import com.flagshipserver.app.core.RescueEndpoint
import com.flagshipserver.app.core.RescueServerBook
import com.flagshipserver.app.core.InMemoryRescueBookStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class OfflineControlViewModelTest {
    private val user = "bright-maple"
    private val domain = "home.$user.flagship.services"
    private val total = GymRescue.TOTAL

    private class Harness(val vm: OfflineControlViewModel, val box: GymRescue.MockRescueBox, val book: RescueServerBook)

    private fun harness(scenario: String, pinned: Boolean = true, found: Boolean = scenario != "not-found"): Harness {
        val book = RescueServerBook(InMemoryRescueBookStore())
        val dir = File(System.getProperty("java.io.tmpdir"), "rescue-${System.nanoTime()}")
        val (env, box) = GymRescue.environment(domain, scenario, dir, book = book, pinned = pinned, found = found)
        return Harness(OfflineControlViewModel(env, pollMs = 1), box, book)
    }

    private fun failure(h: Harness): String {
        val p = h.vm.phase.value
        assertTrue("expected Failed, got $p", p is OfflineControlViewModel.Phase.Failed)
        return (p as OfflineControlViewModel.Phase.Failed).message
    }

    @Test fun findsTheBoxByItsOpaqueIdAndOpensASession() = runTest {
        val h = harness("found")
        h.vm.start()
        assertEquals(RescueEndpoint("192.168.1.20"), h.vm.servers.value.first().found)
        h.vm.connect(domain)
        assertEquals(OfflineControlViewModel.Phase.Connected, h.vm.phase.value)
        assertEquals(2, h.vm.snapshot.value?.apps?.size)
        assertNull(h.vm.certificateNote)
        assertNotNull("where it answered is remembered", h.book.entry(domain))
    }

    @Test fun anotherKeyIsNotYourServer() = runTest {
        val h = harness("wrong-key")
        h.vm.start()
        h.vm.connect(domain)
        assertTrue(failure(h), failure(h).contains("This isn't your server"))
    }

    @Test fun theBoxRefusesAStrangersSessionInItsOwnWords() = runTest {
        val h = harness("stranger")
        h.vm.start()
        h.vm.connect(domain)
        assertTrue(failure(h), failure(h).startsWith("The rescue session was refused: not signed by this server's owner key"))
    }

    @Test fun anExpiredCertificateStillWorksByKey() = runTest {
        val h = harness("expired-cert")
        h.vm.start()
        h.vm.connect(domain)
        assertEquals(OfflineControlViewModel.Phase.Connected, h.vm.phase.value)
        assertNotNull(h.vm.certificateNote)
    }

    @Test fun notFoundAndNothingSeenBeforeSaysSoThenTheTypedAddressWorks() = runTest {
        val h = harness("not-found")
        h.vm.start()
        h.vm.connect(domain)
        assertTrue(failure(h), failure(h).contains("wasn't found on this Wi-Fi"))
        h.vm.manualName = domain
        h.vm.manualAddress = "192.168.1.20"
        assertTrue(h.vm.canConnectManually)
        h.vm.connectManually()
        assertEquals(OfflineControlViewModel.Phase.Connected, h.vm.phase.value)
    }

    @Test fun aServerWithNoPinnedKeyIsNotTried() = runTest {
        val h = harness("found", pinned = false)
        h.vm.start()
        h.vm.connect(domain)
        assertTrue(failure(h), failure(h).contains("never confirmed"))
    }

    @Test fun eachControlIsASignedOrderTheBoxChecks() = runTest {
        val h = harness("found")
        h.vm.start()
        h.vm.connect(domain)
        val notes = "$user--notes"
        fun state() = h.vm.snapshot.value?.apps?.first { it.serviceId == notes }?.state
        h.vm.perform(Rescue.Action.APP_STOP, notes)
        assertNull(h.vm.actionError)
        assertEquals("stopped", state())
        h.vm.perform(Rescue.Action.APP_START, notes)
        assertEquals("running", state())
        h.vm.perform(Rescue.Action.APP_RESTART, notes)
        assertEquals("Notes was restarted.", h.vm.notice)
        h.vm.perform(Rescue.Action.SERVER_SHUTDOWN)
        assertEquals(OfflineControlViewModel.Phase.List, h.vm.phase.value)
        assertEquals("The server is shutting down.", h.vm.notice)
        assertEquals(listOf("app-stop|$notes", "app-start|$notes", "app-restart|$notes", "server-shutdown|$domain"), h.box.seenControls)
    }

    @Test fun anInterruptedDownloadResumesAndFinishes() = runTest {
        val h = harness("interrupt")
        h.vm.start()
        h.vm.connect(domain)
        h.vm.askPasscode()
        assertFalse("the passcode must be saved first", h.vm.canStartBackup)
        h.vm.passcodeSaved = true
        h.vm.startBackup()
        assertTrue("got ${h.vm.backup.value}", h.vm.backup.value is OfflineControlViewModel.Backup.Interrupted)
        h.vm.download()
        val saved = h.vm.backup.value as? OfflineControlViewModel.Backup.Saved ?: return@runTest fail("saved, got ${h.vm.backup.value}")
        assertEquals(total.toLong(), saved.file.length())
        assertTrue(saved.file.readBytes().contentEquals(GymRescue.data))
    }
}
