package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.pq.PqVectors.h
import com.flagshipserver.app.core.pq.PqVectors.x
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/box-claim/vectors.json.
class BoxClaimVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/box-claim/vectors.json")
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject
    private val domain = v.s("serverDomain")
    private val serial = v.s("serial")

    private fun rand(w: JsonElement?): BoxClaim.Randomness {
        val o = w!!.jsonObject
        return BoxClaim.Randomness(h(o.s("ephemeralSeedHex")), h(o.s("nonceHex")), h(o.s("encapsulationHex")))
    }

    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: BoxClaimException) {
        e.code
    }

    @Test
    fun setupCodes() {
        for (e in v["setupCodes"]!!.jsonArray) {
            val c = e.jsonObject
            val g = BoxClaim.generateSetupCode(h(c.s("randomHex")))
            assertEquals(c.s("code"), g)
            assertEquals(c.s("formatted"), BoxClaim.formatSetupCode(g))
            assertEquals(c.s("codeKeyHex"), x(BoxClaim.setupCodeKey(g)))
            assertEquals(c.s("mailboxId"), BoxClaim.setupCodeMailboxId(g))
            assertEquals(c.s("link"), BoxClaim.setupCodeLink(g))
            assertEquals(g, BoxClaim.parseSetupCodeLink(c.s("link")))
        }
        for (e in v["normalize"]!!.jsonArray) {
            val n = e.jsonObject
            val out = n["output"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(out, BoxClaim.normalizeSetupCode(n.s("input")))
        }
        assertNull(BoxClaim.parseSetupCodeLink("https://flagshipserver.com/claim#c=B9D5MPJTB9D5MPJTB9D5&v=2"))
        assertNotEquals(BoxClaim.generateSetupCode(), BoxClaim.generateSetupCode())
    }

    @Test
    fun transcripts() {
        val stk = v.o("stk")
        val stkSecret = h(stk.s("ed25519SeedHex")) + h(stk.s("mldsaSeedHex"))
        for (e in v["transcripts"]!!.jsonArray) {
            val t = e.jsonObject
            val r = t.o("randomness")
            val mode = BoxClaim.Mode.of(t.s("mode"))!!
            val state = BoxClaim.AdvertState.of(t.s("state"))!!
            val c = t["code"]?.jsonPrimitive?.content
            val start = BoxClaim.PhoneStart(mode, c, rand(r["phone"]))
            assertEquals(t["hello"], start.hello.json)
            val box = BoxClaim.BoxPending(start.hello.json, state, c?.let { BoxClaim.setupCodeKey(it) }, rand(r["box"]))
            assertEquals(t["accept"], box.accept.json)
            val (fin, pp) = start.finish(t["accept"], rand(r["phone"]))
            assertEquals(t["finish"], fin)
            val (ready, boxCh) = box.complete(t["finish"])
            assertEquals(t["ready"], ready)
            val phone = pp.confirm(t["ready"])
            assertEquals(t.s("transcriptHex"), phone.transcriptHex)
            assertEquals(t.s("transcriptHex"), boxCh.transcriptHex)
            assertEquals(t.s("sessionIdHex"), phone.sessionIdHex)
            assertEquals(state, phone.advertState)
            for (re in t["records"]!!.jsonArray) {
                val rec = re.jsonObject
                val fromPhone = rec.s("from") == "phone"
                val (sender, receiver) = if (fromPhone) phone to boxCh else boxCh to phone
                val pt = rec.s("plaintext")
                assertEquals(rec.s("recordHex"), x(sender.seal(pt.toByteArray())))
                assertEquals(pt, String(receiver.open(h(rec.s("recordHex")))))
                val obj = Json.parseToJsonElement(pt)
                if (fromPhone) assertEquals(pt, BoxClaim.PhoneMessage.parse(obj).jsonText) else BoxClaim.BoxMessage.parse(obj)
            }
            val receipt = BoxClaim.verifyReceipt(t["receipt"], t.s("transcriptHex"), mode, domain, serial)
            assertEquals(stk.s("hybridPubHex").substring(0, 64), receipt.stkPubHex)
            val resigned = receipt.copy(signature = "").signed { p, m -> PqHybrid.hybridSign(stkSecret, p, m, deterministic = true) }
            assertEquals(t.o("receipt").s("signature"), resigned.signature)
            val bad = JsonObject(t.o("receipt") + ("model" to JsonPrimitive("Other")))
            assertEquals("bad-receipt", code { BoxClaim.verifyReceipt(bad, t.s("transcriptHex"), mode, domain, serial) })
            assertEquals("bad-receipt", code { BoxClaim.verifyReceipt(t["receipt"], t.s("transcriptHex"), mode, domain, "another-serial-01") })
        }
    }

    private fun run(mode: BoxClaim.Mode, state: BoxClaim.AdvertState, phoneCode: String?, boxCode: String?, w: JsonElement?): Pair<BoxClaim.Channel, BoxClaim.Channel> {
        val r = w!!.jsonObject
        val s = BoxClaim.PhoneStart(mode, phoneCode, rand(r["phone"]))
        val b = BoxClaim.BoxPending(s.hello.json, state, boxCode?.let { BoxClaim.setupCodeKey(it) }, rand(r["box"]))
        val (fin, pp) = s.finish(b.accept.json, rand(r["phone"]))
        val (ready, ch) = b.complete(fin)
        return pp.confirm(ready) to ch
    }

    @Test
    fun negatives() {
        val by = v["negatives"]!!.jsonArray.associate { it.jsonObject.s("name") to it.jsonObject }
        val transcripts = v["transcripts"]!!.jsonArray
        val code0 = transcripts[2].jsonObject.s("code")
        val other = v["setupCodes"]!!.jsonArray[1].jsonObject.s("code")

        val wc = by["wrong-code"]!!
        assertEquals(wc.s("expect"), code { run(BoxClaim.Mode.CODE, BoxClaim.AdvertState.UNCLAIMED, other, code0, wc["randomness"]) })

        val bw = by["box-without-code"]!!
        val s0 = BoxClaim.PhoneStart(BoxClaim.Mode.CODE, code0, rand(bw.o("randomness")["phone"]))
        assertEquals(bw.s("expect"), code { BoxClaim.BoxPending(s0.hello.json, BoxClaim.AdvertState.UNCLAIMED, null, rand(bw.o("randomness")["box"])) })

        for (mode in BoxClaim.Mode.entries) {
            val n = by["state-forgery-${mode.wire}"]!!
            val r = n.o("randomness")
            val c = if (mode == BoxClaim.Mode.CODE) code0 else null
            val s = BoxClaim.PhoneStart(mode, c, rand(r["phone"]))
            val b = BoxClaim.BoxPending(s.hello.json, BoxClaim.AdvertState.RESET_WINDOW, c?.let { BoxClaim.setupCodeKey(it) }, rand(r["box"]))
            val forged = JsonObject(b.accept.json + ("state" to JsonPrimitive("unclaimed")))
            val (fin, _) = s.finish(forged, rand(r["phone"]))
            assertEquals(n.s("expect"), code { b.complete(fin) })
        }

        val sc = BoxClaim.PhoneStart(BoxClaim.Mode.CODE, code0)
        val so = BoxClaim.PhoneStart(BoxClaim.Mode.OPEN)
        val openHello = JsonObject(so.hello.json + ("ephemeralPub" to JsonPrimitive(sc.hello.ephemeralPub)))
        val down = BoxClaim.BoxPending(openHello, BoxClaim.AdvertState.UNCLAIMED, null)
        assertEquals(by["mode-downgrade"]!!.s("expect"), code { sc.finish(down.accept.json) })

        val rk = by["relay-key-swap"]!!
        val (a, _) = run(BoxClaim.Mode.OPEN, BoxClaim.AdvertState.UNCLAIMED, null, null, rk.o("randomness")["phoneToRelay"])
        val (_, realBox) = run(BoxClaim.Mode.OPEN, BoxClaim.AdvertState.UNCLAIMED, null, null, rk.o("randomness")["relayToBox"])
        assertNotEquals(a.transcriptHex, realBox.transcriptHex)
        val forwarded = JsonObject(transcripts[0].jsonObject.o("receipt") + ("transcript" to JsonPrimitive(realBox.transcriptHex)))
        assertEquals(rk.s("expect"), code { BoxClaim.verifyReceipt(forwarded, a.transcriptHex, BoxClaim.Mode.OPEN, domain, serial) })

        val rr = by["record-replay"]!!
        val (phone, box) = run(BoxClaim.Mode.OPEN, BoxClaim.AdvertState.UNCLAIMED, null, null, rr["randomness"])
        val r0 = phone.seal(BoxClaim.PhoneMessage.Arm.jsonText.toByteArray())
        val r1 = phone.seal(BoxClaim.PhoneMessage.WifiScan.jsonText.toByteArray())
        assertEquals("replay", code { box.open(r1) })
        box.open(r0)
        assertEquals(rr.s("expect"), code { box.open(r0) })
        val fromBox = box.seal("""{"t":"armed"}""".toByteArray())
        assertEquals("decrypt-failed", code { box.open(fromBox) })
    }

    @Test
    fun pressChecks() {
        for (e in v["press"]!!.jsonArray) {
            val p = e.jsonObject
            val verdict = BoxClaim.judgePressReport(p["armSentAt"]!!.jsonPrimitive.long, p["instructionAt"]!!.jsonPrimitive.long, p["atMs"]!!.jsonPrimitive.long,
                p["count"]!!.jsonPrimitive.int, p["long"]!!.jsonPrimitive.boolean, p["receivedAt"]!!.jsonPrimitive.long)
            assertEquals(p.s("name"), p.s("verdict"), verdict.name.lowercase())
        }
        assertEquals(BoxClaim.INSTRUCTION_PAUSE_MIN_MS, BoxClaim.instructionPauseMs(byteArrayOf(0, 0)))
        assertEquals(BoxClaim.INSTRUCTION_PAUSE_MAX_MS, BoxClaim.instructionPauseMs(byteArrayOf(-1, -1)))
        repeat(50) { assertTrue(BoxClaim.instructionPauseMs() in BoxClaim.INSTRUCTION_PAUSE_MIN_MS..BoxClaim.INSTRUCTION_PAUSE_MAX_MS) }
    }

    @Test
    fun claimKey() {
        val k = v.o("claimKey")
        val f = k.o("fields")
        val key = BoxClaim.ClaimKey(f.s("username"), f.s("serial"), f.s("serverDomain"), f.s("stkPubHex"), f["issuedAt"]!!.jsonPrimitive.long)
        assertEquals(k.s("canonical"), String(key.canonical))
        assertEquals(k.s("signerPubHex"), x(PqHybrid.ed25519PublicKey(h(k.s("signerSeedHex")))))
        assertEquals(k.s("signatureHex"), x(PqHybrid.ed25519Sign(h(k.s("signerSeedHex")), key.canonical)))
        assertTrue(key.verify(h(k.s("signatureHex")), h(k.s("signerPubHex"))))
        assertFalse(key.copy(stkPubHex = "00".repeat(32)).verify(h(k.s("signatureHex")), h(k.s("signerPubHex"))))
    }

    @Test
    fun frames() {
        val f = v.o("frames")
        val frames = BoxClaim.fragment(h(f.s("messageHex")), f["mtu"]!!.jsonPrimitive.int)
        assertEquals(f["frames"]!!.jsonArray.map { it.jsonPrimitive.content }, frames.map { x(it) })
        val r = BoxClaim.Reassembler()
        var out: ByteArray? = null
        for (fr in frames) out = r.push(fr)
        assertEquals(f.s("messageHex"), x(out!!))
        val many = BoxClaim.fragment(ByteArray(100), 23)
        val r2 = BoxClaim.Reassembler()
        assertEquals("claim-malformed", code { r2.push(many[1]) })
        r2.push(many[0])
        assertEquals("claim-malformed", code { r2.push(many[0]) })
    }

    @Test
    fun phoneMessages() {
        val wifi = BoxClaim.WiFiConfig("Home|Net", "pass|word1", "DE", 1)
        val text = BoxClaim.PhoneMessage.Network(wifi).jsonText
        assertEquals(BoxClaim.PhoneMessage.Network(wifi), BoxClaim.PhoneMessage.parse(Json.parseToJsonElement(text)))
        assertEquals("claim-malformed", code { BoxClaim.PhoneMessage.parse(Json.parseToJsonElement("""{"t":"arm","x":1}""")) })
        assertFalse(wifi.copy(psk = "short").isValid)
        assertFalse(wifi.copy(ssid = "x".repeat(33)).isValid)
    }
}
