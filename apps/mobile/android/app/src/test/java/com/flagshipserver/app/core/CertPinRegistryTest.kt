// A′ phase 4 — the pin install path (verified /pods reconcile) and the
// host→pin lookup. A pin is installed ONLY when the STK signature verifies
// under the LOCALLY derived STK, the report is about the pod it rides on,
// it is fresh, and it carries a well-formed fingerprint; every failure mode
// degrades to "no pin" (default TLS validation), never to a wrong pin.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DaemonStatusReportWire
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.SignedDaemonStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CertPinRegistryTest {

    private val now = DaemonStatusVector.REPORT.issuedAt + 1_000L

    private fun wireReport(
        r: DaemonStatusReport.Report = DaemonStatusVector.REPORT,
    ) = DaemonStatusReportWire(
        serverDomain = r.serverDomain,
        certSha256 = r.certSha256,
        certValidUntil = r.certValidUntil,
        certIssuer = r.certIssuer,
        appsServed = r.appsServed,
        nonce = r.nonce,
        issuedAt = r.issuedAt,
    )

    private fun pod(
        serverDomain: String = DaemonStatusVector.SERVER_ID,
        revokedAt: Long? = null,
        signedStatus: SignedDaemonStatus? = SignedDaemonStatus(
            report = wireReport(),
            signatureHex = DaemonStatusVector.SIG_HEX,
        ),
    ) = PodDirectoryEntry(
        serverDomain = serverDomain,
        identityPubKey = DaemonStatusVector.STK_PUB_HEX,
        revokedAt = revokedAt,
        signedStatus = signedStatus,
    )

    private fun registryWith(vararg pods: PodDirectoryEntry, nowMs: Long = now): CertPinRegistry =
        CertPinRegistry().apply { update(pods.toList(), DaemonStatusVector.UMK_SEED, nowMs) }

    @Test fun verifiedReportInstallsThePin() {
        val reg = registryWith(pod())
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun serviceHostsUnderTheBoxRideTheBoxPin() {
        val reg = registryWith(pod())
        assertEquals(
            DaemonStatusVector.CERT_SHA256,
            reg.pinFor("wiki.abc5.harry1.flagship.services"),
        )
        assertEquals(
            DaemonStatusVector.CERT_SHA256,
            reg.pinFor("deep.nested.abc5.harry1.flagship.services"),
        )
    }

    @Test fun hostLookupNormalizesCaseAndTrailingDot() {
        val reg = registryWith(pod())
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor("ABC5.HARRY1.FLAGSHIP.SERVICES"))
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor("abc5.harry1.flagship.services."))
    }

    @Test fun unknownHostsHaveNoPin() {
        val reg = registryWith(pod())
        assertNull(reg.pinFor("other.harry1.flagship.services"))
        assertNull(reg.pinFor("flagshipserver.com"))
        // A suffix that is not a label boundary must not match.
        assertNull(reg.pinFor("evilabc5.harry1.flagship.services"))
        assertNull(reg.pinFor(""))
    }

    @Test fun badSignatureInstallsNoPin() {
        val tampered = SignedDaemonStatus(
            report = wireReport(),
            signatureHex = "00" + DaemonStatusVector.SIG_HEX.drop(2),
        )
        assertNull(registryWith(pod(signedStatus = tampered)).pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun malformedSignatureHexInstallsNoPin() {
        val garbled = SignedDaemonStatus(report = wireReport(), signatureHex = "zz")
        assertNull(registryWith(pod(signedStatus = garbled)).pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun tamperedFingerprintFailsVerificationSoNoPin() {
        val swapped = SignedDaemonStatus(
            report = wireReport().copy(certSha256 = "ab".repeat(32)),
            signatureHex = DaemonStatusVector.SIG_HEX,
        )
        assertNull(registryWith(pod(signedStatus = swapped)).pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun staleReportInstallsNoPin() {
        val stale = DaemonStatusVector.REPORT.issuedAt + DaemonStatusReport.MAX_REPORT_AGE_MS + 1
        assertNull(registryWith(pod(), nowMs = stale).pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun reportAtTheFreshnessBoundaryStillPins() {
        val edge = DaemonStatusVector.REPORT.issuedAt + DaemonStatusReport.MAX_REPORT_AGE_MS
        assertEquals(
            DaemonStatusVector.CERT_SHA256,
            registryWith(pod(), nowMs = edge).pinFor(DaemonStatusVector.SERVER_ID),
        )
    }

    @Test fun reportAboutAnotherDomainMustNotPinThisPod() {
        // A valid signed report for abc5 riding a DIFFERENT pod's entry: the
        // serverDomain cross-check refuses it, so neither domain gets a pin.
        val reg = registryWith(pod(serverDomain = "evil.harry1.flagship.services"))
        assertNull(reg.pinFor("evil.harry1.flagship.services"))
        assertNull(reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun revokedPodInstallsNoPin() {
        assertNull(registryWith(pod(revokedAt = now)).pinFor(DaemonStatusVector.SERVER_ID))
    }

    // SEC-1: a revoke is an EXPLICIT drop signal — it must clear a
    // previously-verified pin (unlike a mere failed verification, which
    // retains).
    @Test fun revokeDropsAPreviouslyVerifiedPin() {
        val reg = registryWith(pod())
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
        reg.update(listOf(pod(revokedAt = now)), DaemonStatusVector.UMK_SEED, now)
        assertNull(reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun livenessOnlyReportWithoutFingerprintInstallsNoPin() {
        val nullStatus = SignedDaemonStatus(
            report = wireReport(DaemonStatusVector.NULL_REPORT),
            signatureHex = DaemonStatusVector.NULL_SIG_HEX,
        )
        assertNull(registryWith(pod(signedStatus = nullStatus)).pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun missingSignedStatusInstallsNoPin() {
        assertNull(registryWith(pod(signedStatus = null)).pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun wrongUmkInstallsNoPin() {
        val reg = CertPinRegistry()
        reg.update(listOf(pod()), ByteArray(32) { 0x08 }, now)
        assertNull(reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    // SEC-1 (the security fix): a previously-VERIFIED pin must SURVIVE a later
    // /pods where the same pod is still listed but its report no longer
    // verifies — otherwise a tampered/dropped daemon-status downgrades the box
    // to default TLS and a CA-valid rogue cert passes.
    @Test fun missingReportRetainsThePreviousPin() {
        val reg = registryWith(pod())
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
        reg.update(listOf(pod(signedStatus = null)), DaemonStatusVector.UMK_SEED, now)
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun tamperedSignatureRetainsThePreviousPin() {
        val reg = registryWith(pod())
        val tampered = SignedDaemonStatus(
            report = wireReport(),
            signatureHex = "00" + DaemonStatusVector.SIG_HEX.drop(2),
        )
        reg.update(listOf(pod(signedStatus = tampered)), DaemonStatusVector.UMK_SEED, now)
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun tamperedFingerprintRetainsThePreviousPin() {
        val reg = registryWith(pod())
        val swapped = SignedDaemonStatus(
            report = wireReport().copy(certSha256 = "ab".repeat(32)),
            signatureHex = DaemonStatusVector.SIG_HEX,
        )
        reg.update(listOf(pod(signedStatus = swapped)), DaemonStatusVector.UMK_SEED, now)
        // Retain the last-known-good — NOT the unverified swapped fingerprint.
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun staleReportRetainsThePreviousPin() {
        val reg = registryWith(pod())
        val staleNow = DaemonStatusVector.REPORT.issuedAt + DaemonStatusReport.MAX_REPORT_AGE_MS + 1
        reg.update(listOf(pod()), DaemonStatusVector.UMK_SEED, staleNow)
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    // A genuine renewal: the pod is listed and a NEWLY-verified report carries
    // a different fingerprint ⇒ replace.
    @Test fun newlyVerifiedReportReplacesThePin() {
        val reg = registryWith(pod())
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
        // The fixture only has one signed vector, so re-applying the same
        // verified report is the renewal path that must keep the pin set.
        reg.update(listOf(pod()), DaemonStatusVector.UMK_SEED, now)
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    // A pod that was never verified and reports nothing stays unpinned — keep-
    // last-known-good only retains a pin that actually existed.
    @Test fun unverifiedPodWithNoPriorPinStaysUnpinned() {
        val reg = registryWith(pod(signedStatus = null))
        assertNull(reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun domainAbsentFromTheDirectoryIsUnpinned() {
        val reg = registryWith(pod())
        reg.update(emptyList(), DaemonStatusVector.UMK_SEED, now)
        assertNull(reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun clearDropsEveryPin() {
        val reg = registryWith(pod())
        reg.clear()
        assertNull(reg.pinFor(DaemonStatusVector.SERVER_ID))
    }

    @Test fun updateNeverThrowsOnAMalformedEntry() {
        val reg = CertPinRegistry()
        reg.update(
            listOf(pod(serverDomain = ""), pod()),
            DaemonStatusVector.UMK_SEED,
            now,
        )
        assertEquals(DaemonStatusVector.CERT_SHA256, reg.pinFor(DaemonStatusVector.SERVER_ID))
    }
}
