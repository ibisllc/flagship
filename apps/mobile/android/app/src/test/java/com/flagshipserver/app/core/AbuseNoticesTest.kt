package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AbuseNoticesTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/abuse-notice-done/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun build(o: JsonObject) = AbuseNotices.canonicalBytes(
        o["username"]!!.jsonPrimitive.content,
        o["noticeId"]!!.jsonPrimitive.content,
        o["note"]!!.jsonPrimitive.content,
        o["issuedAt"]!!.jsonPrimitive.long,
    )

    @Test fun canonicalBytesAndSignaturesMatchTheSharedVector() {
        val v = vectors()
        val verifier = Ed25519Verify(unhex(v["pubHex"]!!.jsonPrimitive.content))
        val signer = Ed25519Sign(unhex(v["seedHex"]!!.jsonPrimitive.content))
        for (e in v["done"]!!.jsonArray) {
            val entry = e.jsonObject
            val bytes = build(entry["done"]!!.jsonObject)
            assertEquals(entry["canonical"]!!.jsonPrimitive.content, bytes.decodeToString())
            verifier.verify(unhex(entry["signatureHex"]!!.jsonPrimitive.content), bytes)
            assertEquals(entry["signatureHex"]!!.jsonPrimitive.content, HexUtil.encode(signer.sign(bytes)))
        }
    }

    @Test fun refusesTheMalformedNotes() {
        for (e in vectors()["refused"]!!.jsonArray) {
            val r = e.jsonObject
            try {
                build(r["done"]!!.jsonObject)
                fail("accepted: ${r["name"]}")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    private val sample = """{"notices":[{"id":"0123456789abcdef0123456789abcdef","subjectKind":"app","subject":"chess.alice.flagship.services",
        "serviceId":"alice--chess","category":"phishing","action":"take-down","detail":"The login page copies a bank.",
        "deadlineAt":1762300000000,"issuedAt":1762000000000,"doneAt":null,"doneNote":null,"extra":1}],
        "suspension":null}"""

    @Test fun decodesTheWireAndToleratesUnknownFields() {
        val r = OkHttpJsonTransport.defaultJson.decodeFromString(AbuseNoticesResponse.serializer(), sample)
        assertEquals(1, r.notices.size)
        assertEquals("take-down", r.notices[0].action)
        assertNull(r.suspension)
        val s = OkHttpJsonTransport.defaultJson.decodeFromString(
            AbuseNoticesResponse.serializer(),
            """{"notices":[],"suspension":{"suspendedAt":1,"category":"malware","reason":"Serves malware.","appealEmail":"abuse@flagship.services","appealUrl":"https://flagshipserver.com/abuse#appeal"}}""",
        )
        assertEquals("malware", s.suspension!!.category)
    }

    @Test fun theBannerIsForAdminDevicesOnlyAndSaysWhatAndBy() {
        val r = OkHttpJsonTransport.defaultJson.decodeFromString(AbuseNoticesResponse.serializer(), sample)
        assertTrue(AbuseNoticeModels.banners(r, isAdmin = false).isEmpty())
        val b = AbuseNoticeModels.banners(r, isAdmin = true) { "DATE$it" }.single()
        assertEquals("Action needed on your account", b.title)
        assertEquals("We received a report about chess.alice.flagship.services.", b.about)
        assertEquals("Reason: Phishing", b.reason)
        assertEquals("What to do: take it down.", b.whatToDo)
        assertEquals("Deadline: DATE1762300000000", b.deadline)
        assertEquals("If it is still there after the deadline, this account can be suspended.", b.warning)
        assertEquals("The login page copies a bank.", b.detail)
        assertNull(b.doneLine)
        val done = r.copy(notices = r.notices.map { it.copy(doneAt = 5) })
        assertEquals("Marked done on DATE5. We will check it.", AbuseNoticeModels.banners(done, true) { "DATE$it" }.single().doneLine)
    }

    @Test fun theSuspendedScreenNamesTheReasonAndTheWayOut() {
        assertNull(AbuseNoticeModels.suspended(null, "alice"))
        val m = AbuseNoticeModels.suspended(AbuseSuspension(1, "csam", "Reported to NCMEC."), "alice")!!
        assertEquals("This account was suspended", m.title)
        assertEquals("Reason: Child sexual abuse material", m.reason)
        assertEquals("Reported to NCMEC.", m.operatorReason)
        assertTrue(m.dataStays.startsWith("Your data stays on your own server."))
        assertEquals("mailto:abuse@flagship.services?subject=Appeal%20%28alice%29", m.appealMailto)
    }

    private class FakeApi(var response: AbuseNoticesResponse, var doneStatus: Int? = null) : AbuseNoticesApi {
        var sent: AbuseNoticeDoneRequest? = null
        override suspend fun fetch(username: String) = response
        override suspend fun markDone(username: String, noticeId: String, body: AbuseNoticeDoneRequest) {
            doneStatus?.let { throw HttpException(it, "{}", "x") }
            sent = body
        }
    }

    @Test fun markDoneSignsTheCanonicalBytesAndUpdatesTheBanner() = runBlocking {
        val v = vectors()
        val seed = unhex(v["seedHex"]!!.jsonPrimitive.content)
        val r = OkHttpJsonTransport.defaultJson.decodeFromString(AbuseNoticesResponse.serializer(), sample)
        val api = FakeApi(r)
        val c = AbuseNoticeCenter(api, { "Alice" }, { true }, { Ed25519Sign(seed) }, { 1762000000000 })
        c.refresh()
        assertEquals(AbuseDoneResult.Done, c.markDone("0123456789abcdef0123456789abcdef", "  Took it down.  "))
        val sent = api.sent!!
        assertEquals("alice", sent.request.username)
        assertEquals("Took it down.", sent.request.note)
        Ed25519Verify(unhex(v["pubHex"]!!.jsonPrimitive.content)).verify(
            unhex(sent.signature),
            AbuseNotices.canonicalBytes("alice", sent.request.noticeId, sent.request.note, sent.request.issuedAt),
        )
        assertEquals(1762000000000, c.state.value!!.notices.single().doneAt)
    }

    @Test fun aNonAdminDeviceIsRefusedLocallyAndByTheServer() = runBlocking {
        val r = OkHttpJsonTransport.defaultJson.decodeFromString(AbuseNoticesResponse.serializer(), sample)
        val seed = ByteArray(32) { 0x55 }
        val local = AbuseNoticeCenter(FakeApi(r), { "alice" }, { false }, { Ed25519Sign(seed) })
        assertEquals(AbuseDoneResult.Failed("Only an admin device can do this."), local.markDone("0123456789abcdef0123456789abcdef", ""))
        val server = AbuseNoticeCenter(FakeApi(r, doneStatus = 403), { "alice" }, { true }, { Ed25519Sign(seed) })
        assertEquals(AbuseDoneResult.Failed("Only an admin device can do this."), server.markDone("0123456789abcdef0123456789abcdef", ""))
        val other = AbuseNoticeCenter(FakeApi(r, doneStatus = 500), { "alice" }, { true }, { Ed25519Sign(seed) })
        assertEquals(AbuseDoneResult.Failed("Couldn't send. Try again."), other.markDone("0123456789abcdef0123456789abcdef", ""))
    }

    @Test fun continuingToTheDataLastsUntilTheSuspensionEnds() = runBlocking {
        val api = FakeApi(AbuseNoticesResponse(suspension = AbuseSuspension(1, "malware", "x")))
        val c = AbuseNoticeCenter(api, { "alice" }, { false })
        c.refresh()
        c.dismissSuspended()
        c.refresh()
        assertTrue(c.suspendedDismissed.value)
        api.response = AbuseNoticesResponse()
        c.refresh()
        assertEquals(false, c.suspendedDismissed.value)
        assertNull(c.state.value!!.suspension)
    }
}
