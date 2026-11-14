// The remote page's QR parser and the sealed ticket's wire shape (byte-identical
// with iOS + the webapp, or the browser rejects it).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CompanionTicketUrlTest {

    private val sid = Base64URL.encode(ByteArray(16) { it.toByte() })
    private val pk = Base64URL.encode(ByteArray(32) { 7 })

    @Test fun remotePageCodeParses() {
        val parsed = RemoteApprovalLink.parse("flagship://remote?s=$sid&k=$pk")
        assertNotNull(parsed)
        assertEquals(sid, parsed!!.sid)
        assertEquals(32, parsed.browserPublicKey.size)
    }

    @Test fun remotePageAppLinkParses() {
        for (raw in listOf(
            "https://flagshipserver.com/remote?s=$sid&k=$pk",
            "https://flagshipserver.com/remote/?s=$sid&k=$pk",
            "https://www.flagshipserver.com/remote?s=$sid&k=$pk",
        )) {
            val parsed = RemoteApprovalLink.parse(raw)
            assertNotNull(raw, parsed)
            assertEquals(sid, parsed!!.sid)
        }
        assertNull(RemoteApprovalLink.parse("https://evil.example/remote?s=$sid&k=$pk"))
        assertNull(RemoteApprovalLink.parse("http://flagshipserver.com/remote?s=$sid&k=$pk"))
        assertNull(RemoteApprovalLink.parse("https://flagshipserver.com/remote?s=short&k=$pk"))
    }

    @Test fun remotePageCodeRejectsOtherShapes() {
        // The old desktop-begin link (server/request/code) is gone.
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        assertNull(RemoteApprovalLink.parse("flagship://remote?server=demo.alice.flagship.services&request=$request&code=$code"))
        assertNull(RemoteApprovalLink.parse("flagship://dock?s=$sid&k=$pk"))
        // A create-server QR carries the same s/k shape under another host.
        assertNull(RemoteApprovalLink.parse("https://flagshipserver.com/qr?s=$sid&k=$pk"))
        assertNull(RemoteApprovalLink.parse("flagship://remote?s=$sid&k=${Base64URL.encode(ByteArray(31))}"))
        assertNull(RemoteApprovalLink.parse("flagship://remote?s=short&k=$pk"))
    }

    @Test fun remoteTicketCarriesItsKind() {
        val json = Json { encodeDefaults = true }.encodeToString(
            RemoteTicketPayload.serializer(),
            RemoteTicketPayload(ticketId = "T", ticketSecret = "S", podBaseUrl = "U", username = "N"),
        )
        assertEquals(
            """{"kind":"flagship/remote-ticket/v1","ticketId":"T","ticketSecret":"S","podBaseUrl":"U","username":"N"}""",
            json,
        )
    }

    @Test fun extensionCodeParses() {
        for (raw in listOf(
            "https://flagshipserver.com/pair-extension?s=$sid&k=$pk",
            "https://flagshipserver.com/pair-extension/?s=$sid&k=$pk",
            "flagship://pair-extension?s=$sid&k=$pk",
        )) {
            val parsed = ExtensionPairLink.parse(raw)
            assertNotNull(raw, parsed)
            assertEquals(sid, parsed!!.sid)
            assertEquals(32, parsed.browserPublicKey.size)
        }
    }

    @Test fun extensionAndRemoteCodesNeverCross() {
        for (raw in listOf(
            "https://flagshipserver.com/remote?s=$sid&k=$pk",
            "flagship://remote?s=$sid&k=$pk",
        )) assertNull(raw, ExtensionPairLink.parse(raw))
        for (raw in listOf(
            "https://flagshipserver.com/pair-extension?s=$sid&k=$pk",
            "flagship://pair-extension?s=$sid&k=$pk",
        )) assertNull(raw, RemoteApprovalLink.parse(raw))
        assertNull(ExtensionPairLink.parse("https://flagshipserver.com/pair-extension-x?s=$sid&k=$pk"))
        assertNull(ExtensionPairLink.parse("https://flagshipserver.com/remote/pair-extension?s=$sid&k=$pk"))
    }

    @Test fun extensionCodeRefusesOtherHostsAndShapes() {
        assertNull(ExtensionPairLink.parse("https://evil.example/pair-extension?s=$sid&k=$pk"))
        assertNull(ExtensionPairLink.parse("http://flagshipserver.com/pair-extension?s=$sid&k=$pk"))
        assertNull(ExtensionPairLink.parse("https://home.alice.flagship.services/pair-extension?s=$sid&k=$pk"))
        // A 16-byte sid only, a 32-byte key only.
        val longSid = Base64URL.encode(ByteArray(24) { 1 })
        assertNull(ExtensionPairLink.parse("https://flagshipserver.com/pair-extension?s=$longSid&k=$pk"))
        assertNull(ExtensionPairLink.parse("https://flagshipserver.com/pair-extension?s=short&k=$pk"))
        assertNull(ExtensionPairLink.parse("https://flagshipserver.com/pair-extension?s=$sid&k=${Base64URL.encode(ByteArray(31))}"))
        assertNull(ExtensionPairLink.parse("https://flagshipserver.com/pair-extension?s=$sid"))
    }

    @Test fun extensionPayloadKeysAreSorted() {
        val json = Json { encodeDefaults = true }.encodeToString(
            ExtensionPairPayload.serializer(),
            ExtensionPairPayload(
                podBaseUrl = "U", serverDomain = "D", stkPubHex = "K",
                ticketId = "T", ticketSecret = "S", username = "N",
            ),
        )
        assertEquals(
            """{"kind":"flagship/extension-pair/v1","podBaseUrl":"U","serverDomain":"D","stkPubHex":"K","ticketId":"T","ticketSecret":"S","username":"N"}""",
            json,
        )
    }
}
