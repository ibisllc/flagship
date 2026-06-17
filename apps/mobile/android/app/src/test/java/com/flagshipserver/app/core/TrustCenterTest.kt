// The app-side maintainer-trust gate: TrustCenter (verdict + failing-cert
// registry + override) and the TrustException canonical bytes the override
// signs. Mirror of iOS TrustCenterTests.swift.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TrustCenterTest {

    companion object {
        const val CA_PUB = "bb5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a"
        const val CA_PUB2 = "aa5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a"
        // Pinned: sha256hex(utf8(CA_PUB)) — matches the iOS test + node compute.
        const val CERT_HASH = "f78690df9cb15b62a8e4fe6e9c5647e7d222c515f882774abbe7cea200569a42"
    }

    private fun failure(caPub: String = CA_PUB, cls: TrustCertClass = TrustCertClass.CONTROL) =
        TrustFailure(cls, TrustException.certHashForCaPubkey(caPub), caPub)

    // --- certHash + slug + label shapes -------------------------------------

    @Test
    fun certHashMatchesPinned() {
        assertEquals(CERT_HASH, TrustException.certHashForCaPubkey(CA_PUB))
    }

    @Test
    fun slugIsFirst8Hex() {
        assertEquals("f78690df", failure().slug)
        assertEquals(CERT_HASH.take(8), failure().slug)
    }

    @Test
    fun labelShapes() {
        assertEquals("Control server certificate expired · f78690df",
            failure(CA_PUB, TrustCertClass.CONTROL).label)
        assertEquals("Relay certificate expired · f78690df",
            failure(CA_PUB, TrustCertClass.RELAY).label)
    }

    // --- Verdict + isServerTrusted ------------------------------------------

    @Test
    fun unknownIsTrustedByDefault() {
        val c = TrustCenter()
        assertEquals(TrustVerdict.UNKNOWN, c.verdict.value)
        assertTrue(c.isServerTrusted)
        assertTrue(c.sliverFailures.isEmpty())
    }

    @Test
    fun trustedLetsTrafficThrough() {
        val c = TrustCenter()
        c.markTrusted()
        assertEquals(TrustVerdict.TRUSTED, c.verdict.value)
        assertTrue(c.isServerTrusted)
        assertTrue(c.sliverFailures.isEmpty())
    }

    @Test
    fun untrustedHaltsAndShowsOneLine() {
        val c = TrustCenter()
        c.markUntrusted(listOf(failure()))
        assertEquals(TrustVerdict.UNTRUSTED, c.verdict.value)
        assertFalse(c.isServerTrusted)
        assertEquals(1, c.sliverFailures.size)
        assertEquals("Control server certificate expired · f78690df", c.sliverFailures.first().label)
    }

    @Test
    fun noVerdictLeavesUntrustedHalting() {
        val c = TrustCenter()
        c.markUntrusted(listOf(failure()))
        c.markNoVerdict()
        assertFalse(c.isServerTrusted)
        assertEquals(TrustVerdict.UNTRUSTED, c.verdict.value)
    }

    // --- Line dedup ----------------------------------------------------------

    @Test
    fun duplicateFailuresDedup() {
        val c = TrustCenter()
        c.markUntrusted(listOf(failure(), failure(), failure()))
        assertEquals(1, c.sliverFailures.size)
    }

    @Test
    fun controlAndRelayBothShow() {
        val c = TrustCenter()
        c.markUntrusted(listOf(failure(CA_PUB, TrustCertClass.CONTROL), failure(CA_PUB2, TrustCertClass.RELAY)))
        assertEquals(2, c.sliverFailures.size)
    }

    @Test
    fun sameCertHashDifferentClassAreDistinctLines() {
        val c = TrustCenter()
        c.markUntrusted(listOf(failure(CA_PUB, TrustCertClass.CONTROL), failure(CA_PUB, TrustCertClass.RELAY)))
        assertEquals(2, c.sliverFailures.size)
    }

    // --- Override ------------------------------------------------------------

    @Test
    fun overrideUnhaltsButLinePersists() {
        val c = TrustCenter()
        val f = failure()
        c.markUntrusted(listOf(f))
        assertFalse(c.isServerTrusted)

        c.recordOverride(f.certHash)
        assertTrue(c.isServerTrusted)          // traffic resumes
        assertEquals(1, c.sliverFailures.size) // line PERSISTS
        assertFalse(c.isBlocking(f.certHash))
    }

    @Test
    fun partialOverrideStillHalts() {
        val c = TrustCenter()
        c.markUntrusted(listOf(failure(CA_PUB, TrustCertClass.CONTROL), failure(CA_PUB2, TrustCertClass.RELAY)))
        c.recordOverride(TrustException.certHashForCaPubkey(CA_PUB))
        assertFalse(c.isServerTrusted)
        c.recordOverride(TrustException.certHashForCaPubkey(CA_PUB2))
        assertTrue(c.isServerTrusted)
    }

    @Test
    fun returningToTrustedClearsLines() {
        val c = TrustCenter()
        val f = failure()
        c.markUntrusted(listOf(f))
        c.recordOverride(f.certHash)
        c.markTrusted()
        assertTrue(c.sliverFailures.isEmpty())
        assertEquals(TrustVerdict.TRUSTED, c.verdict.value)
    }

    // --- TrustException canonical bytes (pinned cross-platform vector) -------

    @Test
    fun trustExceptionCanonicalBytes() {
        val bytes = TrustException.canonicalBytes(
            certClass = TrustCertClass.CONTROL,
            certHash = CERT_HASH,
            grantedAt = 1_779_235_200_000L,
            grantedByDevicePub = "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc",
        )
        val expected = "flagship/trust-exception/v1|control|$CERT_HASH|1779235200000|" +
            "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
        assertEquals(expected, String(bytes, Charsets.UTF_8))
    }
}
