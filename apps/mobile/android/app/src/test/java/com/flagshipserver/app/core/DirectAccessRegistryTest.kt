// Direct access on the phone (docs/direct-access-and-domains.md): a public
// endpoint is dialed only inside an owner order that verifies under the
// account's key, after the same pinned probe as a LAN one.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectAccessRegistryTest {
    private val box = "home.alice.flagship.services"
    private val pin = "cd".repeat(32)
    private val now = 1_790_000_000_000L
    private val stk = Ed25519Sign.KeyPair.newKeyPair()
    private val admin = Ed25519Sign.KeyPair.newKeyPair()
    private val order = DirectAccess.Order(box, true, listOf("81.2.69.142"), listOf("2a02:8010:6400::/48"), 443, now)

    private class Prober(val reachable: Set<String>) : LanProber {
        val probed = mutableListOf<String>()
        override fun probe(sniHost: String, address: String, port: Int, certSha256: String): Boolean {
            probed += address
            return address in reachable
        }
    }

    private fun envelope(lan: List<String>, direct: List<String>, orderKey: Ed25519Sign.KeyPair?): DirectAccess.HintV2Envelope {
        val h = DirectAccess.HintV2(
            box, pin, lan.map { LanHint.Endpoint(it, 443) }, direct.map { LanHint.Endpoint(it, 443) },
            if (direct.isEmpty()) "" else DirectAccess.orderSha256(order), now, now + 3_600_000,
        )
        val sig = HexUtil.encode(Ed25519Sign(stk.privateKey).sign(DirectAccess.canonical(h)))
        val signed = orderKey?.let { DirectAccess.SignedOrder(order, DirectAccess.sign(order, Ed25519Sign(it.privateKey))) }
        return DirectAccess.HintV2Envelope(h, sig, signed)
    }

    private fun registry(p: LanProber) = LanDirectRegistry(p, { now }, { it() }, { })

    @Test fun aVerifiedOrderLetsThePhoneProveAndUseThePublicEndpoint() {
        val p = Prober(setOf("81.2.69.142"))
        val r = registry(p)
        assertNull(r.accept(box, envelope(listOf("192.168.1.20"), listOf("81.2.69.142"), admin), stk.publicKey, pin, listOf(admin.publicKey)))
        r.lanAddressFor("app.$box")
        assertEquals(listOf("192.168.1.20", "81.2.69.142"), p.probed)
        assertEquals("81.2.69.142", r.provenAddressFor("app.$box"))
        assertTrue(r.isDirectAddress("81.2.69.142"))
        assertFalse(r.isDirectAddress("192.168.1.20"))
    }

    @Test fun anOrderTheAccountDidNotSignLeavesOnlyTheLanPart() {
        val p = Prober(setOf("81.2.69.142"))
        val r = registry(p)
        val forger = Ed25519Sign.KeyPair.newKeyPair()
        assertNull(r.accept(box, envelope(listOf("192.168.1.20"), listOf("81.2.69.142"), forger), stk.publicKey, pin, listOf(admin.publicKey)))
        r.lanAddressFor(box)
        assertEquals(listOf("192.168.1.20"), p.probed)
        assertNull(r.provenAddressFor(box))
        assertFalse(r.isDirectAddress("81.2.69.142"))
    }

    @Test fun noAuthorityKeyMeansNoPublicEndpoint() {
        val r = registry(Prober(setOf("81.2.69.142")))
        assertEquals("direct-without-order", r.accept(box, envelope(emptyList(), listOf("81.2.69.142"), admin), stk.publicKey, pin, emptyList()))
        assertNull(r.lanAddressFor(box))
    }

    @Test fun anotherBoxsHintIsRefused() {
        val r = registry(Prober(emptySet()))
        val other = Ed25519Sign.KeyPair.newKeyPair()
        assertEquals("bad-signature", r.accept(box, envelope(listOf("192.168.1.20"), listOf("81.2.69.142"), admin), other.publicKey, pin, listOf(admin.publicKey)))
    }
}
