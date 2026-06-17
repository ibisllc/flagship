// PINNED cross-platform vectors for the maintainer-trust ENFORCEMENT feature
// (verifyComBlessing / authorizedCaKeys), the half of the maintainers port the
// app's control-server trust gate calls.
//
// The vectors below are produced by a node script run against
// @ibisllc/maintainers with the SAME fixed seeds as
// maintainers/packages/cli/tests/caEndorsement.test.ts (caRootMandate):
// maintainer = keypair(1) (seed = 32 bytes, byte[0]=1), hotCa = keypair(9).
// Captured literal canonical-byte strings + signatures + pubkeys are embedded
// here exactly like DaemonStatusReportTest. They MUST match Worker A's
// packages/protocol/tests/fixtures/maintainerTrust.vectors.json and the iOS
// MaintainerTrustVectorTests.swift byte-for-byte — regenerate only on a
// deliberate v2 of the format.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MaintainerTrustVectorTest {

    companion object {
        const val PIN = "a170c80dcf3b6d1d42fcc196c8d5f2dbec7a87db6a3d5d2692773442af4a62ee"
        const val MAINTAINER_PUB = "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
        const val HOT_CA_PUB = "bb5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a"
        const val ROGUE_PUB = "d523845a249f6994b019cbb33057d352237858ff79a98cb2359d805ee45044d6"

        const val ROOT_SIG =
            "5a72395870ce102c85eadec3c5927aeb28f02a90e2d56eea59773b60a7ea5dd5" +
                "96c1c5ba70965fba939d6f558afcb222ddffc50dc8856f2e7fe1c5e8792fa402"
        const val ENDORSEMENT_SIG =
            "1702e3497ea944eff9586b5f596787715fa3f37431fbe381adac87d6ed440da3" +
                "8d62bee536d701f9b76326ea1823b6244271ef27e18fd062b51ca8843f178102"

        const val ROOT_CANONICAL =
            "maintainers/mandate/v1|ca-root-0000-4000-8000-000000000000|ca|" +
                "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc|" +
                "2026-01-01T00:00:00.000Z|2027-01-01T00:00:00.000Z|" +
                "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc|" +
                "1|1|31536000|31536000|flagship|harry@flagship.services||ca|" +
                "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"

        const val END_CANONICAL =
            "maintainers/ca-endorsement/v1|ca-e1-0000-0000-0000-000000000000|ca|" +
                "bb5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a|" +
                "flagship/directory-attestation|2026-05-17T12:00:00.000Z|" +
                "2026-05-24T12:00:00.000Z|2026-05-17T12:00:00.000Z|" +
                "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"

        // Lease window: notBefore .. notAfter = 2026-05-17 .. 2026-05-24.
        const val WITHIN_MS = 1_779_235_200_000L // 2026-05-20
        const val AFTER_MS = 1_782_777_600_000L  // 2026-06-30 (lapsed)
        const val BEFORE_MS = 1_777_593_600_000L // 2026-05-01 (not-yet)

        fun root(): Mandate = Mandate(
            kind = "Mandate", version = 1,
            mandateId = "ca-root-0000-4000-8000-000000000000",
            track = "ca", holder = MAINTAINER_PUB,
            issuedAt = "2026-01-01T00:00:00.000Z",
            expiresAt = "2027-01-01T00:00:00.000Z",
            successors = listOf(MAINTAINER_PUB),
            approvalRule = MaintainersApprovalRule("threshold", 1),
            minSuccessors = 1,
            maxDurationSeconds = 31_536_000,
            defaultDurationSeconds = 31_536_000,
            project = MaintainersProject("flagship", "harry@flagship.services", null, listOf("ca")),
            signedBy = MAINTAINER_PUB,
            signatures = listOf(MaintainersSignature(MAINTAINER_PUB, ROOT_SIG)),
        )

        fun endorsement(
            caPubkey: String = HOT_CA_PUB,
            signedBy: String = MAINTAINER_PUB,
            sig: String = ENDORSEMENT_SIG,
        ): CaEndorsement = CaEndorsement(
            kind = "CaEndorsement", version = 1,
            endorsementId = "ca-e1-0000-0000-0000-000000000000",
            track = "ca", caPubkey = caPubkey,
            scope = "flagship/directory-attestation",
            notBefore = "2026-05-17T12:00:00.000Z",
            notAfter = "2026-05-24T12:00:00.000Z",
            issuedAt = "2026-05-17T12:00:00.000Z",
            signedBy = signedBy,
            signatures = listOf(MaintainersSignature(MAINTAINER_PUB, sig)),
        )
    }

    private fun blessing(
        pin: String = PIN,
        caPubkey: String = HOT_CA_PUB,
        mandates: List<Mandate> = listOf(root()),
        endorsements: List<CaEndorsement> = listOf(endorsement()),
    ) = MaintainerBlessing(pin, caPubkey, mandates, endorsements)

    // --- Byte identity -------------------------------------------------------

    @Test
    fun canonicalBytesByteIdentical() {
        assertEquals(ROOT_CANONICAL, String(MaintainersCanonical.canonicalMandate(root()), Charsets.UTF_8))
        assertEquals(
            END_CANONICAL,
            String(MaintainersCanonical.canonicalCaEndorsement(endorsement()), Charsets.UTF_8),
        )
    }

    @Test
    fun pinHashMatches() {
        assertEquals(PIN, MaintainersCanonical.mandatePinHash(root()))
    }

    @Test
    fun pinnedSignaturesVerify() {
        assertTrue(
            MaintainersEd25519.verify(
                ROOT_SIG, MaintainersCanonical.canonicalMandate(root()), MAINTAINER_PUB,
            ),
        )
        assertTrue(
            MaintainersEd25519.verify(
                ENDORSEMENT_SIG, MaintainersCanonical.canonicalCaEndorsement(endorsement()), MAINTAINER_PUB,
            ),
        )
    }

    // --- Chain + authorized keys verdicts -----------------------------------

    @Test
    fun chainAnchorsAtPin() {
        val chain = MaintainersVerifier.verifyMandateChainFromPin(PIN, listOf(root()))
        assertNull(chain.rootError)
        assertEquals(1, chain.validMandates.size)
        assertEquals(MAINTAINER_PUB, chain.root?.holder)
    }

    @Test
    fun authorizedKeysWithinWindow() {
        val chain = MaintainersVerifier.verifyMandateChainFromPin(PIN, listOf(root()))
        assertEquals(
            listOf(HOT_CA_PUB),
            MaintainersCaVerifier.authorizedCaKeys(listOf(endorsement()), chain, WITHIN_MS),
        )
    }

    @Test
    fun authorizedKeysEmptyWhenLapsed() {
        val chain = MaintainersVerifier.verifyMandateChainFromPin(PIN, listOf(root()))
        assertEquals(
            emptyList<String>(),
            MaintainersCaVerifier.authorizedCaKeys(listOf(endorsement()), chain, AFTER_MS),
        )
    }

    @Test
    fun authorizedKeysEmptyWhenNotYet() {
        val chain = MaintainersVerifier.verifyMandateChainFromPin(PIN, listOf(root()))
        assertEquals(
            emptyList<String>(),
            MaintainersCaVerifier.authorizedCaKeys(listOf(endorsement()), chain, BEFORE_MS),
        )
    }

    @Test
    fun emptyPinFailsClosed() {
        val chain = MaintainersVerifier.verifyMandateChainFromPin("", listOf(root()))
        assertEquals(V2RootFailReason.NoPin, chain.rootError)
        assertEquals(
            emptyList<String>(),
            MaintainersCaVerifier.authorizedCaKeys(listOf(endorsement()), chain, WITHIN_MS),
        )
    }

    // --- verifyComBlessing (the feature's top-level verdict) ----------------

    @Test
    fun blessingTrustedWithinWindow() {
        assertTrue(MaintainersComTrust.verifyComBlessing(blessing(), WITHIN_MS, PIN))
    }

    @Test
    fun blessingUntrustedWhenLapsed() {
        assertFalse(MaintainersComTrust.verifyComBlessing(blessing(), AFTER_MS, PIN))
    }

    @Test
    fun blessingUntrustedWhenComServesUnauthorizedKey() {
        assertFalse(
            MaintainersComTrust.verifyComBlessing(blessing(caPubkey = ROGUE_PUB), WITHIN_MS, PIN),
        )
    }

    @Test
    fun blessingUntrustedWhenComLowersTheFloor() {
        assertFalse(
            MaintainersComTrust.verifyComBlessing(blessing(pin = "0".repeat(64)), WITHIN_MS, PIN),
        )
    }

    @Test
    fun blessingUntrustedWhenSignedByRogue() {
        assertFalse(
            MaintainersComTrust.verifyComBlessing(
                blessing(endorsements = listOf(endorsement(signedBy = ROGUE_PUB))), WITHIN_MS, PIN,
            ),
        )
    }

    @Test
    fun blessingFailsClosedOnEmptyBakedPin() {
        assertFalse(MaintainersComTrust.verifyComBlessing(blessing(), WITHIN_MS, ""))
    }
}
