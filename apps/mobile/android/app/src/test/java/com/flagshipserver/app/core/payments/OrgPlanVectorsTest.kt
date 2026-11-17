// The Kotlin org plan, org wallet, org plan attestation and voucher files against
// packages/protocol/test-vectors/org-plan/ (genOrgPlanVectors.ts).

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.pq.OrgKeyKind
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OrgPlanVectorsTest {
    private val V by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/org-plan/vectors.json").readText()).jsonObject }
    private val cfg = PaymentsConfig.DEFAULT
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun JsonObject.cases(k: String) = this[k]!!.jsonArray.map { it.jsonObject }
    private fun h(s: String) = WebEnvelopes.hexToBytes(s)
    private fun terms(o: JsonObject) = OrgPlanTerms(o.l("trialEndsAt"), o.l("trialSeats"), o.l("paidSeats"), o.l("paidUntil"))
    private fun canon(w: OrgVoucherWallet) = WebEnvelopes.canonicalJson(w.toJson())

    @Test fun configAndUnitLengths() {
        assertEquals(V.o("config"), cfg.toJson())
        assertEquals(cfg, PaymentsConfig.merge(V["config"]))
        assertEquals(V.o("unitMs").l("3"), cfg.orgSeatUnitMs(3))
        assertEquals(V.o("unitMs").l("10"), cfg.orgSeatUnitMs(10))
        assertEquals(V.o("monthlyUnits").l("3"), cfg.orgMonthlyUnits(3))
        assertEquals(V.o("monthlyUnits").l("10"), cfg.orgMonthlyUnits(10))
    }

    @Test fun stateSpendTrickleEgress() {
        val states = V.cases("state")
        val egress = V.cases("egress")
        states.forEachIndexed { i, c ->
            val out = c.o("out")
            val st = OrgPlans.state(cfg, terms(c.o("terms")), c.l("now"))
            assertEquals(c.s("name"), terms(out), st.terms)
            assertEquals(c.s("name"), out.s("status"), st.status)
            assertEquals(c.s("name"), out.l("seatLimit"), st.seatLimit)
            assertEquals(c.s("name"), out.l("coveredUntil"), st.coveredUntil)
            val want = egress[i]["out"]
            assertEquals(c.s("name"), if (want is JsonNull) null else want!!.jsonPrimitive.long, OrgPlans.egressGb(cfg, st.status, st.seatLimit))
        }
        for (c in V.cases("spend")) {
            assertEquals(c.s("name"), c.l("out"), OrgPlans.paidUntilAfterSpend(cfg, terms(c.o("terms")), c.l("seats"), c.l("n"), c.l("now")))
            assertEquals(c.s("name"), c.l("ahead"), OrgPlans.aheadMs(cfg, terms(c.o("terms")), c.l("seats"), c.l("now")))
        }
        for (c in V.cases("trickle")) {
            val i = c.o("input")
            val input = OrgTrickleInput(i.l("now"), i["enabled"]!!.jsonPrimitive.boolean, i.l("balance"), terms(i.o("terms")), i.l("seats"), i.l("nextSpendAt"))
            val out = c.o("out")
            assertEquals(c.s("name"), TrickleOut(out.l("spend"), out.l("nextSpendAt")), OrgPlans.trickleStep(cfg, input, c["rand"]!!.jsonPrimitive.double))
        }
    }

    @Test fun attestationBytesAndSignature() {
        val a = V.o("attestation")
        val b = a.o("body")
        val body = OrgPlanAttestation(b.s("orgId"), b.s("status"), b.l("seatLimit"), b.l("paidSeats"), b.l("trialEndsAt"), b.l("paidUntil"), b.l("issuedAt"), b.l("expiresAt"))
        assertEquals(a.s("canonical"), String(OrgPlanAttestations.canonical(body), Charsets.UTF_8))
        assertEquals(OrgPlanAttestations.TAG, a.s("canonical").substringBefore('|'))
        val parsed = OrgPlanAttestations.parse(a["signed"])!!
        assertEquals(body, parsed.copy(signedBy = "", signatures = emptyList()))
        assertEquals(a.s("caPubHex"), parsed.signedBy)
        assertTrue(OrgPlanAttestations.verify(parsed, a.s("caPubHex"), b.l("issuedAt") + 1))
        assertFalse(OrgPlanAttestations.verify(parsed, a.s("caPubHex"), b.l("expiresAt")))
        assertFalse(OrgPlanAttestations.verify(parsed.copy(seatLimit = parsed.seatLimit + 1), a.s("caPubHex"), b.l("issuedAt") + 1))
        assertFalse(OrgPlanAttestations.verify(parsed, "00".repeat(32), b.l("issuedAt") + 1))
        val signed = a.o("signed")
        assertNull(OrgPlanAttestations.parse(JsonObject(signed + ("status" to JsonPrimitive("free")))))
        assertNull(OrgPlanAttestations.parse(JsonObject(signed + ("orgId" to JsonPrimitive("ab")))))
    }

    @Test fun voucherFiles() {
        val vs = V.o("batch")["vouchers"]!!.jsonArray.map { Vouchers.parse(it)!! }
        val f = V.o("voucherFile")
        assertEquals(f.s("text"), VoucherFiles.text(vs))
        assertEquals(f.s("text"), VoucherFiles.text(vs.reversed() + vs.first()))
        assertEquals(f.s("id"), VoucherFiles.id(f.s("text")))
        assertEquals(f["split2"]!!.jsonArray.map { it.jsonPrimitive.content }, VoucherFiles.split(vs, 2))
        assertEquals(3, VoucherFiles.parse(f.s("text"))!!.size)
        assertNull(VoucherFiles.parse("""{"kind":"flagship-vouchers","v":1,"vouchers":[]}"""))
        assertNull(VoucherFiles.parse("""{"kind":"other","v":1,"vouchers":[]}"""))
        assertNull(VoucherFiles.parse("not json"))
        val key = V.o("key").let { VoucherKey(it.s("keyId"), it.s("nHex"), it.s("eHex")) }
        assertTrue(vs.all { Vouchers.verify(key, it) })
    }

    @Test fun walletSealOpenWriteMerge() {
        val w = V.o("wallet")
        val orgId = w.s("orgId")
        val key = OrgWallets.deriveKey(h(w.s("ringKeyHex")), orgId)
        assertEquals(w.s("keyHex"), VoiciJs.hex(key))
        val wallet = OrgWallets.parse(w["wallet"])!!
        assertEquals(w.s("plaintext"), OrgWallets.plaintext(wallet))
        assertEquals(w.l("plaintextLength").toInt(), OrgWallets.plaintext(wallet).length)
        val sealed = OrgWallets.seal(key, orgId, w.l("keyVersion"), w.l("version"), wallet, h(w.s("nonceHex")))
        assertEquals(w.o("sealed"), sealed.toJson())
        assertEquals(canon(wallet), canon(OrgWallets.open(key, orgId, w["sealed"])!!))
        assertNull(OrgWallets.open(key, "1f".repeat(16), w["sealed"]))
        assertNull(OrgWallets.open(key, orgId, JsonObject(w.o("sealed") + ("version" to JsonPrimitive(w.l("version") + 1)))))
        assertNull(OrgWallets.open(key, orgId, JsonObject(w.o("sealed") + ("keyVersion" to JsonPrimitive(3)))))
        assertEquals(w.s("blobSha256"), OrgWallets.blobSha256(sealed))
        val write = w.o("write")
        assertEquals(write, OrgWallets.writeFor(orgId, sealed, write.l("issuedAt")).toJson())
        val ww = OrgWalletWrite(write.s("orgId"), write.l("version"), write.l("keyVersion"), write.s("blobSha256"), write.l("issuedAt"))
        assertEquals(w.s("writeCanonical"), String(OrgWallets.canonicalWrite(ww), Charsets.UTF_8))
        assertEquals(OrgWallets.TAG_WRITE, w.s("writeCanonical").substringBefore('|'))
        val m = V.o("merge")
        val local = OrgWallets.parse(m["local"])!!
        val remote = OrgWallets.parse(m["remote"])!!
        assertEquals(WebEnvelopes.canonicalJson(m.o("merged")), canon(OrgWallets.merge(local, remote)))
        assertEquals(WebEnvelopes.canonicalJson(m.o("merged")), canon(OrgWallets.merge(remote, local)))
    }

    @Test fun rulesAndOverrides() {
        assertFalse(cfg.isOrgSeatCount(2))
        assertTrue(cfg.isOrgSeatCount(3))
        val c = PaymentsConfig.merge(Json.parseToJsonElement("""{"business":{"unitsPerSeatMonth":8,"minSeats":5,"trialDays":14}}"""))
        assertEquals(BusinessNumbers(unitsPerSeatMonth = 8, minSeats = 5, trialDays = 14), c.business)
        assertEquals(cfg.business, PaymentsConfig.merge(Json.parseToJsonElement("""{"business":{"minSeats":50,"maxSeats":10}}""")).business)
        assertEquals(6, PaymentsConfig.merge(Json.parseToJsonElement("""{"business":{"unitsPerSeatMonth":-1}}""")).business.unitsPerSeatMonth)
        val now = 1_000_000_000_000
        val t = OrgPlanTerms(now - 1, 10, 3, now + 6 * PaymentsConfig.DAY_MS)
        assertEquals(3 * PaymentsConfig.DAY_MS, OrgPlans.paidUntilAfterSpend(cfg, t, 6, 0, now) - now)
        val key = ByteArray(32) { 1 }
        val empty = OrgWallets.empty(3, 10)
        val s = OrgWallets.seal(key, "ab".repeat(16), 1, 1, empty)
        assertEquals(canon(empty), canon(OrgWallets.open(key, "ab".repeat(16), s.toJson())!!))
        assertEquals("wallet", OrgKeyKind.WALLET.wire)
        assertEquals(OrgKeyKind.WALLET, OrgKeyKind.of("wallet"))
        assertEquals(OrgWallets.TAG, "flagship/org-voucher-wallet/v1")
    }
}
