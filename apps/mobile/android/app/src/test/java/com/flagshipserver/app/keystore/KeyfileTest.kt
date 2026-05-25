// Byte-compatibility + round-trip tests for the `.flagshipkey` account
// backup. The INTEROP GATE proves the Kotlin reader unwraps the golden
// file produced by the canonical TS writer (packages/protocol/src/
// keyfile.ts) — argon2id params, AAD canonical string, AES-256-GCM
// ct||tag split, hex encoding all agree.
//
// Runs under Robolectric so org.json (used by Keyfile.unwrap) resolves
// to a real implementation rather than the android.jar stub. The crypto
// itself (BouncyCastle argon2id + javax AES-GCM) is pure JVM.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class KeyfileTest {

    private companion object {
        const val GOLDEN_FILE = """
            {"magic":"flagship-key","version":1,"username":"interop","accountId":"acct-golden","createdAt":"2026-05-25T00:00:00.000Z","kdf":{"algo":"argon2id","m":65536,"t":3,"p":4,"saltHex":"fc6235a631ca2ca22c0335541200972a"},"aead":"aes-256-gcm","nonceHex":"a032679f057a61a653814b15","ciphertextHex":"606618b0f9918b91ee724ff83ee7cb88728d9b6663899991c0e2e0133579547ec3547122d83165ebfe0d2d74fc827c24"}
        """

        const val GOLDEN_PASSPHRASE = "interop-test-passphrase"
        const val GOLDEN_SEED_HEX =
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

        // Light params so round-trip tests run fast — the params travel
        // in the file so unwrap uses them too.
        val FAST = Keyfile.ArgonParams(m = 256, t = 1, p = 1)
    }

    // ── INTEROP GATE ──────────────────────────────────────────────

    @Test
    fun interop_unwrapsGoldenFileToExpectedSeed() {
        val (seed, meta) = Keyfile.unwrap(GOLDEN_FILE.trim(), GOLDEN_PASSPHRASE)
        assertEquals(GOLDEN_SEED_HEX, HexUtil.encode(seed))
        assertEquals("interop", meta.username)
        assertEquals("acct-golden", meta.accountId)
        assertEquals("2026-05-25T00:00:00.000Z", meta.createdAt)
    }

    @Test
    fun interop_wrongPassphraseFailsCleanly() {
        try {
            Keyfile.unwrap(GOLDEN_FILE.trim(), "wrong-passphrase-here")
            fail("expected KeyfileException")
        } catch (e: Keyfile.KeyfileException) {
            assertEquals(Keyfile.KeyfileException.Code.BAD_PASSPHRASE, e.code)
        }
    }

    // Emit a keyfile OUR code produces so the TS side can confirm it
    // reads. Printed to stdout for the operator + asserted self-readable.
    @Test
    fun emit_sampleKeyfile_roundTrips() {
        val seed = HexUtil.decode(GOLDEN_SEED_HEX)!!
        val meta = Keyfile.Meta(
            username = "interop",
            accountId = "acct-golden",
            createdAt = "2026-05-25T00:00:00.000Z",
        )
        val text = Keyfile.wrap(seed, GOLDEN_PASSPHRASE, meta, FAST)
        println("=== SAMPLE .flagshipkey PRODUCED BY ANDROID (params m=256,t=1,p=1) ===")
        println(text)
        println("=== END SAMPLE ===")
        // Self-readable.
        val (recovered, _) = Keyfile.unwrap(text, GOLDEN_PASSPHRASE)
        assertEquals(GOLDEN_SEED_HEX, HexUtil.encode(recovered))
    }

    // ── Round trip ────────────────────────────────────────────────

    @Test
    fun wrapThenUnwrap_recoversSeed() {
        val seed = ByteArray(32) { (it + 1).toByte() }
        val meta = Keyfile.Meta("alice", "acct-1", "2026-05-25T12:00:00.000Z")
        val text = Keyfile.wrap(seed, "correct horse battery", meta, FAST)
        val (recovered, recoveredMeta) = Keyfile.unwrap(text, "correct horse battery")
        assertTrue(seed.contentEquals(recovered))
        assertEquals(meta, recoveredMeta)
    }

    @Test
    fun wrap_omitsAccountIdWhenNull() {
        val seed = ByteArray(32) { 7 }
        val meta = Keyfile.Meta("bob", null, "2026-05-25T12:00:00.000Z")
        val text = Keyfile.wrap(seed, "longenoughpass", meta, FAST)
        assertFalse("null accountId must be omitted", text.contains("accountId"))
        val (recovered, recoveredMeta) = Keyfile.unwrap(text, "longenoughpass")
        assertTrue(seed.contentEquals(recovered))
        assertNull(recoveredMeta.accountId)
    }

    @Test
    fun unwrap_wrongPassphraseThrowsBadPassphrase() {
        val seed = ByteArray(32) { 3 }
        val meta = Keyfile.Meta("alice", null, "2026-05-25T12:00:00.000Z")
        val text = Keyfile.wrap(seed, "the-right-pass", meta, FAST)
        try {
            Keyfile.unwrap(text, "the-wrong-pass")
            fail("expected KeyfileException")
        } catch (e: Keyfile.KeyfileException) {
            assertEquals(Keyfile.KeyfileException.Code.BAD_PASSPHRASE, e.code)
        }
    }

    @Test
    fun unwrap_tamperedHeaderFailsAadBinding() {
        val seed = ByteArray(32) { 5 }
        val meta = Keyfile.Meta("alice", "acct-1", "2026-05-25T12:00:00.000Z")
        val text = Keyfile.wrap(seed, "the-right-pass", meta, FAST)
        // Flip the username in the header — the AAD binding must reject it.
        val tampered = text.replace("\"alice\"", "\"mallory\"")
        assertFalse(tampered == text)
        try {
            Keyfile.unwrap(tampered, "the-right-pass")
            fail("expected KeyfileException")
        } catch (e: Keyfile.KeyfileException) {
            assertEquals(Keyfile.KeyfileException.Code.BAD_PASSPHRASE, e.code)
        }
    }

    @Test
    fun unwrap_notAKeyfileThrowsMalformed() {
        for (bad in listOf("{\"hello\":\"world\"}", "not json at all")) {
            try {
                Keyfile.unwrap(bad, "whatever")
                fail("expected MALFORMED for: $bad")
            } catch (e: Keyfile.KeyfileException) {
                assertEquals(Keyfile.KeyfileException.Code.MALFORMED, e.code)
            }
        }
    }

    @Test
    fun wrap_rejectsShortPassphrase() {
        val seed = ByteArray(32) { 1 }
        val meta = Keyfile.Meta("alice", null, "2026-05-25T12:00:00.000Z")
        try {
            Keyfile.wrap(seed, "short", meta)
            fail("expected MALFORMED")
        } catch (e: Keyfile.KeyfileException) {
            assertEquals(Keyfile.KeyfileException.Code.MALFORMED, e.code)
        }
    }
}
