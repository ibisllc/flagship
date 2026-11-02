// Replays packages/protocol/test-vectors/messages/vectors.json (tools/voici-vectors.ts) against the Kotlin port:
// derivations, canonical JSON, base64, attestation, delegation, thread statement, message / reply / draft envelopes
// and every refusal, open, ack, block, state blob, reports, sign-in, the phone endpoint's web policy. Mirrors
// packages/protocol/tests/voiciVectors.test.ts (the abuse tag and thread-fetch sections are not ported).

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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagesVectorsTest {
    private val M: JsonObject by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/messages/vectors.json").readText()).jsonObject }
    private val d by lazy { M.o("derivations") }
    private val keys by lazy { M.o("keys") }
    private fun utf8(b: ByteArray) = String(b, Charsets.UTF_8)

    @Test fun derivations() {
        val owner = h(d.s("ownerUmk"))
        val inbox = VoiciMessages.deriveVoiciInboxKey(owner, d.s("pageId"), d.l("inboxEpoch"))
        assertEquals(d.s("inboxSeed"), H(inbox.seed))
        assertEquals(d.s("inboxPub"), H(inbox.publicKey))
        assertEquals(d.s("inboxPubSha256"), WebEnvelopes.sha256Hex(inbox.publicKey))
        assertEquals(d.s("inboxEpoch2Seed"), H(VoiciMessages.deriveVoiciInboxKey(owner, d.s("pageId"), 2).seed))
        val os = VoiciMessages.deriveVoiciOwnerSignKey(owner, d.s("pageId"), d.l("inboxEpoch"))
        assertEquals(d.s("ownerSignSeed"), H(os.seed))
        assertEquals(d.s("ownerSignPub"), H(os.publicKey))
        val ms = VoiciMessages.deriveMessagesSecret(h(d.s("visitorUmk")))
        assertEquals(d.s("messagesSecret"), H(ms))
        val p = VoiciMessages.deriveMessagesPseudonymKey(ms, d.s("pageId"))
        assertEquals(d.s("pseudonymSeed"), H(p.seed))
        assertEquals(d.s("pseudonymPub"), H(p.publicKey))
        assertEquals(d.s("otherPagePseudonymPub"), H(VoiciMessages.deriveMessagesPseudonymKey(ms, "aa".repeat(16)).publicKey))
        val t = VoiciMessages.deriveMessagesThreadKey(ms, d.s("pageId"))
        assertEquals(d.s("threadSeed"), H(t.seed))
        assertEquals(d.s("threadPub"), H(t.publicKey))
        assertEquals(d.s("draftsKey"), H(VoiciMessages.deriveVoiciDraftsKey(owner)))
        assertEquals(d.s("stateKey"), H(VoiciMessages.deriveMessagesStateKey(owner)))
        assertEquals(d.s("conv"), VoiciMessages.voiciConv(d.s("pageId"), d.s("pseudonymPub")))
        assertEquals(d.s("pseudonymName"), VoiciText.voiciPseudonymName(d.s("pseudonymPub")))
        assertEquals(keys.s("browserPub"), H(VoiciJs.p256PublicKey(h(keys.s("browserPriv")))))
    }

    @Test fun canonicalJsonAndBase64() {
        val cj = M.o("canonicalJson")
        for (c in cj.a("cases").map { it.jsonObject }) assertEquals(c.s("name"), c.s("canonical"), WebEnvelopes.canonicalJson(c["value"]))
        for (c in cj.a("refusals").map { it.jsonObject }) {
            val threw = try {
                WebEnvelopes.canonicalJson(Json.parseToJsonElement(c.s("json")))
                false
            } catch (_: IllegalArgumentException) {
                true
            }
            assertTrue(c.s("name"), threw)
        }
        // A JSON string is never a number and `true` is never 1.
        assertEquals("{\"a\":\"1\",\"b\":true,\"c\":1}", WebEnvelopes.canonicalJson(Json.parseToJsonElement("{\"c\":1,\"b\":true,\"a\":\"1\"}")))
        for (c in M.a("base64").map { it.jsonObject }) {
            val b = WebEnvelopes.b64Decode(c.s("b64"))
            assertEquals(c.s("b64"), c.sOrNull("hex"), b?.let { H(it) })
            if (b != null) assertEquals(c.s("b64"), WebEnvelopes.b64Encode(b))
        }
    }

    @Test fun attestation() {
        val a = M.o("attestation")
        val rq = a.o("request")
        val req = MessagesKeyAttestationRequest(rq.s("username"), rq.s("pseudonymPub"), rq.s("renewOfHash"), rq.s("deviceCheckRef"), rq.l("issuedAt"))
        assertEquals(a.s("requestCanonical"), utf8(MessagesAttestations.canonicalMessagesKeyAttestationRequest(req)))
        assertEquals(a.s("requestSignature"), MessagesAttestations.signMessagesKeyAttestationRequest(req, h(keys.s("deviceSeed"))))
        assertTrue(MessagesAttestations.verifyMessagesKeyAttestationRequest(req, a.s("requestSignature"), keys.s("devicePub")))
        assertFalse(MessagesAttestations.verifyMessagesKeyAttestationRequest(req.copy(deviceCheckRef = "none"), a.s("requestSignature"), keys.s("devicePub")))
        val sg = a.o("signed")
        val signed = MessagesAttestations.signMessagesKeyAttestation(sg.s("pseudonymPub"), sg.l("abuseEpoch"), sg.l("issuedAt"), sg.l("expiresAt"), h(a.s("abuseTagHex")), h(keys.s("caSeed")))
        assertEquals(a["signed"], signed.toJson())
        assertEquals(a.s("canonical"), utf8(MessagesAttestations.canonicalMessagesKeyAttestation(signed)))
        assertEquals(a.s("renewOfHash"), MessagesAttestations.messagesAttestationHash(signed))
        for (c in a.a("checks").map { it.jsonObject }) {
            val ctx = c.o("ctx")
            val r = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], ctx.a("caKeys").map { it.jsonPrimitive.content }, ctx.l("now"), ctx.sOrNull("pseudonymPub"))
            assertEquals(c.s("name"), c.s("expected"), r.code)
        }
    }

    private fun want(o: JsonObject) = WebDelegations.Want(o.s("scope"), o.s("origin"), o.s("audience"), o.s("principalPub"), o.l("now"), o.lOrNull("notAfter"))

    @Test fun delegationRevokeAndThreadStatement() {
        val x = M.o("delegation")
        val del = WebDelegations.parseWebDelegation(x["delegation"])!!
        assertEquals(x["delegation"], del.toJson())
        assertEquals(x.s("canonical"), utf8(WebDelegations.canonicalWebDelegation(del)))
        assertEquals(x.s("signature"), WebDelegations.signWebDelegation(del, h(d.s("pseudonymSeed"))))
        for (c in x.a("checks").map { it.jsonObject }) {
            assertEquals(c.s("name"), c.s("expected"), WebDelegations.checkWebDelegation(c["delegation"], c.sOrNull("signature"), want(c.o("want"))).code)
        }
        val rv = x.o("revoke")
        val revoke = WebDelegations.parseWebDelegationRevoke(rv["revoke"])!!
        assertEquals(rv.s("canonical"), utf8(WebDelegations.canonicalWebDelegationRevoke(revoke)))
        assertEquals(rv.s("signature"), WebDelegations.signWebDelegationRevoke(revoke, h(d.s("pseudonymSeed"))))
        assertTrue(WebDelegations.verifyWebDelegationRevoke(revoke, rv.s("signature"), d.s("pseudonymPub")))
        assertFalse(WebDelegations.verifyWebDelegationRevoke(revoke.copy(issuedAt = revoke.issuedAt + 1), rv.s("signature"), d.s("pseudonymPub")))
        val t = M.o("threadStatement")
        val st = VoiciMessages.parseVoiciThreadStatement(t["statement"])!!
        assertEquals(t.s("canonical"), utf8(VoiciMessages.canonicalVoiciThreadStatement(st)))
        assertEquals(t.s("signature"), VoiciMessages.signVoiciThreadStatement(st, h(d.s("pseudonymSeed"))))
    }

    private fun plain(o: JsonObject) = VoiciPlaintext(o.s("text"), o.sOrNull("replyTo"))
    private fun rnd(o: JsonObject) = VoiciSealRandomness(h(o.s("cek")), h(o.s("nonce")), o.a("eseeds").map { h(it.jsonPrimitive.content) })

    @Test fun messageSealedBodyEnvelopeChecksOpen() {
        val m = M.o("message")
        val env = WebEnvelopes.parseWebEnvelope(m["envelope"])!!
        assertEquals(m["envelope"], env.toJson())
        val body = VoiciMessages.sealVoiciBody(d.s("conv"), env.msgId, env.sentAt, d.s("pseudonymPub"), listOf(h(d.s("inboxPub")), h(d.s("threadPub"))), plain(m.o("plaintext")), rnd(m.o("randomness")))
        assertEquals(m.s("bodyText"), utf8(body))
        assertEquals(env.bodyB64, WebEnvelopes.b64Encode(body))
        assertEquals(m.s("plaintextCanonical"), WebEnvelopes.canonicalJson(plain(m.o("plaintext")).toJson()))
        assertEquals(m.s("canonical"), utf8(WebEnvelopes.canonicalWebEnvelope(env)))
        assertTrue(WebEnvelopes.verifyWebEnvelopeSignature(env, keys.s("browserPub")))
        // The P-256 signature is RFC 6979 in the vectors; BouncyCastle's deterministic signer reproduces it.
        assertEquals(env.sig, WebEnvelopes.signWebEnvelopeP256(env, h(keys.s("browserPriv"))).sig)
        var n = 0
        for (c in m.a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            val ctx = VoiciMessageCheckContext(
                pageId = x.s("pageId"),
                acceptsMessages = x["acceptsMessages"]!!.jsonPrimitive.boolean,
                origin = x.s("origin"),
                caKeys = x.a("caKeys").map { it.jsonPrimitive.content },
                now = x.l("now"),
                blocked = x["blocked"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet(),
                revoked = x["revoked"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet(),
                rateLimit = if (x["rateLimited"]?.jsonPrimitive?.booleanOrNull == true) ({ _: WebEnvelope -> "rate-limited" }) else null,
            )
            assertEquals(c.s("name"), c.s("expected"), VoiciMessages.checkVoiciMessage(c["envelope"], ctx).code)
            n++
        }
        assertEquals(24, n)
        // The same envelope as JSON text.
        assertEquals("ok", VoiciMessages.checkVoiciMessage(m["envelope"].toString(), VoiciMessageCheckContext(d.s("pageId"), true, WebDelegations.VOICI_WEB_ORIGIN, listOf(keys.s("caPub")), M.l("t0") + 30_000)).code)
        for (c in m.a("open").map { it.jsonObject }) {
            val r = VoiciMessages.openVoiciBody(body, c.s("conv"), c.s("msgId"), h(c.s("seed")))
            val got = when (r) {
                is VoiciOutcome.Ok -> JsonObject(mapOf("ok" to JsonPrimitive(true), "plaintext" to r.value.toJson()))
                is VoiciOutcome.Refused -> JsonObject(mapOf("ok" to JsonPrimitive(false), "code" to JsonPrimitive(r.reason)))
            }
            assertEquals(c.s("name"), c["expected"], got)
        }
    }

    @Test fun replyAndDraft() {
        val r = M.o("reply")
        val env = WebEnvelopes.parseWebEnvelope(r["envelope"])!!
        val body = VoiciMessages.sealVoiciBody(d.s("conv"), env.msgId, env.sentAt, d.s("ownerSignPub"), listOf(h(d.s("threadPub")), h(d.s("inboxPub"))), plain(r.o("plaintext")), rnd(r.o("randomness")))
        assertEquals(r.s("bodyText"), utf8(body))
        assertEquals(r.s("canonical"), utf8(WebEnvelopes.canonicalWebEnvelope(env)))
        assertEquals(env.sig, WebEnvelopes.signWebEnvelopeEd25519(env, h(d.s("ownerSignSeed"))).sig)
        val opened = VoiciMessages.openVoiciBody(body, d.s("conv"), env.msgId, h(d.s("threadSeed")))
        assertEquals(plain(r.o("plaintext")), opened.valueOrNull())
        for (c in r.a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            assertEquals(c.s("name"), c.s("expected"), VoiciMessages.checkVoiciReply(c["envelope"], x.s("pageId"), x.s("ownerSignPub"), x.sOrNull("conv"), x.lOrNull("freshAt")).code)
        }

        val dr = M.o("draft")
        val op = VoiciMessages.parseVoiciDraftOp(dr["op"])!!
        assertEquals(dr["op"], op.toJson())
        val sealed = VoiciMessages.sealVoiciDraft(h(d.s("draftsKey")), dr.s("username"), op, h(dr.s("nonce")))
        assertEquals(dr.s("bodyText"), utf8(sealed))
        assertEquals(op, VoiciMessages.openVoiciDraft(h(d.s("draftsKey")), dr.s("username"), op.opId, sealed))
        assertNull(VoiciMessages.openVoiciDraft(h(d.s("draftsKey")), dr.s("username"), "00".repeat(16), sealed))
        val denv = WebEnvelopes.parseWebEnvelope(dr["envelope"])!!
        assertEquals(denv.sig, WebEnvelopes.signWebEnvelopeEd25519(denv, h(keys.s("deviceSeed"))).sig)
        val ok = dr.o("grantAccepted")
        val checkGrant = { g: JsonElement?, s: String, pub: String ->
            WebEnvelopes.canonicalJson(g) == WebEnvelopes.canonicalJson(ok["grant"]) && s == ok.s("grantSignature") && pub == ok.s("devicePub")
        }
        for (c in dr.a("checks").map { it.jsonObject }) {
            val x = c.o("ctx")
            assertEquals(c.s("name"), c.s("expected"), VoiciMessages.checkVoiciDraft(c["envelope"], x.s("username"), checkGrant, x.lOrNull("freshAt")).code)
        }
        for (c in dr.a("opCases").map { it.jsonObject }) {
            assertEquals(c.s("name"), c["expected"]!!.jsonPrimitive.boolean, VoiciMessages.parseVoiciDraftOp(c["op"]) != null)
        }
    }

    @Test fun ackBlockStateReportsSignInPhoneWeb() {
        val ak = M.o("ack")
        val am = ak.o("message")
        val ack = VoiciAck(am.s("conv"), am.s("msgId"), am.l("receivedAt"), am.s("phoneRoutePub"))
        assertEquals(ak.s("canonical"), utf8(VoiciMessages.canonicalVoiciAck(ack)))
        assertEquals(ak["message"], VoiciMessages.signVoiciAck(ack, h(d.s("ownerSignSeed"))).toJson())
        val dk = ak.o("draft")
        assertEquals(ak["draft"], VoiciMessages.signVoiciAck(VoiciAck(dk.s("conv"), dk.s("msgId"), dk.l("receivedAt"), dk.s("phoneRoutePub")), h(keys.s("adminRootSeed"))).toJson())
        for (c in ak.a("cases").map { it.jsonObject }) {
            val w = c.o("want")
            assertEquals(c.s("name"), c["expected"]!!.jsonPrimitive.boolean, VoiciMessages.verifyVoiciAck(c["ack"], c.s("signerPub"), w.s("msgId"), w.sOrNull("conv")) != null)
        }

        val bk = M.o("block")
        val block = VoiciMessages.parseVoiciBlock(bk["block"])!!
        assertEquals(bk.s("canonical"), utf8(VoiciMessages.canonicalVoiciBlock(block)))
        assertEquals(bk.s("signature"), VoiciMessages.signVoiciBlock(block, h(d.s("ownerSignSeed"))))
        assertTrue(VoiciMessages.verifyVoiciBlock(block, bk.s("signature"), d.s("ownerSignPub")))
        assertFalse(VoiciMessages.verifyVoiciBlock(block.copy(op = "unblock"), bk.s("signature"), d.s("ownerSignPub")))

        val s = M.o("state")
        val a = VoiciMessages.parseMessagesState(s["a"])!!
        val b = VoiciMessages.parseMessagesState(s["b"])!!
        assertEquals(s["a"], a.toJson())
        assertEquals(s["merged"], VoiciMessages.mergeMessagesState(a, b).toJson())
        val sealed = VoiciMessages.sealMessagesState(h(d.s("stateKey")), s.s("username"), s.l("version"), a, h(s.s("nonce")))
        assertEquals(s["sealed"], sealed.toJson())
        assertEquals(a, VoiciMessages.openMessagesState(h(d.s("stateKey")), s.s("username"), s["sealed"]))
        assertNull(VoiciMessages.openMessagesState(h(d.s("stateKey")), s.s("username"), sealed.copy(version = 5).toJson()))
        assertEquals(VoiciMessages.emptyMessagesState(), VoiciMessages.parseMessagesState(MessagesState().toJson()))

        val rp = M.o("reports")
        for (k in listOf("message", "messageWithText")) {
            val x = rp.o(k).o("report")
            val report = VoiciMessageReport(x.s("pageId"), WebEnvelopes.parseWebEnvelope(x["envelope"])!!, x.s("reason"), x.sOrNull("attached"), x.l("issuedAt"))
            assertEquals(k, rp.o(k).s("canonical"), utf8(VoiciMessages.canonicalVoiciReport(report)))
            assertEquals(k, rp.o(k).s("signature"), VoiciMessages.signVoiciMessageReport(report, h(d.s("ownerSignSeed"))))
            assertTrue(k, VoiciMessages.verifyVoiciMessageReport(report, rp.o(k).s("signature"), d.s("ownerSignPub")))
        }
        val pr = rp.o("page").o("report")
        val pageReport = VoiciPageReport(pr.s("username"), pr.l("seq"), pr.s("reason"), pr.s("note"), pr.l("issuedAt"))
        assertEquals(rp.o("page").s("canonical"), utf8(VoiciMessages.canonicalVoiciReport(pageReport)))
        assertTrue(WebEnvelopes.p256VerifyP1363(rp.o("page").s("signature"), VoiciJs.utf8(rp.o("page").s("canonical")), keys.s("browserPub")))
        assertFalse(WebEnvelopes.p256VerifyP1363(rp.o("page").s("signature"), VoiciJs.utf8(rp.o("page").s("canonical") + "x"), keys.s("browserPub")))

        val si = M.o("signIn")
        assertNotNull(VoiciMessages.parseVoiciSignInRequest(si["request"]))
        val ctx = si.o("ctx")
        for (c in si.a("checks").map { it.jsonObject }) {
            val req = VoiciMessages.parseVoiciSignInRequest(c["request"])!!
            assertEquals(c.s("name"), c.s("expected"), VoiciMessages.checkVoiciSignInAnswer(c["answer"], req, ctx.a("caKeys").map { it.jsonPrimitive.content }, ctx.l("now")).code)
        }

        val pw = M.o("phoneWeb")
        for (c in pw.a("cases").map { it.jsonObject }) {
            val q = c.o("request")
            val req = PhoneWebRequest(q.s("method"), q.s("path"), q.s("host"), q.sOrNull("origin"), q.sOrNull("contentType"), q.sOrNull("acrMethod"), q.sOrNull("acrHeaders"))
            val got = VoiciPhoneWeb.phoneWebCheck(req, c.s("hostname"), c.a("origins").map { it.jsonPrimitive.content })
            assertEquals(c.s("name"), c["expected"], got.toJson())
        }
        for (c in pw.a("liveAnswers").map { it.jsonObject }) {
            assertEquals(c["expected"]!!.jsonPrimitive.boolean, VoiciPhoneWeb.parsePhoneLiveAnswer(c["answer"]) != null)
        }
        val k = M.o("constants")
        assertEquals(k["phoneWebOrigins"]!!.jsonArray.map { it.jsonPrimitive.content }, VoiciPhoneWeb.PHONE_WEB_ORIGINS)
        assertEquals(k["phoneWebOriginsGym"]!!.jsonArray.map { it.jsonPrimitive.content }, VoiciPhoneWeb.PHONE_WEB_ORIGINS_GYM)
        assertEquals(k.l("phoneDeliverMaxBytes"), VoiciPhoneWeb.PHONE_DELIVER_MAX_BYTES.toLong())
        assertEquals(k.l("envelopeMaxBytes"), WebEnvelopes.WEB_ENVELOPE_MAX_BYTES.toLong())
        assertEquals(k.l("draftMaxBodyBytes"), VoiciMessages.VOICI_DRAFT_MAX_BODY_BYTES.toLong())
        assertEquals(k.l("sendSkewMs"), VoiciMessages.VOICI_SEND_SKEW_MS)
        assertEquals(k.l("attestationTtlMs"), MessagesAttestations.MESSAGES_ATTESTATION_TTL_MS)
        assertEquals(k.s("webOrigin"), WebDelegations.VOICI_WEB_ORIGIN)
        assertEquals(k.s("webOriginGym"), WebDelegations.VOICI_WEB_ORIGIN_GYM)
    }

    @Test fun randomSealsRoundTrip() {
        val umk = ByteArray(32) { 3 }
        val pid = "33".repeat(16)
        val inbox = VoiciMessages.deriveVoiciInboxKey(umk, pid, 1)
        val t = VoiciMessages.deriveMessagesThreadKey(VoiciMessages.deriveMessagesSecret(umk), pid)
        val pt = VoiciPlaintext("x", null)
        val a = VoiciMessages.sealVoiciBody("44".repeat(32), "55".repeat(16), 1, "66".repeat(32), listOf(inbox.publicKey, t.publicKey), pt)
        val b = VoiciMessages.sealVoiciBody("44".repeat(32), "55".repeat(16), 1, "66".repeat(32), listOf(inbox.publicKey, t.publicKey), pt)
        assertFalse(H(a) == H(b))
        assertEquals(pt, VoiciMessages.openVoiciBody(a, "44".repeat(32), "55".repeat(16), t.seed).valueOrNull())
        val threw = try {
            VoiciMessages.sealVoiciBody("44".repeat(32), "55".repeat(16), 1, "66".repeat(32), listOf(inbox.publicKey, t.publicKey), VoiciPlaintext("a‮b", null))
            false
        } catch (_: IllegalArgumentException) {
            true
        }
        assertTrue(threw)
    }
}
