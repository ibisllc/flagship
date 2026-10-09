// Mirrors packages/protocol/tests/lanHint.test.ts — same pinned vector.
package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LanHintTest {
    private val server = "abc5.harry1.flagship.services"
    private val umk = ByteArray(32) { 7 }
    private val stkPub = ServerKeys.deriveStkPub(umk, server)
    private val signer = Ed25519Sign(ServerKeys.deriveStkSeed(umk, server))
    private val cert = "ab".repeat(32)
    private val issued = 1791500000000L

    private val hint = LanHint.Hint(
        serverDomain = server,
        certSha256 = cert,
        endpoints = listOf(LanHint.Endpoint("fd12:3456::7", 443), LanHint.Endpoint("192.168.1.20", 443)),
        issuedAt = issued,
        expiresAt = issued + 3_600_000,
    )
    private val canonical = "flagship/lan-hint/v1|abc5.harry1.flagship.services|" +
        "abababababababababababababababababababababababababababababababab|" +
        "192.168.1.20:443,[fd12:3456::7]:443|1791500000000|1791503600000"
    private val sigHex = "9fc9b39958189204e86823a832b42257f3a2773d671a8292be0826c3a45e3cdb" +
        "b6c3f212dd159b73f86d5b9ad5815e8e024b3f9042c127133dfb30fdeb73e800"

    private fun reject(h: LanHint.Hint, sig: ByteArray = signer.sign(LanHint.canonical(h)), now: Long = issued + 1000,
                       domain: String = server, pin: String = cert) =
        LanHint.reject(h, sig, stkPub, domain, pin, now)

    @Test fun stkPubIsTheSharedVectorKey() =
        assertEquals("0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47", HexUtil.encode(stkPub))

    @Test fun canonicalBytesMatchThePinnedString() =
        assertEquals(canonical, String(LanHint.canonical(hint), Charsets.UTF_8))

    @Test fun pinnedSignatureIsDeterministicAndVerifies() {
        assertEquals(sigHex, HexUtil.encode(signer.sign(LanHint.canonical(hint))))
        assertNull(reject(hint, HexUtil.decode(sigHex)!!))
    }

    @Test fun refusals() {
        val pinned = HexUtil.decode(sigHex)!!
        assertEquals("bad-signature", reject(hint.copy(endpoints = listOf(LanHint.Endpoint("192.168.1.99", 443))), pinned))
        assertEquals("expired", reject(hint, now = hint.expiresAt))
        assertEquals("not-yet-valid", reject(hint, now = issued - 10 * 60_000))
        assertEquals("ttl-too-long", reject(hint.copy(expiresAt = issued + 25 * 3_600_000L)))
        assertEquals("wrong-server", reject(hint, domain = "x.harry1.flagship.services"))
        assertEquals("cert-mismatch", reject(hint, pin = "cd".repeat(32)))
        assertEquals("non-lan-endpoint", reject(hint.copy(endpoints = listOf(LanHint.Endpoint("8.8.8.8", 443)))))
        assertEquals("bad-port", reject(hint.copy(endpoints = listOf(LanHint.Endpoint("10.0.0.2", 0)))))
        assertEquals("bad-endpoint-count", reject(hint.copy(endpoints = emptyList())))
    }

    @Test fun lanAddressFilter() {
        val yes = listOf("10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.0.10", "fd00::1", "fc12:3456::1")
        val no = listOf("172.15.0.1", "172.32.0.1", "8.8.8.8", "100.64.0.1", "127.0.0.1", "169.254.10.1",
            "0.0.0.0", "224.0.0.1", "256.1.1.1", "::1", "fe80::1", "fc::1", "2001:db8::1",
            "::ffff:192.168.1.1", "ff02::1", "", "localhost")
        yes.forEach { assertEquals(it, true, LanHint.isLanAddress(it)) }
        no.forEach { assertEquals(it, false, LanHint.isLanAddress(it)) }
    }
}
