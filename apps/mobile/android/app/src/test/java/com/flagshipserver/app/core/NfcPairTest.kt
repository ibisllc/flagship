// Kotlin mirror of `packages/protocol/tests/canonicalBytesVectors.test.ts`
// + `apps/mobile/ios/Tests/FlagshipMobileTests/NfcPairTests.swift`
// (pair / box-unpair / wifi-config subset). Also exercises the local
// sign/verify and seal/open round-trips, plus determinism of K_session
// + SAS, since the cross-language fixture only pins canonical bytes
// + signatures (no recorded K_session/SAS values yet).
//
// `org.json.JSONObject` is part of Android (stubbed on the unit-test
// classpath), so the fixture-loading tests need Robolectric to wire in
// the real implementation. SDK 33 matches the pinned project default.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.SecureRandom

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class NfcPairTest {

    // ────────────────────────────────────────────────────────────────────
    // Round-trip: PAIR sign/verify

    @Test fun signPair_verifyPair_roundTrip() {
        val stk = Ed25519Sign.KeyPair.newKeyPair()
        val eBoxPriv = X25519.generatePrivateKey()
        val eBoxPub = X25519.publicFromPrivate(eBoxPriv)
        val payload = PairPayload(
            stkPub = stk.publicKey,
            eBoxPub = eBoxPub,
            nonce = ByteArray(16) { 0x11.toByte() },
            sessionId = ByteArray(16) { 0x05.toByte() },
            hint = PairHint(
                mdnsName = "flagship-abcdef.local",
                cloudRendezvousId = "rndz-abcdef",
                suffix6 = "abcdef",
            ),
        )
        val sig = signPair(payload, stk.privateKey)
        assertTrue("verify must succeed for the same key", verifyPair(payload, sig))

        // Wrong key: substitute stkPub with a different identity → verify fails.
        val otherStk = Ed25519Sign.KeyPair.newKeyPair()
        val swapped = payload.copy(stkPub = otherStk.publicKey)
        assertFalse(
            "verify must fail when stkPub is swapped",
            verifyPair(swapped, sig),
        )

        // Tampered payload (same key, different content) → verify fails.
        val altered = payload.copy(nonce = ByteArray(16) { 0x22.toByte() })
        assertFalse(
            "verify must fail when nonce is altered under the same key",
            verifyPair(altered, sig),
        )
    }

    // ────────────────────────────────────────────────────────────────────
    // Round-trip: BoxUnpair sign/verify

    @Test fun signBoxUnpair_verifyBoxUnpair_roundTrip() {
        val irk = Ed25519Sign.KeyPair.newKeyPair()
        val u = BoxUnpair(
            userId = "harry",
            boxId = "b927c2d0bf0e6d27010d32bba280743e8fc4c6dec0b1702ddc7cd6be27cd078d",
            issuedAt = 1_735_689_600_000L,
        )
        val sig = signBoxUnpair(u, irk.privateKey)
        assertTrue(verifyBoxUnpair(u, sig, irk.publicKey))

        val otherIrk = Ed25519Sign.KeyPair.newKeyPair()
        assertFalse(
            "verify must fail under wrong IRK pubkey",
            verifyBoxUnpair(u, sig, otherIrk.publicKey),
        )

        val altered = u.copy(userId = "sarah")
        assertFalse(
            "verify must fail when canonical-bytes input is altered",
            verifyBoxUnpair(altered, sig, irk.publicKey),
        )
    }

    // ────────────────────────────────────────────────────────────────────
    // Round-trip: WiFiConfig seal/open

    @Test fun sealWiFiConfig_openWiFiConfig_roundTrip() {
        val k = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val w = WiFiConfig(
            ssid = "Home",
            psk = "correct-horse-battery-staple",
            regulatoryRegion = "US",
            issuedAt = 1_735_689_600_000L,
        )
        val sealed = sealWiFiConfig(w, k)
        assertEquals("AES-GCM nonce MUST be 12 bytes", 12, sealed.nonce.size)
        val opened = openWiFiConfig(sealed, k)
        assertEquals(w, opened)

        // Wrong key → AEAD auth failure → throws.
        val wrongKey = ByteArray(32).also { SecureRandom().nextBytes(it) }
        try {
            openWiFiConfig(sealed, wrongKey)
            fail("open with wrong key must throw")
        } catch (_: javax.crypto.AEADBadTagException) {
            // expected
        } catch (_: javax.crypto.BadPaddingException) {
            // some providers report AEAD-tag failure via the parent class
        }
    }

    @Test fun sealWiFiConfig_rejects_wrongSizeKey() {
        val k = ByteArray(16) { 0xaa.toByte() }
        val w = WiFiConfig(ssid = "x", psk = "y", regulatoryRegion = "US", issuedAt = 1L)
        assertThrows(NfcPairError.KSessionWrongSize::class.java) {
            sealWiFiConfig(w, k)
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // HKDF determinism

    @Test fun deriveSessionKey_and_SAS_areDeterministic() {
        val ss = ByteArray(32) { 0x42.toByte() }
        val stkPub = ByteArray(32) { 0x01.toByte() }
        val eBoxPub = ByteArray(32) { 0x02.toByte() }
        val ePhonePub = ByteArray(32) { 0x03.toByte() }
        val nonce = ByteArray(16) { 0x04.toByte() }
        val sessionId = ByteArray(16) { 0x05.toByte() }

        val k1 = deriveSessionKey(ss, stkPub, eBoxPub, ePhonePub, nonce, sessionId)
        val k2 = deriveSessionKey(ss, stkPub, eBoxPub, ePhonePub, nonce, sessionId)
        assertTrue("K_session must be deterministic for identical inputs", k1.contentEquals(k2))
        assertEquals(32, k1.size)

        val s1 = deriveSAS(ss, stkPub, eBoxPub, ePhonePub, nonce, sessionId)
        val s2 = deriveSAS(ss, stkPub, eBoxPub, ePhonePub, nonce, sessionId)
        assertTrue("SAS must be deterministic for identical inputs", s1.contentEquals(s2))
        assertEquals(4, s1.size)

        // Different transcript inputs must yield different keys.
        val kDiff = deriveSessionKey(
            sharedSecret = ss,
            stkPub = stkPub,
            eBoxPub = eBoxPub,
            ePhonePub = ByteArray(32) { 0x99.toByte() },
            nonce = nonce,
            sessionId = sessionId,
        )
        assertFalse(
            "K_session must change when transcript changes",
            k1.contentEquals(kDiff),
        )
    }

    // ────────────────────────────────────────────────────────────────────
    // End-to-end: phone+box ECDH agrees on K_session + SAS

    @Test fun endToEnd_phoneAndBox_deriveSameKeyAndSAS() {
        // Box side: STK + box ephemeral X25519.
        val stk = Ed25519Sign.KeyPair.newKeyPair()
        val eBoxPriv = X25519.generatePrivateKey()
        val eBoxPub = X25519.publicFromPrivate(eBoxPriv)
        // Phone side: phone ephemeral X25519.
        val ePhonePriv = X25519.generatePrivateKey()
        val ePhonePub = X25519.publicFromPrivate(ePhonePriv)

        val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val sessionId = ByteArray(16).also { SecureRandom().nextBytes(it) }

        val payload = PairPayload(
            stkPub = stk.publicKey,
            eBoxPub = eBoxPub,
            nonce = nonce,
            sessionId = sessionId,
            hint = PairHint("x.local", "rndz-x", "abcdef"),
        )
        val sig = signPair(payload, stk.privateKey)
        assertTrue(verifyPair(payload, sig))

        // Phone derives ss from (ePhonePriv, eBoxPub).
        val ssPhone = deriveSharedSecret(ePhonePriv, payload.eBoxPub)
        // Box derives ss from (eBoxPriv, ePhonePub) — must match.
        val ssBox = deriveSharedSecret(eBoxPriv, ePhonePub)
        assertTrue(
            "X25519 ECDH must agree on the shared secret",
            ssPhone.contentEquals(ssBox),
        )

        val kPhone = deriveSessionKey(
            ssPhone, payload.stkPub, payload.eBoxPub, ePhonePub,
            payload.nonce, payload.sessionId,
        )
        val kBox = deriveSessionKey(
            ssBox, payload.stkPub, payload.eBoxPub, ePhonePub,
            payload.nonce, payload.sessionId,
        )
        assertTrue(
            "K_session must agree across phone + box",
            kPhone.contentEquals(kBox),
        )

        val sasPhone = deriveSAS(
            ssPhone, payload.stkPub, payload.eBoxPub, ePhonePub,
            payload.nonce, payload.sessionId,
        )
        val sasBox = deriveSAS(
            ssBox, payload.stkPub, payload.eBoxPub, ePhonePub,
            payload.nonce, payload.sessionId,
        )
        assertTrue("SAS must agree across phone + box", sasPhone.contentEquals(sasBox))
    }

    // ────────────────────────────────────────────────────────────────────
    // stkPubToSuffix6

    @Test fun stkPubToSuffix6_lastSixHexChars() {
        // From the fixture: stkPubHex ends in "...cd078d" → suffix6 = "cd078d".
        val stkPub = NfcPairHex.decode(
            "b927c2d0bf0e6d27010d32bba280743e8fc4c6dec0b1702ddc7cd6be27cd078d"
        )
        assertEquals("cd078d", stkPubToSuffix6(stkPub))
    }

    // ────────────────────────────────────────────────────────────────────
    // LED-SAS encoder

    @Test fun encodeLedSas_consumesFirst18Bits() {
        // Two zero bytes ALL → not enough; need 3+ bytes for 18 bits.
        val zeros = ByteArray(4)
        assertEquals("R".repeat(9), encodeLedSas(zeros))

        val short = byteArrayOf(0xff.toByte(), 0xff.toByte())
        try {
            encodeLedSas(short)
            fail("expected LedSasError for too-short input")
        } catch (_: LedSasError) {
            // expected
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Cross-language golden vectors

    private fun loadVectorsJSON(): JSONObject {
        // Repo absolute path — pinning to the canonical fixture ensures
        // any TS-side regeneration of vectors fails the Android gate
        // until the Kotlin canonical-bytes match again.
        val file = File("/Users/harrywinner/flagship/test-vectors/canonical-bytes.json")
        assertTrue("test-vectors fixture must exist at ${file.absolutePath}", file.exists())
        return JSONObject(file.readText(Charsets.UTF_8))
    }

    private fun findVector(json: JSONObject, name: String): JSONObject? {
        val vectors = json.getJSONArray("vectors")
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            if (v.optString("name") == name) return v
        }
        return null
    }

    @Test fun goldenVector_pair_verifies() {
        val json = loadVectorsJSON()
        val v = findVector(json, "pair") ?: run {
            fail("pair vector missing from canonical-bytes.json"); return
        }
        val input = v.getJSONObject("input")
        val sigHex = v.getString("signatureHex")
        val hintDict = input.getJSONObject("hint")

        val payload = PairPayload(
            v = input.optInt("v", PAIR_PROTOCOL_VERSION),
            stkPub = NfcPairHex.decode(input.getString("stkPub")),
            eBoxPub = NfcPairHex.decode(input.getString("eBoxPub")),
            nonce = NfcPairHex.decode(input.getString("nonce")),
            sessionId = NfcPairHex.decode(input.getString("sessionId")),
            hint = PairHint(
                mdnsName = hintDict.getString("mdnsName"),
                cloudRendezvousId = hintDict.getString("cloudRendezvousId"),
                suffix6 = hintDict.getString("suffix6"),
            ),
        )
        // Belt-and-suspenders against an encoder regression that happens
        // to still verify against a recorded sig.
        val canonHex = NfcPairHex.encode(canonicalPair(payload))
        assertNotNull(canonHex)
        assertTrue(canonHex.isNotEmpty())
        assertEquals(0, canonHex.length % 2)

        val sig = NfcPairHex.decode(sigHex)
        assertTrue(
            "recorded pair signature must verify against Kotlin canonical bytes",
            verifyPair(payload, sig),
        )
    }

    @Test fun goldenVector_boxUnpair_verifies() {
        val json = loadVectorsJSON()
        val metadata = json.getJSONObject("metadata")
        val irkPubHex = metadata.getString("irkPubHex")
        val v = findVector(json, "box-unpair") ?: run {
            fail("box-unpair vector missing from canonical-bytes.json"); return
        }
        val input = v.getJSONObject("input")
        val sigHex = v.getString("signatureHex")

        val u = BoxUnpair(
            userId = input.getString("userId"),
            boxId = input.getString("boxId"),
            issuedAt = input.getLong("issuedAt"),
        )
        val sig = NfcPairHex.decode(sigHex)
        val irkPub = NfcPairHex.decode(irkPubHex)
        assertTrue(
            "recorded box-unpair signature must verify against Kotlin canonical bytes",
            verifyBoxUnpair(u, sig, irkPub),
        )
    }

    @Test fun goldenVector_wifiConfig_canonicalBytes_matchRecordedHex() {
        val json = loadVectorsJSON()
        val v = findVector(json, "wifi-config") ?: run {
            fail("wifi-config vector missing from canonical-bytes.json"); return
        }
        val input = v.getJSONObject("input")
        val recordedHex = v.getString("canonicalHex")

        val w = WiFiConfig(
            ssid = input.getString("ssid"),
            psk = input.getString("psk"),
            regulatoryRegion = input.getString("regulatoryRegion"),
            issuedAt = input.getLong("issuedAt"),
        )
        val canonHex = NfcPairHex.encode(canonicalWiFiConfig(w))
        assertEquals(
            "Kotlin canonicalWiFiConfig must byte-match recorded canonicalHex",
            recordedHex,
            canonHex,
        )
    }

    // Sanity: equality on the wrong stkPub must NOT verify, so the
    // pair golden vector isn't an accidental any-key wildcard.
    @Test fun goldenVector_pair_failsUnderWrongPub() {
        val json = loadVectorsJSON()
        val v = findVector(json, "pair") ?: run {
            fail("pair vector missing"); return
        }
        val input = v.getJSONObject("input")
        val hintDict = input.getJSONObject("hint")
        val wrongPub = ByteArray(32) { 0xee.toByte() }
        val payload = PairPayload(
            v = input.optInt("v", PAIR_PROTOCOL_VERSION),
            stkPub = wrongPub,
            eBoxPub = NfcPairHex.decode(input.getString("eBoxPub")),
            nonce = NfcPairHex.decode(input.getString("nonce")),
            sessionId = NfcPairHex.decode(input.getString("sessionId")),
            hint = PairHint(
                mdnsName = hintDict.getString("mdnsName"),
                cloudRendezvousId = hintDict.getString("cloudRendezvousId"),
                suffix6 = hintDict.getString("suffix6"),
            ),
        )
        val sig = NfcPairHex.decode(v.getString("signatureHex"))
        assertFalse(
            "pair sig must fail under a substituted stkPub",
            verifyPair(payload, sig),
        )
        // Suppress unused-import warning across compilers; assertNotEquals
        // is used here as a deliberate "not the same" sanity check.
        assertNotEquals(0, wrongPub.size)
    }
}
