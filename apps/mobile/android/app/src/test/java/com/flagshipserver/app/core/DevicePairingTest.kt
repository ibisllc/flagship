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
            admit = DeviceAdmit("hilton", "aa".repeat(32), 1_700_000_000_000L),
            admitSig = "cc".repeat(64),
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
            admit = DeviceAdmit("acme", "dd".repeat(32), 42L),
            admitSig = "ee".repeat(64),
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
}
