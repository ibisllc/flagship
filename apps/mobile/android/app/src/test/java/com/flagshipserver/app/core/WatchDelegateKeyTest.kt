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
        // SINGLE-scope vector — UNCHANGED by the fixed-index sort (the common case).
        val expected = "flagship/watch-delegate-key/v1|g-1|dani|" +
            "ab".repeat(32) + "|boot-approval|1000|2000"
        assertEquals(expected, String(canon, Charsets.UTF_8))
    }

    /** AUTHORITATIVE cross-platform MULTI-SCOPE vector for DeviceCapabilityGrant
     *  — pinned in TS (packages/protocol/tests/deviceCapabilityGrant.test.ts)
     *  and iOS. The scopes include `add-device` + `admin` alongside `browse` —
     *  the set where a LEXICOGRAPHIC sort (the prior mobile bug) diverges from
     *  the DEVICE_SCOPES-index sort: alphabetical -> "add-device,admin,browse",
     *  canonical -> "browse,add-device,admin". Mobile MUST match canonical. */
    @Test
    fun deviceCapabilityGrant_multiScope_canonicalBytes_matchWorker() {
        // FIXED_DEVICE_PUB from the shared TS fixture: byte[i] = (i*3 + 11) & 0xff.
        val pub = ByteArray(32) { i -> ((i * 3 + 11) and 0xff).toByte() }
        val canon = DeviceCapabilityGrant.canonicalBytes(
            grantId = "550e8400-e29b-41d4-a716-446655440000",
            username = "trent",
            deviceId = "00112233445566778899aabbccddeeff",
            devicePubKeyHex = HexUtil.encode(pub),
            scopes = listOf("admin", "browse", "add-device"), // scrambled input on purpose
            issuedAt = 1_780_000_000_000,
            expiresAt = 1_787_776_000_000,
        )
        val expected = "flagship/device-capability-grant/v2" +
            "|550e8400-e29b-41d4-a716-446655440000|trent|00112233445566778899aabbccddeeff|" +
            "0b0e1114171a1d202326292c2f3235383b3e4144474a4d505356595c5f626568" +
            "|browse,add-device,admin|1780000000000|1787776000000"
        val canonStr = String(canon, Charsets.UTF_8)
        assertEquals(expected, canonStr)
        // It must NOT be the alphabetical ordering.
        assertFalse(canonStr.contains("add-device,admin,browse"))
        // And the SHA-256 must match the pinned id shared with TS + iOS.
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(canon)
        assertEquals(
            "7310f7d71e11f74561a20e47fdf2d68c9f6d36abff97df2cb706c422d19bcbd7",
            HexUtil.encode(sha),
        )
    }

    @Test
    fun deviceCapabilityGrant_multiScope_signVerify_roundTrip() {
        val (irk, irkPubHex) = key(1)
        val pub = ByteArray(32) { i -> ((i * 3 + 11) and 0xff).toByte() }
        val devicePubHex = HexUtil.encode(pub)
        val sig = irk.sign(
            DeviceCapabilityGrant.canonicalBytes(
                "550e8400-e29b-41d4-a716-446655440000", "trent", "ipad", devicePubHex,
                listOf("admin", "browse", "add-device"), 1_780_000_000_000, 1_787_776_000_000,
            ),
        )
        val irkPub = HexUtil.decode(irkPubHex)!!
        assertTrue(
            DeviceCapabilityGrant.verify(
                sig, irkPub, "550e8400-e29b-41d4-a716-446655440000", "trent", "ipad", devicePubHex,
                listOf("admin", "browse", "add-device"), 1_780_000_000_000, 1_787_776_000_000,
            ),
        )
        val (_, otherPubHex) = key(9)
        assertFalse(
            DeviceCapabilityGrant.verify(
                sig, HexUtil.decode(otherPubHex)!!, "550e8400-e29b-41d4-a716-446655440000", "trent", "ipad",
                devicePubHex, listOf("admin", "browse", "add-device"), 1_780_000_000_000, 1_787_776_000_000,
            ),
        )
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
