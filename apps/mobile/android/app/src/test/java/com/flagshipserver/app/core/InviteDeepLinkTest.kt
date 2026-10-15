// Parsing of the service-access redeem deep link (docs/service-access-gating.md):
// the control-host App Link https://flagshipserver.com/invite#server=…&k=…, its
// older flagship://invite?server=…&k=… twin + the box universal
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

    // ── The box page's "Open in the Flagship app": /invite#server=&k=&a=&i=&s= ──

    private val box = "home.alice.flagship.services"
    private val author = "cd".repeat(32)

    @Test fun controlHostInviteFragmentParses() {
        val full = "server=$box&k=$secret&a=$author&i=$inviteId&s=alice-notes"
        val expected = DeepLink.RedeemInvite(box, secret, author, inviteId, "alice-notes")
        for (raw in listOf(
            "https://flagshipserver.com/invite#$full",
            "https://flagshipserver.com/invite/#$full",
            "https://www.flagshipserver.com/invite#$full",
        )) {
            assertEquals(raw, expected, DeepLink.parse(Uri.parse(raw)))
            assertEquals(raw, expected, AppLink.resolve(Uri.parse(raw)))
        }
        // a, i and s may be absent.
        assertEquals(
            DeepLink.RedeemInvite(box, secret),
            DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#server=$box&k=$secret")),
        )
        // URLSearchParams-encoded, and the same as the older custom-scheme form.
        assertEquals(
            expected,
            DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#server=home%2Ealice%2Eflagship%2Eservices&k=${secret.uppercase()}&a=$author&i=$inviteId&s=alice%2Dnotes")),
        )
        assertEquals(expected, DeepLink.parse(Uri.parse("flagship://invite?$full")))
    }

    @Test fun controlHostInviteFragmentRejectsBadLinks() {
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#server=$box")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#server=$box&k=notahex")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#k=$secret")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#server=evil.example&k=$secret")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#server=flagship.services.evil.example&k=$secret")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite#$secret")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/invite#server=$box&k=$secret")))
        assertNull(DeepLink.parse(Uri.parse("flagship://invite?server=evil.example&k=$secret")))
    }

    @Test fun customSchemeMissingServerIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://invite?k=$secret")))
    }

    @Test fun customSchemeBadSecretIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://invite?server=home.alice.flagship.services&k=notahex")))
    }

    // ── v2: author AID + inviteId carried in the link ───────────────────────

    private val authorAid = "b4".repeat(32) // 64-hex
    private val inviteId = "ea".repeat(32)  // 64-hex

    @Test fun universalLinkCarriesAuthorAidFromFragment() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$secret&a=$authorAid"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, authorAid), link)
    }

    @Test fun universalLinkCarriesAuthorAidAndInviteId() {
        // Canonical: BARE leading secret, then &a=/&i=.
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$secret&a=$authorAid&i=$inviteId"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, authorAid, inviteId), link)
    }

    @Test fun customSchemeCarriesAuthorAidQuery() {
        val link = DeepLink.parse(Uri.parse("flagship://invite?server=home.alice.flagship.services&k=$secret&a=$authorAid"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, authorAid), link)
    }

    @Test fun customSchemeCarriesAuthorAidAndInviteIdQuery() {
        val link = DeepLink.parse(Uri.parse("flagship://invite?server=home.alice.flagship.services&k=$secret&a=$authorAid&i=$inviteId"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, authorAid, inviteId), link)
    }

    @Test fun universalLinkWithoutAuthorHasNullAuthor() {
        val link = DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$secret"))
        assertEquals(DeepLink.RedeemInvite("home.alice.flagship.services", secret, null, null), link)
    }

    /** FROZEN cross-client canonical fragment (interop lock — the IDENTICAL
     *  string is pinned on the webapp serviceInvite test + iOS DeepLink). */
    @Test fun frozenCanonicalFragmentParses() {
        val s = "a".repeat(64)
        val a = "b4b357bf622c86ea3b6c3e2440e2bf9e344ac3cf5f61236da8e6f280f93db640"
        val i = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        assertEquals(
            DeepLink.RedeemInvite("home.alice.flagship.services", s, a, i),
            DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$s&a=$a&i=$i")),
        )
        // Bare secret → secret only.
        assertEquals(
            DeepLink.RedeemInvite("home.alice.flagship.services", s, null, null),
            DeepLink.parse(Uri.parse("https://home.alice.flagship.services/invite#$s")),
        )
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
                    "&ref=alice--notes&page=cb2421036efeb738c6017d8ee92e7b89",
            ),
        )
        assertEquals(
            DeepLink.AuthorizeKnock(
                serverId = "home.alice.flagship.services",
                svc = "notes",
                serviceRef = "alice--notes",
                pageId = "cb2421036efeb738c6017d8ee92e7b89",
            ),
            link,
        )
    }

    @Test fun accessLinkUrlEncodedRefDecoded() {
        // The daemon URL-encodes svc/ref/page; getQueryParameter decodes them.
        val link = DeepLink.parse(
            Uri.parse("flagship://access?server=home.alice.flagship.services&svc=&ref=alice--notes&page=abc123"),
        )
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "", "alice--notes", "abc123"),
            link,
        )
    }

    @Test fun accessLinkMissingServerIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://access?ref=alice--notes&page=abc123")))
    }

    @Test fun accessLinkMissingRefIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://access?server=home.alice.flagship.services&page=abc123")))
    }

    @Test fun accessLinkMissingPageIsNull() {
        assertNull(DeepLink.parse(Uri.parse("flagship://access?server=home.alice.flagship.services&ref=alice--notes")))
    }

    @Test fun accessFragmentLinkParses() {
        val expected = DeepLink.AuthorizeKnock("home.alice.flagship.services", "notes", "alice--notes", "abc123")
        val f = "server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123"
        for (raw in listOf(
            "https://flagshipserver.com/access#$f",
            "https://flagshipserver.com/access/#$f",
            "https://www.flagshipserver.com/access#$f",
            "https://flagshipserver.com/app/access#$f",
        )) {
            assertEquals(raw, expected, DeepLink.parse(Uri.parse(raw)))
            assertEquals(raw, expected, AppLink.resolve(Uri.parse(raw)))
        }
        // URLSearchParams-encoded: %20 and + both decode to a space.
        val spaced = DeepLink.AuthorizeKnock("home.alice.flagship.services", "my notes", "alice--notes", "abc123")
        assertEquals(spaced, DeepLink.parse(Uri.parse("https://flagshipserver.com/access#${f.replace("svc=notes", "svc=my%20notes")}")))
        assertEquals(spaced, DeepLink.parse(Uri.parse("https://flagshipserver.com/access#${f.replace("svc=notes", "svc=my+notes")}")))
        // The fragment wins over a query; an empty fragment falls back to the query.
        assertEquals(expected, DeepLink.parse(Uri.parse("https://flagshipserver.com/access?server=x&ref=y&page=z#$f")))
        assertEquals(expected, DeepLink.parse(Uri.parse("https://flagshipserver.com/access?$f#")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/access#server=home.alice.flagship.services&ref=alice--notes")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/access#$f")))
    }

    @Test fun accessAppLinkParsesLikeTheScheme() {
        val expected = DeepLink.AuthorizeKnock("home.alice.flagship.services", "notes", "alice--notes", "abc123")
        for (raw in listOf(
            "https://flagshipserver.com/access?server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123",
            "https://flagshipserver.com/access/?server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123",
            "https://www.flagshipserver.com/access?server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123",
        )) {
            assertEquals(raw, expected, DeepLink.parse(Uri.parse(raw)))
            assertEquals(raw, expected, AppLink.resolve(Uri.parse(raw)))
        }
        // URLSearchParams-encoded (the knock page builds it that way).
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "my notes", "alice--notes", "abc123"),
            DeepLink.parse(Uri.parse("https://flagshipserver.com/access?server=home.alice.flagship.services&svc=my%20notes&ref=alice--notes&page=abc123")),
        )
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/access?server=home.alice.flagship.services&ref=alice--notes")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/access?server=h&ref=r&page=p")))
    }

    // ── invite-accept — a friend's acceptance reply ─────────────────────────

    private val acceptQuery = "server=home.alice.flagship.services" +
        "&iid=ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890&ref=alice-notes" +
        "&aid=086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a&sig=${"1f".repeat(64)}&at=1700006000000"

    @Test fun inviteAcceptParsesBothForms() {
        for (raw in listOf(
            "https://flagshipserver.com/invite-accept#$acceptQuery",
            "https://flagshipserver.com/invite-accept/#$acceptQuery",
            "https://www.flagshipserver.com/invite-accept#$acceptQuery",
            "https://flagshipserver.com/invite-accept?$acceptQuery",
            "https://flagshipserver.com/invite-accept/?$acceptQuery",
            "https://www.flagshipserver.com/invite-accept?$acceptQuery",
            "flagship://invite-accept?$acceptQuery",
        )) {
            assertEquals(raw, DeepLink.AcceptInvite(raw), DeepLink.parse(Uri.parse(raw)))
            assertEquals(raw, DeepLink.AcceptInvite(raw), AppLink.resolve(Uri.parse(raw)))
        }
    }

    @Test fun inviteAcceptNeedsServerAndValidFields() {
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite-accept?${acceptQuery.substringAfter("&")}")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite-accept?server=h&iid=short")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/invite-accept?$acceptQuery")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/invite-accept#${acceptQuery.substringAfter("&")}")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/invite-accept#$acceptQuery")))
    }

    // ── builder — Flagship Studio's pairing QR ─────────────────────────────

    @Test fun builderQrParsesBothForms() {
        val q = "c=AEBAGBAF&k=pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        for (raw in listOf(
            "https://flagshipserver.com/builder?$q",
            "https://flagshipserver.com/builder/?$q",
            "https://www.flagshipserver.com/builder?$q",
            "flagship://builder?$q",
        )) {
            assertEquals(raw, DeepLink.BuilderPair(raw), DeepLink.parse(Uri.parse(raw)))
            assertEquals(raw, DeepLink.BuilderPair(raw), AppLink.resolve(Uri.parse(raw)))
        }
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/builder?k=x")))
        assertNull(DeepLink.parse(Uri.parse("https://flagshipserver.com/builder?c=nope!!")))
        assertNull(DeepLink.parse(Uri.parse("https://evil.example/builder?$q")))
    }

    @Test fun appLinkResolvesAccessScheme() {
        // AppLink.resolve (the MainActivity entry point) hands flagship://
        // straight to DeepLink.parse.
        val link = AppLink.resolve(
            Uri.parse("flagship://access?server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123"),
        )
        assertEquals(
            DeepLink.AuthorizeKnock("home.alice.flagship.services", "notes", "alice--notes", "abc123"),
            link,
        )
    }
}
