// Replays packages/protocol/test-vectors/voici-calls/vectors.json (tools/voici-calls-vectors.ts) against the Kotlin port.
// Mirrors packages/protocol/tests/voiciCallsVectors.test.ts; the phone's own answers and end orders are verified.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.H
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.a
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.h
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.l
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.lOrNull
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.o
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.s
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.sOrNull
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class VoiciCallsVectorsTest {
    private val V: JsonObject by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voici-calls/vectors.json").readText()).jsonObject }
    private val k by lazy { V.o("keys") }
    private val request by lazy { V.o("request").o("signed") }
    private val callId by lazy { request.s("callId") }
    private fun utf8(b: ByteArray) = String(b, Charsets.UTF_8)
    private fun bool(o: JsonObject, key: String) = (o[key] as? JsonPrimitive)?.boolean == true
    private fun set(o: JsonObject, key: String) = o[key]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet()
    private fun code(r: VoiciOutcome<*>) = when (r) { is VoiciOutcome.Ok -> "ok"; is VoiciOutcome.Refused -> r.reason }
    private fun reqBytes() = VoiciCalls.canonicalRequest(request.s("pageId"), request.s("conv"), callId, request.s("callerXwingPub"), request.s("offerSdp"), request.l("issuedAt"))

    @Test fun sdp() {
        val s = V.o("sdp")
        assertEquals(s.s("offer"), VoiciCalls.mungeSdp(s.s("offerRaw")))
        assertEquals(s.s("answer"), VoiciCalls.mungeSdp(s.s("answerRaw")))
        assertEquals(s.s("offer"), VoiciCalls.mungeSdp(s.s("offer")))
        assertEquals(s.s("offerFingerprint"), VoiciCalls.sdpFingerprint(s.s("offer")))
        for (c in s.a("checks").map { it.jsonObject }) assertEquals(c.s("name"), c.sOrNull("expected"), VoiciCalls.checkSdp(c.s("sdp")))
    }

    @Test fun requestChecks() {
        val r = V.o("request")
        assertEquals(r.s("canonical"), utf8(reqBytes()))
        assertEquals(r.s("hash"), VoiciCalls.requestHash(request))
        for (c in r.a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            val ctx = VoiciCallRequestCheckContext(
                x.s("pageId"), bool(x, "acceptsCalls"), x.s("origin"), x.a("caKeys").map { it.jsonPrimitive.content }, x.l("now"),
                blocked = set(x, "blocked"), revoked = set(x, "revoked"), allowed = if (bool(x, "notAllowed")) { _ -> false } else null,
                skipFresh = bool(x, "skipFresh"),
            )
            assertEquals(c.s("name"), c.s("expected"), code(VoiciCalls.checkRequest(c["request"], ctx)))
        }
    }

    @Test fun keysAnswerFrames() {
        val (ct, ss) = VoiciCalls.encapsulate(h(k.s("callerXwingPub")), h(k.s("eseed")))
        assertEquals(k.s("xwingCiphertext"), H(ct))
        assertEquals(k.s("sharedSecret"), H(ss))
        assertEquals(k.s("sharedSecret"), H(VoiciCalls.decapsulate(h(k.s("xwingCiphertext")), h(k.s("callerSeed")))))
        assertEquals(k.s("deviceRef"), VoiciCalls.deviceRef(k.s("devicePub")))

        val a = V.o("answer")
        val body = VoiciCalls.parseAnswer(a["signed"])!!.first
        val answerBytes = VoiciCalls.canonicalAnswer(body)
        assertEquals(a.s("canonical"), utf8(answerBytes))
        assertEquals("ok", code(VoiciCalls.checkAnswer(VoiciCalls.signAnswer(body, h(k.s("ownerSignSeed"))), request, k.s("ownerSignPub"))))
        for (c in a.a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            assertEquals(c.s("name"), c.s("expected"), code(VoiciCalls.checkAnswer(c["answer"], request, x.s("ownerSignPub"), x.lOrNull("now"))))
        }

        val f = V.o("frames")
        val (c2p, p2c) = VoiciCalls.frameKeys(h(k.s("sharedSecret")), reqBytes(), answerBytes)
        assertEquals(f.s("c2p"), H(c2p))
        assertEquals(f.s("p2c"), H(p2c))
        assertEquals(f.s("c2pEpoch1"), H(VoiciCalls.nextFrameKey(c2p)))
        for (c in f.a("cases").map { it.jsonObject }) {
            val dir = VoiciCallDir.valueOf(c.s("dir"))
            assertEquals(c.s("sealed"), H(VoiciCalls.sealFrame(h(c.s("key")), callId, dir, c.l("ctr"), h(c.s("frame")))))
            assertEquals(c.l("epoch"), VoiciCalls.epoch(c.l("ctr")))
        }
        for (c in f.a("refusals").map { it.jsonObject }) {
            assertNull(c.s("name"), VoiciCalls.openFrame(h(c.s("key")), c.s("callId"), VoiciCallDir.valueOf(c.s("dir")), h(c.s("sealed"))))
        }
        val rx = VoiciCallFrameReceiver(h(f.s("c2p")), callId, VoiciCallDir.c2p)
        for (c in f.a("receiver").map { it.jsonObject }) assertEquals(c.s("note"), c.sOrNull("frame"), rx.open(h(c.s("sealed")))?.let(::H))
        val rx2 = VoiciCallFrameReceiver(h(f.s("c2p")), callId, VoiciCallDir.c2p)
        for (c in (f.a("epochPrelude") + f.a("epochRun")).map { it.jsonObject }) assertEquals(c.sOrNull("frame"), rx2.open(h(c.s("sealed")))?.let(::H))
        val tx = VoiciCallFrameSender(p2c, callId, VoiciCallDir.p2c)
        val rxp = VoiciCallFrameReceiver(p2c, callId, VoiciCallDir.p2c)
        assertArrayEquals(byteArrayOf(1, 2, 3), rxp.open(tx.seal(byteArrayOf(1, 2, 3))))
    }

    @Test fun receiptEndAllowPushMissed() {
        for (c in V.o("receipt").a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            assertEquals(c.s("name"), c.s("expected"),
                code(VoiciCalls.checkReceipt(c["receipt"], x.a("caKeys").map { it.jsonPrimitive.content }, x.l("now"), x.s("account"), x.sOrNull("deviceRef"))))
        }
        for (c in V.o("end").a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            assertEquals(c.s("name"), bool(c, "expected"), VoiciCalls.checkEnd(c["end"], x.s("callId"), x.s("callerPub"), x.s("ownerSignPub")) != null)
        }
        val mine = VoiciCalls.signEndOwner(callId, "hangup", 1, h(k.s("ownerSignSeed")))
        assertEquals("hangup", VoiciCalls.checkEnd(mine, callId, k.s("browserPub"), k.s("ownerSignPub")))
        val al = V.o("allow")
        val o = al.o("order")
        assertEquals(al.s("canonical"), utf8(VoiciCalls.canonicalAllow(o.s("pageId"), o.s("conv"), o.s("op"), o.l("issuedAt"))))
        assertEquals(al.s("signature"), VoiciCalls.signAllow(o.s("pageId"), o.s("conv"), o.s("op"), o.l("issuedAt"), h(k.s("ownerSignSeed"))))

        val inbox = h(k.s("inboxSeed"))
        val push = VoiciCalls.openPush(inbox, callId, WebEnvelopes.b64Decode(V.o("push").s("sealed"))!!)
        assertEquals(Triple(k.s("pageId"), k.s("conv"), k.s("pseudonymPub")), push)
        assertNull(VoiciCalls.openPush(inbox, callId, WebEnvelopes.b64Decode(V.o("push").s("badConvSealed"))!!))
        assertNull(VoiciCalls.openPush(inbox, "00".repeat(16), WebEnvelopes.b64Decode(V.o("push").s("sealed"))!!))
        val origin = V.o("constants").s("origin")
        val missed = VoiciCalls.openMissedCall(inbox, callId, WebEnvelopes.b64Decode(V.o("missedCall").s("sealed"))!!, k.s("pageId"), origin, listOf(k.s("caPub")))
        assertNotNull(missed)
        assertEquals("no-answer", missed!!.reason)
        assertNull(VoiciCalls.openMissedCall(inbox, callId, WebEnvelopes.b64Decode(V.o("missedCall").s("forgedSealed"))!!, k.s("pageId"), origin, listOf(k.s("caPub"))))
    }

    @Test fun video() {
        val x = V.o("video")
        assertEquals(x.a("buckets").map { it.jsonPrimitive.content.toInt() }, VoiciCalls.VIDEO_BUCKETS)
        val sdp = x.o("sdp")
        assertEquals(sdp.s("offer"), VoiciCalls.mungeSdp(sdp.s("offerRaw")))
        assertEquals(sdp.s("answer"), VoiciCalls.mungeSdp(sdp.s("answerRaw")))
        for (c in sdp.a("checks").map { it.jsonObject }) assertEquals(c.s("name"), c.sOrNull("expected"), VoiciCalls.checkSdp(c.s("sdp"), c.s("media")))

        val r = x.o("request")
        val signed = r.o("signed")
        val rb = VoiciCalls.requestBytes(signed)!!
        assertEquals(r.s("canonical"), utf8(rb))
        assertEquals(r.s("hash"), VoiciCalls.requestHash(signed))
        val cx = r.o("ctx")
        val ctx = VoiciCallRequestCheckContext(cx.s("pageId"), true, cx.s("origin"), cx.a("caKeys").map { it.jsonPrimitive.content }, cx.l("now"))
        for (c in r.a("checks").map { it.jsonObject }) assertEquals(c.s("name"), c.s("expected"), code(VoiciCalls.checkRequest(c["request"], ctx)))
        assertEquals(true, (VoiciCalls.checkRequest(signed, ctx) as VoiciOutcome.Ok).value.hasVideo)

        val a = x.o("answer")
        val body = VoiciCalls.parseAnswer(a["signed"])!!.first
        assertEquals(VoiciCalls.MEDIA_VIDEO, body.media)
        val ab = VoiciCalls.canonicalAnswer(body)
        assertEquals(a.s("canonical"), utf8(ab))
        assertEquals("ok", code(VoiciCalls.checkAnswer(VoiciCalls.signAnswer(body, h(k.s("ownerSignSeed"))), signed, k.s("ownerSignPub"))))
        for (c in a.a("checks").map { it.jsonObject }) {
            assertEquals(c.s("name"), c.s("expected"), code(VoiciCalls.checkAnswer(c["answer"], c["request"]!!, k.s("ownerSignPub"), V.l("now"))))
        }

        val keys = x.o("keys")
        val (vc, vp) = VoiciCalls.videoFrameKeys(h(keys.s("sharedSecret")), rb, ab)
        val (ac, ap) = VoiciCalls.frameKeys(h(keys.s("sharedSecret")), rb, ab)
        assertEquals(listOf(keys.s("c2p"), keys.s("p2c"), keys.s("audioC2p"), keys.s("audioP2c")), listOf(H(vc), H(vp), H(ac), H(ap)))
        val cid = signed.s("callId")
        val f = x.o("frames")
        for (c in f.a("cases").map { it.jsonObject }) {
            val dir = VoiciCallDir.valueOf(c.s("dir"))
            val frame = h(c.s("frame"))
            val sealed = VoiciCalls.sealVideoFrame(h(c.s("key")), cid, dir, c.l("ctr"), frame)
            assertEquals(c.s("sealed"), H(sealed))
            assertEquals(c.l("sealedLen").toInt(), sealed.size)
            assertEquals(c.l("clearLen").toInt(), VoiciCalls.videoClearLen(frame))
            assertArrayEquals(frame, VoiciCalls.openVideoFrame(h(c.s("key")), cid, dir, sealed)!!.second)
        }
        for (c in f.a("refusals").map { it.jsonObject }) {
            assertNull(c.s("name"), VoiciCalls.openVideoFrame(h(c.s("key")), cid, VoiciCallDir.valueOf(c.s("dir")), h(c.s("sealed"))))
        }
        for (c in f.a("seal").map { it.jsonObject }) {
            val frame = ByteArray(c.l("frameLen").toInt())
            if (frame.isNotEmpty()) frame[0] = c.l("firstByte").toByte()
            val got = try { VoiciCalls.sealVideoFrame(vc, cid, VoiciCallDir.c2p, 0, frame); "ok" } catch (_: IllegalArgumentException) { "refused" }
            assertEquals(c.s("name"), c.s("expected"), got)
        }
        val rx = VoiciCallFrameReceiver(vc, cid, VoiciCallDir.c2p, video = true)
        for (c in f.a("receiver").map { it.jsonObject }) assertEquals(c.sOrNull("frame"), rx.open(h(c.s("sealed")))?.let(::H))
    }

    @Test fun pageIndexV2() {
        val p = V.o("pageV2")
        val ctx = p.o("ctx")
        val idx = VoiciPage.parseVoiciPageIndex(p["signed"])!!
        assertEquals(p.s("canonical"), utf8(VoiciPage.canonicalVoiciPageIndex(idx.body)))
        assertEquals(true, idx.body.takesCalls)
        assertEquals(p.o("signed"), idx.toJson())
        assertEquals(p.o("signed").s("signature"), VoiciPage.signVoiciPageIndex(idx.body, ByteArray(32) { 0x33 }).signature)
        for (c in p.a("checks").map { it.jsonObject }) {
            assertEquals(c.s("name"), c.s("expected"), code(VoiciPage.checkVoiciPageIndex(c["index"], ctx.s("username"), ctx.s("sensitiveKind"), ctx.s("sensitivePub"))))
        }
    }
}
