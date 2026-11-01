// Runs packages/protocol/test-vectors/phone-route/vectors.json against the Kotlin port (claim and
// order bytes and signatures, the CSR bytes, certificate reuse, the endpoint policy), read from disk
// so a drift fails here.

package com.flagshipserver.app.phoneroute

import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class PhoneRouteVectorsTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/phone-route/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return f
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun JsonElement?.strOrNull() = if (this == null || this is JsonNull) null else jsonPrimitive.content

    private fun claimOf(o: JsonObject) = RouteClaim(o.s("account"), o.s("phoneRoutePub"), o.s("hostname"), o.l("generation"), o.s("sessionNonce"), o.l("issuedAt"))

    @Test fun bareNames() {
        for (b in root["bare"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(b.s("sni"), b["account"].strOrNull(), PhoneRoute.bareAccount(b.s("sni"), b.s("apex")))
        }
    }

    @Test fun theClaimReproducesItsBytesAndSignature() {
        val c = root["claim"]!!.jsonObject
        val claim = claimOf(c["record"]!!.jsonObject)
        val bytes = PhoneRoute.canonical(claim)
        assertEquals(c.s("canonical"), String(bytes, Charsets.UTF_8))
        val key = Ed25519Sign(HexUtil.decode(root.s("signerSeed"))!!)
        assertEquals(c.s("signature"), PhoneRoute.sign(bytes, key))
        assertEquals(root.s("signerPub"), HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(HexUtil.decode(root.s("signerSeed"))!!).publicKey))
    }

    @Test fun thePhoneOrderReproducesItsBytesAndSignature() {
        val o = root["certificateOrder"]!!.jsonObject
        val r = o["record"]!!.jsonObject
        assertEquals("phone", r.s("class"))
        assertEquals(0L, r.l("regGen"))
        val order = PhoneCertificateOrder(r.s("device"), r.s("csrSha256"), r.s("requestId"), r.l("issuedAt"))
        val bytes = PhoneRoute.canonical(order)
        assertEquals(o.s("canonical"), String(bytes, Charsets.UTF_8))
        assertEquals(o.s("signature"), PhoneRoute.sign(bytes, Ed25519Sign(HexUtil.decode(root.s("signerSeed"))!!)))
    }

    @Test fun theCsrBytesMatchAndAJcaSignatureVerifies() {
        val c = root["csr"]!!.jsonObject
        val pub = HexUtil.decode(c.s("publicKeyUncompressed"))!!
        val info = PhoneRoute.csrInfo(pub, c.s("hostname"))
        assertEquals(c.s("infoHex"), HexUtil.encode(info))
        val csr = PhoneRoute.csr(info, HexUtil.decode(c.s("signatureDerHex"))!!)
        assertEquals(c.s("csrHex"), HexUtil.encode(csr))
        assertEquals(c.s("csrSha256"), PhoneRoute.sha256Hex(csr))

        // A key made here (as the Keystore would) signs its own CSR info; the signature verifies.
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val mine = PhoneTlsKey.uncompressed(kp.public as ECPublicKey)
        val myInfo = PhoneRoute.csrInfo(mine, "bob.flagship.services")
        val sig = Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(myInfo); sign() }
        val ok = Signature.getInstance("SHA256withECDSA").run { initVerify(kp.public); update(myInfo); verify(sig) }
        assertTrue(ok)
    }

    @Test fun certificateReuse() {
        for (c in root["certReuse"]!!.jsonArray.map { it.jsonObject }) {
            val got = PhoneRoute.needsOrder(c["notAfter"]?.jsonPrimitive?.longOrNull, c["lastFailureAt"]?.jsonPrimitive?.longOrNull, c.l("now"))
            assertEquals(c.toString(), c["order"]!!.jsonPrimitive.booleanOrNull, got)
        }
    }

    @Test fun theEndpointPolicy() {
        for (c in root["endpoint"]!!.jsonArray.map { it.jsonObject }) {
            val r = c["request"]!!.jsonObject
            val ctx = c["context"]!!.jsonObject
            val req = PhoneEndpointRequest(
                method = r.s("method"),
                host = r.s("host"),
                origin = r["origin"].strOrNull(),
                sessionCookie = r["sessionCookie"].strOrNull(),
                csrf = r["csrf"].strOrNull(),
                upgrade = r["upgrade"]!!.jsonPrimitive.booleanOrNull == true,
                establish = r["establish"]?.jsonPrimitive?.booleanOrNull == true,
            )
            assertEquals(c.s("name"), c.s("verdict"), PhoneEndpointPolicy.check(req, ctx.s("hostname"), ctx["sessionToken"].strOrNull(), ctx["csrfToken"].strOrNull()))
        }
    }

    @Test fun theVectorSignatureVerifiesUnderTheVectorKeyWithJca() {
        val c = root["csr"]!!.jsonObject
        val raw = HexUtil.decode(c.s("publicKeyUncompressed"))!!
        val params = java.security.AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        val point = java.security.spec.ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        val pub = KeyFactory.getInstance("EC").generatePublic(java.security.spec.ECPublicKeySpec(point, params))
        val ok = Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(HexUtil.decode(c.s("infoHex"))!!)
            verify(HexUtil.decode(c.s("signatureDerHex"))!!)
        }
        assertTrue(ok)
    }

    @Test fun theReleaseAndThePresenceReproduceTheirBytesAndVerify() {
        val r = root["release"]!!.jsonObject
        val bytes = PhoneRoute.canonicalRelease(claimOf(r["record"]!!.jsonObject))
        assertEquals(r.s("canonical"), String(bytes, Charsets.UTF_8))
        assertTrue(PhoneRoute.verify(bytes, r.s("signature"), root.s("signerPub")))
        val p = root["presence"]!!.jsonObject
        val rec = p["record"]!!.jsonObject
        val pb = PhoneRoute.canonicalPresence(rec.s("account"), rec.s("devicePub"), rec.s("hostname"), rec.l("issuedAt"))
        assertEquals(p.s("canonical"), String(pb, Charsets.UTF_8))
        assertTrue(PhoneRoute.verify(pb, p.s("signature"), rec.s("devicePub")))
        assertEquals(p.s("signature"), PhoneRoute.sign(pb, Ed25519Sign(HexUtil.decode(root.s("signerSeed"))!!)))
    }
}
