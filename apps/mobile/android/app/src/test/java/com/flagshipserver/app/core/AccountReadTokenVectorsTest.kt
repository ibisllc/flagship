// Runs packages/protocol/test-vectors/account-read-token/vectors.json
// (docs/account-read-token.md), read from disk so a drift fails here: the
// device request and the IRK claim a phone mints a read token with.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AccountReadTokenVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/account-read-token/vectors.json"
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
    private fun JsonObject.l(k: String): Long = this[k]!!.jsonPrimitive.long
    private fun JsonObject.o(k: String): JsonObject = this[k]!!.jsonObject
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!

    private val umk by lazy { bytes(keys.s("umkSeedHex")) }
    private val account by lazy { keys.s("accountId") }
    private val deviceId by lazy { keys.s("deviceId") }

    private fun verifies(pubHex: String, sigHex: String, canonical: String): Boolean =
        runCatching { Ed25519Verify(bytes(pubHex)).verify(bytes(sigHex), canonical.toByteArray()) }.isSuccess

    @Test fun derivesTheKeys() {
        assertEquals(keys.s("deviceSeedHex"), HexUtil.encode(AccountMetadata.deriveAccountDeviceSeed(umk, account, deviceId)))
        assertEquals(keys.s("devicePubHex"), HexUtil.encode(AccountMetadata.deriveAccountDevicePub(umk, account, deviceId)))
        assertEquals(keys.s("irkPubHex"), HexUtil.encode(ServerKeys.deriveProtocolIrkPub(umk)))
    }

    @Test fun reproducesTheDeviceRequest() {
        val v = root.o("device")
        val f = v.o("fields")
        assertEquals(AccountReadTokenProtocol.path(account), f.s("path"))
        val canonical = AccountMetadata.canonicalDirectoryRequest(
            accountId = f.s("accountId"),
            deviceId = f.s("deviceId"),
            signerPubHex = f.s("signerPubHex"),
            method = f.s("method"),
            path = f.s("path"),
            requestId = f.s("requestId"),
            issuedAt = f.l("issuedAt"),
        )
        assertEquals(v.s("canonical"), String(canonical))
        val sig = AccountMetadata.deriveAccountDeviceKey(umk, account, deviceId).sign(canonical)
        assertEquals(v.s("signatureHex"), HexUtil.encode(sig))
        assertTrue(verifies(keys.s("devicePubHex"), v.s("signatureHex"), v.s("canonical")))
        assertFalse(verifies(keys.s("devicePubHex"), v.o("reject").s("signatureHex"), v.s("canonical")))
    }

    @Test fun reproducesTheIrkClaim() {
        val v = root.o("irk")
        val f = v.o("fields")
        assertEquals(AccountReadTokenProtocol.ENDPOINT_LABEL, f.s("endpointLabel"))
        val canonical = DeviceEndpointClaim.canonicalBytes(
            username = f.s("username"),
            endpointLabel = f.s("endpointLabel"),
            phoneIrkPubHex = f.s("phoneIrkPub"),
            issuedAt = f.l("issuedAt"),
            expiresAt = f.l("expiresAt"),
            nonceHex = f.s("nonce"),
        )
        assertEquals(v.s("canonical"), String(canonical))
        val sig = DeviceEndpointClaim.sign(
            irk = ServerKeys.deriveProtocolIrk(umk),
            username = f.s("username"),
            endpointLabel = f.s("endpointLabel"),
            phoneIrkPubHex = f.s("phoneIrkPub"),
            issuedAt = f.l("issuedAt"),
            expiresAt = f.l("expiresAt"),
            nonceHex = f.s("nonce"),
        )
        assertEquals(v.s("signatureHex"), HexUtil.encode(sig))
        assertFalse(verifies(keys.s("irkPubHex"), v.o("reject").s("signatureHex"), v.s("canonical")))
    }
}
