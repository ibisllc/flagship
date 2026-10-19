// The Activity tab's accordion data: absolute row times, paging in place with
// Load more, the server section's name and the box-event wording. Mirrors the
// iOS ActivityViewModel / BoxEventLabels tests (docs: parity activity-feed).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AuditEvent
import com.flagshipserver.app.api.BoxActivityEntry
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.BoxEventLabels
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.screens.activityServerTitle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.Locale

@OptIn(ExperimentalCoroutinesApi::class)
class ActivityAccordionTest {

    private fun ms(y: Int, mo: Int, d: Int, h: Int, mi: Int) =
        ZonedDateTime.of(y, mo, d, h, mi, 0, 0, ZoneOffset.UTC).toInstant().toEpochMilli()

    @Test fun timesAreDateAndTimeToTheMinute() {
        val now = ms(2026, 10, 17, 12, 0)
        assertEquals("Oct 17, 2:45 PM", ActivityDates.format(ms(2026, 10, 17, 14, 45), now, ZoneOffset.UTC, Locale.US))
        assertEquals("Jan 3, 9:05 AM", ActivityDates.format(ms(2026, 1, 3, 9, 5), now, ZoneOffset.UTC, Locale.US))
    }

    @Test fun anotherYearShowsTheYear() {
        val now = ms(2026, 10, 17, 12, 0)
        assertEquals("Dec 31, 2025, 11:59 PM", ActivityDates.format(ms(2025, 12, 31, 23, 59), now, ZoneOffset.UTC, Locale.US))
    }

    private fun entry(i: Int) = BoxActivityEntry(seq = i, ts = 1_000_000L + i, action = "x", kind = "server.backup.created")

    @Test fun loadMorePagesInPlaceUntilTheEnd() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0).apply {
            boxActivityFixture = (100 downTo 1).map(::entry)
        }
        val vm = ActivityViewModel(screens, scope = backgroundScope)
        vm.load().join()
        var feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(30, feed.items.filterIsInstance<ActivityItem.BoxEvent>().size)
        assertTrue("a full page means more may exist", feed.moreBox)
        assertFalse("no account events without a server client", feed.moreAudit)

        vm.loadMoreBox().join()
        feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(60, feed.items.filterIsInstance<ActivityItem.BoxEvent>().size)
        assertTrue(feed.moreBox)
        vm.loadMoreBox().join()
        vm.loadMoreBox().join()
        feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(100, feed.items.filterIsInstance<ActivityItem.BoxEvent>().size)
        assertFalse("the last page ended short: that's everything", feed.moreBox)
    }

    @Test fun accountEventsPageToo() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            auditEventsByUser = mutableMapOf(
                "alice" to (1..40).map { AuditEvent(it, "device-disconnected", "Disconnected device $it", "ab", 1_000L * it) }.toMutableList(),
            )
        }
        val vm = ActivityViewModel(MockScreensClient(simulatedLatencyMs = 0), scope = backgroundScope, server = server, username = { "alice" })
        vm.load().join()
        var feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(30, feed.items.filterIsInstance<ActivityItem.AuditEntry>().size)
        assertTrue(feed.moreAudit)
        vm.loadMoreAudit().join()
        feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(40, feed.items.filterIsInstance<ActivityItem.AuditEntry>().size)
        assertFalse(feed.moreAudit)
    }

    @Test fun serverSectionNamesItsServer() {
        val home = PodInfo(podId = "p1", name = "Home", fqdn = "home.a.flagship.services")
        val office = PodInfo(podId = "p2", name = "Office", fqdn = "office.a.flagship.services")
        assertEquals("Server · Home", activityServerTitle(listOf(home), null))
        assertEquals("Server · Office", activityServerTitle(listOf(home, office), "p2"))
        assertEquals("All servers", activityServerTitle(listOf(home, office), null))
        assertEquals("This server", activityServerTitle(emptyList(), null))
    }

    private fun title(kind: String) = BoxEventLabels.title(BoxActivityEntry(ts = 1, action = kind, kind = kind))

    @Test fun newBoxEventsReadInPlainWords() {
        assertEquals("Changed an app's internet access", title("app.access.edit"))
        assertEquals("Invited someone to an app", title("app.invite.create"))
        assertEquals("Changed the backup policy", title("server.backup.policy"))
        assertEquals("An app ran out of space", title("app.storage.full"))
        assertEquals("The disk is nearly full", title("server.disk.full"))
        assertEquals("Paused apps for the move", title("server.migration.paused"))
        assertEquals("Waiting for its backup", title("server.restore.waiting"))
        assertNotNull(title("something.new.here"))
        assertEquals("Something new here", title("something.new.here"))
    }
}
