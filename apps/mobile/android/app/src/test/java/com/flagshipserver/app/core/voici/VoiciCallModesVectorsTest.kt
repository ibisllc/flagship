// Call modes, ringing back, delete and reveal: the Kotlin port (VoiciCallModes) against
// packages/protocol/test-vectors/voici-call-modes/ and voici-conversation/ (tools/voici-call-modes-vectors.ts,
// tools/voici-conversation-vectors.ts). Ed25519 signatures are deterministic, so the app's own records match byte for byte.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.H
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.h
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiciCallModesVectorsTest {
    private fun load(rel: String) = Json.parseToJsonElement(vectorsFile(rel).readText()).jsonObject
    private val M by lazy { load("packages/protocol/test-vectors/voici-call-modes/vectors.json") }
    private val C by lazy { load("packages/protocol/test-vectors/voici-conversation/vectors.json") }
    private val D by lazy { load("packages/protocol/test-vectors/messages/vectors.json")["derivations"]!!.jsonObject }
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun JsonObject.cases(k: String) = this[k]!!.jsonArray.map { it.jsonObject }
    private fun JsonObject.keys(k: String) = this[k]!!.jsonArray.map { it.jsonPrimitive.content }
    private fun code(r: VoiciOutcome<*>) = when (r) { is VoiciOutcome.Ok -> "ok"; is VoiciOutcome.Refused -> r.reason }

    @Test fun proofOfWork() {
        val p = M.o("pow")
        assertNotNull(VoiciCallModes.parsePow(p.s("challenge")))
        assertTrue(VoiciCallModes.powSolves(p.s("challenge"), p.s("nonce")))
        assertFalse(VoiciCallModes.powSolves(p.s("challenge"), p.s("wrongNonce")))
    }

    @Test fun anonymousRequestTheAnsweringPhoneChecks() {
        val a = M.o("anon")
        val ctx = a.o("ctx")
        val check = { input: JsonElement?, from: String -> VoiciCallModes.checkAnon(input, ctx.s("pageId"), true, from, ctx.l("now")) }
        for (c in a.cases("checks")) assertEquals(c.s("name"), c.s("expect"), code(check(c["input"], ctx.s("callsFrom"))))
        for (c in a.cases("modeChecks")) assertEquals(c.s("name"), c.s("expect"), code(check(a["signed"], c.s("callsFrom"))))
        val bytes = VoiciCallModes.anonBytes(a["signed"])!!
        assertEquals(a.s("canonical"), String(bytes, Charsets.UTF_8))
        // The answering phone hashes an anonymous request by its kind (the answer names this hash).
        assertEquals(a.s("hash"), VoiciCalls.requestHash(a["signed"]!!))
        assertTrue(VoiciCallModes.isAnon(a["signed"]))
    }

    /**
     * Anonymous requests packages/flagship-web built from real Chromium offers, as the room hands them to a ringing
     * device; and a mode refusal from this device's own (older) copy of the index asks the live index once.
     */
    @Test fun theBrowsersAnonymousRequestsAndTheLiveMode() = runBlocking {
        val b = load("packages/protocol/test-vectors/voici-call-modes/browser-built.json")
        val ctx = b.o("ctx")
        val requests = b.o("requests")
        assertEquals(setOf("audio", "video"), requests.keys)
        for ((kind, r) in requests) {
            val check = { on: Boolean, from: String -> code(VoiciCallModes.checkAnon(r, ctx.s("pageId"), on, from, ctx.l("now"))) }
            assertEquals(kind, "ok", check(true, "anyone"))
            for (from in listOf("accepted", "signed-in", "callback")) assertEquals("$kind $from", "not-allowed", check(true, from))
            assertEquals(kind, "calls-off", check(false, "anyone"))
        }
        val r = requests["audio"]
        var asked = 0
        suspend fun run(pageId: String, on: Boolean, from: String, now: Long, m: Pair<Boolean, String>?) =
            code(VoiciCallModes.checkAnonLive(r, pageId, on, from, now, null) { asked++; m })
        val pageId = ctx.s("pageId")
        val now = ctx.l("now")
        assertEquals("ok", run(pageId, true, "signed-in", now, true to "anyone"))
        assertEquals("ok", run(pageId, false, "accepted", now, true to "anyone"))
        assertEquals("not-allowed", run(pageId, true, "signed-in", now, true to "callback"))
        assertEquals("not-allowed", run(pageId, true, "signed-in", now, null))
        assertEquals(4, asked)
        assertEquals("wrong-audience", run("00".repeat(16), true, "signed-in", now, true to "anyone"))
        assertEquals("stale", run(pageId, true, "anyone", now + 3_600_000, true to "anyone"))
        assertEquals(4, asked)
    }

    @Test fun ringBackChannelOrders() {
        val r = M.o("ringBack")
        val ctx = r.o("ctx")
        for (c in r.cases("checks")) {
            assertEquals(c.s("name"), c.s("expect"), code(VoiciCallModes.checkRingBack(c["input"], ctx.s("pageId"), ctx.s("origin"), ctx.keys("caKeys"), ctx.l("now"))))
        }
        val app = r.o("app")
        val o = app.o("order")
        assertEquals(app, VoiciCallModes.signRingBackPseudonym(o.s("pageId"), o.s("conv"), o.s("op"), o.l("issuedAt"), h(D.s("pseudonymSeed"))))
        assertEquals(r.s("canonical"), String(VoiciCallModes.canonicalRingBack(o.s("pageId"), o.s("conv"), o.s("op"), o.l("issuedAt")), Charsets.UTF_8))
    }

    @Test fun conversationDelete() {
        val d = C.o("delete")
        val ctx = d.o("ctx")
        for (c in d.cases("checks")) {
            assertEquals(c.s("name"), c.s("expect"), code(VoiciCallModes.checkConvDelete(c["input"], ctx.s("pageId"), ctx.s("ownerSignPub"), ctx.s("origin"), ctx.keys("caKeys"), ctx.l("now"))))
        }
        val owner = d.o("owner")
        val od = owner.o("del")
        assertEquals(d.s("canonical"), String(VoiciCallModes.canonicalConvDelete(od.s("pageId"), od.s("conv"), od.s("side"), od.l("issuedAt")), Charsets.UTF_8))
        assertEquals(owner, VoiciCallModes.signConvDeleteOwner(od.s("pageId"), od.s("conv"), od.l("issuedAt"), h(D.s("ownerSignSeed"))))
        val app = d.o("app")
        val ad = app.o("del")
        assertEquals(app, VoiciCallModes.signConvDeletePseudonym(ad.s("pageId"), ad.s("conv"), ad.l("issuedAt"), h(D.s("pseudonymSeed"))))
    }

    @Test fun revealAndUnreveal() {
        val r = C.o("reveal")
        val ctx = r.o("ctx")
        for (c in r.cases("checks")) assertEquals(c.s("name"), c.s("expect"), code(VoiciCallModes.checkReveal(c["input"], ctx.s("conv"), ctx.s("pageSignPub"))))
        val signed = r.o("signed")
        assertEquals(signed, VoiciCallModes.signReveal(signed.s("conv"), signed.s("username"), signed.s("displayName"), signed.l("issuedAt"), h(r.s("pageSignSeed"))))
        val noName = r.o("noName")
        assertEquals(noName, VoiciCallModes.signReveal(noName.s("conv"), noName.s("username"), null, noName.l("issuedAt"), h(r.s("pageSignSeed"))))
        assertEquals(r.s("canonical"), String(VoiciCallModes.canonicalReveal(signed.s("conv"), signed.s("username"), signed.s("displayName"), signed.l("issuedAt")), Charsets.UTF_8))
        assertEquals(r.s("nameHash"), VoiciCallModes.revealNameHash(signed.s("displayName")))
        val un = r.o("unreveal")
        assertEquals(un, VoiciCallModes.unreveal(un.s("conv"), un.l("issuedAt")))
        for (c in r.cases("unrevealShapes")) assertEquals(c.s("name"), c["expect"]!!.jsonPrimitive.boolean, VoiciCallModes.parseRevealControl(c["input"]) is VoiciCallModes.RevealControl.Hidden)
    }

    @Test fun controlBodiesOpenForTheirConversationOnly() {
        val c = C.o("control")
        val conv = C.s("conv")
        for (k in listOf("reveal", "unreveal")) {
            val x = c.o(k)
            val r = VoiciMessages.openVoiciBodyAny(WebEnvelopes.b64Decode(x.s("body"))!!, conv, x.s("msgId"), h(c.s("inboxSeed")))
            assertEquals(k, x.o("control"), ((r as VoiciOutcome.Ok).value as VoiciMessages.VoiciBodyControl).control)
            // A text reader refuses a control body as an inner schema and shows nothing.
            assertEquals("inner-schema", code(VoiciMessages.openVoiciBody(WebEnvelopes.b64Decode(x.s("body"))!!, conv, x.s("msgId"), h(c.s("inboxSeed")))))
        }
        val w = c.o("wrongConv")
        assertEquals(w.s("expect"), code(VoiciMessages.openVoiciBodyAny(WebEnvelopes.b64Decode(w.s("body"))!!, conv, w.s("msgId"), h(c.s("inboxSeed")))))
        // The app's own seal of a control opens back the same way.
        val inbox = VoiciMessages.deriveVoiciInboxKey(h(D.s("ownerUmk")), C.s("pageId"), 1)
        val ctl = VoiciCallModes.unreveal(conv, 5)
        val sealed = VoiciMessages.sealVoiciControl(conv, "b1".repeat(16), 5, D.s("pseudonymPub"), listOf(inbox.publicKey, h(D.s("threadPub"))), ctl)
        val back = VoiciMessages.openVoiciBodyAny(sealed, conv, "b1".repeat(16), inbox.seed)
        assertEquals(ctl, ((back as VoiciOutcome.Ok).value as VoiciMessages.VoiciBodyControl).control)
    }

    @Test fun anonymousCallerBlock() {
        val b = C.o("anonBlock")
        val o = b.o("order")
        assertEquals(b.s("canonical"), String(VoiciCallModes.canonicalAnonBlock(o.s("pageId"), o.s("conv"), o.s("op"), o.l("issuedAt")), Charsets.UTF_8))
        val signed = VoiciCallModes.signAnonBlock(o.s("pageId"), o.s("conv"), o.s("op"), o.l("issuedAt"), h(D.s("ownerSignSeed")))
        assertEquals(b.s("signature"), signed.s("signature"))
        for (c in b.cases("checks")) assertEquals(c.s("name"), c["expect"]!!.jsonPrimitive.boolean, VoiciCallModes.verifyAnonBlock(c["block"], c.s("signature"), C.s("ownerSignPub")))
    }

    @Test fun callSettingsSealedAndSynced() {
        val x = M.o("callSettings")
        val key = VoiciCallHoursSettings.deriveKey(h(x.s("ownerUmk")))
        assertEquals(x.s("key"), H(key))
        val plain = VoiciCallHoursSettings.parse(x["plain"])!!
        val sealed = x.o("sealed")
        assertEquals(sealed, VoiciCallHoursSettings.seal(key, x.s("username"), sealed.l("version"), plain, h(x.s("nonce"))))
        assertEquals(plain, VoiciCallHoursSettings.open(key, x.s("username"), sealed))
        assertEquals(x["plain"], plain.toJson())
        // Refusals: another account, another version, another key.
        assertEquals(null, VoiciCallHoursSettings.open(key, "bob", sealed))
        assertEquals(null, VoiciCallHoursSettings.open(key, x.s("username"), JsonObject(sealed + ("version" to kotlinx.serialization.json.JsonPrimitive(sealed.l("version") + 1)))))
        assertEquals(null, VoiciCallHoursSettings.open(ByteArray(32) { 1 }, x.s("username"), sealed))
        for (c in x.cases("hoursShapes")) assertEquals(c.s("name"), c["expect"]!!.jsonPrimitive.boolean, VoiciCallHoursSettings.parseHours(c["value"]) != null)
        for (c in x.cases("hoursAllow")) {
            val hours = (c["hours"] as? JsonObject)?.let(VoiciCallHoursSettings::parseHours)
            assertEquals(c.s("name"), c["expect"]!!.jsonPrimitive.boolean, VoiciCallHoursSettings.allow(hours, c.l("now")))
        }
        val none = VoiciCallHoursSettings.parse(x["plainNone"])!!
        assertEquals(plain, VoiciCallHoursSettings.merge(none, plain))
        assertEquals(plain, VoiciCallHoursSettings.merge(plain, none))
    }

    @Test fun anAnonymousCallersPushOpensAsAnonymous() {
        val a = M.o("anonPush")
        val o = VoiciCalls.openPush(h(a.s("inboxSeed")), a.s("callId"), WebEnvelopes.b64Decode(a.s("sealed"))!!)!!
        val opened = a.o("opened")
        assertEquals(Triple(opened.s("pageId"), opened.s("conv"), opened.s("from")), o)
        assertTrue(VoiciCalls.isAnonymousCaller(o.third))
        // A push whose conv belongs to another browser key is refused.
        assertEquals(null, VoiciCalls.openPush(h(a.s("inboxSeed")), a.s("callId"), WebEnvelopes.b64Decode(a.s("badConvSealed"))!!))
    }
}
