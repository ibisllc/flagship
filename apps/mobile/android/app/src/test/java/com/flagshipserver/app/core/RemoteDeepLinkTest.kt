// The remote page's QR (flagship://remote?s=&k=) must route to Settings →
// Remote. Before 2026-10-14 only the old `dock` host was routed, so scanning
// the page's code with the camera did nothing. Uri.parse needs Robolectric.

package com.flagshipserver.app.core

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RemoteDeepLinkTest {
    private val link = "flagship://remote?s=${Base64URL.encode(ByteArray(16) { 1 })}&k=${Base64URL.encode(ByteArray(32) { 2 })}"

    @Test fun remotePageCodeRoutesToApproval() {
        assertEquals(DeepLink.CompanionDockApproval(link), DeepLink.parse(Uri.parse(link)))
    }

    @Test fun oldDockLinkIsNotRouted() {
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        assertNull(DeepLink.parse(Uri.parse("flagship://dock?server=home.alice.flagship.services&request=$request&code=$code")))
        assertNull(DeepLink.parse(Uri.parse("flagship://remote?s=x")))
    }
}
