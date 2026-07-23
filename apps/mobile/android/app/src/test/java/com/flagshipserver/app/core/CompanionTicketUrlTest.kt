// P14 — pin the Android companion-ticket URL builder against the iOS
// + webapp encoders. The QR payload that lands in the desktop browser
// must be byte-identical across all three surfaces or the redeem
// handler will reject it.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionTicketUrlTest {

    @Test fun desktopDockLinkParses() {
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        val parsed = CompanionDockApprovalLink.parse(
            "flagship://dock?server=demo.alice.flagship.services&request=$request&code=$code",
        )
        assertNotNull(parsed)
        assertEquals("demo.alice.flagship.services", parsed!!.serverDomain)
        assertEquals(request, parsed.requestId)
        assertEquals(code, parsed.approvalSecret)
    }

    /** The feature was renamed dock -> remote on 2026-07-23. The webapp now
     *  emits `flagship://remote`; `flagship://dock` stays parseable so a
     *  browser still serving the pre-rename shell keeps working. */
    @Test fun remoteLinkParsesIdenticallyToTheLegacyDockLink() {
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        val query = "server=demo.alice.flagship.services&request=$request&code=$code"
        val viaRemote = CompanionDockApprovalLink.parse("flagship://remote?$query")
        val viaDock = CompanionDockApprovalLink.parse("flagship://dock?$query")
        assertNotNull(viaRemote)
        assertEquals(viaDock, viaRemote)
    }

    @Test fun desktopDockLinkRejectsWrongShape() {
        assertEquals(null, CompanionDockApprovalLink.parse("flagship://dock?server=evil.example&request=x&code=y"))
        // Only the two sanctioned labels — a third host is not a remote link.
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        assertEquals(
            null,
            CompanionDockApprovalLink.parse(
                "flagship://companion?server=demo.alice.flagship.services&request=$request&code=$code",
            ),
        )
    }

    @Test fun urlHasCanonicalPrefix() {
        val url = CompanionTicketUrl.build(
            ticketId = "tk-1",
            ticketSecret = "s",
            podBaseUrl = "https://home.alice.flagship.services",
            username = "alice",
        )
        assertTrue(url, url.startsWith("https://webapp.flagshipserver.com/?companion="))
    }

    @Test fun payloadIsBase64UrlNoPadding() {
        val url = CompanionTicketUrl.build(
            ticketId = "tk-1",
            ticketSecret = "abc",
            podBaseUrl = "https://home.alice.flagship.services",
            username = "alice",
        )
        val encoded = url.removePrefix("https://webapp.flagshipserver.com/?companion=")
        assertFalse("base64url has no padding", encoded.contains("="))
        assertFalse("base64url uses '-' not '+'", encoded.contains("+"))
        assertFalse("base64url uses '_' not '/'", encoded.contains("/"))
    }

    @Test fun jsonRoundTripsIdentically() {
        val ticketId = "tk-12345678"
        val ticketSecret = "deadbeefcafef00d"
        val podBaseUrl = "https://home.alice.flagship.services"
        val username = "alice"

        val url = CompanionTicketUrl.build(ticketId, ticketSecret, podBaseUrl, username)
        val encoded = url.removePrefix("https://webapp.flagshipserver.com/?companion=")
        val decoded = Base64URL.decode(encoded)
        assertNotNull(decoded)
        val jsonString = String(decoded!!, Charsets.UTF_8)

        val parsed = Json.parseToJsonElement(jsonString) as JsonObject
        assertEquals(ticketId, parsed["ticketId"]!!.jsonPrimitive.content)
        assertEquals(ticketSecret, parsed["ticketSecret"]!!.jsonPrimitive.content)
        assertEquals(podBaseUrl, parsed["podBaseUrl"]!!.jsonPrimitive.content)
        assertEquals(username, parsed["username"]!!.jsonPrimitive.content)
    }

    @Test fun fieldOrderIsCanonical() {
        val url = CompanionTicketUrl.build(
            ticketId = "T",
            ticketSecret = "S",
            podBaseUrl = "U",
            username = "N",
        )
        val encoded = url.removePrefix("https://webapp.flagshipserver.com/?companion=")
        val jsonString = String(Base64URL.decode(encoded)!!, Charsets.UTF_8)
        // Declaration order in CompanionTicketPayload + kotlinx-serialization's
        // preservation thereof + the daemon TS encoder + iOS Codable all keep
        // the same order. Anchor it here so a refactor can't silently shuffle.
        assertEquals(
            """{"ticketId":"T","ticketSecret":"S","podBaseUrl":"U","username":"N"}""",
            jsonString,
        )
    }

    @Test fun emptyStringsAreEncodedNotDropped() {
        val url = CompanionTicketUrl.build(
            ticketId = "",
            ticketSecret = "",
            podBaseUrl = "",
            username = "",
        )
        val encoded = url.removePrefix("https://webapp.flagshipserver.com/?companion=")
        val jsonString = String(Base64URL.decode(encoded)!!, Charsets.UTF_8)
        assertEquals(
            """{"ticketId":"","ticketSecret":"","podBaseUrl":"","username":""}""",
            jsonString,
        )
    }

    @Test fun specialCharsInPayloadRoundTrip() {
        val ticketId = "tk/with+special chars"
        val ticketSecret = "s|e|c"
        val podBaseUrl = "https://home.alice.flagship.services/"
        val username = "alice"
        val url = CompanionTicketUrl.build(ticketId, ticketSecret, podBaseUrl, username)
        val encoded = url.removePrefix("https://webapp.flagshipserver.com/?companion=")
        val decoded = Base64URL.decode(encoded)
        assertNotNull(decoded)
        val parsed = Json.parseToJsonElement(String(decoded!!, Charsets.UTF_8)) as JsonObject
        assertEquals(ticketId, parsed["ticketId"]!!.jsonPrimitive.content)
        assertEquals(ticketSecret, parsed["ticketSecret"]!!.jsonPrimitive.content)
    }
}
