package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phone side of boot unlock v2 against packages/protocol/test-vectors/boot-unlock-v2/vectors.json:
 * material and request checks, and the reply and lease seals reproduced byte for byte.
 */
class BootUnlockV2VectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/boot-unlock-v2/vectors.json")
    private val domain = v["serverDomain"]!!.jsonPrimitive.content
    private val now = v["now"]!!.jsonPrimitive.long
    private fun key(k: String, f: String) = v["keys"]!!.jsonObject[k]!!.jsonObject[f]!!.jsonPrimitive.content
    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content
    private val stkBinding = PqTrust.verifyPqKeyBinding(v["stkBinding"], PqTrust.Expectation("box-stk", domain, key("stk", "publicKey").take(64), null, now))
    private fun signer(k: String): BootUnlockV2.OwnerSigner {
        val sk = PqVectors.h(key(k, "edSeed") + key(k, "mldsaSeed"))
        return BootUnlockV2.OwnerSigner { p, m -> PqHybrid.hybridSign(sk, p, m, deterministic = true) }
    }
    private fun code(f: () -> Unit): String = try { f(); "ok" } catch (e: BootUnlockV2.Failure) { e.code }

    @Test fun materialCases() {
        for (c in v["material"]!!.jsonObject["cases"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(s(c, "name"), s(c, "expect"), code { BootUnlockV2.verifyMaterial(c["wire"], domain, s(c, "bootPubHex"), stkBinding, now) })
        }
    }

    @Test fun requestCases() {
        val m = BootUnlockV2.verifyMaterial(v["material"]!!.jsonObject["wire"], domain, key("boot", "pubHex"), stkBinding, now)
        assertEquals("tpm", m.custody)
        for (c in v["request"]!!.jsonObject["cases"]!!.jsonArray.map { it.jsonObject }) {
            val r = c["v1"]!!.jsonObject
            val got = code {
                BootUnlockV2.verifyRequest(s(r, "serverDomain"), s(r, "bootPubHex"), s(r, "purpose"), s(r, "nonceHex"), r["issuedAt"]!!.jsonPrimitive.long, c["pq"], m)
            }
            assertEquals(s(c, "name"), s(c, "expect"), got)
        }
    }

    @Test fun replyAndLeaseAreByteIdentical() {
        val reply = v["reply"]!!.jsonObject
        val ctx = reply["ctx"]!!.jsonObject
        val sealed = BootUnlockV2.buildReply(
            s(ctx, "serverDomain"), s(ctx, "bootPubHex"), s(ctx, "nonceHex"), PqVectors.h(s(ctx, "replyKemPubHex")),
            PqVectors.h(v["diskKey"]!!.jsonPrimitive.content), PqVectors.h(key("owner", "publicKey")),
            reply["issuedAt"]!!.jsonPrimitive.long, signer("owner"), PqVectors.h(s(reply, "randomness")),
        )
        assertEquals(s(reply, "sealed"), PqVectors.x(sealed))
        val lease = v["lease"]!!.jsonObject
        val f = lease["fields"]!!.jsonObject
        val sealedKey = BootUnlockV2.sealLease(
            s(f, "serverDomain"), s(f, "bootPubHex"), s(f, "leaseId"), f["issuedAt"]!!.jsonPrimitive.long, f["expiresAt"]!!.jsonPrimitive.long,
            leaseKemPublicKey = PqVectors.h(key("leaseKem", "publicKey")), diskKey = PqVectors.h(v["diskKey"]!!.jsonPrimitive.content),
            ownerHybridPublicKey = PqVectors.h(key("owner", "publicKey")), sign = signer("owner"), randomness = PqVectors.h(s(lease, "randomness")),
        )
        assertEquals(s(lease, "sealedKey"), PqVectors.x(sealedKey))
    }

    @Test fun downgradeChoices() {
        for (c in v["replyChoice"]!!.jsonArray.map { it.jsonObject }) {
            val got = try {
                BootUnlockV2.chooseReplyVersion(c["strict"]!!.jsonPrimitive.boolean, c["material"]!!.jsonPrimitive.boolean, c["requestHasPq"]!!.jsonPrimitive.boolean, c["canSignHybrid"]!!.jsonPrimitive.boolean).toString()
            } catch (e: BootUnlockV2.Failure) { e.code }
            assertEquals(s(c, "expect"), got)
        }
        for (c in v["leaseChoice"]!!.jsonArray.map { it.jsonObject }) {
            val got = try {
                BootUnlockV2.chooseLeaseVersion(c["strict"]!!.jsonPrimitive.boolean, c["material"]!!.jsonPrimitive.boolean, c["canSignHybrid"]!!.jsonPrimitive.boolean).toString()
            } catch (e: BootUnlockV2.Failure) { e.code }
            assertEquals(s(c, "expect"), got)
        }
    }
}
