// Runs packages/protocol/test-vectors/device-pairing/vectors.json, read from
// disk so a drift fails here: adding a device is admin-only (owner rule
// 2026-10-16), the admit and the device grant it seals are signed exactly as
// the webapp and .com expect, and the bundle carries the keys `bundleKeys` lists.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class DevicePairingVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/device-pairing/vectors.json"
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

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private val keys: JsonObject by lazy { root["keys"]!!.jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.o(k: String): JsonObject = this[k]!!.jsonObject
    private fun JsonObject.strings(k: String): List<String> = this[k]!!.jsonArray.map { it.jsonPrimitive.content }
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!

    private fun grant(g: JsonObject) = PairingGrant(
        grantId = g.s("grantId"),
        username = g.s("username"),
        deviceId = g.s("deviceId"),
        devicePubHex = g.s("devicePubHex"),
        scopes = g.strings("scopes"),
        issuedAt = g["issuedAt"]!!.jsonPrimitive.long,
        expiresAt = g["expiresAt"]!!.jsonPrimitive.long,
        signerRoot = g.s("signerRoot"),
    )

    private fun canonical(g: PairingGrant): ByteArray = DeviceCapabilityGrant.canonicalBytes(
        g.grantId, g.username, g.deviceId, g.devicePubHex, g.scopes, g.issuedAt, g.expiresAt,
    )

    @Test fun adminOnlyLineIsTheGateSentence() {
        assertEquals(root.s("adminOnlyLine"), AddServerGate.ADD_DEVICE_ADMIN_ONLY)
    }

    @Test fun keysMatchTheirSeeds() {
        for ((seed, pub) in listOf("irkSeedHex" to "irkPubHex", "adminRootSeedHex" to "adminRootPubHex", "deviceSeedHex" to "devicePubHex")) {
            val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(bytes(keys.s(seed)))
            assertEquals(pub, keys.s(pub), HexUtil.encode(pair.publicKey))
        }
    }

    @Test fun scopeOrderAndMemberScopesMatch() {
        assertEquals(root.strings("scopeOrder"), DeviceCapabilityGrant.DEVICE_SCOPE_ORDER)
        assertEquals(root.strings("memberScopes"), PairingGrants.MEMBER_SCOPES)
        assertEquals(root["grantTtlMs"]!!.jsonPrimitive.long, PairingGrants.GRANT_TTL_MS)
    }

    @Test fun admitCanonicalAndSignature() {
        val v = root.o("admit")
        val f = v.o("fields")
        val admit = DeviceAdmit(
            username = f.s("username"),
            deviceId = f.s("deviceId"),
            newDevicePubHex = f.s("newDevicePubHex"),
            issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        )
        assertEquals(v.s("canonical"), String(DeviceAdmitClaim.canonicalBytes(admit), Charsets.UTF_8))
        val sig = DeviceAdmitClaim.sign(admit, Ed25519Sign(bytes(keys.s("irkSeedHex"))))
        assertEquals(v.s("signatureHex"), HexUtil.encode(sig))
        Ed25519Verify(bytes(keys.s("irkPubHex"))).verify(bytes(v.s("signatureHex")), DeviceAdmitClaim.canonicalBytes(admit))
    }

    private fun checkGrant(name: String, signerSeedKey: String, signerPubKey: String, root: String) {
        val v = this.root.o(name)
        val g = grant(v.o("grant"))
        assertEquals(root, g.signerRoot)
        assertEquals(v.s("canonical"), String(canonical(g), Charsets.UTF_8))
        val sig = Ed25519Sign(bytes(keys.s(signerSeedKey))).sign(canonical(g))
        assertEquals(v.s("signatureHex"), HexUtil.encode(sig))
        Ed25519Verify(bytes(keys.s(signerPubKey))).verify(bytes(v.s("signatureHex")), canonical(g))
    }

    @Test fun memberGrantIsSignedByTheAccountKey() = checkGrant("memberGrant", "irkSeedHex", "irkPubHex", "membership")

    @Test fun adminGrantIsSignedByTheAdminRoot() = checkGrant("adminGrant", "adminRootSeedHex", "adminRootPubHex", "admin-root")

    @Test fun adminGrantCarriesEveryScope() {
        assertEquals(DeviceCapabilityGrant.DEVICE_SCOPE_ORDER, root.o("adminGrant").o("grant").strings("scopes"))
    }

    @Test fun bundleCarriesExactlyTheListedKeys() {
        val g = grant(root.o("memberGrant").o("grant"))
        val bundle = PairingBundle(
            umkSeedHex = "00".repeat(32),
            admit = DeviceAdmit("harry", g.deviceId, g.devicePubHex, g.issuedAt),
            admitSig = root.o("admit").s("signatureHex"),
            grant = g,
            grantSignature = root.o("memberGrant").s("signatureHex"),
            irkPubHex = keys.s("irkPubHex"),
        )
        val sent = Json.parseToJsonElement(String(bundle.toJsonBytes(), Charsets.UTF_8)).jsonObject.keys
        val required = root.strings("bundleKeys").filterNot { it.endsWith("?") }.toSet()
        val optional = root.strings("bundleKeys").filter { it.endsWith("?") }.map { it.removeSuffix("?") }.toSet()
        assertTrue("missing ${required - sent}", sent.containsAll(required))
        assertTrue("unexpected ${sent - required}", (sent - required).all { it in optional })
    }
}
