// Per-cert RELAY-trust aggregation (RelayTrustAggregator) — the Layer-3 client
// half of maintainer-trust enforcement. Each box signs a
// `flagship/box-trust-status/v1` verdict with its STK; the aggregator
// re-verifies EACH under the pod's `identityPubKey` and folds the untrusted
// ones BY `failingCertHash` across all pods — one entry per DISTINCT faulty
// relay authority. Signing here uses REAL Tink Ed25519 (the box's STK path), so
// the verify is genuine, not mocked. Mirror of the Swift + webapp suites.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BoxTrustStatusReportWire
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.SignedBoxTrustStatus
import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayTrustAggregatorTest {
    private val certA = "aa".repeat(32) // 64-hex authority A
    private val certB = "bb".repeat(32) // authority B

    private var seedCounter = 0

    /** Build a `/pods` entry whose `trustStatus` is genuinely STK-signed over
     *  the canonical bytes (so it verifies), unless [tamper] corrupts the sig. */
    private fun signedPod(
        serverDomain: String,
        verdict: BoxTrustStatusReport.RelayVerdict,
        failingCertHash: String?,
        covering: String? = null,
        tamper: Boolean = false,
    ): PodDirectoryEntry {
        val seed = ByteArray(32) { (seedCounter + 1).toByte() }
        seedCounter++
        val stkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        val signer = Ed25519Sign(seed)
        val report = BoxTrustStatusReport.Report(
            serverDomain = serverDomain,
            relayVerdict = verdict,
            lockedDown = false,
            failingCertHash = failingCertHash,
            coveringExceptionCertHash = covering,
            nonce = "00",
            issuedAt = 1,
        )
        val sig = signer.sign(BoxTrustStatusReport.canonicalBytes(report))
        val sigHex = if (tamper) "00".repeat(64) else HexUtil.encode(sig)
        val wire = BoxTrustStatusReportWire(
            serverDomain = serverDomain,
            relayVerdict = verdict.wire,
            lockedDown = false,
            failingCertHash = failingCertHash,
            coveringExceptionCertHash = covering,
            nonce = "00",
            issuedAt = 1,
        )
        return PodDirectoryEntry(
            serverDomain = serverDomain,
            identityPubKey = HexUtil.encode(stkPub),
            trustStatus = SignedBoxTrustStatus(report = wire, signatureHex = sigHex),
        )
    }

    @Test
    fun twoPodsSameCertHashAggregateToOneEntrySpanningBothServers() {
        val pods = listOf(
            signedPod("a.harry1.flagship.services", BoxTrustStatusReport.RelayVerdict.UNTRUSTED, certA),
            signedPod("b.harry1.flagship.services", BoxTrustStatusReport.RelayVerdict.UNTRUSTED, certA),
        )
        val out = RelayTrustAggregator.aggregate(pods)
        assertEquals(1, out.size)
        assertEquals(certA, out[0].certHash)
        assertEquals(2, out[0].serverCount)
        assertEquals(
            listOf("a.harry1.flagship.services", "b.harry1.flagship.services"),
            out[0].servers,
        )
        assertFalse(out[0].overridden)
        assertEquals("Relay certificate expired · aaaaaaaa", out[0].label)
    }

    @Test
    fun distinctCertHashesProduceDistinctEntries() {
        val pods = listOf(
            signedPod("a.x", BoxTrustStatusReport.RelayVerdict.UNTRUSTED, certA),
            signedPod("b.x", BoxTrustStatusReport.RelayVerdict.UNTRUSTED, certB),
        )
        val out = RelayTrustAggregator.aggregate(pods)
        assertEquals(listOf(certA, certB), out.map { it.certHash })
    }

    @Test
    fun coveringExceptionCertHashOnTheWireMarksTheEntryOverridden() {
        // A covered box keeps reporting `untrusted` for the cert but ALSO names
        // it as covered — the standing override marker is that relayed field.
        val pods = listOf(
            signedPod("a.x", BoxTrustStatusReport.RelayVerdict.UNTRUSTED, certA, covering = certA),
        )
        val out = RelayTrustAggregator.aggregate(pods)
        assertEquals(1, out.size)
        assertTrue(out[0].overridden)
    }

    @Test
    fun unverifiableSignatureIsDropped() {
        val pods = listOf(
            signedPod("a.x", BoxTrustStatusReport.RelayVerdict.UNTRUSTED, certA, tamper = true),
        )
        assertTrue(RelayTrustAggregator.aggregate(pods).isEmpty())
    }

    @Test
    fun trustedAndUnknownVerdictsAndMissingTrustStatusAreIgnored() {
        val pods = listOf(
            signedPod("a.x", BoxTrustStatusReport.RelayVerdict.TRUSTED, null),
            signedPod("b.x", BoxTrustStatusReport.RelayVerdict.UNKNOWN, null),
            PodDirectoryEntry(serverDomain = "c.x", identityPubKey = "cc".repeat(32)),
        )
        assertTrue(RelayTrustAggregator.aggregate(pods).isEmpty())
    }
}
