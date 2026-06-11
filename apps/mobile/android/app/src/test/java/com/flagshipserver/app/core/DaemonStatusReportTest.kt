// Mirrors packages/protocol/tests/daemonStatus.test.ts — the PINNED
// cross-platform vector is the single byte-level contract for the A′
// cert-fingerprint pinning primitive. Regenerate only on a deliberate v2
// of the format.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

object DaemonStatusVector {
    val UMK_SEED: ByteArray = ByteArray(32) { 0x07 }
    const val SERVER_ID = "abc5.harry1.flagship.services"
    const val STK_PUB_HEX =
        "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47"
    const val CERT_SHA256 =
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

    // Deliberately unsorted appsServed — canonical bytes sort.
    val REPORT = DaemonStatusReport.Report(
        serverDomain = SERVER_ID,
        certSha256 = CERT_SHA256,
        certValidUntil = 1_800_000_000_000L,
        certIssuer = "C=US, O=Let's Encrypt, CN=YR1",
        appsServed = listOf(
            "wiki.abc5.harry1.flagship.services",
            "abc5.harry1.flagship.services",
        ),
        nonce = "00112233445566778899aabbccddeeff",
        issuedAt = 1_700_000_000_000L,
    )

    const val CANONICAL =
        "flagship/daemon-status/v1|abc5.harry1.flagship.services|" +
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08|" +
            "1800000000000|C=US, O=Let's Encrypt, CN=YR1|" +
            "abc5.harry1.flagship.services,wiki.abc5.harry1.flagship.services|" +
            "00112233445566778899aabbccddeeff|1700000000000"

    const val SIG_HEX =
        "367b6e23c4f6bcc5f7ea0d082c3f411a439642af775be6c12517f9563f7228706" +
            "4d207b9b3af42a92b0a0f8b2ea7d35b10616bc9d73d95d960b12ba1c72c6005"

    val NULL_REPORT = REPORT.copy(
        certSha256 = null,
        certValidUntil = null,
        certIssuer = null,
        appsServed = emptyList(),
    )

    const val NULL_CANONICAL =
        "flagship/daemon-status/v1|abc5.harry1.flagship.services|||||" +
            "00112233445566778899aabbccddeeff|1700000000000"

    const val NULL_SIG_HEX =
        "890c1bcf92399d2560b6a326844a5b66cd934ee724d02722f7e141e01ba555172" +
            "12934a9bde72128aaf21f496a06bec2aed802fb84a5cc67d3e2536e6b782308"

    val SIG: ByteArray get() = HexUtil.decode(SIG_HEX)!!
    val NULL_SIG: ByteArray get() = HexUtil.decode(NULL_SIG_HEX)!!
    val STK_PUB: ByteArray get() = HexUtil.decode(STK_PUB_HEX)!!
}

class DaemonStatusReportTest {

    @Test fun canonicalBytesMatchThePinnedString() {
        assertEquals(
            DaemonStatusVector.CANONICAL,
            String(DaemonStatusReport.canonicalBytes(DaemonStatusVector.REPORT), Charsets.UTF_8),
        )
    }

    @Test fun nullCertFieldsAndEmptyAppsEncodeAsEmptySegments() {
        assertEquals(
            DaemonStatusVector.NULL_CANONICAL,
            String(DaemonStatusReport.canonicalBytes(DaemonStatusVector.NULL_REPORT), Charsets.UTF_8),
        )
    }

    @Test fun pinnedSignatureVerifiesUnderThePinnedStkPub() {
        assertTrue(
            DaemonStatusReport.verify(
                DaemonStatusVector.REPORT, DaemonStatusVector.SIG, DaemonStatusVector.STK_PUB,
            ),
        )
        assertTrue(
            DaemonStatusReport.verify(
                DaemonStatusVector.NULL_REPORT, DaemonStatusVector.NULL_SIG, DaemonStatusVector.STK_PUB,
            ),
        )
    }

    @Test fun rejectsAMutationOfEachSignedField() {
        val r = DaemonStatusVector.REPORT
        val mutations = listOf(
            r.copy(serverDomain = "evil.harry1.flagship.services"),
            r.copy(certSha256 = "ab".repeat(32)),
            r.copy(certSha256 = null),
            r.copy(certValidUntil = 1_800_000_000_001L),
            r.copy(certValidUntil = null),
            r.copy(certIssuer = "C=US, O=Evil CA, CN=X1"),
            r.copy(certIssuer = null),
            r.copy(appsServed = listOf("abc5.harry1.flagship.services")),
            r.copy(appsServed = emptyList()),
            r.copy(nonce = "ff112233445566778899aabbccddeeff"),
            r.copy(issuedAt = 1_700_000_000_001L),
        )
        for (mutated in mutations) {
            assertFalse(
                "mutation should fail verification: $mutated",
                DaemonStatusReport.verify(mutated, DaemonStatusVector.SIG, DaemonStatusVector.STK_PUB),
            )
        }
    }

    @Test fun appsOrderDoesNotAffectTheSignature() {
        val reordered = DaemonStatusVector.REPORT.copy(
            appsServed = DaemonStatusVector.REPORT.appsServed.reversed(),
        )
        assertTrue(
            DaemonStatusReport.verify(reordered, DaemonStatusVector.SIG, DaemonStatusVector.STK_PUB),
        )
    }

    @Test fun rejectsASignatureFromADifferentKey() {
        val otherStkSeed = ServerKeys.deriveStkSeed(
            ByteArray(32) { 0x08 }, DaemonStatusVector.SERVER_ID,
        )
        val sig = com.google.crypto.tink.subtle.Ed25519Sign(otherStkSeed)
            .sign(DaemonStatusReport.canonicalBytes(DaemonStatusVector.REPORT))
        assertFalse(
            DaemonStatusReport.verify(DaemonStatusVector.REPORT, sig, DaemonStatusVector.STK_PUB),
        )
    }

    @Test fun verifyNeverThrowsOnMalformedInputs() {
        assertFalse(
            DaemonStatusReport.verify(DaemonStatusVector.REPORT, ByteArray(3), ByteArray(2)),
        )
        assertFalse(
            DaemonStatusReport.verify(DaemonStatusVector.REPORT, ByteArray(0), DaemonStatusVector.STK_PUB),
        )
    }
}
