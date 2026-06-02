// KNOWN-ANSWER tests that LOCK Android's passphrase derivation to the
// canonical webapp sub-origin (apps/web/public/recovery/recovery.js). If
// any of these drift, a passphrase enrolled on one surface stops
// recovering on another — so these are load-bearing.
//
// Vectors were generated from recovery.js's derivePassphraseSecrets and
// independently reproduced against BouncyCastle's Argon2id + JCE HKDF.
// Pure JVM (BouncyCastle + javax.crypto) — no Robolectric needed.
//
// Argon2id at 46 MiB / t=3 takes ~1-2s per call; that's expected.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class RecoveryDerivationTest {

    private companion object {
        const val PASSPHRASE = "correct horse battery staple"
        const val USERNAME = "demo1234"

        const val MASTER_KEY_HEX =
            "3caa60297e4e7b47706de4daad0113474b83adceb347d687cd75f95be68abc59"
        const val FETCH_TOKEN_HEX =
            "abc2929a7c417541d592d50e97e1ae50b6f1e04a97332c951f9be7fb445a2f35"
        const val PRF_SALT_HEX =
            "989187b759f0532849837ced25036b2d8b6fec7e3fd2b8980ad94063ad4d46f2"
        const val FETCH_TOKEN_SHA256 =
            "1855f76047a70b68cd18403ca6c907cfa633763a66778d81eb365d27bfd852ef"
        const val PRF_SALT_SHA256 =
            "7b4f096b4f508e43a587721de4f8377ea694bee808d6ba3061d83ddd1f33d5bd"
    }

    @Test
    fun knownAnswer_fetchTokenAndPrfSalt_matchWebapp() {
        val secrets = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, USERNAME)
        assertEquals(FETCH_TOKEN_HEX, HexUtil.encode(secrets.fetchToken))
        assertEquals(PRF_SALT_HEX, HexUtil.encode(secrets.prfSalt))
    }

    @Test
    fun knownAnswer_sha256OfTokens_matchStoredGateHashes() {
        // These are the exact bytes .com stores as fetchTokenHash /
        // prfSaltHash and compares against on the gated fetch.
        val secrets = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, USERNAME)
        assertEquals(FETCH_TOKEN_SHA256, RecoveryDerivation.sha256Hex(secrets.fetchToken))
        assertEquals(PRF_SALT_SHA256, RecoveryDerivation.sha256Hex(secrets.prfSalt))
    }

    @Test
    fun sha256Hex_emptyInput_isWellKnownDigest() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            RecoveryDerivation.sha256Hex(ByteArray(0)),
        )
    }

    @Test
    fun masterKey_isStableAcrossCalls_andLengths() {
        // The same (passphrase, username) yields the same secrets; both
        // halves are exactly 32 bytes (the wrap key + the PRF eval input).
        val a = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, USERNAME)
        val b = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, USERNAME)
        assertEquals(HexUtil.encode(a.fetchToken), HexUtil.encode(b.fetchToken))
        assertEquals(HexUtil.encode(a.prfSalt), HexUtil.encode(b.prfSalt))
        assertEquals(32, a.fetchToken.size)
        assertEquals(32, a.prfSalt.size)
        // fetchToken and prfSalt are domain-separated → never equal.
        assertNotEquals(HexUtil.encode(a.fetchToken), HexUtil.encode(a.prfSalt))
    }

    @Test
    fun username_isCaseFolded() {
        // recovery.js lowercases the username before salting, so the same
        // passphrase under different-cased usernames derives identically.
        val lower = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, "demo1234")
        val upper = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, "DEMO1234")
        assertEquals(HexUtil.encode(lower.fetchToken), HexUtil.encode(upper.fetchToken))
        assertEquals(HexUtil.encode(lower.prfSalt), HexUtil.encode(upper.prfSalt))
    }

    @Test
    fun differentPassphrase_yieldsDifferentSecrets() {
        val a = RecoveryDerivation.derivePassphraseSecrets(PASSPHRASE, USERNAME)
        val b = RecoveryDerivation.derivePassphraseSecrets("a different passphrase", USERNAME)
        assertNotEquals(HexUtil.encode(a.fetchToken), HexUtil.encode(b.fetchToken))
        assertNotEquals(HexUtil.encode(a.prfSalt), HexUtil.encode(b.prfSalt))
    }
}
