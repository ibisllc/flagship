// Phase Android-A — the watch-delegate crypto + boot-auth surface. Canonical
// bytes MUST stay byte-identical to the Worker (packages/protocol +
// packages/control-plane) and to iOS, so these assert the exact `|`-joined
// string in addition to the sign/verify round-trips.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchDelegateKeyTest {

    private fun key(seedByte: Byte): Pair<Ed25519Sign, String> {
        val seed = ByteArray(32) { seedByte }
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        return Ed25519Sign(seed) to HexUtil.encode(pub)
    }

    @Test
    fun canonicalBytes_matchWorker() {
        val canon = WatchDelegateKey.canonicalBytes(
            grantId = "g-1",
            username = "dani",
            delegatePubKeyHex = "ab".repeat(32),
            scopes = listOf("boot-approval"),
            issuedAt = 1000,
            expiresAt = 2000,
        )
        val expected = "flagship/watch-delegate-key/v1|g-1|dani|" +
            "ab".repeat(32) + "|boot-approval|1000|2000"
        assertEquals(expected, String(canon, Charsets.UTF_8))
    }

    @Test
    fun watchDelegate_signVerify_roundTrip() {
        val (irk, irkPubHex) = key(1)
        val (_, delegatePubHex) = key(5)
        val sig = WatchDelegateKey.sign(
            irk, "g-2", "dani", delegatePubHex, listOf("boot-approval"), 1000, 9_000_000,
        )
        val irkPub = HexUtil.decode(irkPubHex)!!
        assertTrue(WatchDelegateKey.verify(sig, irkPub, "g-2", "dani", delegatePubHex, listOf("boot-approval"), 1000, 9_000_000))
        // A different IRK pub must not verify.
        val (_, otherPubHex) = key(9)
        assertFalse(WatchDelegateKey.verify(sig, HexUtil.decode(otherPubHex)!!, "g-2", "dani", delegatePubHex, listOf("boot-approval"), 1000, 9_000_000))
    }

    @Test
    fun revoke_canonicalBytes_andRoundTrip() {
        val (irk, irkPubHex) = key(1)
        assertEquals(
            "flagship/revoke-watch-delegate/v1|g-3|dani|1500",
            String(RevokeWatchDelegate.canonicalBytes("g-3", "dani", 1500), Charsets.UTF_8),
        )
        val sig = RevokeWatchDelegate.sign(irk, "g-3", "dani", 1500)
        assertTrue(RevokeWatchDelegate.verify(sig, HexUtil.decode(irkPubHex)!!, "g-3", "dani", 1500))
    }

    @Test
    fun bootAuth_delegateHeader_carriesDelegateRole_andVerifies() {
        val (delegate, delegatePubHex) = key(5)
        val nonce = ByteArray(32) { 7 }
        val header = BootAuth.delegateHeader(
            serverDomain = "home.dani.flagship.services",
            method = "POST",
            path = "/api/boot/response",
            signer = delegate,
            pubHex = delegatePubHex,
            issuedAt = 1_700_000,
            nonce = nonce,
        )
        val parts = header.split(" ")
        assertEquals("Flagship-Boot-v1", parts[0])
        val json = String(java.util.Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals("delegate", obj["role"]!!.jsonPrimitive.content)
        assertEquals(delegatePubHex, obj["pubKeyHex"]!!.jsonPrimitive.content)

        // The signature must verify under the delegate key over the canonical bytes.
        val canon = BootAuth.canonicalBytes(
            "delegate", "home.dani.flagship.services", "POST", "/api/boot/response",
            obj["pubKeyHex"]!!.jsonPrimitive.content, obj["nonceHex"]!!.jsonPrimitive.content,
            obj["issuedAt"]!!.jsonPrimitive.content.toLong(),
        )
        val sig = HexUtil.decode(obj["signatureHex"]!!.jsonPrimitive.content)!!
        // verify via the public key
        com.google.crypto.tink.subtle.Ed25519Verify(HexUtil.decode(delegatePubHex)!!).verify(sig, canon)
    }
}
