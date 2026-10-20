// The security notice's fetch, store and decisions end to end with a throwaway
// authority (the baked pin is never involved): a verified update-required notice
// locks, a forged one, a failed fetch and junk lock nothing, an older notice
// cannot bring a lock back, and the lock lifts by itself (docs/security-notices.md).

package com.flagshipserver.app.core

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SecurityNoticeCenterTest {
    private val t0 = 1_792_000_000_000L
    private val day = 86_400_000L
    private val a = NoticeGymAuthority(seedByte = 0x77, now = t0)
    private val other = NoticeGymAuthority(seedByte = 0x78, now = t0)

    private var clock = t0 + day
    private var served: NoticeFetch = NoticeFetch.NoNotice
    private val backend = MemoryNoticeStoreBackend()

    private fun center(build: Long = 8, b: NoticeStoreBackend = backend, pin: String = a.pin, lockEnabled: Boolean = true) = SecurityNoticeCenter(
        backend = b,
        fetcher = { NoticeFetcher { served } },
        client = NoticeClient("android", build, SecurityNoticeProtocol.CLIENT_PROTOCOL_LEVEL),
        pin = { pin },
        clock = { clock },
        jitterMs = { 0 },
        lockEnabled = { lockEnabled },
    )

    private fun lockNotice(seq: Long = 3, lockFrom: Long = t0, auth: NoticeGymAuthority = a) = auth.notice(
        seq = seq, kind = "update-required", validFrom = t0, validUntil = t0 + 20 * day,
        eventAt = t0 + 2 * day, lockFrom = lockFrom,
        platforms = mapOf("android" to (9L to 1L), "ios" to (12L to 1L), "web" to (150L to 1L)),
        advisoryId = "FSA-2026-001", reason = "A flaw lets an attacker act as you.",
        message = "You must update Flagship by {date}. Older versions will stop working.",
    )

    private fun serve(auth: NoticeGymAuthority, notice: kotlinx.serialization.json.JsonElement) {
        served = NoticeFetch.Document(auth.response(notice))
    }

    @Before fun fresh() = UpdateLock.set(false)
    @After fun cleanup() = UpdateLock.set(false)

    @Test fun withTheLockSwitchedOffAnUpdateRequiredNoticeOnlyNags() = runBlocking {
        val c = center(lockEnabled = false)
        serve(a, lockNotice())
        assertTrue(c.refresh().fetched)
        assertTrue(c.outcome.value is NoticeOutcome.Banner)
        assertFalse(UpdateLock.isLocked)
    }

    @Test fun aLockedPhoneStillLetsTheOwnersServerStart() {
        UpdateLock.set(true)
        val apex = Endpoints.controlHost
        assertTrue(UpdateLock.allows("POST", apex, path = "/api/secret-requests"))
        assertTrue(UpdateLock.allows("POST", "boot.$apex", path = "/api/boot/response"))
        assertFalse(UpdateLock.allows("POST", apex, path = "/api/accounts/x/server-order"))
        assertFalse(UpdateLock.allows("POST", "boot.$apex", path = "/api/boot/lease"))
        assertFalse(UpdateLock.allows("POST", "evil.$apex", path = "/api/boot/response"))
        assertFalse(UpdateLock.allows("PUT", "boot.$apex", path = "/api/boot/response"))
        assertTrue(UpdateLock.allows("GET", apex))
    }

    @Test fun aVerifiedUpdateRequiredNoticeLocksAndIsRemembered() = runBlocking {
        val c = center()
        serve(a, lockNotice())
        val r = c.refresh()
        assertTrue(r.fetched)
        assertNull(r.refused)
        assertTrue(c.outcome.value is NoticeOutcome.Lock)
        assertTrue(UpdateLock.isLocked)
        val s = c.load()
        assertEquals(3L, s.highestSeq)
        assertTrue(s.tip > 0)
        // A fresh process decides the same from the store alone.
        val again = center()
        again.evaluate()
        assertTrue(again.outcome.value is NoticeOutcome.Lock)
    }

    @Test fun aLockSignedByAnotherChainLocksNothing() = runBlocking {
        val c = center()
        serve(other, lockNotice(auth = other))
        val r = c.refresh()
        assertEquals("unauthorized-signer", r.refused)
        assertEquals(NoticeOutcome.nothing, c.outcome.value)
        assertFalse(UpdateLock.isLocked)
        assertEquals(0L, c.load().highestSeq)
    }

    @Test fun aChainThatDoesNotHashToThePinLocksNothing() = runBlocking {
        val c = center(pin = "00".repeat(32))
        serve(a, lockNotice())
        c.refresh()
        assertFalse(UpdateLock.isLocked)
        assertNull(c.load().doc)
    }

    @Test fun noNoticeAnErrorAndJunkChangeNothing() = runBlocking {
        val c = center()
        serve(a, lockNotice())
        c.refresh()
        assertTrue(UpdateLock.isLocked)
        for (miss in listOf(NoticeFetch.NoNotice, NoticeFetch.Failed, NoticeFetch.Document("not json"), NoticeFetch.Document("{}"), NoticeFetch.Document("[1]"))) {
            served = miss
            c.refresh()
            assertTrue("still locked after $miss", UpdateLock.isLocked)
            assertEquals(3L, c.load().highestSeq)
        }
    }

    @Test fun anOlderNoticeCannotBringTheLockBackAndAnAllClearLiftsIt() = runBlocking {
        val c = center()
        serve(a, lockNotice(seq = 5))
        c.refresh()
        assertTrue(UpdateLock.isLocked)
        // A replay of an older (lower seq) lock after the all clear stays refused.
        serve(a, a.notice(seq = 6, kind = "none", validFrom = t0, validUntil = t0 + 20 * day, message = ""))
        c.refresh()
        assertFalse(UpdateLock.isLocked)
        assertEquals(6L, c.load().highestSeq)
        serve(a, lockNotice(seq = 5))
        val r = c.refresh()
        assertEquals("stale", r.refused)
        assertFalse(UpdateLock.isLocked)
    }

    @Test fun theLockLiftsWhenTheBuildIsUpdatedOrTheNoticeEnds() = runBlocking {
        center().also { serve(a, lockNotice()); it.refresh() }
        assertTrue(UpdateLock.isLocked)
        val updated = center(build = 9)
        updated.evaluate()
        assertEquals(NoticeOutcome.None("up-to-date"), updated.outcome.value)
        assertFalse(UpdateLock.isLocked)
        // Same old build, past validUntil: a lock is never shown past it, however stale the cache.
        clock = t0 + 21 * day
        val late = center()
        late.evaluate()
        assertEquals(NoticeOutcome.None("expired"), late.outcome.value)
        assertFalse(UpdateLock.isLocked)
    }

    @Test fun aGraceWindowNagsThenLocks() = runBlocking {
        val c = center()
        serve(a, lockNotice(lockFrom = t0 + 3 * day))
        c.refresh()
        val banner = c.outcome.value as NoticeOutcome.Banner
        assertEquals("update", banner.style)
        assertFalse(UpdateLock.isLocked)
        assertTrue(c.banner.value != null)
        clock = t0 + 3 * day + 1
        c.evaluate()
        assertTrue(c.outcome.value is NoticeOutcome.Lock)
        assertTrue(UpdateLock.isLocked)
        assertNull(c.banner.value)
    }

    @Test fun anAuthorityOlderThanTheTipLocksNothing() = runBlocking {
        val c = center()
        serve(a, lockNotice())
        c.refresh()
        assertTrue(UpdateLock.isLocked)
        // The device has seen a newer authority mandate than the chain it holds: that chain is refused.
        val s = c.load()
        backend.write(s.copy(tip = Long.MAX_VALUE / 4).toJson())
        c.evaluate()
        assertFalse(UpdateLock.isLocked)
    }

    @Test fun aCorruptStoreIsAnEmptyOne() = runBlocking {
        val bad = MemoryNoticeStoreBackend("{{{")
        val c = center(b = bad)
        c.evaluate()
        assertEquals(NoticeOutcome.nothing, c.outcome.value)
        assertEquals(StoredNotices(), c.load())
        assertEquals(StoredNotices(), StoredNotices.parse("[]"))
    }

    @Test fun aMaintenanceBannerStaysDismissedAndAnAdvisoryReturnsAfterADay() = runBlocking {
        val c = center()
        serve(a, a.notice(seq = 1, kind = "maintenance", validFrom = t0, validUntil = t0 + 20 * day, eventAt = t0 + 5 * day, message = "We will update on {date}. Flagship may be briefly unavailable."))
        c.refresh()
        val m = c.banner.value!!
        assertEquals("maintenance", m.style)
        c.dismiss(m)
        assertNull(c.banner.value)
        clock += 10 * day / 2
        c.evaluate()
        assertNull("a maintenance banner stays dismissed for its seq", c.banner.value)

        // An advisory comes back a day after it was dismissed; a new seq shows again at once.
        serve(a, a.notice(seq = 2, kind = "update-advisory", validFrom = t0, validUntil = t0 + 20 * day, message = "A new version is out.", platforms = mapOf("android" to (9L to 0L))))
        c.refresh()
        val adv = c.banner.value!!
        assertEquals("update", adv.style)
        c.dismiss(adv)
        assertNull(c.banner.value)
        clock += day - 1
        c.evaluate()
        assertNull(c.banner.value)
        clock += 2
        c.evaluate()
        assertEquals(2L, c.banner.value?.notice?.seq)
    }

    @Test fun theGraceBannerComesBackOnEveryLaunch() = runBlocking {
        val c = center()
        serve(a, lockNotice(lockFrom = t0 + 5 * day))
        c.refresh()
        c.dismiss(c.banner.value!!)
        assertNull(c.banner.value)
        c.evaluate()
        assertNull("dismissal lasts the launch", c.banner.value)
        val relaunch = center()
        relaunch.evaluate()
        assertTrue(relaunch.banner.value != null)
    }

    @Test fun theBannerSaysTheDateInThePersonsOwnFormat() {
        val n = SecurityNoticeProtocol.parse(lockNotice())!!
        val text = SecurityNoticeProtocol.text(n) { "Friday, October 23 at 9:00 AM" }
        assertEquals("You must update Flagship by Friday, October 23 at 9:00 AM. Older versions will stop working.", text)
    }

    @Test fun theLockScreenAndBannerSayExactlyWhatTheSpecSays() {
        val n = SecurityNoticeProtocol.parse(lockNotice())!!
        val m = SecurityNoticeModels.lock(n, unlocked = true) { "DATE" }
        assertEquals("Security update", m.kicker)
        assertEquals("Update required", m.title)
        assertEquals("You must update Flagship by DATE. Older versions will stop working.", m.body)
        assertEquals("Why: A flaw lets an attacker act as you.", m.why)
        assertEquals("Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.", m.reassure)
        assertEquals("Update Flagship", m.update)
        assertEquals("Back up my account key", m.backup)
        assertEquals("Sign out", m.signOut)
        assertEquals("Advisory FSA-2026-001 · Signed by the Flagship maintainers", m.meta)
        assertEquals("Unlock to back up my account key", SecurityNoticeModels.lock(n, unlocked = false) { "DATE" }.backup)
        assertEquals("https://play.google.com/store/apps/details?id=com.flagshipserver.app", SecurityNoticeCopy.STORE_URL)
        assertEquals("Couldn't update yet. Check your connection and try again.", SecurityNoticeCopy.UPDATE_FAILED)
        val b = SecurityNoticeModels.banner(NoticeOutcome.Banner("update", n)) { "DATE" }
        assertEquals("Update", b.action)
        assertEquals("Dismiss", b.dismiss)
        assertNull(SecurityNoticeModels.banner(NoticeOutcome.Banner("maintenance", n)) { "DATE" }.action)
    }

    // ---- the lock's network gate ----

    private fun gateClient(sent: MutableList<Request>) = OkHttpClient.Builder()
        .addInterceptor(UpdateLockInterceptor())
        .addInterceptor(Interceptor { chain ->
            sent.add(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        })
        .build()

    @Test fun whileLockedOnlyReadsFromTheControlApexLeaveTheApp() {
        val sent = ArrayList<Request>()
        val client = gateClient(sent)
        val json = "{}".toRequestBody("application/json".toMediaType())
        fun get(url: String) = client.newCall(Request.Builder().url(url).get().build()).execute().close()
        fun post(url: String) = client.newCall(Request.Builder().url(url).post(json).build()).execute().close()

        UpdateLock.set(false)
        post("https://flagshipserver.com/api/anything")
        get("https://home.me.flagship.services/api/screens/x")
        assertEquals(2, sent.size)

        sent.clear()
        UpdateLock.set(true)
        get("https://flagshipserver.com/api/accounts/me/devices")
        client.newCall(Request.Builder().url("https://flagshipserver.com/api/health").head().build()).execute().close()
        assertEquals(2, sent.size)

        for (bad in listOf<() -> Unit>(
            { post("https://flagshipserver.com/api/orders/send") },
            { get("https://home.me.flagship.services/api/screens/x") },
            { get("https://recovery.flagshipserver.com/x") },
            { get("https://example.com/") },
            { client.newCall(Request.Builder().url("https://flagshipserver.com/x").delete().build()).execute().close() },
        )) {
            assertThrows(UpdateRequiredException::class.java) { bad() }
        }
        assertEquals("nothing else left the app", 2, sent.size)
        assertEquals("Update required. Flagship is paused on this device until you update.", UpdateLock.REFUSAL)
    }

    @Test fun theLockRefusesTheSigningOfAnApprovalAndTheFactoryClientCarriesTheGateFirst() {
        UpdateLock.set(true)
        assertThrows(UpdateRequiredException::class.java) { UpdateLock.requireUnlocked() }
        UpdateLock.set(false)
        UpdateLock.requireUnlocked()
        val first = HttpClientFactory.build().interceptors.first()
        assertTrue("the lock's gate is installed first", first is UpdateLockInterceptor)
    }

    // ---- the fetch is anonymous ----

    @Test fun theFetchIsOneBareGetWithNoCookieHeaderQueryOrRedirect() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "/elsewhere").addHeader("Set-Cookie", "a=b"))
        server.enqueue(MockResponse().setResponseCode(200).setBody(a.response(lockNotice())))
        server.start()
        try {
            val fetcher = AnonymousNoticeFetcher(baseUrl = { server.url("").toString().trimEnd('/') })
            assertEquals(NoticeFetch.NoNotice, fetcher.fetch())
            assertEquals("a redirect is a failure", NoticeFetch.Failed, fetcher.fetch())
            assertTrue(fetcher.fetch() is NoticeFetch.Document)
            assertEquals("no redirect was followed", 3, server.requestCount)
            repeat(3) {
                val req = server.takeRequest()
                assertEquals("GET", req.method)
                assertEquals("/api/notices", req.path)
                assertEquals(0, req.bodySize)
                val names = req.headers.names().map { it.lowercase() }
                for (forbidden in listOf("cookie", "authorization", "referer", "origin", "x-flagship-device", "x-flagship-session")) {
                    assertFalse("sent $forbidden", forbidden in names)
                }
                assertTrue("no x-flagship-* header", names.none { it.startsWith("x-flagship") })
            }
            val client = AnonymousNoticeFetcher.anonymousClient()
            assertFalse(client.followRedirects)
            assertFalse(client.followSslRedirects)
            assertEquals(okhttp3.CookieJar.NO_COOKIES, client.cookieJar)
            assertTrue("the notice fetch is not routed through the app's gated client", client.interceptors.none { it is UpdateLockInterceptor })
        } finally {
            server.shutdown()
        }
    }

    @Test fun aFailedFetchIsSilent() = runBlocking {
        val fetcher = AnonymousNoticeFetcher(baseUrl = { "http://127.0.0.1:1" })
        assertEquals(NoticeFetch.Failed, fetcher.fetch())
    }

    @Test fun onlyOneRefreshIsInFlightAtATime() = runBlocking {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val c = SecurityNoticeCenter(
            backend = MemoryNoticeStoreBackend(),
            fetcher = { NoticeFetcher { gate.await(); NoticeFetch.NoNotice } },
            client = NoticeClient("android", 8, 1),
            pin = { a.pin },
            clock = { clock },
            jitterMs = { 0 },
        )
        val first = async(kotlinx.coroutines.Dispatchers.Default) { c.refresh() }
        kotlinx.coroutines.delay(50)
        assertEquals("busy", c.refresh().refused)
        gate.complete(Unit)
        assertTrue(first.await().fetched)
    }
}
