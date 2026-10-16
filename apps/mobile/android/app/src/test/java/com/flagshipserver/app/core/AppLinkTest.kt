// Robolectric tests for AppLink.resolve — the URI → DeepLink
// translation that MainActivity.handleIntent calls on every inbound
// intent. Pin the two recognized forms:
//   1. https://flagshipserver.com/app/<route>[/<more>]?<params> (what the app
//      and the Worker's pushes emit)
//   2. older builds' flagship://<route>[/<more>]?<params>

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

    // Back-compat: the legacy unlock-approve link now lands on the relay
    // approval list (the plaintext flow is gone).
    @Test fun primarySchemeForm_legacyUnlockApprove_resolvesToSecretRequests() {
        val uri = Uri.parse("flagship://unlock-approve?requestId=req-9")
        assertEquals(DeepLink.SecretRequests, AppLink.resolve(uri))
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
        assertEquals(DeepLink.SecretRequests, AppLink.resolve(uri))
    }

    @Test fun appLinkForm_retiredMarketplace_returnsNull() {
        val uri = Uri.parse("https://flagshipserver.com/app/marketplace")
        assertNull(AppLink.resolve(uri))
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
        val uri = Uri.parse("http://flagshipserver.com/app/server?podId=p1")
        assertEquals(DeepLink.ServerDetail("p1"), AppLink.resolve(uri))
    }

    // ── /app/<route>[/<more>] keeps the whole path ───────────────────

    @Test fun appLinkForm_keepsPathSegments() {
        assertEquals(DeepLink.VibeCodeChat("sess-42"), AppLink.resolve(Uri.parse("https://flagshipserver.com/app/vibecode/sess-42")))
        assertEquals(DeepLink.VibeCodeChat("sess-42"), AppLink.resolve(Uri.parse("flagship://vibecode/sess-42")))
    }

    @Test fun appLinkForm_acceptsWwwHost() {
        assertEquals(DeepLink.ServerDetail("p1"), AppLink.resolve(Uri.parse("https://www.flagshipserver.com/app/server?podId=p1")))
        assertNull(AppLink.resolve(Uri.parse("https://evil.flagshipserver.com/app/server?podId=p1")))
    }

    @Test fun appLinkForm_parsedWithoutAppLink() {
        // Paste surfaces (Process URL) call DeepLink.parse directly.
        assertEquals(DeepLink.VibeCodeChat("s1"), DeepLink.parse(Uri.parse("https://flagshipserver.com/app/vibecode/s1")))
        assertEquals(
            DeepLink.VibeCodeChat("s1", "home.harry.flagship.services"),
            DeepLink.parse(Uri.parse("https://flagshipserver.com/app/vibecode/s1?server=home.harry.flagship.services")),
        )
    }

    // ── The Worker's push deepLinks ──────────────────────────────────

    @Test fun accountPushLinks_routeToTheirScreens() {
        val base = "https://flagshipserver.com/app"
        assertEquals(DeepLink.AccountSecurity, AppLink.resolve(Uri.parse("$base/account/security?u=alice")))
        assertEquals(DeepLink.TrustedDevices, AppLink.resolve(Uri.parse("$base/account/devices?u=alice")))
        assertEquals(DeepLink.TrustedDevices, AppLink.resolve(Uri.parse("$base/account/re-pair?u=alice")))
        assertEquals(DeepLink.AccountSecurity, AppLink.resolve(Uri.parse("$base/settings/two-factor")))
        // A page this app has no screen for opens the Settings tab.
        assertEquals(DeepLink.Settings, AppLink.resolve(Uri.parse("$base/account/something-new?u=alice")))
        assertEquals(DeepLink.Settings, AppLink.resolve(Uri.parse("$base/settings")))
    }

    @Test fun inviteCreatedPush_opensTheAccountActivity() {
        assertEquals(DeepLink.AccountActivity, AppLink.resolve(Uri.parse("https://flagshipserver.com/app/account/activity")))
        assertEquals(DeepLink.AccountActivity, AppLink.resolve(Uri.parse("flagship://account/activity")))
        assertEquals(
            DeepLink.AccountActivity,
            AppLink.resolve(Uri.parse(com.flagshipserver.app.push.InviteCreatedPush.deepLink())),
        )
    }

    @Test fun accountPushLinks_legacySchemeForms() {
        assertEquals(DeepLink.AccountSecurity, AppLink.resolve(Uri.parse("flagship://account/security?u=alice")))
        assertEquals(DeepLink.TrustedDevices, AppLink.resolve(Uri.parse("flagship://account/re-pair?u=alice")))
        assertEquals(DeepLink.AccountSecurity, AppLink.resolve(Uri.parse("flagship://settings/two-factor")))
    }

    @Test fun installProgress_withAndWithoutSerial() {
        assertEquals(DeepLink.InstallProgress(), AppLink.resolve(Uri.parse("https://flagshipserver.com/app/install-progress")))
        assertEquals(
            DeepLink.InstallProgress("ORDER-1"),
            AppLink.resolve(Uri.parse("https://flagshipserver.com/app/install-progress?serial=ORDER-1")),
        )
        assertEquals(DeepLink.InstallProgress(), AppLink.resolve(Uri.parse("flagship://install-progress")))
    }

    @Test fun deadman_carriesServerDomain() {
        assertEquals(
            DeepLink.Deadman("home.alice.flagship.services"),
            AppLink.resolve(Uri.parse("https://flagshipserver.com/app/deadman/home.alice.flagship.services")),
        )
        assertEquals(
            DeepLink.Deadman("home.alice.flagship.services"),
            AppLink.resolve(Uri.parse("flagship://deadman/home.alice.flagship.services")),
        )
        assertNull(AppLink.resolve(Uri.parse("https://flagshipserver.com/app/deadman")))
    }

    // ── What the app itself emits round-trips ────────────────────────

    @Test fun endpointsAppRoute_roundTrips() {
        assertEquals("https://flagshipserver.com/app/secret-requests", Endpoints.appRoute("secret-requests"))
        assertEquals(DeepLink.SecretRequests, AppLink.resolve(Uri.parse(Endpoints.appRoute("secret-requests"))))
        assertEquals(DeepLink.VibeCodeChat("abc"), AppLink.resolve(Uri.parse(Endpoints.appRoute("vibecode/abc"))))
        assertEquals(
            DeepLink.Deadman("home.alice.flagship.services"),
            AppLink.resolve(Uri.parse(Endpoints.appRoute("deadman/home.alice.flagship.services"))),
        )
        assertEquals(
            DeepLink.InstallProgress("A B"),
            AppLink.resolve(Uri.parse(Endpoints.appRoute("install-progress", mapOf("serial" to "A B")))),
        )
    }
}
