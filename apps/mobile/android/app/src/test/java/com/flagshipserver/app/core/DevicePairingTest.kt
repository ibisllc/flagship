// Phase 3b — pure-JVM pairing primitives: JoinLink build/parse, the
// sealed PairingBundle JSON shape, and the QrSession seal↔open roundtrip
// across the admin + incoming sides (ECDH symmetric → same kEnc).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicePairingTest {

    // ── JoinLink build + parse ───────────────────────────────────────

    @Test fun build_thenParse_roundTrips() {
        val pub = ByteArray(32) { (it + 1).toByte() }
        val url = JoinLink.build("sess-123", pub)
        assertTrue(url.startsWith("https://flagshipserver.com/join?sid=sess-123&pk="))
        val parsed = JoinLink.parse(url)
        assertEquals("sess-123", parsed?.sid)
        assertArrayEquals(pub, parsed?.adminPubKey)
    }

    @Test fun parse_acceptsFlagshipScheme() {
        val pub = ByteArray(32) { 0x07 }
        val pk = Base64URL.encode(pub)
        val parsed = JoinLink.parse("flagship://join?sid=abc&pk=$pk")
        assertEquals("abc", parsed?.sid)
        assertArrayEquals(pub, parsed?.adminPubKey)
    }

    @Test fun parse_acceptsBareQuery() {
        val pub = ByteArray(32) { 0x09 }
        val pk = Base64URL.encode(pub)
        val parsed = JoinLink.parse("sid=zzz&pk=$pk")
        assertEquals("zzz", parsed?.sid)
    }

    @Test fun parse_rejectsNonJoinUrls() {
        val pk = Base64URL.encode(ByteArray(32))
        // A different path on the same host is NOT an invite.
        assertNull(JoinLink.parse("https://flagshipserver.com/app/server?sid=x&pk=$pk"))
        // An unrelated origin with the right query is NOT an invite.
        assertNull(JoinLink.parse("https://evil.example.com/join?sid=x&pk=$pk"))
        assertNull(JoinLink.parse(""))
        assertNull(JoinLink.parse("not a url"))
    }

    @Test fun parse_rejectsMissingOrBadParams() {
        assertNull(JoinLink.parse("https://flagshipserver.com/join?sid=only"))
        assertNull(JoinLink.parse("https://flagshipserver.com/join?pk=only"))
        // pk that isn't 32 bytes.
        val short = Base64URL.encode(ByteArray(16))
        assertNull(JoinLink.parse("https://flagshipserver.com/join?sid=x&pk=$short"))
        // pk that isn't valid base64url.
        assertNull(JoinLink.parse("https://flagshipserver.com/join?sid=x&pk=!!!notb64!!!"))
    }

    // ── PairingBundle JSON ───────────────────────────────────────────

    @Test fun pairingBundle_jsonRoundTrips() {
        val bundle = PairingBundle(
            umkSeedHex = "11".repeat(32),
            admit = DeviceAdmit("hilton", "00".repeat(16), "aa".repeat(32), 1_700_000_000_000L),
            admitSig = "cc".repeat(64),
            grant = PairingGrant("g-1", "hilton", "00".repeat(16), "aa".repeat(32), listOf("view-directory"), 1, 2, "membership"),
            grantSignature = "dd".repeat(64),
        )
        val bytes = bundle.toJsonBytes()
        val back = PairingBundle.fromJsonBytes(bytes)
        assertEquals(bundle, back)
    }

    // ── seal (admin) ↔ open (incoming) over the relay kEnc ───────────

    @Test fun adminSeal_incomingOpens_acrossSessions() {
        // Admin shows QR (its ephemeral pub goes in the link); incoming
        // scans + sends its ephemeral pub. ECDH is symmetric ⇒ same kEnc.
        val admin = QrSession.fresh()
        val incoming = QrSession.fresh()

        val adminSas = admin.pair(incoming.phonePubKey)
        val incomingSas = incoming.pair(admin.phonePubKey)
        assertEquals("both sides derive the same SAS", adminSas, incomingSas)

        val bundle = PairingBundle(
            umkSeedHex = "22".repeat(32),
            admit = DeviceAdmit("acme", "11".repeat(16), "dd".repeat(32), 42L),
            admitSig = "ee".repeat(64),
            grant = PairingGrant("g-2", "acme", "11".repeat(16), "dd".repeat(32), listOf("view-directory"), 42, 84, "membership"),
            grantSignature = "ff".repeat(64),
        )
        val sealed = admin.seal(bundle.toJsonBytes())
        val opened = incoming.open(sealed.ciphertextB64u, sealed.nonceB64u)
        assertEquals(bundle, PairingBundle.fromJsonBytes(opened))
    }

    @Test(expected = Exception::class)
    fun open_withWrongPeer_failsTag() {
        val admin = QrSession.fresh()
        val incoming = QrSession.fresh()
        val attacker = QrSession.fresh()
        admin.pair(incoming.phonePubKey)
        // The opener paired against a DIFFERENT peer ⇒ wrong kEnc ⇒ the
        // GCM tag fails. A MitM can't open the bundle.
        attacker.pair(admin.phonePubKey)  // attacker derives some other kEnc
        val sealed = admin.seal("secret".toByteArray())
        // incoming never paired; open() before pair() OR a wrong-key open
        // both throw. Use the attacker who paired with a non-matching key.
        attacker.open(sealed.ciphertextB64u, sealed.nonceB64u)
    }

    @Test fun adminSeal_isOpenedOnlyByMatchingPeer() {
        val admin = QrSession.fresh()
        val incoming = QrSession.fresh()
        admin.pair(incoming.phonePubKey)
        incoming.pair(admin.phonePubKey)
        val sealed = admin.seal("ok".toByteArray())
        assertEquals("ok", incoming.open(sealed.ciphertextB64u, sealed.nonceB64u).decodeToString())
    }

    private fun freshDevicePub(): String =
        HexUtil.encode(Ed25519Sign.KeyPair.newKeyPair().publicKey)

    @Test fun freshDevicePub_is32BytesHex() {
        assertEquals(64, freshDevicePub().length)
    }

    // ── DeviceAdmit canonical bytes (byte-identical with iOS + the
    //    Worker verifier) ─────────────────────────────────────────────
    //
    // The Worker verifies under canonical bytes
    //   flagship/device-admit/v2|<username>|<deviceId>|<newDevicePubHex>|<issuedAt>
    // Drift in tag, separator, field order, or `issuedAt` rendering
    // breaks every cross-device admit. Mirrors
    // ios/Sources/Flagship/DeviceAdmit.swift `canonicalBytes()`.

    @Test fun deviceAdmit_canonicalBytes_matchesWorkerString() {
        val admit = DeviceAdmit(
            username = "techstars",
            deviceId = "00".repeat(16),
            newDevicePubHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
            issuedAt = 1_700_000_000_000L,
        )
        val expected =
            "flagship/device-admit/v2|" +
                "techstars|" +
                "${"00".repeat(16)}|" +
                "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20|" +
                "1700000000000"
        val actual = DeviceAdmitClaim.canonicalBytes(admit).toString(Charsets.UTF_8)
        assertEquals(expected, actual)
    }

    @Test fun deviceAdmit_canonicalTag_isExact() {
        // The tag itself is load-bearing: changing it silently swaps the
        // verification domain. Pin it independently.
        assertEquals("flagship/device-admit/v2", DeviceAdmitClaim.CANONICAL_TAG)
    }

    @Test fun deviceAdmit_signThenVerify_underAccountIrk() {
        val seed = ByteArray(32) { (it * 7 + 3).toByte() }
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        val admit = DeviceAdmit(
            username = "acme",
            deviceId = "11".repeat(16),
            newDevicePubHex = HexUtil.encode(ByteArray(32) { 0x42 }),
            issuedAt = 42L,
        )
        val sig = DeviceAdmitClaim.sign(admit, com.google.crypto.tink.subtle.Ed25519Sign(seed))
        assertTrue(DeviceAdmitClaim.verify(admit, sig, pair.publicKey))

        // A flipped issuedAt MUST fail (commits to the exact envelope).
        val tampered = admit.copy(issuedAt = 43L)
        assertTrue("tampered envelope must not verify", !DeviceAdmitClaim.verify(tampered, sig, pair.publicKey))
    }
}
