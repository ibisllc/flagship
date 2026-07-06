// Slice C — parsing the transfer take-over deep links. Both the control-apex
// universal link (`https://flagshipserver.com/transfer?o=<b64url>`) and the
// custom-scheme twin (`flagship://transfer?o=…`) resolve to DeepLink.TransferOffer
// carrying the decoded offer JSON. Uri.parse needs Robolectric.

package com.flagshipserver.app.core

import android.net.Uri
import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TransferDeepLinkTest {
    private val host = "home.alice.flagship.services"
    private val giver = Ed25519Sign.KeyPair.newKeyPair()

    private fun offerQr() = ServerTransferFlow.buildOffer(
        serverDomain = host, username = "alice", irk = Ed25519Sign(giver.privateKey),
        irkPubHex = HexUtil.encode(giver.publicKey), issuedAt = 1, ttlMs = 9_999_999L,
        nonce = ByteArray(32) { 0xcd.toByte() }, authNonce = ByteArray(32) { 2 },
    ).qr

    @Test fun universalLinkParsesToTransferOffer() {
        val qr = offerQr()
        val json = ServerTransferFlow.encodeQR(qr)
        val link = DeepLink.parse(Uri.parse(ServerTransferFlow.offerUrl(qr)))
        assertEquals(DeepLink.TransferOffer(json), link)
    }

    @Test fun customSchemeParsesToTransferOffer() {
        val qr = offerQr()
        val json = ServerTransferFlow.encodeQR(qr)
        val link = DeepLink.parse(Uri.parse(ServerTransferFlow.offerCustomSchemeUrl(qr)))
        assertEquals(DeepLink.TransferOffer(json), link)
    }

    @Test fun appLinkResolvesUniversalTransferLink() {
        val qr = offerQr()
        val json = ServerTransferFlow.encodeQR(qr)
        val link = AppLink.resolve(Uri.parse(ServerTransferFlow.offerUrl(qr)))
        assertEquals(DeepLink.TransferOffer(json), link)
    }

    @Test fun ingestedOfferJson_verifiesAndCarriesTheDomain() {
        val link = DeepLink.parse(Uri.parse(ServerTransferFlow.offerCustomSchemeUrl(offerQr())))
        val json = (link as DeepLink.TransferOffer).offerJson
        val parsed = ServerTransferFlow.parseQR(json)
        assertEquals(host, parsed.serverDomain)
        assertTrue(ServerTransferFlow.verifyOfferSignature(parsed))
    }

    @Test fun missingParamIsNull() {
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/transfer")))
        assertNull(DeepLink.parse(Uri.parse("flagship://transfer")))
    }

    @Test fun wrongHostIsNull() {
        // A `/transfer` on a data-plane box host is not a control-apex link.
        val param = ServerTransferFlow.encodeOfferParam(offerQr())
        assertNull(DeepLink.parse(Uri.parse("https://home.alice.flagship.services/transfer?o=$param")))
    }
}
