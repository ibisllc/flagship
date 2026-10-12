// Suggested access lists (docs/ai-privacy-and-staging.md §3a "Suggested
// lists"): the wire shapes, the app list badge, the page's Review / Dismiss,
// and the alert's Review / Not now.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AccessRequestsResponse
import com.flagshipserver.app.api.AppAccessDraft
import com.flagshipserver.app.api.AppAccessState
import com.flagshipserver.app.api.AppAccessSuggestion
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.AccessBox
import com.flagshipserver.app.core.AccessRequestCenter
import com.flagshipserver.app.core.AppAccessList
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.ui.screens.accessListRoute
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppAccessDraftTest {
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val issuedAt = 1_700_000_000_000L
    private val wiki = "bright-maple--wiki"
    private val draftList = "allow api.github.com   # sync notes\nallow en.wikipedia.org\n"
    private val draft = AppAccessDraft(
        list = draftList,
        listSha256 = AppAccessList.sha256Hex(draftList),
        hosts = listOf(AppAccessSuggestion("api.github.com", "sync notes")),
        createdAt = issuedAt - 1000,
    )

    private fun withDraft(): MockScreensClient = MockScreensClient(simulatedLatencyMs = 0).apply {
        accessFixture[wiki] = accessFixture[wiki]!!.copy(draft = draft)
    }

    // ---- the wire ----

    @Test fun theBoxShapesDecode() {
        val json = Json { ignoreUnknownKeys = true; classDiscriminator = "kind" }
        val state = json.decodeFromString(
            AppAccessState.serializer(),
            """{"list":"deny all\n","listSha256":"x","pending":[],"draft":{"list":"allow a.example\ndeny all\n","listSha256":"y","hosts":[{"host":"a.example","why":"maps"},{"host":"b.example"}],"createdAt":5}}""",
        )
        assertEquals(listOf("a.example", "b.example"), state.draft!!.hosts.map { it.host })
        assertEquals(listOf("maps", null), state.draft!!.hosts.map { it.why })
        assertNull(json.decodeFromString(AppAccessState.serializer(), """{"list":"deny all\n","pending":[],"draft":null}""").draft)
        assertNull(json.decodeFromString(AppAccessState.serializer(), """{"list":"deny all\n","pending":[]}""").draft)

        // A draft entry has no host; it must not break the request list.
        val reqs = json.decodeFromString(
            AccessRequestsResponse.serializer(),
            """{"requests":[{"serviceId":"me--w","appName":"Weather","kind":"draft","hosts":[{"host":"api.open-meteo.com","why":"forecasts"}],"createdAt":9},{"serviceId":"me--w","appName":"Weather","host":"x.example","source":"attempt","attempts":2,"firstSeen":1,"lastSeen":2}]}""",
        )
        assertTrue(reqs.requests[0].isDraft)
        assertEquals("api.open-meteo.com", reqs.requests[0].hosts.single().host)
        assertFalse(reqs.requests[1].isDraft)
        assertEquals("x.example", reqs.requests[1].host)
    }

    @Test fun badge_whileADraftWaits() {
        val json = Json { ignoreUnknownKeys = true }
        val row = """{"serviceId":"me--w","creator":"me","slug":"w","urlLabel":"w","url":"https://w","status":"running","installedAt":1"""
        val list = json.decodeFromString(
            AppsListResponse.serializer(),
            """{"apps":[$row,"access":{"rules":1,"pending":0,"draft":true}},$row,"access":{"rules":1,"pending":0}}]}""",
        )
        assertEquals(listOf(true, false), list.apps.map { AppAccessViewModel.showsBadge(it) })
    }

    // ---- the app's page ----

    @Test fun page_showsTheDraft_dismissSendsNoSignature() = runTest {
        val mock = withDraft()
        val vm = AppAccessViewModel(wiki, mock, AppAccessOrder(mock, signer = { error("must not sign") }), appName = "Wiki")
        vm.load()
        assertEquals(draft, vm.state.value!!.draft)
        assertTrue(mock.appsList().apps.first { it.serviceId == wiki }.access!!.draft)

        assertTrue(vm.dismissDraft())
        assertEquals(listOf(wiki), mock.accessDraftDismissals)
        assertTrue(mock.accessCalls.isEmpty())
        assertNull(vm.state.value!!.draft)
        assertFalse(mock.appsList().apps.first { it.serviceId == wiki }.access!!.draft)
    }

    @Test fun page_aRefusedDismissSaysWhy() = runTest {
        val mock = object : com.flagshipserver.app.api.ScreensClient by withDraft() {
            override suspend fun serviceAccessDraftDismiss(serviceId: String) =
                throw ScreensError.Http(403, """{"error":"companion-write-not-allowed"}""")
        }
        val vm = AppAccessViewModel(wiki, mock)
        vm.load()
        assertFalse(vm.dismissDraft())
        assertEquals("companion-write-not-allowed", vm.error.value)
        assertEquals(draft, vm.state.value!!.draft)
    }

    @Test fun review_savesTheDraftTextSigned_andTheDraftClears() = runTest {
        val mock = withDraft()
        val reasons = mutableListOf<String>()
        val vm = AppAccessViewModel(
            wiki, mock,
            AppAccessOrder(mock, signer = { r -> reasons += r; Ed25519Sign(seed) }, now = { issuedAt }),
            appName = "Wiki",
        )
        vm.load()
        val text = vm.state.value!!.draft!!.list
        assertTrue(vm.save(text, vm.approveDraftReason))
        val req = mock.accessCalls.single().second
        assertEquals(AppAccessList.normalize(draftList), req.list)
        assertEquals(AppAccessList.sha256Hex(req.list), req.grant.listSha256)
        assertEquals(listOf("Approve the hosts Wiki suggests"), reasons)
        assertNull(vm.state.value!!.draft)
        assertNull(mock.accessFixture[wiki]!!.draft)
    }

    @Test fun routes() {
        assertEquals("service-access-list/me--w", accessListRoute("me--w"))
        assertEquals("service-access-list/me--w?draft=true", accessListRoute("me--w", draft = true))
        assertFalse(DeepLink.AccessList("me--w").draft)
    }

    // ---- the alerts ----

    private fun center(mock: MockScreensClient, clock: () -> Long = { issuedAt }) = AccessRequestCenter(
        boxes = { listOf(AccessBox("pod-home", "home.bright-maple.flagship.services", mock)) },
        signer = { error("a draft alert never signs") },
        now = clock,
    )

    @Test fun alert_draftComesFirst_reviewHandsBackTheApp_andMovesOn() = runTest {
        val mock = withDraft()
        val c = center(mock)
        assertEquals(2, c.refresh())
        val shown = c.shown.value!!
        assertTrue(shown.alert.isDraft)
        assertEquals("Wiki suggests an access list", shown.alert.asks)
        assertEquals("api.github.com: sync notes", shown.alert.detail)

        // Allow / Deny don't apply to a draft.
        c.answer(allow = true)
        assertEquals(AccessRequestCenter.Phase.Asking, c.shown.value!!.phase)
        assertTrue(mock.accessCalls.isEmpty())

        val reviewed = c.review()!!
        assertEquals(wiki, reviewed.request.serviceId)
        assertTrue(reviewed.isDraft)
        assertEquals("Plants wants to reach api.open-meteo.com", c.shown.value!!.alert.asks)
        // The single-host alert has no Review.
        assertNull(c.review())
        // Reviewed: not raised again today, and nothing was dismissed on the box.
        c.notNow()
        assertEquals(0, c.refresh())
        assertTrue(mock.accessDraftDismissals.isEmpty())
    }

    @Test fun alert_notNow_asksAgainADayLater_aNewerDraftAsksAtOnce() = runTest {
        val mock = withDraft()
        mock.accessFixture["bright-maple--plants"] = mock.accessFixture["bright-maple--plants"]!!.copy(pending = emptyList())
        var t = issuedAt
        val c = center(mock) { t }
        assertEquals(1, c.refresh())
        c.notNow()
        assertNull(c.shown.value)
        assertEquals(0, c.refresh())

        mock.accessFixture[wiki] = mock.accessFixture[wiki]!!.copy(draft = draft.copy(createdAt = issuedAt + 5))
        assertEquals(1, c.refresh())
        assertTrue(c.shown.value!!.alert.isDraft)
        c.notNow()
        t += 24L * 3600 * 1000 + 1
        assertEquals(1, c.refresh())
    }

    @Test fun alert_aDraftApprovedElsewhereLeavesTheQueue() = runTest {
        val mock = withDraft()
        val c = center(mock)
        c.refresh()
        mock.serviceAccessDraftDismiss(wiki)
        c.refresh()
        c.notNow() // the draft was showing; the next is the plants request
        assertFalse(c.shown.value!!.alert.isDraft)
        c.notNow()
        assertNull(c.shown.value)
    }
}
