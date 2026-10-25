// Browser access beyond an app's manifest (SEC-BROWSER-002): the phone lists every box's asks,
// names the app from the box's own list, says exactly which sites and devices, signs Allow as
// flagship/browser-grant/v1 for the duration the owner picks (the ask's or shorter, never longer),
// sends Deny unsigned, refreshes on the box's socket frame, and lists and withdraws what it allowed.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BrowserGrantRequestWire
import com.flagshipserver.app.api.BrowserLocalNetwork
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ScreensEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserGrantCenterTest {
    private val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private val issuedAt = 1_760_000_000_000L
    private val fqdn = "home.bright-maple.flagship.services"

    private fun setup(canAnswer: Boolean = true, alerts: Boolean = true): Triple<BrowserGrantCenter, MockScreensClient, MutableList<String>> {
        val screens = MockScreensClient().apply { seedBrowserGrants() }
        val box = AccessBox("pod-1", fqdn, screens)
        val reasons = mutableListOf<String>()
        val center = BrowserGrantCenter(
            boxes = { listOf(box) },
            canAnswer = { canAnswer },
            alertsEnabled = { alerts },
            signer = { r -> reasons += r; Ed25519Sign(kp.privateKey) },
            now = { issuedAt },
        )
        return Triple(center, screens, reasons)
    }

    @Test fun showsTheVerifiedAppTheExactSitesAndHowLong() = runBlocking {
        val (center, _, _) = setup()
        val l = center.load().requests
        assertEquals(listOf("Plants", "Wiki"), l.map { it.appName })
        val plants = l[0]
        assertEquals("Plants wants to use this server's browser.", BrowserGrantText.wants(plants))
        assertEquals("radar.weather.example" to null, BrowserGrantText.site(plants.request.origins.single()))
        assertEquals(listOf("Open pages", "Take screenshots"), plants.request.capabilities.map { BrowserGrantText.capability(it) })
        assertEquals("For one visit", BrowserGrantText.duration(plants.request.duration))
        assertEquals("Allow once", BrowserGrantText.allowLabel(plants.request.duration))
        assertNull(BrowserGrantText.localNetwork(plants))

        val wiki = l[1]
        assertEquals("*.docs.example.org" to "and every address under it", BrowserGrantText.site(wiki.request.origins.single()))
        assertEquals("These devices on your network: 192.168.1.40", BrowserGrantText.localNetwork(wiki))
        assertEquals("Always allow", BrowserGrantText.allowLabel(wiki.request.duration))
        assertEquals("Until you remove it", BrowserGrantText.duration(wiki.request.duration))
        assertEquals("Allow for this session", BrowserGrantText.allowLabel("session"))
        assertEquals("Until this browser session ends", BrowserGrantText.duration("session"))
    }

    @Test fun anAppNotInTheBoxListIsShownByItsId() = runBlocking {
        val screens = MockScreensClient()
        screens.browserGrantFixture += BrowserGrantRequestWire("6b7c0f1e-3333-4a2b-9c3d-000000000003", "someone--ghost", listOf("navigate"), listOf("a.example"), null, "once")
        val center = BrowserGrantCenter(boxes = { listOf(AccessBox(null, fqdn, screens)) })
        assertEquals("someone--ghost", center.load().requests.single().appName)
    }

    @Test fun asksThePhoneCannotShowExactlyAreDropped() {
        val box = AccessBox(null, fqdn, MockScreensClient())
        val items = BrowserGrantText.read(
            box,
            listOf(
                BrowserGrantRequestWire("a", "s", listOf("navigate"), listOf("x.example"), null, "forever"),
                BrowserGrantRequestWire("b", "s", listOf("teleport"), listOf("x.example"), null, "once"),
                BrowserGrantRequestWire("c", "s", listOf("navigate"), emptyList(), null, "once"),
                BrowserGrantRequestWire("d", "s", listOf("navigate"), emptyList(), BrowserLocalNetwork("exact", emptyList()), "once"),
                BrowserGrantRequestWire("e", "s", listOf("navigate"), emptyList(), BrowserLocalNetwork("whole-lan"), "session"),
            ),
            emptyMap(),
        )
        assertEquals(listOf("e"), items.map { it.request.requestId })
        assertEquals("Every device on your local network", BrowserGrantText.localNetwork(items.single()))
    }

    @Test fun allowSignsExactlyWhatWasShownWithTheAsksDuration() = runBlocking {
        val (center, screens, reasons) = setup()
        val wiki = center.load().requests.first { it.request.serviceId == "bright-maple--wiki" }
        assertNull(center.answer(wiki, true))
        val sent = screens.browserGrantAnswers.single()
        assertEquals("allow", sent.decision)
        assertEquals(issuedAt, sent.issuedAt)
        val bytes = BrowserGrant.canonicalBytes(
            fqdn, wiki.request.requestId, "bright-maple--wiki", "allow", "service",
            listOf("navigate", "read-dom"), listOf("*.docs.example.org"), listOf("192.168.1.40"), false, issuedAt,
        )
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(sent.signature!!)!!, bytes)
        assertEquals(listOf("Allow browser access for Wiki"), reasons)
        assertTrue(center.listing.value.requests.none { it.request.serviceId == "bright-maple--wiki" })
    }

    @Test fun denySendsNoSignatureAndTheBoxCoolsDown() = runBlocking {
        val (center, screens, reasons) = setup()
        val plants = center.load().requests.first()
        assertNull(center.answer(plants, false))
        val sent = screens.browserGrantAnswers.single()
        assertEquals("deny", sent.decision)
        assertNull(sent.signature)
        assertTrue(reasons.isEmpty())
        assertTrue("bright-maple--plants" in screens.browserGrantCooling)
    }

    @Test fun aGoneRequestAndAnAdminOnlyRefusalSaySo() = runBlocking {
        val (center, screens, _) = setup()
        val plants = center.load().requests.first()
        screens.browserGrantFixture.clear()
        assertEquals("That request is no longer waiting.", center.answer(plants, true))
        assertTrue(center.listing.value.requests.none { it.key == plants.key })
        assertEquals(
            "This device can't approve browser access. Use an admin device.",
            BrowserGrantText.error(ScreensError.Http(403, """{"error":"that answer was not signed by the owner"}""")),
        )
    }

    @Test fun aBoxWithTheBrowserOffHasNothingWaiting() = runBlocking {
        val (center, screens, _) = setup()
        screens.browserOff = true
        assertTrue(center.load().requests.isEmpty())
        assertEquals(0, center.refresh())
    }

    @Test fun oneDialogAtATimeAndNoneWithoutTheRightToAnswer() = runBlocking {
        val (center, _, _) = setup()
        assertEquals(2, center.refresh())
        assertEquals("bright-maple--plants", center.shown.value!!.item.request.serviceId)
        center.notNow()
        assertEquals("bright-maple--wiki", center.shown.value!!.item.request.serviceId)
        center.answerShown(false)
        assertTrue(center.shown.value!!.phase is BrowserGrantCenter.Phase.Done)

        val (other, _, _) = setup(canAnswer = false)
        assertEquals(0, other.refresh())
        assertNull(other.shown.value)
        assertEquals(2, other.listing.value.requests.size)
    }

    @Test fun allowOnceOnASessionAskSignsTheSharedNarrowedVector() {
        var dir: java.io.File? = java.io.File(System.getProperty("user.dir")!!).absoluteFile
        var f: java.io.File? = null
        while (dir != null && f == null) {
            f = java.io.File(dir, "packages/protocol/test-vectors/browser-grant/vectors.json").takeIf { it.isFile }
            dir = dir.parentFile
        }
        val v = Json.parseToJsonElement(f!!.readText()).jsonObject
        val answers = v["answers"]!!.jsonArray
        val ask = answers[0].jsonObject["answer"]!!.jsonObject
        val narrowed = answers[5].jsonObject
        val lan = ask["localNetwork"]!!.jsonObject
        val request = BrowserGrantRequestWire(
            requestId = ask["requestId"]!!.jsonPrimitive.content,
            serviceId = ask["serviceId"]!!.jsonPrimitive.content,
            capabilities = ask["capabilities"]!!.jsonArray.map { it.jsonPrimitive.content },
            origins = ask["origins"]!!.jsonArray.map { it.jsonPrimitive.content },
            localNetwork = BrowserLocalNetwork("exact", lan["hosts"]!!.jsonArray.map { it.jsonPrimitive.content }),
            duration = ask["duration"]!!.jsonPrimitive.content,
        )
        val item = BrowserGrantItem(AccessBox(null, fqdn, MockScreensClient()), request, "Shop")
        assertEquals(listOf("once", "session"), item.durationChoices)
        val bytes = BrowserGrantText.canonical(item, ask["serverDomain"]!!.jsonPrimitive.content, ask["issuedAt"]!!.jsonPrimitive.long, "once")
        assertEquals(narrowed["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
        val seed = HexUtil.decode(v["seedHex"]!!.jsonPrimitive.content)!!
        assertEquals(narrowed["signatureHex"]!!.jsonPrimitive.content, HexUtil.encode(Ed25519Sign(seed).sign(bytes)))
    }

    @Test fun theOwnerMayGrantLessThanAskedNeverMore() = runBlocking {
        val (center, screens, _) = setup()
        val wiki = center.load().requests.first { it.request.serviceId == "bright-maple--wiki" }
        assertEquals(listOf("once", "session", "service"), wiki.durationChoices)
        val plants = center.load().requests.first { it.request.serviceId == "bright-maple--plants" }
        assertEquals(listOf("once"), plants.durationChoices)
        // A longer duration than asked is never sent.
        assertTrue(center.answer(plants, true, "service") != null)
        assertTrue(screens.browserGrantAnswers.isEmpty())
        assertNull(center.answer(wiki, true, "once"))
        val sent = screens.browserGrantAnswers.single()
        assertEquals("once", sent.duration)
        val bytes = BrowserGrant.canonicalBytes(
            fqdn, wiki.request.requestId, "bright-maple--wiki", "allow", "once",
            listOf("navigate", "read-dom"), listOf("*.docs.example.org"), listOf("192.168.1.40"), false, issuedAt,
        )
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(sent.signature!!)!!, bytes)
        assertEquals("once", screens.ownerBrowserGrants.single().duration)
    }

    @Test fun aSocketFrameFromTheBoxRefreshesAtOnce() = runBlocking {
        val screens = MockScreensClient()
        val center = BrowserGrantCenter(boxes = { listOf(AccessBox(null, fqdn, screens)) }, now = { issuedAt })
        assertEquals(0, center.refresh())
        screens.seedBrowserGrants()
        center.onEvent(ScreensEvent(ScreensEvent.ACCESS_REQUEST, "bright-maple--plants"))
        assertTrue(center.listing.value.requests.isEmpty())
        center.onEvent(ScreensEvent(ScreensEvent.BROWSER_GRANT_REQUEST, "bright-maple--plants"))
        assertEquals(2, center.listing.value.requests.size)
        assertEquals("browser-grant-request", ScreensEvent.BROWSER_GRANT_REQUEST)
    }

    @Test fun listsWhatTheOwnerAllowedAndWithdrawsItSigned() = runBlocking {
        val (center, screens, reasons) = setup()
        screens.seedOwnerBrowserGrant()
        val given = center.loadGrants("bright-maple--plants")
        assertEquals(listOf("docs.plants.example"), given.single().grant.origins)
        assertTrue(center.loadGrants("bright-maple--wiki").isEmpty())
        assertNull(center.withdraw(given.single(), "Plants"))
        val sent = screens.browserGrantRevokes.single()
        Ed25519Verify(kp.publicKey).verify(
            HexUtil.decode(sent.signature)!!,
            BrowserGrant.revokeCanonicalBytes(fqdn, "bright-maple--plants", "bg-0f4c9a1e-2d3b-4c5d-8e6f-7a8b9c0d1e2f", issuedAt),
        )
        assertEquals(listOf("Withdraw Plants's browser access"), reasons)
        assertTrue(center.grantsFor("bright-maple--plants").isEmpty())
        assertTrue(screens.ownerBrowserGrants.isEmpty())
        // Already gone on the box: it says so and the card goes.
        screens.seedOwnerBrowserGrant()
        val again = center.loadGrants("bright-maple--plants").single()
        screens.ownerBrowserGrants.clear()
        assertEquals("That access was already withdrawn.", center.withdraw(again, "Plants"))
        assertTrue(center.grantsFor("bright-maple--plants").isEmpty())
        assertEquals("Browser access withdrawn", BrowserGrantText.withdrawn())
    }

    @Test fun anAllowAddsToTheAppsAllowedList() = runBlocking {
        val (center, _, _) = setup()
        assertTrue(center.loadGrants("bright-maple--wiki").isEmpty())
        val wiki = center.load().requests.first { it.request.serviceId == "bright-maple--wiki" }
        assertNull(center.answer(wiki, true, "session"))
        assertEquals("session", center.grantsFor("bright-maple--wiki").single().grant.duration)
    }
}
