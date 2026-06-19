// Parsing of the service-access redeem deep link (docs/service-access-gating.md):
// the flagship://invite?server=…&k=… custom-scheme hand-off + the box universal
// link https://<server>.<user>.flagship.services/invite#<secret>. The Uri.parse
// paths need Robolectric (android.net.Uri lives in android.jar); the pure
// secretFromFragment helper is plain-JVM.

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
class InviteDeepLinkTest {
    private val secret = "ab".repeat(32) // 64-hex

    @Test fun universalLinkFragmentSecret() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$secret"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret), link)
    }

    @Test fun universalLinkKEqualsFragment() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#k=$secret"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret), link)
    }

    @Test fun universalLinkUppercaseSecretLowercased() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#${secret.uppercase()}"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret), link)
    }

    @Test fun universalLinkWithoutFragmentIsNull() {
        assertNull(DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite")))
    }

    @Test fun universalLinkWrongPathIsNull() {
        assertNull(DeepLink.parse(Uri.parse("https://home.alice.flagship.services/other#$secret")))
    }

    @Test fun controlHostInviteIsNull() {
        // flagshipserver.com is not under the data apex -> not a box invite.
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#$secret")))
    }

    @Test fun customSchemeServerAndK() {
        val link = DeepLink.parse(Uri.parse("flagship://invite?server=home.alice.flagship.services&k=$secret"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret), link)
    }

    @Test fun customSchemeMissingServerIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://invite?k=$secret")))
    }

    @Test fun customSchemeBadSecretIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://invite?server=home.alice.flagship.services&k=notahex")))
    }

    // ── v2: author AID carried in the link ──────────────────────────────────

    private val authorAid = "b4".repeat(32) // 64-hex

    @Test fun universalLinkCarriesAuthorAidFromFragment() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$secret&a=$authorAid"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, authorAid), link)
    }

    @Test fun customSchemeCarriesAuthorAidQuery() {
        val link = DeepLink.parse(Uri.parse("flagship://invite?server=home.alice.flagship.services&k=$secret&a=$authorAid"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, authorAid), link)
    }

    @Test fun universalLinkWithoutAuthorHasNullAuthor() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$secret"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, null), link)
    }

    @Test fun secretFromFragmentHelper() {
        assertEquals(secret, DeepLink.secretFromFragment(secret))
        assertEquals(secret, DeepLink.secretFromFragment("#$secret"))
        assertEquals(secret, DeepLink.secretFromFragment("k=$secret"))
        assertEquals(secret, DeepLink.secretFromFragment("a=1&k=$secret&b=2"))
        assertNull(DeepLink.secretFromFragment(""))
        assertNull(DeepLink.secretFromFragment("abc"))
        assertNull(DeepLink.secretFromFragment(null))
    }

    // ── flagship://access — web-experience gating (QR-login) ────────────────

    @Test fun accessLinkParsesAllParams() {
        val link = DeepLink.parse(
            Uri.parse(
                "flagship://access?server=home.alice.flagship.services&svc=notes" +
                    "&ref=alice-notes&page=cb2421036efeb738c6017d8ee92e7b89",
            ),
        )
        assertEquals(
            DeepLink.AuthorizeKnock(
                serverId = "home.alice.flagship.services",
                svc = "notes",
                serviceRef = "alice-notes",
                pageId = "cb2421036efeb738c6017d8ee92e7b89",
            ),
            link,
        )
    }

    @Test fun accessLinkUrlEncodedRefDecoded() {
        // The daemon URL-encodes svc/ref/page; getQueryParameter decodes them.
        val link = DeepLink.parse(
            Uri.parse("flagship://access?server=home.alice.flagship.services&svc=&ref=alice-notes&page=abc123"),
        )
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "", "alice-notes", "abc123"),
            link,
        )
    }

    @Test fun accessLinkMissingServerIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://access?ref=alice-notes&page=abc123")))
    }

    @Test fun accessLinkMissingRefIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://access?server=home.alice.flagship.services&page=abc123")))
    }

    @Test fun accessLinkMissingPageIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://access?server=home.alice.flagship.services&ref=alice-notes")))
    }

    @Test fun appLinkResolvesAccessScheme() {
        // AppLink.resolve (the MainActivity entry point) hands flagship://
        // straight to DeepLink.parse.
        val link = AppLink.resolve(
            Uri.parse("flagship://access?server=home.alice.flagship.services&svc=notes&ref=alice-notes&page=abc123"),
        )
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "notes", "alice-notes", "abc123"),
            link,
        )
    }
}
