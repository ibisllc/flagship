// Robolectric tests for QrRelay.parseQrUrl + Base64URL.decode + the
// DeepLink.parse(Uri) overload — all need android.jar so they can't
// run as plain JVM tests.

package com.flagshipserver.app.core

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class QrRelayUriParseTest {

    @Test fun parseQrUrl_httpsForm() {
        val pk = ByteArray(32) { it.toByte() }
        val pkB64u = Base64URL.encode(pk)
        val session = QrRelay.parseQrUrl("https://flagshipserver.com/qr?s=abc&k=$pkB64u")
        assertEquals("abc", session.sid)
        assertEquals(32, session.browserPublicKey.size)
    }

    @Test fun parseQrUrl_customSchemeForm() {
        val pk = ByteArray(32) { (it * 7).toByte() }
        val pkB64u = Base64URL.encode(pk)
        val session = QrRelay.parseQrUrl("flagship://qr?s=xyz&k=$pkB64u")
        assertEquals("xyz", session.sid)
    }

    @Test fun parseQrUrl_rawKeyValueForm() {
        val pk = ByteArray(32) { (it * 11).toByte() }
        val pkB64u = Base64URL.encode(pk)
        val session = QrRelay.parseQrUrl("s=abc&k=$pkB64u")
        assertEquals("abc", session.sid)
    }

    @Test(expected = QrRelay.RelayError::class)
    fun parseQrUrl_rejectsMissingFields() {
        QrRelay.parseQrUrl("https://flagshipserver.com/qr")
    }

    @Test fun base64Url_decodeRejectsGarbage() {
        assertNull(Base64URL.decode("not_base64!!"))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DeepLinkParseTest {

    // Back-compat: the legacy unlock-approve host now resolves to the relay
    // approval list (the plaintext flow is gone).
    @Test fun parsesLegacyUnlockApproveAsSecretRequests() {
        val uri = Uri.parse("flagship://unlock-approve?requestId=req-1")
        val link = DeepLink.parse(uri)
        assertEquals(DeepLink.SecretRequests, link)
    }

    @Test fun parsesServerDetail() {
        val uri = Uri.parse("flagship://server?podId=pod-x")
        assertEquals(DeepLink.ServerDetail("pod-x"), DeepLink.parse(uri))
    }

    @Test fun parsesAppDetail() {
        val uri = Uri.parse("flagship://app?appId=plants")
        assertEquals(DeepLink.AppDetail("plants"), DeepLink.parse(uri))
    }

    @Test fun parsesBareMarketplaceAndCreateServer() {
        assertEquals(DeepLink.Marketplace, DeepLink.parse(Uri.parse("flagship://marketplace")))
        assertEquals(DeepLink.CreateServer, DeepLink.parse(Uri.parse("flagship://create-server")))
    }

    @Test fun rejectsForeignScheme() {
        assertNull(DeepLink.parse(Uri.parse("https://example.com/foo")))
    }

    @Test fun rejectsUnknownHost() {
        assertNull(DeepLink.parse(Uri.parse("flagship://unknown?x=y")))
    }
}
