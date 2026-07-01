// Slice C — the transfer offer's universal-link encoding + signature/expiry
// verification (pure JVM; no android.net.Uri). The `o=` param is
// base64url(UTF8(offerJSON)) with no padding, carried as a QUERY param so
// Android/webapp don't strip it. Byte-compat with iOS + the webapp.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerTransferUrlTest {
    private val host = "home.alice.flagship.services"
    private val giver = Ed25519Sign.KeyPair.newKeyPair()

    private fun offer(ttlMs: Long = 9_999_999_999_999L) = ServerTransferFlow.buildOffer(
        serverDomain = host, username = "alice", irk = Ed25519Sign(giver.privateKey),
        irkPubHex = HexUtil.encode(giver.publicKey), issuedAt = 1, ttlMs = ttlMs,
        nonce = ByteArray(32) { 0xab.toByte() }, authNonce = ByteArray(32) { 1 },
    ).qr

    @Test fun offerUrl_isControlHostTransferWithNoPaddingParam() {
        val url = ServerTransferFlow.offerUrl(offer())
        assertTrue(url.startsWith("https://flagshipserver.com/transfer?o="))
        val param = url.substringAfter("?o=")
        // base64url alphabet only (-_), no '=' padding.
        assertFalse(param.contains("="))
        assertFalse(param.contains("+"))
        assertFalse(param.contains("/"))
    }

    @Test fun encodeDecodeParam_roundTrips() {
        val qr = offer()
        val param = ServerTransferFlow.encodeOfferParam(qr)
        val json = ServerTransferFlow.decodeOfferParam(param)!!
        val parsed = ServerTransferFlow.parseQR(json)
        assertEquals(host, parsed.serverDomain)
        assertEquals(qr.transferNonce, parsed.transferNonce)
    }

    @Test fun offerJsonFrom_acceptsHttpsUrl_customScheme_andBareJson() {
        val qr = offer()
        val bare = ServerTransferFlow.encodeQR(qr)
        assertEquals(host, ServerTransferFlow.parseQR(ServerTransferFlow.offerJsonFrom(ServerTransferFlow.offerUrl(qr))!!).serverDomain)
        assertEquals(host, ServerTransferFlow.parseQR(ServerTransferFlow.offerJsonFrom(ServerTransferFlow.offerCustomSchemeUrl(qr))!!).serverDomain)
        assertEquals(host, ServerTransferFlow.parseQR(ServerTransferFlow.offerJsonFrom(bare)!!).serverDomain)
    }

    @Test fun offerJsonFrom_nullOnGarbage() {
        assertNull(ServerTransferFlow.offerJsonFrom("not a link"))
        assertNull(ServerTransferFlow.offerJsonFrom(""))
    }

    @Test fun verifyOfferSignature_trueForGenuine_falseForTampered() {
        val qr = offer()
        assertTrue(ServerTransferFlow.verifyOfferSignature(qr))
        // Any change to a signed field invalidates the signature.
        assertFalse(ServerTransferFlow.verifyOfferSignature(qr.copy(serverDomain = "evil.mallory.flagship.services")))
        assertFalse(ServerTransferFlow.verifyOfferSignature(qr.copy(expiresAt = qr.expiresAt + 1)))
        assertFalse(ServerTransferFlow.verifyOfferSignature(qr.copy(offerSignature = "00".repeat(64))))
    }

    @Test fun verifyOfferSignature_falseForMalformedKeyOrSig() {
        val qr = offer()
        assertFalse(ServerTransferFlow.verifyOfferSignature(qr.copy(giverIrkPub = "zz")))
        assertFalse(ServerTransferFlow.verifyOfferSignature(qr.copy(offerSignature = "nothex")))
    }
}
