package com.flagshipserver.app.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The caller's check of the callee phone's TURN certificate (a real Let's Encrypt phone certificate, public in CT). */
class TurnCertCheckTest {
    private fun res(name: String) = javaClass.classLoader!!.getResourceAsStream("turn/$name")!!.readBytes()
    private val leaf = TurnCertCheck.parse(res("brisk-quartz-leaf.der"))!!
    private val ye2 = TurnCertCheck.parse(res("ye2.der"))!!

    @Test fun theHostComesFromTheTurnUrl() {
        assertEquals("brisk-quartz.flagship.services", TurnCertCheck.host("turns:Brisk-Quartz.flagship.services:443?transport=tcp"))
        assertNull(TurnCertCheck.host("turn:brisk-quartz.flagship.services:443"))
        assertNull(TurnCertCheck.host("turns::443"))
    }

    @Test fun onlyTheDialledNameMatches() {
        assertTrue(TurnCertCheck.namesHost(leaf, "brisk-quartz.flagship.services"))
        assertFalse(TurnCertCheck.namesHost(leaf, "zippy-fern.flagship.services"))
    }

    @Test fun theIssuerAddressIsRead() {
        assertEquals(listOf("http://ye2.i.lencr.org/"), TurnCertCheck.issuerUrls(leaf))
    }

    @Test fun theChainFollowsIssuersAndStopsAtAMismatch() {
        val fetched = mutableListOf<String>()
        val chain = TurnCertCheck.chain(leaf) { url -> fetched += url; if (url == "http://ye2.i.lencr.org/") ye2 else null }
        assertEquals(listOf(leaf, ye2), chain.take(2))
        assertEquals("http://ye2.i.lencr.org/", fetched.first())
        // A fetched certificate that isn't the issuer is not used.
        assertEquals(listOf(leaf), TurnCertCheck.chain(leaf) { leaf })
    }

    @Test fun garbageIsRefused() {
        assertFalse(TurnCertCheck.verify(byteArrayOf(1, 2, 3), "brisk-quartz.flagship.services"))
        assertFalse(TurnCertCheck.verify(res("brisk-quartz-leaf.der"), "zippy-fern.flagship.services"))
    }
}
