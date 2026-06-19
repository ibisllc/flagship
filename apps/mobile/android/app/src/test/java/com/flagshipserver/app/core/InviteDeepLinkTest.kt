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

    @Test fun secretFromFragmentHelper() {
        assertEquals(secret, DeepLink.secretFromFragment(secret))
        assertEquals(secret, DeepLink.secretFromFragment("#$secret"))
        assertEquals(secret, DeepLink.secretFromFragment("k=$secret"))
        assertEquals(secret, DeepLink.secretFromFragment("a=1&k=$secret&b=2"))
        assertNull(DeepLink.secretFromFragment(""))
        assertNull(DeepLink.secretFromFragment("abc"))
        assertNull(DeepLink.secretFromFragment(null))
    }
}
