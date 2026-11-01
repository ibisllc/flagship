// Runs packages/protocol/test-vectors/service-invite/vectors.json (the set the Rust port also reads), read from
// disk so a drift fails here: the create / redeem / accept / revoke canonical strings and the TypeScript signer's
// signatures (Ed25519 is deterministic, so this port reproduces them byte for byte), the secret hash and the refusals.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServiceInviteMessageVectorsTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/service-invite/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val v: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun hex(s: String) = HexUtil.decode(s)!!
    private fun cases(k: String) = v[k]!!.jsonArray.map { it.jsonObject }
    private fun key(name: String) = v["keys"]!!.jsonObject[name]!!.jsonObject
    private fun signer(name: String) = Ed25519Sign(ByteArray(32) { key(name)["seedByte"]!!.jsonPrimitive.int.toByte() })
    private fun pub(name: String) = hex(key(name).s("pub"))
    private fun text(b: ByteArray) = String(b, Charsets.UTF_8)

    private fun create(c: JsonObject): ByteArray = ServiceInvite.canonicalCreate(
        c.s("inviteId"), hex(c.s("authorAID")), c.s("serviceRef"), c.s("secretHash"), c.s("encryptedBundle"), c.l("issuedAt"),
        maxRedemptions = c["maxRedemptions"]?.jsonPrimitive?.int,
        expiresAt = c["expiresAt"]?.jsonPrimitive?.long,
    )

    @Test fun create() {
        for (c in cases("create")) {
            val bytes = create(c)
            assertEquals(c.s("name"), c.s("canonical"), text(bytes))
            assertEquals(c.s("name"), c.s("signature"), HexUtil.encode(ServiceInvite.sign(bytes, signer("irk"))))
            assertTrue(ServiceInvite.verify(hex(c.s("signature")), bytes, pub("irk")))
            assertFalse(ServiceInvite.verify(hex(c.s("signature")), bytes, pub("friend")))
        }
    }

    @Test fun redeemAcceptRevoke() {
        for (r in cases("redeem")) {
            val bytes = ServiceInvite.canonicalRedeem(r.s("secretHash"), hex(r.s("visitorAID")), r.l("redeemedAt"))
            assertEquals(r.s("canonical"), text(bytes))
            assertEquals(r.s("signature"), HexUtil.encode(ServiceInvite.sign(bytes, signer("friend"))))
        }
        for (a in cases("accept")) {
            val sig = ServiceInvite.signAcceptServiceInvite(a.s("inviteId"), a.s("serviceRef"), hex(a.s("contactAID")), a.l("acceptedAt"), signer("contact"))
            assertEquals(a.s("canonical"), text(ServiceInvite.canonicalAccept(a.s("inviteId"), a.s("serviceRef"), hex(a.s("contactAID")), a.l("acceptedAt"))))
            assertEquals(a.s("signature"), HexUtil.encode(sig))
        }
        for (r in cases("revoke")) {
            val bytes = ServiceInvite.canonicalRevoke(r.s("inviteId"), r.l("issuedAt"))
            assertEquals(r.s("canonical"), text(bytes))
            assertEquals(r.s("signature"), HexUtil.encode(ServiceInvite.sign(bytes, signer("irk"))))
        }
    }

    @Test fun secretHash() {
        for (s in cases("secretHash")) assertEquals(s.s("expect"), ServiceInvite.secretHash(hex(s.s("secretHex"))))
    }

    @Test fun invalid() {
        for (c in cases("invalid")) {
            val name = c.s("name")
            if (c.s("op") == "create") {
                // A fractional expiry has no Long form: the API can't be handed one at all.
                val exp = c["expiresAt"]?.jsonPrimitive
                if (exp != null && exp.double != Math.floor(exp.double)) continue
                assertTrue(name, runCatching { create(c) }.isFailure)
            } else {
                assertTrue(name, runCatching { ServiceInvite.canonicalRedeem(c.s("secretHash"), hex(c.s("visitorAID")), c.l("redeemedAt")) }.isFailure)
            }
        }
    }
}
