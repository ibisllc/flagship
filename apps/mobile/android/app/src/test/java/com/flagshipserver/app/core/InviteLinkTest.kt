// InviteLink (gating v2) — the author-AID-carrying share link + the base64url
// acceptance-reply codec. Needs Robolectric (android.net.Uri + android.util.Base64
// live in android.jar).

package com.flagshipserver.app.core

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class InviteLinkTest {
    private val server = "home.alice.flagship.services"
    private val secret = "07".repeat(32)
    private val author = "b4".repeat(32)

    @Test fun shareLinkEmbedsSecretAndAuthor() {
        val link = InviteLink.shareLink(server, secret, author)
        assertEquals("https://$server/invite#$secret&a=$author", link)
        assertEquals(author, InviteLink.authorAidFromLink(link))
    }

    @Test fun appLinkEmbedsAuthorQuery() {
        val link = InviteLink.appLink(server, secret, author)
        assertTrue(link.startsWith("flagship://invite?server=$server"))
        assertEquals(author, InviteLink.authorAidFromLink(link))
    }

    @Test fun authorAidFromFragmentVariants() {
        assertEquals(author, InviteLink.authorAidFromFragment("$secret&a=$author"))
        assertEquals(author, InviteLink.authorAidFromFragment("#a=$author&k=$secret"))
        assertNull(InviteLink.authorAidFromFragment(secret)) // no a= param
        assertNull(InviteLink.authorAidFromFragment(null))
    }

    @Test fun acceptanceRoundTrips() {
        val accept = buildJsonObject {
            put("inviteId", JsonPrimitive("inv1"))
            put("serviceRef", JsonPrimitive("alice-notes"))
            put("contactAID", JsonPrimitive("c".repeat(64)))
            put("acceptedAt", JsonPrimitive(1700L))
        }
        val create = buildJsonObject {
            put("inviteId", JsonPrimitive("inv1"))
            put("authorAID", JsonPrimitive(author))
            put("serviceRef", JsonPrimitive("alice-notes"))
            put("secretHash", JsonPrimitive("d".repeat(64)))
            put("encryptedBundle", JsonPrimitive("00"))
            put("issuedAt", JsonPrimitive(1500L))
        }
        val body = InviteLink.encodeAcceptance(accept, "a".repeat(128), create, "b".repeat(128))
        // decodes from the bare body AND from the flagship://accept?b=… wrapper.
        for (raw in listOf(body, InviteLink.acceptanceLink(body))) {
            val acc = InviteLink.decodeAcceptance(raw)!!
            assertEquals("inv1", acc.accept["inviteId"]!!.jsonPrimitive.content)
            assertEquals("a".repeat(128), acc.acceptSigHex)
            assertEquals("00", acc.create["encryptedBundle"]!!.jsonPrimitive.content)
            assertEquals("b".repeat(128), acc.createSigHex)
        }
    }

    @Test fun decodeAcceptanceRejectsGarbage() {
        assertNull(InviteLink.decodeAcceptance("not-base64-or-a-link"))
        assertNull(InviteLink.decodeAcceptance(""))
    }
}
