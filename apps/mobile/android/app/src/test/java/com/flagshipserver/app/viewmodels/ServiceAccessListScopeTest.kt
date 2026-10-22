// A separate access list on each server (Pro; feat/marketplace) on the Access
// control screen: the switch only on admin devices, locked without Pro, the
// signed flagship/app-list-scope/v1 order (admin root), the 402 Pro line, the
// turn-off confirm naming the leader, and the server picker that retargets
// the members and mode calls to the picked server.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.AppListScope
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceAccessListScopeTest {
    private val home = "home.bright-maple.flagship.services"
    private val office = "office.bright-maple.flagship.services"
    private val serviceRef = "bright-maple--notes"
    private val umkSeed = ByteArray(32) { 0x0b }
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private val deviceKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 6 })
    private val names = mapOf(home to "Living room", office to "Office")

    private class Recorder : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        val calls = mutableListOf<Pair<String, String>>()
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            calls += method to url
            return HttpResponse(200, "{}".toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    private fun box(context: String = "home", plan: String = "pro", scope: String? = null) =
        MockScreensClient(simulatedLatencyMs = 0).apply {
            podContext = context
            listScopePlan = plan
            listScopeServers = listOf(home, office)
            if (scope != null) listScopes[serviceRef] = scope
        }

    private fun vm(
        screens: ScreensClient,
        admin: Boolean = true,
        transport: Recorder = Recorder(),
        now: () -> Long = { 1700 },
        others: Map<String, ScreensClient> = emptyMap(),
    ) = ServiceAccessViewModel(
        serverDomain = home, serviceRef = serviceRef, username = "bright-maple",
        client = ServiceAccessClient(boxTransport = transport, comTransport = transport),
        aidSigner = { ServerKeys.deriveAccountId(umkSeed) },
        aidPubHex = { HexUtil.encode(ServerKeys.deriveAccountIdPub(umkSeed)) },
        householdKey = { ServerKeys.deriveHouseholdKey(umkSeed) },
        now = now,
        screens = screens,
        isAdminDevice = { admin },
        adminSigner = { Ed25519Sign(adminKp.privateKey) },
        deviceId = { "0123456789abcdef0123456789abcdef" },
        deviceSigner = { Ed25519Sign(deviceKp.privateKey) },
        ownDevicePubHex = { HexUtil.encode(deviceKp.publicKey) },
        screensFor = { others[it] },
        serverName = { names[it] ?: AppListScope.firstLabel(it) },
    )

    @Test fun theSwitchIsHiddenOnADeviceThatIsntAnAdmin() = runTest {
        val v = vm(box(scope = "server"), admin = false)
        v.load()
        assertFalse(v.showsListScopeToggle)
        assertFalse(v.showsListScopeProLine)
        assertEquals("Each server has its own list.", v.listScopeReadOnlyLine)
        assertFalse(v.setListScope(false))

        val off = vm(box(), admin = false)
        off.load()
        assertFalse(off.showsListScopeToggle)
        assertNull(off.listScopeReadOnlyLine)
    }

    @Test fun withoutProTheSwitchIsLockedAndSendsNothing() = runTest {
        val b = box(plan = "free")
        val v = vm(b)
        v.load()
        assertTrue(v.showsListScopeToggle)
        assertFalse(v.listScopeOn)
        assertTrue(v.listScopeLocked)
        assertTrue(v.showsListScopeProLine)
        assertFalse(v.setListScope(true))
        assertTrue(b.setListScopeCalls.isEmpty())
    }

    @Test fun turningOnSignsTheServerOrderWithTheAdminRootAndPostsIt() = runTest {
        val b = box()
        val v = vm(b)
        v.load()
        assertFalse(v.listScopeLocked)
        assertFalse(v.showsListScopeProLine)
        assertEquals(AppListScope.ON_CONFIRM, v.listScopeConfirm(true).second)
        assertTrue(v.setListScope(true))
        val (ref, req) = b.setListScopeCalls.single()
        assertEquals(serviceRef, ref)
        assertEquals("server", req.order.scope)
        assertEquals(1700L, req.order.issuedAt)
        val bytes = AppListScope.canonicalBytes(AppListScope.Order(serviceRef, "server", 1700))
        assertEquals("flagship/app-list-scope/v1|$serviceRef|server|1700", String(bytes))
        val sig = HexUtil.decode(req.signature)!!
        assertTrue("signed by the admin root", ServiceInvite.verify(sig, bytes, adminKp.publicKey))
        assertFalse("never the device key", ServiceInvite.verify(sig, bytes, deviceKp.publicKey))
        assertTrue(v.listScopeOn)
        assertTrue(v.showsServerPicker)
    }

    @Test fun a402ShowsTheProLine() = runTest {
        val b = box().apply { listScopeStatus = 402 }
        val v = vm(b)
        v.load()
        assertFalse(v.setListScope(true))
        assertTrue(v.scopeNeedsPro.value)
        assertTrue(v.showsListScopeProLine)
        assertFalse(v.listScopeOn)
    }

    @Test fun a409IsSignedOnceMoreNewer() = runTest {
        val b = box().apply { listScopeStatus = 409 }
        var t = 1700L
        val v = vm(b, now = { t++ })
        v.load()
        assertTrue(v.setListScope(true))
        assertEquals(2, b.setListScopeCalls.size)
        assertTrue(b.setListScopeCalls[1].second.order.issuedAt > b.setListScopeCalls[0].second.order.issuedAt)
    }

    @Test fun turningOffNamesTheLeadersList() = runTest {
        val b = box(scope = "server")
        val v = vm(b)
        v.load()
        assertTrue(v.listScopeOn)
        val (title, text) = v.listScopeConfirm(false)
        assertEquals(AppListScope.OFF_TITLE, title)
        assertEquals("Every server will use Living room's list. People who joined on other servers since lose access.", text)
        assertTrue(v.setListScope(false))
        assertEquals("account", b.setListScopeCalls.single().second.order.scope)
        assertFalse(v.showsServerPicker)
    }

    @Test fun thePickerShowsOnlyWithSeparateLists() = runTest {
        val v = vm(box(scope = "account"))
        v.load()
        assertFalse(v.showsServerPicker)
        assertTrue(v.pickerServers.isEmpty())

        val w = vm(box(scope = "server"))
        w.load()
        assertTrue(w.showsServerPicker)
        assertEquals(listOf(home, office), w.pickerServers)
        assertEquals(home, w.shownServer.value)
        assertEquals("Office", w.serverLabel(office))
    }

    @Test fun pickingAServerRetargetsTheMembersAndModeCalls() = runTest {
        val homeBox = box(scope = "server")
        val officeBox = box(context = "office", scope = "server")
        val rec = Recorder()
        val v = vm(homeBox, transport = rec, others = mapOf(office to officeBox))
        v.load()
        assertTrue(rec.calls.any { it.second == "https://$home/api/service-access/$serviceRef" })

        rec.calls.clear()
        assertTrue(v.selectServer(office))
        assertEquals(office, v.shownServer.value)
        assertEquals(office, v.listScope.value?.self)
        assertTrue(rec.calls.any { it.second == "https://$office/api/service-access/$serviceRef" })
        assertFalse(rec.calls.any { it.second.startsWith("https://$home/") })

        assertTrue(v.setMode(restricted = true))
        assertEquals("POST" to "https://$office/api/service-access", rec.calls.last())

        val other = v.members.value!!.accountMembers.first { it.deviceId == MockScreensClient.OTHER_DEVICE_ID }
        assertTrue(v.setAccountRank(other, com.flagshipserver.app.core.AppMemberRole.MANAGER))
        assertEquals(1, officeBox.setAppRankCalls.size)
        assertTrue(homeBox.setAppRankCalls.isEmpty())

        assertTrue(v.setListScope(false))
        assertEquals("the order goes to the shown server", 1, officeBox.setListScopeCalls.size)
        assertTrue(homeBox.setListScopeCalls.isEmpty())
        assertEquals("back to the server it opened on", home, v.shownServer.value)
    }

    @Test fun aServerWithoutASessionIsRefusedPlainly() = runTest {
        val v = vm(box(scope = "server"))
        v.load()
        assertFalse(v.selectServer(office))
        assertEquals(ServiceAccessPhase.Failed("This phone isn't set up on Office."), v.phase.value)
        assertEquals(home, v.shownServer.value)
    }

    @Test fun anOlderBoxHidesTheWholeRow() = runTest {
        val v = vm(object : ScreensClient by box() {
            override suspend fun appListScope(serviceId: String) = throw com.flagshipserver.app.api.ScreensError.Http(404, "{}")
        })
        v.load()
        assertNull(v.listScope.value)
        assertFalse(v.showsListScopeToggle)
        assertFalse(v.showsServerPicker)
    }

    private val rows = listOf(
        AccessPerson("known", "Alex", null, bound = true, boundAidHex = "ab".repeat(32)),
        AccessPerson("granted", "Chess club", null, bound = true, isGroup = true, redemptions = 2, memberAids = listOf("cd".repeat(32))),
        AccessPerson("unused", "Sam", null, bound = false),
        AccessPerson("elsewhere", "Jo", null, bound = true, boundAidHex = "ef".repeat(32)),
        AccessPerson("elsewhere-group", "Club", null, bound = false, isGroup = true, redemptions = 1),
    )
    private val shownBox = com.flagshipserver.app.api.AppMembersResponse(
        serviceId = serviceRef, mode = "open", defaultRole = "member",
        members = listOf(com.flagshipserver.app.api.AppMember("cd".repeat(32), "member", listOf(com.flagshipserver.app.api.AppMemberGrant("granted", "member")))),
        invites = listOf(com.flagshipserver.app.api.AppMemberInviteRole("known", "member")),
    )
    private fun scope(s: String) = com.flagshipserver.app.api.AppListScopeState(serviceRef = serviceRef, scope = s, plan = "pro", self = home)

    @Test fun separateListsKeepOnlyTheShownServersInvitesAndUnusedLinks() {
        val v = vm(box())
        assertEquals(listOf("known", "granted", "unused"), v.peopleOnShownServer(rows, shownBox, scope("server")).map { it.inviteId })
    }

    @Test fun oneListKeepsEveryInvite() {
        val v = vm(box())
        assertEquals(rows, v.peopleOnShownServer(rows, shownBox, scope("account")))
    }

    @Test fun noMembersAnswerKeepsEveryInvite() {
        val v = vm(box())
        assertEquals(rows, v.peopleOnShownServer(rows, null, scope("server")))
        assertEquals(rows, v.peopleOnShownServer(rows, shownBox, null))
    }
}
