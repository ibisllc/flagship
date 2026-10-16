// The access-list flows (docs/ai-privacy-and-staging.md §3a) against the mock
// box: the service page's Allow / Deny / Ignore, the editor's Save, the
// alerts' Allow / Deny / Not now, refusals, and the list badge.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.api.AccessRequestsResponse
import com.flagshipserver.app.api.AppAccessState
import com.flagshipserver.app.api.AppAccessSummary
import com.flagshipserver.app.api.AppEgress
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ScreensEvent
import com.flagshipserver.app.core.AccessBox
import com.flagshipserver.app.core.AccessRequestCenter
import com.flagshipserver.app.core.AppAccessList
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.push.FlagshipFcmService
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppAccessFlowTest {
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val issuedAt = 1_700_000_000_000L
    private val plants = "bright-maple--plants"

    private fun order(mock: ScreensClient, reasons: MutableList<String> = mutableListOf()) =
        AppAccessOrder(mock, signer = { r -> reasons += r; Ed25519Sign(seed) }, now = { issuedAt })

    private fun verify(mock: MockScreensClient, i: Int = mock.accessCalls.lastIndex) {
        val (id, req) = mock.accessCalls[i]
        assertEquals(id, req.grant.serviceId)
        assertEquals(AppAccessList.sha256Hex(req.list), req.grant.listSha256)
        assertEquals(issuedAt, req.grant.issuedAt)
        assertEquals(AppAccessList.normalize(req.list), req.list)
        Ed25519Verify(pub).verify(
            HexUtil.decode(req.signature)!!,
            AppAccessList.canonicalBytes(req.grant.serverDomain, id, req.grant.listSha256, req.grant.issuedAt),
        )
    }

    // ---- the service page ----

    @Test fun allow_putsTheRuleOnTop_signsAndClearsThePendingHost() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val reasons = mutableListOf<String>()
        val vm = AppAccessViewModel(plants, mock, order(mock, reasons), appName = "Plants")
        vm.load()
        assertEquals(listOf("api.open-meteo.com"), vm.state.value!!.pending.map { it.host })
        assertEquals(0, vm.ruleCount)

        assertTrue(vm.answer("api.open-meteo.com", allow = true))
        val req = mock.accessCalls.single().second
        assertEquals("allow api.open-meteo.com\n" + AppAccessList.DEFAULT_LIST, req.list)
        assertEquals("home.bright-maple.flagship.services", req.grant.serverDomain)
        verify(mock)
        assertEquals(listOf("Allow Plants to reach api.open-meteo.com"), reasons)
        assertEquals(emptyList<String>(), vm.state.value!!.pending.map { it.host })
        assertEquals(1, vm.ruleCount)
        assertEquals("allow", AppAccessList.decide(vm.state.value!!.list, "api.open-meteo.com").result)
    }

    @Test fun deny_replacesAnEarlierRuleForThatHost() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.accessFixture[plants] = AppAccessState("allow api.open-meteo.com\ndeny all\n")
        val vm = AppAccessViewModel(plants, mock, order(mock))
        assertTrue(vm.answer("api.open-meteo.com", allow = false))
        assertEquals("deny api.open-meteo.com\ndeny all\n", mock.accessCalls.single().second.list)
    }

    @Test fun ignore_dismissesWithoutSigningOrChangingTheList() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppAccessViewModel(plants, mock, AppAccessOrder(mock, signer = { error("must not sign") }))
        vm.load()
        assertTrue(vm.dismiss("api.open-meteo.com"))
        assertEquals(listOf(plants to "api.open-meteo.com"), mock.accessDismissals)
        assertTrue(mock.accessCalls.isEmpty())
        assertTrue(vm.state.value!!.pending.isEmpty())
        assertEquals(AppAccessList.DEFAULT_LIST, mock.accessFixture[plants]!!.list)
    }

    @Test fun save_normalizesAndSigns_anInvalidListSendsNothing() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppAccessViewModel(plants, mock, order(mock))
        assertFalse(vm.save("allow https://a.com\n"))
        assertTrue(mock.accessCalls.isEmpty())
        assertEquals(AppAccessOrder.LIST_HAS_ERRORS, vm.error.value)

        assertTrue(vm.save("allow a.com   \r\ndeny all\r\n\r\n"))
        assertEquals("allow a.com\ndeny all\n", mock.accessCalls.single().second.list)
        verify(mock)
    }

    @Test fun refusalsAreShownPlainly() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppAccessViewModel(plants, mock, order(mock))
        mock.accessError = ScreensError.Http(400, """{"error":"bad list","errors":[{"line":2,"message":"one host per line"}]}""")
        assertFalse(vm.save("allow a.com\n"))
        assertEquals(listOf(2), vm.boxErrors.value.map { it.line })
        assertEquals("The server found errors in this list.", vm.error.value)

        mock.accessError = ScreensError.Http(403, """{"error":"stale order"}""")
        assertFalse(vm.save("allow a.com\n"))
        assertEquals("The server refused this change: stale order. Check this phone's clock and try again.", vm.error.value)
        assertTrue(vm.boxErrors.value.isEmpty())

        mock.accessError = ScreensError.Http(404, """{"error":"no such service"}""")
        assertFalse(vm.save("allow a.com\n"))
        assertEquals("This app is no longer installed on the server.", vm.error.value)

        mock.accessError = ScreensError.Http(409, """{"error":"not newer"}""")
        assertFalse(vm.save("allow a.com\n"))
        assertEquals("The list changed since you opened it. Reload it and try again.", vm.error.value)
    }

    @Test fun aKeyThatWontUnlock_sendsNothing() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppAccessViewModel(plants, mock, AppAccessOrder(mock, signer = { throw IllegalStateException("cancelled") }))
        assertFalse(vm.save("allow a.com\n"))
        assertTrue(mock.accessCalls.isEmpty())
        assertEquals("Couldn't access your account key: cancelled", vm.error.value)
    }

    @Test fun editorErrors_liveParseFirst_thenTheBoxs() {
        val box = listOf(com.flagshipserver.app.api.AppAccessLineError(1, "from the box"))
        assertEquals(listOf(2), AppAccessViewModel.lineErrors("allow a.com\npermit b.com\n", box).map { it.line })
        assertEquals(box, AppAccessViewModel.lineErrors("allow a.com\n", box))
    }

    // ---- the app list and wire ----

    @Test fun badge_accessPendingWins_olderBoxFallsBackToEgress() {
        val json = Json { ignoreUnknownKeys = true }
        val row = """{"serviceId":"me--w","creator":"me","slug":"w","urlLabel":"w","url":"https://w","status":"running","installedAt":1"""
        val list = json.decodeFromString(
            AppsListResponse.serializer(),
            """{"apps":[$row,"access":{"rules":2,"pending":1}},$row,"access":{"rules":0,"pending":0},"egress":{"declared":["a.example"]}},$row,"egress":{"declared":["a.example"]}},$row}]}""",
        )
        assertEquals(AppAccessSummary(2, 1), list.apps[0].access)
        assertEquals(listOf(true, false, true, false), list.apps.map { AppAccessViewModel.showsBadge(it) })
    }

    @Test fun copy() {
        assertEquals("Plants wants to reach api.open-meteo.com", AppAccessViewModel.asksText("Plants", "api.open-meteo.com"))
        assertEquals("Plants can now reach api.open-meteo.com", AppAccessViewModel.allowedText("Plants", "api.open-meteo.com"))
        assertEquals("Plants won't reach api.open-meteo.com", AppAccessViewModel.deniedText("Plants", "api.open-meteo.com"))
        assertEquals("app-access", FlagshipFcmService.APP_ACCESS_CATEGORY)
        assertEquals("One of your apps wants to reach the internet", FlagshipFcmService.APP_ACCESS_TEXT)
        assertEquals("Internet access", AppAccessViewModel.TITLE)
        assertEquals("1 rule", AppAccessViewModel.ruleCountText(1))
        assertEquals("Tried to connect 3 times.", AppAccessViewModel.sourceText("attempt", 3))
        assertEquals("Asked for this when it was installed.", AppAccessViewModel.sourceText("app", 0))
    }

    // ---- the alerts ----

    private fun center(boxes: List<AccessBox>, clock: () -> Long = { issuedAt }) = AccessRequestCenter(
        boxes = { boxes },
        signer = { Ed25519Sign(seed) },
        now = clock,
    )

    @Test fun alerts_fromEveryBox_allowSignsOnThatBox_thenConfirms() = runTest {
        val home = MockScreensClient(simulatedLatencyMs = 0)
        val cabin = MockScreensClient(simulatedLatencyMs = 0).apply { podContext = "cabin"; accessFixture.clear() }
        cabin.accessFixture["bright-maple--notes"] = AppAccessState(
            pending = listOf(com.flagshipserver.app.api.AppAccessPending("api.github.com", "attempt", 2)),
        )
        val c = center(
            listOf(
                AccessBox("pod-home", "home.bright-maple.flagship.services", home),
                AccessBox("pod-cabin", "cabin.bright-maple.flagship.services", cabin),
            ),
        )
        assertEquals(2, c.refresh())
        val first = c.shown.value!!
        assertEquals("Plants wants to reach api.open-meteo.com", first.alert.asks)
        assertEquals(AccessRequestCenter.Phase.Asking, first.phase)

        c.answer(allow = true)
        assertEquals(
            AccessRequestCenter.Phase.Done(true, "Plants can now reach api.open-meteo.com"),
            c.shown.value!!.phase,
        )
        verify(home)
        assertTrue(cabin.accessCalls.isEmpty())

        c.close()
        val second = c.shown.value!!
        assertEquals("Notes wants to reach api.github.com", second.alert.asks)
        assertEquals("Tried to connect 2 times.", second.alert.detail)
        c.answer(allow = false)
        assertEquals(AccessRequestCenter.Phase.Done(false, "Notes won't reach api.github.com"), c.shown.value!!.phase)
        assertEquals("deny api.github.com\n" + AppAccessList.DEFAULT_LIST, cabin.accessCalls.single().second.list)
        assertEquals("cabin.bright-maple.flagship.services", cabin.accessCalls.single().second.grant.serverDomain)
        val viewed = c.viewList()
        assertEquals("bright-maple--notes", viewed!!.request.serviceId)
        assertNull(c.shown.value)

        // Answered: a later fetch shows nothing.
        assertEquals(0, c.refresh())
        assertNull(c.shown.value)
    }

    @Test fun notNow_keepsTheRequest_andAsksAgainADayLater() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        var t = issuedAt
        val c = center(listOf(AccessBox("pod-home", "home.bright-maple.flagship.services", mock)), clock = { t })
        c.refresh()
        c.notNow()
        assertNull(c.shown.value)
        assertTrue(mock.accessCalls.isEmpty())
        assertEquals(1, mock.accessFixture[plants]!!.pending.size)
        assertEquals(0, c.refresh())
        assertNull(c.shown.value)
        t += 24L * 3600 * 1000 + 1
        assertEquals(1, c.refresh())
        assertEquals("api.open-meteo.com", c.shown.value!!.alert.request.host)
    }

    @Test fun alerts_aFailedSendStaysAnswerable_andAnOlderBoxIsSkipped() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val old = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun accessRequests(): AccessRequestsResponse = throw ScreensError.Http(404, "not found")
        }
        val c = center(
            listOf(
                AccessBox(null, "old.bright-maple.flagship.services", old),
                AccessBox("pod-home", "home.bright-maple.flagship.services", mock),
            ),
        )
        assertEquals(1, c.refresh())
        mock.accessError = ScreensError.Http(403, """{"error":"stale order"}""")
        c.answer(allow = true)
        val failed = c.shown.value!!.phase as AccessRequestCenter.Phase.Failed
        assertEquals("The server refused this change: stale order. Check this phone's clock and try again.", failed.message)
        mock.accessError = null
        c.answer(allow = true)
        assertTrue(c.shown.value!!.phase is AccessRequestCenter.Phase.Done)
    }

    @Test fun alerts_aRequestAnsweredElsewhereLeavesTheQueue() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.accessFixture["bright-maple--wiki"] = mock.accessFixture["bright-maple--wiki"]!!.copy(
            pending = listOf(com.flagshipserver.app.api.AppAccessPending("upload.wikimedia.org", "app")),
        )
        val c = center(listOf(AccessBox("pod-home", "home.bright-maple.flagship.services", mock)))
        assertEquals(2, c.refresh())
        mock.serviceAccessDismiss("bright-maple--wiki", "upload.wikimedia.org")
        c.refresh()
        c.notNow()
        assertNull(c.shown.value)
    }

    @Test fun anEventFrameTriggersAFetch() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        var fetches = 0
        val box = object : ScreensClient by mock {
            override suspend fun accessRequests(): AccessRequestsResponse {
                fetches += 1
                return mock.accessRequests()
            }
            override fun screensEvents(): Flow<ScreensEvent> =
                flowOf(ScreensEvent("other"), ScreensEvent(ScreensEvent.ACCESS_REQUEST, plants))
        }
        val c = AccessRequestCenter(
            boxes = { listOf(AccessBox("pod-home", "home.bright-maple.flagship.services", box)) },
            signer = { Ed25519Sign(seed) },
            pollIntervalMs = 1_000_000,
        )
        c.start(backgroundScope)
        testScheduler.runCurrent()
        c.stop()
        assertEquals(2, fetches)
        assertEquals("api.open-meteo.com", c.shown.value!!.alert.request.host)
    }

    @Test fun eventFramesDecode() {
        val e = Json { ignoreUnknownKeys = true }.decodeFromString(
            ScreensEvent.serializer(), """{"type":"access-request","serviceId":"me--w","extra":1}""",
        )
        assertEquals(ScreensEvent("access-request", "me--w"), e)
    }

    // ---- the chat deploy carries the current key ----

    @Test fun chatDeploy_sendsTheCurrentCredential() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        var cred: com.flagshipserver.app.api.LlmProviderCredential? =
            com.flagshipserver.app.api.LlmProviderCredential("anthropic", "sk-ant-x", relay = true)
        val vm = VibeCodeDeployViewModel("s1", mock, scope = backgroundScope, pollIntervalMs = 10, credential = { cred })
        vm.deploy().join()
        cred = cred!!.copy(relay = false)
        vm.deploy().join()
        assertEquals(listOf(true, false), mock.deployCredentials.map { it?.relay })

        val wire = Json { encodeDefaults = true; explicitNulls = false }
        assertEquals(
            """{"provider":"anthropic","apiKey":"k","relay":false}""",
            wire.encodeToString(com.flagshipserver.app.api.LlmProviderCredential.serializer(),
                com.flagshipserver.app.api.LlmProviderCredential("anthropic", "k", relay = false)),
        )
    }

    @Test fun egressOnlyBox_keepsTheOldCard() {
        assertTrue(EgressCardState.from(AppEgress(listOf("a.example")), restricted = false)!!.showsPending)
    }
}
