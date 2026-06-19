// "Process URL" parse helper — a pasted flagship://access link / "Get link"
// string resolves to an AuthorizeKnock (or null). Uri.parse needs Robolectric.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.DeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ProcessUrlParseTest {
    @Test fun validAccessLinkParses() {
        val link = parseAccessLink(
            "flagship://access?server=home.alice.flagship.services&svc=notes&ref=alice-notes&page=abc123",
        )
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "notes", "alice-notes", "abc123"),
            link,
        )
    }

    @Test fun trimmedAccessLinkParses() {
        // The screen trims before calling; assert a clean link still parses.
        val link = parseAccessLink("flagship://access?server=h.a.flagship.services&svc=&ref=a-n&page=p1")
        assertEquals(DeepLink.AuthorizeKnock("h.a.flagship.services", "", "a-n", "p1"), link)
    }

    @Test fun garbageIsNull() {
        assertNull(parseAccessLink("not a link"))
        assertNull(parseAccessLink(""))
    }

    @Test fun nonAccessFlagshipLinkIsNull() {
        // An invite link is a DeepLink but not an AuthorizeKnock.
        assertNull(parseAccessLink("flagship://invite?server=h.a.flagship.services&k=${"ab".repeat(32)}"))
    }
}
