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
}
