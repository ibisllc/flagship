// Mirrors packages/protocol/tests/boxTrustStatus.test.ts — the PINNED
// cross-platform vector is the single byte-level contract for the per-box
// relay-trust verdict. Regenerate only on a deliberate v2 of the format.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

object BoxTrustStatusVector {
    val UMK_SEED: ByteArray = ByteArray(32) { 0x07 }
    const val SERVER_ID = "abc5.harry1.flagship.services"
    const val STK_PUB_HEX =
        "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47"

    val REPORT = BoxTrustStatusReport.Report(
        serverDomain = SERVER_ID,
        relayVerdict = BoxTrustStatusReport.RelayVerdict.UNTRUSTED,
        lockedDown = true,
        failingCertHash =
            "1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372819a0b1c2d3e4f5061",
        coveringExceptionCertHash =
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        nonce = "00112233445566778899aabbccddeeff",
        issuedAt = 1_700_000_000_000L,
    )

    const val CANONICAL =
        "flagship/box-trust-status/v1|abc5.harry1.flagship.services|untrusted|1|" +
            "1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372819a0b1c2d3e4f5061|" +
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899|" +
            "00112233445566778899aabbccddeeff|1700000000000"

    const val SIG_HEX =
        "85ad9b3fb100c7ab8ca3600ac8970a3a66fd2c5ee0ebf363573dac5b70b420ab9" +
            "3a7cace49c5fb153c8549933820893aaad3a5a24a47f6aa3be01babbdd6f502"

    val TRUSTED_REPORT = BoxTrustStatusReport.Report(
        serverDomain = SERVER_ID,
        relayVerdict = BoxTrustStatusReport.RelayVerdict.TRUSTED,
        lockedDown = false,
        failingCertHash = null,
        coveringExceptionCertHash = null,
        nonce = "00112233445566778899aabbccddeeff",
        issuedAt = 1_700_000_000_000L,
    )

    const val TRUSTED_CANONICAL =
        "flagship/box-trust-status/v1|abc5.harry1.flagship.services|trusted|0|||" +
            "00112233445566778899aabbccddeeff|1700000000000"

    const val TRUSTED_SIG_HEX =
        "e674e0c3e329092e11afe5dd9faab14a82edfc4c5063d01eb3f9b6693bc966fb4" +
            "7015b3258b88b03b4b61c82442a017b5b94a8384a7396eb3539f6db3f053807"

    val SIG: ByteArray get() = HexUtil.decode(SIG_HEX)!!
    val TRUSTED_SIG: ByteArray get() = HexUtil.decode(TRUSTED_SIG_HEX)!!
    val STK_PUB: ByteArray get() = HexUtil.decode(STK_PUB_HEX)!!
}

class BoxTrustStatusReportTest {

    @Test fun canonicalBytesMatchThePinnedString() {
        assertEquals(
            BoxTrustStatusVector.CANONICAL,
            String(BoxTrustStatusReport.canonicalBytes(BoxTrustStatusVector.REPORT), Charsets.UTF_8),
        )
    }

    @Test fun trustedHealthyEncodesOptionalFieldsAsEmptySegments() {
        assertEquals(
            BoxTrustStatusVector.TRUSTED_CANONICAL,
            String(BoxTrustStatusReport.canonicalBytes(BoxTrustStatusVector.TRUSTED_REPORT), Charsets.UTF_8),
        )
    }

    @Test fun pinnedSignatureVerifiesUnderThePinnedStkPub() {
        assertTrue(
            BoxTrustStatusReport.verify(
                BoxTrustStatusVector.REPORT, BoxTrustStatusVector.SIG, BoxTrustStatusVector.STK_PUB,
            ),
        )
        assertTrue(
            BoxTrustStatusReport.verify(
                BoxTrustStatusVector.TRUSTED_REPORT, BoxTrustStatusVector.TRUSTED_SIG, BoxTrustStatusVector.STK_PUB,
            ),
        )
    }

    @Test fun rejectsAMutationOfEachSignedField() {
        val r = BoxTrustStatusVector.REPORT
        val mutations = listOf(
            r.copy(serverDomain = "evil.harry1.flagship.services"),
            r.copy(relayVerdict = BoxTrustStatusReport.RelayVerdict.TRUSTED),
            r.copy(relayVerdict = BoxTrustStatusReport.RelayVerdict.UNKNOWN),
            r.copy(lockedDown = false),
            r.copy(failingCertHash = "ab".repeat(32)),
            r.copy(failingCertHash = null),
            r.copy(coveringExceptionCertHash = "cd".repeat(32)),
            r.copy(coveringExceptionCertHash = null),
            r.copy(nonce = "ff112233445566778899aabbccddeeff"),
            r.copy(issuedAt = 1_700_000_000_001L),
        )
        for (mutated in mutations) {
            assertFalse(
                "mutation should fail verification: $mutated",
                BoxTrustStatusReport.verify(mutated, BoxTrustStatusVector.SIG, BoxTrustStatusVector.STK_PUB),
            )
        }
    }

    @Test fun rejectsASignatureFromADifferentKey() {
        val otherStkSeed = ServerKeys.deriveStkSeed(
            ByteArray(32) { 0x08 }, BoxTrustStatusVector.SERVER_ID,
        )
        val sig = com.google.crypto.tink.subtle.Ed25519Sign(otherStkSeed)
            .sign(BoxTrustStatusReport.canonicalBytes(BoxTrustStatusVector.REPORT))
        assertFalse(
            BoxTrustStatusReport.verify(BoxTrustStatusVector.REPORT, sig, BoxTrustStatusVector.STK_PUB),
        )
    }

    @Test fun verifyNeverThrowsOnMalformedInputs() {
        assertFalse(
            BoxTrustStatusReport.verify(BoxTrustStatusVector.REPORT, ByteArray(3), ByteArray(2)),
        )
    }
}
