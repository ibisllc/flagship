// Runs packages/protocol/test-vectors/serving-authority/vectors.json against the Kotlin port of the
// records an app signs (policy, renewal-key delegation, lease), read from disk so a drift fails
// here; plus the P-256 rules the renewal key follows (DER to compact, low-S).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class ServingAuthorityVectorsTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/serving-authority/vectors.json"
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

    private val json = Json { ignoreUnknownKeys = true }
    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun rows(kind: String) = root["records"]!!.jsonArray.map { it.jsonObject }.filter { it["kind"]!!.jsonPrimitive.content == kind }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun policiesReproduceTheCanonicalBytesAndVerify() {
        val rows = rows("serving-policy")
        assertEquals(3, rows.size)
        for (r in rows) {
            val p = json.decodeFromJsonElement(ServingPolicy.serializer(), r["record"]!!)
            val bytes = ServingAuthority.canonical(p)
            assertEquals(r.s("canonical"), String(bytes, Charsets.UTF_8))
            assertTrue(ServingAuthority.verifyEd25519(bytes, r.s("signature"), r.s("signerPub")))
            assertFalse(ServingAuthority.verifyEd25519(ServingAuthority.canonical(p.copy(policyGen = 2)), r.s("signature"), r.s("signerPub")))
        }
    }

    @Test fun theDelegationReproducesTheCanonicalBytesAndVerifies() {
        val r = rows("renewal-key-delegation").single()
        val d = json.decodeFromJsonElement(RenewalKeyDelegation.serializer(), r["record"]!!)
        val bytes = ServingAuthority.canonical(d)
        assertEquals(r.s("canonical"), String(bytes, Charsets.UTF_8))
        assertTrue(ServingAuthority.verifyEd25519(bytes, r.s("signature"), r.s("signerPub")))
    }

    @Test fun leasesVerifyUnderTheirAlgorithmAndHighSIsRefused() {
        val rows = rows("serving-lease")
        assertEquals(setOf("p256", "ed25519"), rows.map { it.s("alg") }.toSet())
        for (r in rows) {
            val l = json.decodeFromJsonElement(ServingLease.serializer(), r["record"]!!)
            assertEquals(r.s("canonical"), String(ServingAuthority.canonical(l), Charsets.UTF_8))
            if (r.s("alg") == "p256") {
                assertTrue(ServingAuthority.verifyLeaseP256(l, r.s("signature"), r.s("signerPub")))
                val raw = HexUtil.decode(r.s("signature"))!!
                val s = BigInteger(1, raw.copyOfRange(32, 64))
                val highS = ServingAuthority.P256_ORDER - s
                val high = raw.copyOfRange(0, 32) + highS.toByteArray().let { b -> if (b.size > 32) b.copyOfRange(b.size - 32, b.size) else ByteArray(32 - b.size) + b }
                assertFalse(ServingAuthority.isLowS(high))
                assertFalse(ServingAuthority.verifyLeaseP256(l, HexUtil.encode(high), r.s("signerPub")))
                assertArrayEquals(raw, ServingAuthority.normalizeLowS(high))
            } else {
                assertTrue(ServingAuthority.verifyEd25519(ServingAuthority.canonical(l), r.s("signature"), r.s("signerPub")))
            }
        }
    }

    @Test fun leaseForFollowsTheGraceAndMatchesTheVectorLease() {
        val p = json.decodeFromJsonElement(ServingPolicy.serializer(), rows("serving-policy").first()["record"]!!)
        val v = json.decodeFromJsonElement(ServingLease.serializer(), rows("serving-lease").first { it.s("alg") == "p256" }["record"]!!)
        assertEquals(v, ServingAuthority.leaseFor(p, v.issuedAt, v.leaseId))
        assertEquals(30L * 86_400_000, ServingAuthority.leaseFor(p.copy(grace = "30d"), 0, "ab".repeat(16))?.notAfter)
        assertNull(ServingAuthority.leaseFor(p.copy(grace = "indefinite"), 0, "ab".repeat(16)))
    }

    @Test fun recordsRefuseWhatTheReferenceRefuses() {
        val box = "6e".repeat(32); val scope = "1b".repeat(32)
        fun refuses(block: () -> Unit) = try { block(); fail("accepted") } catch (_: IllegalArgumentException) {}
        refuses { ServingAuthority.canonical(ServingPolicy("alice", box, 1, 1, "indefinite", "lock-server", scope, 1)) }
        refuses { ServingAuthority.canonical(ServingPolicy("Alice", box, 1, 1, "7d", "stop-apps", scope, 1)) }
        refuses { ServingAuthority.canonical(ServingPolicy("alice", box, 0, 1, "7d", "stop-apps", scope, 1)) }
        refuses { ServingAuthority.canonical(ServingLease("alice", box, 1, 1, "ab", 5, 6)) }
        refuses { ServingAuthority.canonical(ServingLease("alice", box, 1, 1, "ab".repeat(16), 6, 6)) }
        refuses { ServingAuthority.canonical(RenewalKeyDelegation("alice", renewalPub = "04" + "aa".repeat(32), deviceId = box, issuedAt = 1)) }
    }

    /** What Android Keystore does (DER out of SHA256withECDSA), done with a software key. */
    @Test fun derSignaturesBecomeLowSCompactAndVerify() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = ServingAuthority.compressedHex(kp.public as ECPublicKey)
        assertEquals(66, pub.length)
        val lease = ServingLease("alice", "6e".repeat(32), 1, 2, ServingAuthority.randomLeaseId(), 1_000, 2_000)
        repeat(32) {
            val sig = ServingAuthority.signLeaseP256Der(lease) { msg ->
                Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(msg); sign() }
            }
            assertTrue(ServingAuthority.isLowS(HexUtil.decode(sig)!!))
            assertTrue(ServingAuthority.verifyLeaseP256(lease, sig, pub))
        }
    }

    @Test fun derToRawPadsAndRefusesMalformed() {
        val raw = ServingAuthority.derToRaw(byteArrayOf(0x30, 0x08, 0x02, 0x02, 0x00, 0x80.toByte(), 0x02, 0x02, 0x01, 0x02))
        assertNotNull(raw)
        assertEquals(64, raw!!.size)
        assertEquals(0x80.toByte(), raw[31])
        assertArrayEquals(byteArrayOf(0x01, 0x02), raw.copyOfRange(62, 64))
        assertNull(ServingAuthority.derToRaw(byteArrayOf(0x30, 0x03, 0x02, 0x01)))
        assertNull(ServingAuthority.derToRaw(byteArrayOf(0x31, 0x00)))
    }

    @Test fun theLineFollowsThePolicy() {
        assertEquals(ServingLineKind.NoLimit, ServingLineKind.of(ServingGrace.INDEFINITE, ServingOnLapse.STOP_APPS, null))
        assertEquals(ServingLineKind.StaysOnline(5), ServingLineKind.of(ServingGrace.SEVEN_DAYS, ServingOnLapse.STOP_APPS, 5))
        assertEquals(ServingLineKind.Locks(5), ServingLineKind.of(ServingGrace.THIRTY_DAYS, ServingOnLapse.LOCK_SERVER, 5))
        assertEquals(ServingLineKind.NoLease(true), ServingLineKind.of(ServingGrace.SEVEN_DAYS, ServingOnLapse.LOCK_SERVER, null))
    }
}
