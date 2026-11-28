package com.flagshipserver.app.core.pq

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/org-invite-key/vectors.json: the link key's offer key and invite
// key, the invite's canonical bytes, the read proof and the invite-key signature on the accept, with their negatives.
class OrgInviteKeyVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/org-invite-key/vectors.json")
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun obj(k: String) = v[k]!!.jsonObject
    private fun hex(s: String) = PqHex.decode(s)!!

    @Test
    fun derivesTheOfferKeyAndTheInviteKey() {
        val k = OrgAuthority.inviteKeys(hex(v.s("linkKeyHex")))
        assertEquals(v.s("offerKeyHex"), PqHex.encode(k.offerKey))
        assertEquals(v.s("inviteSecretHex"), PqHex.encode(k.secret))
        assertEquals(v.s("inviteKeyPub"), k.inviteKeyPub)
        assertEquals(v.s("wrongInviteKeyPub"), OrgAuthority.inviteKeys(hex(v.s("wrongLinkKeyHex"))).inviteKeyPub)
    }

    @Test
    fun opensTheOfferUnderTheOfferKeyOnly() {
        val sealed = hex(obj("offer").s("sealedHex"))
        fun open(key: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            return c.doFinal(sealed.copyOfRange(12, sealed.size))
        }
        assertEquals(obj("offer").s("plaintext"), String(open(hex(v.s("offerKeyHex"))), Charsets.UTF_8))
        assertTrue(runCatching { open(hex(v.s("linkKeyHex"))) }.isFailure)
    }

    @Test
    fun canonicalBytes() {
        val c = obj("canonical")
        val inv = obj("invites")["invite"]!!.jsonObject
        assertEquals(c["invite"]!!.jsonObject.s("bytes"), String(OrgAuthority.canonicalSeatInvite(inv)!!, Charsets.UTF_8))
        assertEquals(c["invite"]!!.jsonObject.s("sha256"), OrgAuthority.sha256Hex(OrgAuthority.canonicalSeatInvite(inv)!!))
        assertNull(OrgAuthority.canonicalSeatInvite(JsonObject(inv - "inviteKeyPub")))
        val r = c["read"]!!.jsonObject
        assertEquals(r.s("bytes"), String(OrgAuthority.canonicalInviteRead(r.s("orgId"), r.s("seatId"), r["issuedAt"]!!.jsonPrimitive.long), Charsets.UTF_8))
        val w = c["withdraw"]!!.jsonObject
        assertEquals(w.s("bytes"), String(OrgAuthority.canonicalInviteWithdraw(w.s("orgId"), w.s("seatId"), w["oarVersion"]!!.jsonPrimitive.long, w["issuedAt"]!!.jsonPrimitive.long), Charsets.UTF_8))
    }

    @Test
    fun readProofs() {
        for (r in v["reads"]!!.jsonArray.map { it.jsonObject }) {
            val inv = obj("invites")[r.s("invite")]!!.jsonObject
            val got = OrgAuthority.verifyInviteRead(inv.s("orgId"), inv.s("seatId"), inv.s("inviteKeyPub"), r["issuedAt"]!!.jsonPrimitive.long, r.s("signature"), r["now"]!!.jsonPrimitive.long)
            assertEquals(r.s("name"), r["expect"]!!.jsonPrimitive.boolean, got)
        }
    }

    @Test
    fun acceptProofs() {
        for (a in v["accepts"]!!.jsonArray.map { it.jsonObject }) {
            val inv = obj("invites")[a.s("invite")]!!.jsonObject
            val acc = obj("acceptObjects")[a.s("accept")]!!.jsonObject
            assertEquals(a.s("name"), a["expect"]!!.jsonPrimitive.boolean, OrgAuthority.verifyInviteAccept(inv, acc, a.s("signature")))
        }
    }

    @Test
    fun signingReproducesTheDeterministicProofs() {
        val secret = hex(v.s("inviteSecretHex"))
        val r = obj("canonical")["read"]!!.jsonObject
        assertEquals(v["reads"]!!.jsonArray[0].jsonObject.s("signature"),
            OrgAuthority.inviteReadSignature(secret, r.s("orgId"), r.s("seatId"), r["issuedAt"]!!.jsonPrimitive.long, deterministic = true))
        val acceptBytes = obj("canonical")["accept"]!!.jsonObject.s("bytes").toByteArray(Charsets.UTF_8)
        assertEquals(v["accepts"]!!.jsonArray[0].jsonObject.s("signature"), OrgAuthority.inviteAcceptSignature(secret, acceptBytes, deterministic = true))
    }
}
