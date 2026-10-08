// P5 — AuditLogViewModel pagination + kind→label mapping contract.
//
// The Worker's `since` is an EXCLUSIVE LOWER bound that returns the
// newest `limit` rows (ORDER BY seq DESC, capped at 50). The VM grows
// the requested window each time the user taps Load more — it does NOT
// walk a cursor. These tests pin:
//   - first load fetches PAGE_SIZE rows and exposes Loaded
//   - canLoadMore flips off once the server returns fewer rows than
//     requested
//   - the window grows on loadMore but never exceeds MAX_WINDOW
//   - kind→label mapping mirrors docs/revocation-ui.md (and iOS)

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AuditEvent
import com.flagshipserver.app.api.AuditEventListResponse
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AuditLogViewModelTest {

    private fun event(seq: Int, kind: String = "device-added"): AuditEvent =
        AuditEvent(
            seq = seq,
            eventKind = kind,
            detail = "detail-$seq",
            devicePrefix = "dp$seq",
            postedAt = 1_700_000_000_000L + seq.toLong(),
        )

    @Test fun label_mapsAllDocumentedKindsAndFallsThrough() {
        // Pinned to docs/revocation-ui.md so the audit log reads
        // consistently regardless of which subsystem authored the event.
        assertEquals("Disconnected device", auditEventLabel("device-disconnected"))
        assertEquals("Replaced device", auditEventLabel("device-replaced"))
        assertEquals("Added device", auditEventLabel("device-added"))
        assertEquals("Wiped & restarted account", auditEventLabel("wipe-restart"))
        assertEquals("Set up recovery", auditEventLabel("recovery-set-up"))
        assertEquals("Rotated recovery passkey", auditEventLabel("recovery-rotated"))
        assertEquals("Renamed app URL", auditEventLabel("app-renamed"))
        assertEquals("Created server", auditEventLabel("server-created"))
        assertEquals("Server came online", auditEventLabel("server-online"))
        // Unknown kinds are humanized, never shown raw or blank.
        assertEquals("Custom future kind", auditEventLabel("custom-future-kind"))
    }

    @Test fun label_coversServerWrittenKinds() {
        assertEquals("Demo server provisioned", auditEventLabel("demo-vps-provisioned"))
        assertEquals("Turned on authenticator codes", auditEventLabel("totp-enrolled"))
        assertEquals("Refused a device replacement", auditEventLabel("re-pair-refused-no-credential"))
    }

    @Test fun displayDetail_dropsMachineDetailForDemoProvisioning() {
        val demo = AuditEvent(seq = 1, eventKind = "demo-vps-provisioned", detail = "serverId=abc fqdn=home.x.flagship.services", devicePrefix = "", postedAt = 1)
        assertNull(auditEventDisplayDetail(demo))
        val created = AuditEvent(seq = 1, eventKind = "server-created", detail = "home", devicePrefix = "", postedAt = 1)
        assertEquals("home", auditEventDisplayDetail(created))
        val blank = AuditEvent(seq = 1, eventKind = "server-created", detail = "  ", devicePrefix = "", postedAt = 1)
        assertNull(auditEventDisplayDetail(blank))
    }

    @Test fun load_emptyUsername_yieldsLoadedEmpty() = runTest {
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = AuditLogViewModel(
            client = client,
            username = { null },
            scope = backgroundScope,
        )
        vm.load().join()
        val page = (vm.state.first() as LoadingState.Loaded).value
        assertTrue(page.events.isEmpty())
        assertFalse(page.canLoadMore)
    }

    @Test fun load_returnsEventsNewestFirst_andCanLoadMoreWhenFull() = runTest {
        // Seed exactly PAGE_SIZE (20) events so the first window is FULL
        // — Worker can have more under the 50-cap, so canLoadMore is on.
        val seeded = (1..AUDIT_LOG_PAGE_SIZE).map { event(it) }
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            auditEventsByUser = mapOf("harry" to seeded)
        }
        val vm = AuditLogViewModel(
            client = client,
            username = { "harry" },
            scope = backgroundScope,
        )
        vm.load().join()
        val page = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(AUDIT_LOG_PAGE_SIZE, page.events.size)
        // Mock returns DESC by seq.
        assertEquals(AUDIT_LOG_PAGE_SIZE, page.events.first().seq)
        assertEquals(1, page.events.last().seq)
        assertTrue("first-page fill implies more might be available", page.canLoadMore)
    }

    @Test fun load_underFullWindow_canLoadMoreIsFalse() = runTest {
        // Fewer than PAGE_SIZE rows — the server's "ran out" signal.
        val seeded = (1..3).map { event(it) }
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            auditEventsByUser = mapOf("harry" to seeded)
        }
        val vm = AuditLogViewModel(
            client = client,
            username = { "harry" },
            scope = backgroundScope,
        )
        vm.load().join()
        val page = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(3, page.events.size)
        assertFalse("under-full window means no more history", page.canLoadMore)
    }

    @Test fun loadMore_growsWindowAndCapsAtMaxWindow() = runTest {
        // Seed more than MAX_WINDOW so every fetch saturates the window —
        // canLoadMore should stay true UP TO the cap, then flip off.
        val seeded = (1..60).map { event(it) }
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            auditEventsByUser = mapOf("harry" to seeded)
        }
        val vm = AuditLogViewModel(
            client = client,
            username = { "harry" },
            scope = backgroundScope,
        )
        vm.load().join()
        val p1 = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(AUDIT_LOG_PAGE_SIZE, p1.events.size)
        assertTrue(p1.canLoadMore)

        vm.loadMore().join()
        val p2 = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(AUDIT_LOG_PAGE_SIZE * 2, p2.events.size)
        assertTrue(p2.canLoadMore)

        vm.loadMore().join()
        val p3 = (vm.state.first() as LoadingState.Loaded).value
        // Window grew to MAX_WINDOW (50) and is now capped — even though
        // the server has 60 rows total, this endpoint can't surface them.
        assertEquals(AUDIT_LOG_MAX_WINDOW, p3.events.size)
        assertFalse("window hit MAX, no more pages", p3.canLoadMore)
    }

    @Test fun fetchFailure_yieldsFailedWithMessage() = runTest {
        val throwing = object : FlagshipServerClient by MockFlagshipServerClient(simulatedLatencyMs = 0) {
            override suspend fun listAuditEvents(username: String, sinceSeq: Int, limit: Int): AuditEventListResponse =
                throw RuntimeException("transport broken")
        }
        val vm = AuditLogViewModel(
            client = throwing,
            username = { "harry" },
            scope = backgroundScope,
        )
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        val msg = (s as LoadingState.Failed).message
        assertNotNull(msg)
        assertTrue(msg, msg.contains("transport broken"))
    }
}
