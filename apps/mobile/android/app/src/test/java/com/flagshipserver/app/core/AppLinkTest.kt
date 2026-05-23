// Robolectric tests for AppLink.resolve — the URI → DeepLink
// translation that MainActivity.handleIntent calls on every inbound
// intent. Pin the two recognized forms:
//   1. flagship://<host>?<params>
//   2. https://flagshipserver.com/app/<host>?<params>

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
class AppLinkTest {

    @Test fun primarySchemeForm_resolvesViaDeepLinkParse() {
        val uri = Uri.parse("flagship://unlock-approve?requestId=req-9")
        assertEquals(DeepLink.UnlockApprove("req-9"), AppLink.resolve(uri))
    }

    @Test fun primarySchemeForm_serverDetail() {
        val uri = Uri.parse("flagship://server?podId=pod-abc")
        assertEquals(DeepLink.ServerDetail("pod-abc"), AppLink.resolve(uri))
    }

    @Test fun secretRequests_host_resolves() {
        assertEquals(DeepLink.SecretRequests, AppLink.resolve(Uri.parse("flagship://secret-requests")))
    }

    // The `secret-request` push synthesizes the singular host form too.
    @Test fun secretRequest_singularHost_resolves() {
        assertEquals(DeepLink.SecretRequests, AppLink.resolve(Uri.parse("flagship://secret-request")))
    }

    @Test fun appLinkForm_translatesToFlagshipScheme() {
        // https://flagshipserver.com/app/<host>?<params> is the
        // auto-verified Android App Link surface. We rewrite it to the
        // equivalent flagship:// URI and reparse so both surfaces share
        // a single DeepLink contract.
        val uri = Uri.parse("https://flagshipserver.com/app/unlock-approve?requestId=req-9")
        assertEquals(DeepLink.UnlockApprove("req-9"), AppLink.resolve(uri))
    }

    @Test fun appLinkForm_marketplace() {
        val uri = Uri.parse("https://flagshipserver.com/app/marketplace")
        assertEquals(DeepLink.Marketplace, AppLink.resolve(uri))
    }

    @Test fun appLinkForm_appDetail() {
        val uri = Uri.parse("https://flagshipserver.com/app/app?appId=plants")
        assertEquals(DeepLink.AppDetail("plants"), AppLink.resolve(uri))
    }

    @Test fun appLinkForm_preservesQueryString() {
        // Multi-param queries (future-proofing) need to round-trip
        // through the rewrite without losing the encoded query string.
        val uri = Uri.parse("https://flagshipserver.com/app/server?podId=p1&extra=ignored")
        assertEquals(DeepLink.ServerDetail("p1"), AppLink.resolve(uri))
    }

    @Test fun rejectsHttpsHostThatIsntFlagshipserver() {
        val uri = Uri.parse("https://example.com/app/unlock-approve?requestId=x")
        assertNull(AppLink.resolve(uri))
    }

    @Test fun rejectsFlagshipserverPathThatIsntAppPrefix() {
        // We accept ONLY /app/<host>?...; arbitrary other paths return null.
        val uri = Uri.parse("https://flagshipserver.com/blog/post-1")
        assertNull(AppLink.resolve(uri))
    }

    @Test fun rejectsAppPrefixWithMissingHost() {
        val uri = Uri.parse("https://flagshipserver.com/app/")
        assertNull(AppLink.resolve(uri))
    }

    @Test fun rejectsFlagshipSchemeWithUnknownHost() {
        val uri = Uri.parse("flagship://unknown-action?x=1")
        assertNull(AppLink.resolve(uri))
    }

    @Test fun rejectsRandomCustomScheme() {
        val uri = Uri.parse("myapp://anything")
        assertNull(AppLink.resolve(uri))
    }

    // ── Phase 3b — cross-device pairing /join deeplink ───────────────

    @Test fun joinDeeplink_flagshipScheme_parses() {
        val pk = Base64URL.encode(ByteArray(32) { 0x05 })
        val uri = Uri.parse("flagship://join?sid=sess-1&pk=$pk")
        assertEquals(DeepLink.JoinDevice("sess-1", pk), AppLink.resolve(uri))
    }

    @Test fun joinDeeplink_appLinksUniversalUrl_translates() {
        // The admin's QR is an App-Links URL; the native camera opens it
        // straight into the app. /join is a TOP-LEVEL path (not /app/<…>).
        val pk = Base64URL.encode(ByteArray(32) { 0x06 })
        val uri = Uri.parse("https://flagshipserver.com/join?sid=sess-2&pk=$pk")
        assertEquals(DeepLink.JoinDevice("sess-2", pk), AppLink.resolve(uri))
    }

    @Test fun joinDeeplink_missingParams_returnsNull() {
        assertNull(AppLink.resolve(Uri.parse("https://flagshipserver.com/join?sid=only")))
        assertNull(AppLink.resolve(Uri.parse("flagship://join?pk=only")))
    }

    @Test fun acceptsHttpAsWellAsHttps_forFutureProofing() {
        // Belt-and-suspenders: if the OS hands us a plaintext http://
        // intent (e.g. via an `android:scheme="http"` in some future
        // intent-filter), the path still translates. Today the only
        // declared scheme is https, but the check is cheap.
        val uri = Uri.parse("http://flagshipserver.com/app/marketplace")
        assertEquals(DeepLink.Marketplace, AppLink.resolve(uri))
    }
}
