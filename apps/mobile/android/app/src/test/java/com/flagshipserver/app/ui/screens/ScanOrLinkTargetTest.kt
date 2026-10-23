// Settings → "Scan a code or enter a link": what a scanned or pasted text
// opens. The same parser as a tapped link, plus a bare pairing code read as
// the /join link it came from. Uri.parse needs Robolectric.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.DeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ScanOrLinkTargetTest {
    private val pk = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    @Test fun aJoinLinkOpensTheJoinFlow() {
        assertEquals(DeepLink.JoinDevice("abc123", pk), scanOrLinkTarget("https://flagshipserver.com/join?sid=abc123&pk=$pk"))
    }

    @Test fun aBarePairingCodeIsReadAsItsJoinLink() {
        assertEquals(DeepLink.JoinDevice("abc123", pk), scanOrLinkTarget("  sid=abc123&pk=$pk  "))
    }

    @Test fun anAccessLinkOpensTheBrowserSignIn() {
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "notes", "alice--notes", "abc123"),
            scanOrLinkTarget("https://flagshipserver.com/access?server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123"),
        )
    }

    @Test fun aShareLinkOpensTheShare() {
        assertTrue(scanOrLinkTarget("https://flagshipserver.com/share#s=${"b".repeat(32)}&k=${"a".repeat(64)}") is DeepLink.ShareOffer)
    }

    @Test fun anythingElseIsRefused() {
        assertNull(scanOrLinkTarget(""))
        assertNull(scanOrLinkTarget("not a link"))
        assertNull(scanOrLinkTarget("https://example.com/join?sid=a&pk=$pk"))
    }
}
