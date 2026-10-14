// Share-this-server links: the https universal link (fragment), the
// flagship:// twin, and the app-link resolver. Uri.parse needs Robolectric.

package com.flagshipserver.app.core

import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ShareDeepLinkTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private val k = "ab".repeat(32)

    @Test fun universalLinkParses() {
        assertEquals(DeepLink.ShareOffer(id, k), DeepLink.parse(Uri.parse("https://flagshipserver.com/share#s=$id&k=$k")))
    }

    @Test fun appLinkResolverParses() {
        assertEquals(DeepLink.ShareOffer(id, k), AppLink.resolve(Uri.parse("https://flagshipserver.com/share#s=$id&k=$k")))
    }

    @Test fun customSchemeParses() {
        assertEquals(DeepLink.ShareOffer(id, k), DeepLink.parse(Uri.parse("flagship://share?s=$id&k=$k")))
    }

    @Test fun upperCaseHexIsNormalised() {
        assertEquals(DeepLink.ShareOffer(id, k), DeepLink.parse(Uri.parse("https://flagshipserver.com/share#s=${id.uppercase()}&k=${k.uppercase()}")))
    }

    @Test fun malformedLinksAreNotRouted() {
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/share#s=$id")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/share?s=$id&k=$k")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/sharex#s=$id&k=$k")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/share#s=$id&k=$k")))
        assertNull(DeepLink.parse(Uri.parse("flagship://share?s=${id.drop(1)}&k=$k")))
    }

    @Test fun theSecretStaysOutOfToString() {
        assertFalse(DeepLink.ShareOffer(id, k).toString().contains(k))
    }

    @Test fun aShareUrlScannedWithTheCameraOpensTheAcceptFlow() {
        // The camera hands the URL over as an ACTION_VIEW intent; the manifest's
        // https /share app link routes it to MainActivity, whose handleIntent
        // resolves intent.data (fragment included) to the accept flow.
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://flagshipserver.com/share#s=$id&k=$k"))
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .setPackage(context.packageName)
        val handlers = context.packageManager.queryIntentActivities(intent, 0)
        assertTrue(handlers.any { it.activityInfo.name.endsWith(".MainActivity") })
        assertEquals(DeepLink.ShareOffer(id, k), AppLink.resolve(intent.data!!))
    }
}
