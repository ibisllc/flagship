package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.AdminRootRotation
import com.flagshipserver.app.core.pq.PqVectors.h
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/pq-authority/vectors.json: canonical bytes,
// every rotation and grant case, and the old root's companions re-signed byte for byte.
class PqAuthorityVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/pq-authority/vectors.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject

    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: PqTrustException) {
        e.code
    }

    private val rotation: AdminRootRotation get() {
        val f = v.o("rotation").o("fields")
        return AdminRootRotation(f.s("username"), f.s("oldAdminRootPubHex"), f.s("newAdminRootPubHex"), f["issuedAt"]!!.jsonPrimitive.long)
    }

    private fun grantBytes(f: JsonObject) = PqAuthorityRecords.grantBytes(
        f.s("grantId"), f.s("username"), f.s("deviceId"), f.s("devicePubKeyHex"),
        f["scopes"]!!.jsonArray.map { it.jsonPrimitive.content }, f["issuedAt"]!!.jsonPrimitive.long, f["expiresAt"]!!.jsonPrimitive.long,
    )

    private fun verified(name: kotlinx.serialization.json.JsonElement?): PqTrust.VerifiedBinding? {
        if (name == null || name is JsonNull) return null
        val w = v.o("bindings").o(name.jsonPrimitive.content)
        return PqTrust.verifyPqKeyBinding(w, PqTrust.Expectation(w.s("role"), w.s("subjectId"), w.s("ed25519PubHex"), now = v["now"]!!.jsonPrimitive.long))
    }

    private fun policy(p: JsonObject) = AssurancePolicy.legacyState(AssurancePolicy.Scope("installation", "home.alice.flagship.services"))
        .copy(profile = p.s("profile"), rollout = p.s("rollout"))

    private fun secret(name: String): ByteArray {
        val s = v["signers"]!!.jsonArray.map { it.jsonObject }.first { it.s("name") == name }
        return h(s.s("edSeedHex") + s.s("mldsaSeedHex"))
    }

    @Test
    fun canonicalBytes() {
        val nb = v.o("bindings").o("newRoot")
        val kid = PqAuthorityRecords.bindingKeyIdHex(nb.s("ed25519PubHex"), nb.s("mldsaPubHex"))
        assertEquals(v.o("rotation").s("newRootKeyId"), kid)
        assertEquals(v.o("rotation").s("canonical"), String(PqAuthorityRecords.canonicalRotationV2(rotation, kid), Charsets.UTF_8))
        assertThrows(PqTrustException::class.java) { PqAuthorityRecords.canonicalRotationV2(rotation, "AA".repeat(32)) }
        for (k in listOf("admin", "member")) {
            val g = v.o("grants").o(k)
            assertEquals(g.s("canonical"), String(grantBytes(g.o("fields")), Charsets.UTF_8))
        }
    }

    @Test
    fun companionsResignByteForByte() {
        val sk = secret("oldRoot")
        val nb = PqTrust.pqKeyBindingFromWire(v.o("bindings")["newRoot"])
        val c = PqAuthorityRecords.signRotation(rotation, nb) { p, m -> PqHybrid.hybridSign(sk, p, m, deterministic = true) }
        assertEquals(v.o("rotation").o("pq").o("signature").s("signature"), c.signature.signature)
        val admin = v.o("grants").o("admin")
        val g = PqAuthorityRecords.signGrant(grantBytes(admin.o("fields"))) { p, m -> PqHybrid.hybridSign(sk, p, m, deterministic = true) }
        assertEquals(admin.o("pq").s("signature"), g.signature)
    }

    @Test
    fun rotationCases() {
        val newMl = v.o("bindings").o("newRoot").s("mldsaPubHex")
        for (c in v["rotationCases"]!!.jsonArray.map { it.jsonObject }) {
            var got: String? = null
            val out = code { got = PqAuthorityRecords.verifyRotation(rotation, c["pq"], verified(c["oldRootBinding"]), policy(c.o("policy")), v["now"]!!.jsonPrimitive.long).mldsaPubHex }
            val e = c.o("expect")
            if (e["ok"]!!.jsonPrimitive.boolean) {
                assertEquals(c.s("name"), "ok", out)
                assertEquals(newMl, got)
            } else {
                assertEquals(c.s("name"), e.s("code"), out)
            }
        }
    }

    @Test
    fun grantCases() {
        for (c in v["grantCases"]!!.jsonArray.map { it.jsonObject }) {
            val signerPub = v.o("bindings").o(c.s("signer")).s("ed25519PubHex")
            val out = code { PqAuthorityRecords.verifyGrant(grantBytes(c.o("grant")), c["pq"], signerPub, verified(c["signerBinding"]), policy(c.o("policy"))) }
            val e = c.o("expect")
            assertEquals(c.s("name"), if (e["ok"]!!.jsonPrimitive.boolean) "ok" else e.s("code"), out)
        }
    }
}
