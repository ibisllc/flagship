// The org seat invitation link (docs/enterprise-accounts.md §7): /org-join#o=&s=&k=, all in the
// fragment, as iOS DeepLink.orgJoinLink. Uri.parse needs Robolectric.

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
class OrgJoinDeepLinkTest {
    private val o = "0123456789abcdef0123456789abcdef"
    private val s = "fedcba9876543210fedcba9876543210"
    private val k = "ab".repeat(32)

    @Test fun theLinkAndItsTrailingSlashParse() {
        assertEquals(DeepLink.OrgJoin(o, s, k), DeepLink.parse(Uri.parse("https://flagshipserver.com/org-join#o=$o&s=$s&k=$k")))
        assertEquals(DeepLink.OrgJoin(o, s, k), AppLink.resolve(Uri.parse("https://flagshipserver.com/org-join/#o=$o&s=$s&k=$k")))
    }

    @Test fun aMissingOrMalformedPartIsNoLink() {
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/org-join#o=$o&s=$s")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/org-join#o=$o&s=$s&k=${k.uppercase()}")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/org-join#o=${o.drop(2)}&s=$s&k=$k")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/org-join?o=$o&s=$s&k=$k")))
    }

    @Test fun theKeyStaysOutOfLogs() {
        assertEquals("OrgJoin(orgId=$o)", DeepLink.OrgJoin(o, s, k).toString())
    }
}
