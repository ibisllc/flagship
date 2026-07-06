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
    private val invite = "ea".repeat(32)

    @Test fun shareLinkEmbedsSecretAndAuthor() {
        val link = InviteLink.shareLink(server, secret, author)
        assertEquals("https://$server/invite#$secret&a=$author", link)
        assertEquals(author, InviteLink.authorAidFromLink(link))
        assertNull(InviteLink.inviteIdFromLink(link)) // no i= for auto/group
    }

    @Test fun shareLinkEmbedsInviteIdWhenManual() {
        val link = InviteLink.shareLink(server, secret, author, invite)
        assertEquals("https://$server/invite#$secret&a=$author&i=$invite", link)
        assertEquals(author, InviteLink.authorAidFromLink(link))
        assertEquals(invite, InviteLink.inviteIdFromLink(link))
    }

    @Test fun appLinkEmbedsAuthorQuery() {
        val link = InviteLink.appLink(server, secret, author)
        assertTrue(link.startsWith("flagship://invite?server=$server"))
        assertEquals(author, InviteLink.authorAidFromLink(link))
        assertNull(InviteLink.inviteIdFromLink(link))
    }

    @Test fun appLinkEmbedsInviteIdWhenManual() {
        val link = InviteLink.appLink(server, secret, author, invite)
        assertEquals(invite, InviteLink.inviteIdFromLink(link))
    }

    @Test fun authorAidFromFragmentVariants() {
        assertEquals(author, InviteLink.authorAidFromFragment("$secret&a=$author"))
        assertEquals(author, InviteLink.authorAidFromFragment("#a=$author&k=$secret"))
        assertNull(InviteLink.authorAidFromFragment(secret)) // no a= param
        assertNull(InviteLink.authorAidFromFragment(null))
    }

    @Test fun inviteIdFromFragmentVariants() {
        assertEquals(invite, InviteLink.inviteIdFromFragment("$secret&a=$author&i=$invite"))
        assertEquals(invite, InviteLink.inviteIdFromFragment("#i=$invite&k=$secret"))
        assertNull(InviteLink.inviteIdFromFragment("$secret&a=$author")) // no i= param
        assertNull(InviteLink.inviteIdFromFragment(null))
    }

    /** FROZEN cross-client canonical fragment (interop lock — the IDENTICAL
     *  string is pinned on the webapp serviceInvite test + iOS DeepLink). */
    @Test fun frozenCanonicalFragmentInterop() {
        val s = "a".repeat(64)
        val a = "b4b357bf622c86ea3b6c3e2440e2bf9e344ac3cf5f61236da8e6f280f93db640"
        val i = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val frag = "$s&a=$a&i=$i"
        // build(secret,a,i) === the frozen fragment.
        assertEquals("https://$server/invite#$frag", InviteLink.shareLink(server, s, a, i))
        // parse(frozen) === { secret, a, i }.
        assertEquals(a, InviteLink.authorAidFromFragment(frag))
        assertEquals(i, InviteLink.inviteIdFromFragment(frag))
    }

    @Test fun acceptanceRoundTrips() {
        val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val accept = buildJsonObject {
            put("inviteId", JsonPrimitive(iid))
            put("serviceRef", JsonPrimitive("alice--notes"))
            put("contactAID", JsonPrimitive("c".repeat(64)))
            put("acceptedAt", JsonPrimitive(1700L))
        }
        // The canonical reply carries ONLY {accept, acceptSig} — no create.
        val reply = InviteLink.buildAcceptReply("home.alice.flagship.services", accept, "a".repeat(128))
        assertTrue(reply.startsWith("flagship://invite-accept?"))
        val acc = InviteLink.decodeAcceptance(reply)!!
        assertEquals("home.alice.flagship.services", acc.serverDomain)
        assertEquals(iid, acc.accept["inviteId"]!!.jsonPrimitive.content)
        assertEquals("alice--notes", acc.accept["serviceRef"]!!.jsonPrimitive.content)
        assertEquals("c".repeat(64), acc.accept["contactAID"]!!.jsonPrimitive.content)
        assertEquals(1700L, acc.accept["acceptedAt"]!!.jsonPrimitive.content.toLong())
        assertEquals("a".repeat(128), acc.acceptSigHex)
    }

    /** FROZEN cross-client acceptance reply (interop lock — the IDENTICAL string
     *  is pinned on the webapp serviceInvite test + iOS DeepLink). */
    @Test fun frozenAcceptReplyInterop() {
        val server = "home.alice.flagship.services"
        val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val ref = "alice--notes"
        val aid = "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a"
        val sig = "1f".repeat(64)
        val at = 1_700_006_000_000L
        val frozen = "flagship://invite-accept?server=$server&iid=$iid&ref=$ref&aid=$aid&sig=$sig&at=$at"
        val accept = buildJsonObject {
            put("inviteId", JsonPrimitive(iid))
            put("serviceRef", JsonPrimitive(ref))
            put("contactAID", JsonPrimitive(aid))
            put("acceptedAt", JsonPrimitive(at))
        }
        assertEquals(frozen, InviteLink.buildAcceptReply(server, accept, sig))
        val acc = InviteLink.decodeAcceptance(frozen)!!
        assertEquals(iid, acc.accept["inviteId"]!!.jsonPrimitive.content)
        assertEquals(aid, acc.accept["contactAID"]!!.jsonPrimitive.content)
        assertEquals(sig, acc.acceptSigHex)
    }

    /** Back-compat: the legacy `flagship://accept?b=<base64url>` bundle still
     *  decodes (the create is ignored — the box fetches it). */
    @Test fun decodeAcceptanceAcceptsLegacyBundle() {
        val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val legacyJson = """{"v":2,"accept":{"inviteId":"$iid","serviceRef":"alice--notes","contactAID":"${"c".repeat(64)}","acceptedAt":1700},"acceptSig":"${"a".repeat(128)}","create":{"inviteId":"$iid"},"createSig":"${"b".repeat(128)}"}"""
        val b64 = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(legacyJson.toByteArray(Charsets.UTF_8))
        val acc = InviteLink.decodeAcceptance("flagship://accept?b=$b64")!!
        assertNull(acc.serverDomain)
        assertEquals(iid, acc.accept["inviteId"]!!.jsonPrimitive.content)
        assertEquals("a".repeat(128), acc.acceptSigHex)
    }

    @Test fun decodeAcceptanceRejectsGarbage() {
        assertNull(InviteLink.decodeAcceptance("not-base64-or-a-link"))
        assertNull(InviteLink.decodeAcceptance(""))
        assertNull(InviteLink.decodeAcceptance("flagship://invite-accept?iid=tooShort"))
    }
}
