// Android half of the service-access-gating cross-platform contract — mirror of
// the iOS ServiceInviteVectorTests + the TS/webapp tests. Loads THE single
// authoritative fixture, packages/protocol/tests/fixtures/
// serviceAccessGating.vectors.json (generated from @flagship/protocol), FROM
// DISK at runtime via a walk-up from the JVM unit-test working dir — never
// transcribed into Kotlin literals. A drift surfaces HERE, not as a live
// "phone signs, .com/box rejects" failure.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServiceInviteVectorTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun vectorsFile(): File {
        val rel = "packages/protocol/tests/fixtures/serviceAccessGating.vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        try {
            val loc = javaClass.protectionDomain?.codeSource?.location
            if (loc != null) candidates.add(File(loc.toURI()))
        } catch (_: Throwable) {
        }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel from " + candidates.joinToString { it.absolutePath })
        error("unreachable")
    }

    private fun root(): JsonObject = json.parseToJsonElement(vectorsFile().readText()).jsonObject
    private fun JsonObject.obj(k: String): JsonObject = (this[k] as JsonObject)
    private fun JsonObject.s(k: String): String = (this[k] as JsonPrimitive).content
    private fun JsonObject.l(k: String): Long = (this[k] as JsonPrimitive).content.toLong()

    private fun seed(hex: String): ByteArray = HexUtil.decode(hex)!!
    private fun authorUmk(r: JsonObject) = seed(r.obj("seeds").s("authorUmkSeedHex"))
    private fun friendUmk(r: JsonObject) = seed(r.obj("seeds").s("friendUmkSeedHex"))

    /** Reproduce the author IRK signing key the vectors used — protocol v1 IRK
     *  (flagship.irk.v1), so create/revoke/setMode sigs verify against the
     *  recorded authorIrkPubHex. */
    private fun authorIrk(r: JsonObject) = ServerKeys.deriveProtocolIrk(authorUmk(r))
    private fun friendAid(r: JsonObject) = ServerKeys.deriveAccountId(friendUmk(r))

    // v2 Wave 3 signers: the author's STABLE AID (create/revoke move to it) and
    // the friend's PER-AUTHOR contact AID (the redemption identity).
    private fun authorAid(r: JsonObject) = ServerKeys.deriveAccountId(authorUmk(r))
    private fun authorAidPub(r: JsonObject) = ServerKeys.deriveAccountIdPub(authorUmk(r))
    private fun friendContactAid(r: JsonObject) =
        ServerKeys.deriveContactAccountId(friendUmk(r), authorAidPub(r))

    @Test fun derivedKeysMatchFixture() {
        val r = root()
        val d = r.obj("derived")
        assertEquals(d.s("authorAidPubHex"), HexUtil.encode(ServerKeys.deriveAccountIdPub(authorUmk(r))))
        assertEquals(d.s("authorIrkPubHex"), HexUtil.encode(ServerKeys.deriveProtocolIrkPub(authorUmk(r))))
        assertEquals(d.s("friendAidPubHex"), HexUtil.encode(ServerKeys.deriveAccountIdPub(friendUmk(r))))
        assertEquals(d.s("householdKeyHex"), HexUtil.encode(ServerKeys.deriveHouseholdKey(authorUmk(r))))
    }

    @Test fun inviteIdAndSecretHashMatchFixture() {
        val r = root()
        val aidPub = ServerKeys.deriveAccountIdPub(authorUmk(r))
        val devicePub = HexUtil.decode(r.obj("derived").s("authorDevicePubHex"))!!
        assertEquals(r.s("inviteId"), ServiceInvite.inviteId(aidPub, devicePub, 0))
        assertEquals(r.s("inviteIdCounter1"), ServiceInvite.inviteId(aidPub, devicePub, 1))
        assertEquals(r.s("secretHash"), ServiceInvite.secretHash(HexUtil.decode(r.s("secretHex"))!!))
    }

    @Test fun createSignatureVerifies() {
        val r = root()
        val c = r.obj("create")
        val aidPub = ServerKeys.deriveAccountIdPub(authorUmk(r))
        val bytes = ServiceInvite.canonicalCreate(
            r.s("inviteId"), aidPub, r.s("serviceRef"), r.s("secretHash"),
            c.s("encryptedBundlePlaceholder"), c.l("issuedAt"),
        )
        val irkPub = HexUtil.decode(r.obj("derived").s("authorIrkPubHex"))!!
        // The recorded (noble RFC-8032) sig verifies under OUR canonical bytes.
        assertTrue(ServiceInvite.verify(HexUtil.decode(c.s("sigHex"))!!, bytes, irkPub))
        // Tink's Ed25519 IS RFC-8032 deterministic, so our sig byte-equals it.
        assertEquals(c.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, authorIrk(r))))
    }

    @Test fun redeemSignatureVerifies() {
        val r = root()
        val rd = r.obj("redeem")
        val friendAidPub = ServerKeys.deriveAccountIdPub(friendUmk(r))
        val bytes = ServiceInvite.canonicalRedeem(r.s("secretHash"), friendAidPub, rd.l("redeemedAt"))
        assertTrue(ServiceInvite.verify(HexUtil.decode(rd.s("sigHex"))!!, bytes, friendAidPub))
        assertEquals(rd.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, friendAid(r))))
    }

    @Test fun revokeSignatureVerifies() {
        val r = root()
        val rv = r.obj("revoke")
        val bytes = ServiceInvite.canonicalRevoke(r.s("inviteId"), rv.l("issuedAt"))
        val irkPub = HexUtil.decode(r.obj("derived").s("authorIrkPubHex"))!!
        assertTrue(ServiceInvite.verify(HexUtil.decode(rv.s("sigHex"))!!, bytes, irkPub))
        assertEquals(rv.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, authorIrk(r))))
    }

    @Test fun setAccessModeSignatureVerifies() {
        val r = root()
        val sm = r.obj("setAccessMode")
        val bytes = ServiceInvite.canonicalSetAccessMode(r.s("serverId"), r.s("serviceRef"), sm.s("mode"), sm.l("issuedAt"))
        val irkPub = HexUtil.decode(r.obj("derived").s("authorIrkPubHex"))!!
        assertTrue(ServiceInvite.verify(HexUtil.decode(sm.s("sigHex"))!!, bytes, irkPub))
        assertEquals(sm.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, authorIrk(r))))
    }

    @Test fun removeAllowSignatureVerifies() {
        // Owner-IRK prune of a friend's bound AID from the box's allow-list — the
        // `flagship/service-allow-remove/v1` shape. The admin app fires this
        // alongside the `.com` revoke so a revoked friend is actually denied.
        val r = root()
        val ra = r.obj("removeAllow")
        val bytes = ServiceInvite.canonicalRemoveServiceAllow(
            r.s("serverId"), r.s("serviceRef"), ra.s("aid"), ra.l("issuedAt"),
        )
        val irkPub = HexUtil.decode(r.obj("derived").s("authorIrkPubHex"))!!
        assertTrue(ServiceInvite.verify(HexUtil.decode(ra.s("sigHex"))!!, bytes, irkPub))
        // Tink Ed25519 is RFC-8032 deterministic, so our signature byte-equals it.
        assertEquals(ra.s("sigHex"), HexUtil.encode(ServiceInvite.signRemoveServiceAllow(
            r.s("serverId"), r.s("serviceRef"), ra.s("aid"), ra.l("issuedAt"), authorIrk(r),
        )))
    }

    @Test fun visitSignatureVerifies() {
        val r = root()
        val v = r.obj("visit")
        val friendAidPub = ServerKeys.deriveAccountIdPub(friendUmk(r))
        val bytes = ServiceInvite.canonicalVisit(r.s("serverId"), r.s("serviceRef"), friendAidPub, v.l("issuedAt"))
        assertTrue(ServiceInvite.verify(HexUtil.decode(v.s("sigHex"))!!, bytes, friendAidPub))
        assertEquals(v.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, friendAid(r))))
    }

    @Test fun knockSignatureVerifies() {
        // Web-experience gating: the visitor's PHONE AID-signs a
        // KnockAuthorization to authorize a browser's QR-login. The pageId is
        // in the signature.
        val r = root()
        val k = r.obj("knock")
        val friendAidPub = ServerKeys.deriveAccountIdPub(friendUmk(r))
        val bytes = ServiceInvite.canonicalKnock(
            r.s("serverId"), r.s("serviceRef"), k.s("pageId"), friendAidPub, k.l("issuedAt"),
        )
        assertTrue(ServiceInvite.verify(HexUtil.decode(k.s("sigHex"))!!, bytes, friendAidPub))
        // Tink Ed25519 is RFC-8032 deterministic, so our signature byte-equals it.
        assertEquals(k.s("sigHex"), HexUtil.encode(ServiceInvite.signKnockAuthorization(
            r.s("serverId"), r.s("serviceRef"), k.s("pageId"), friendAidPub, k.l("issuedAt"), friendAid(r),
        )))
    }

    @Test fun bundleSealOpenRoundtrip() {
        val r = root()
        val household = ServerKeys.deriveHouseholdKey(authorUmk(r))
        val inviteId = r.s("inviteId")
        val b = r.obj("bundle")
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle(b.s("name"), b.s("photo")), household, inviteId)
        val opened = ServiceInvite.openBundle(sealed, household, inviteId)
        assertEquals(b.s("name"), opened.name)
        assertEquals(b.s("photo"), opened.photo)
        // Wrong inviteId (AAD) fails.
        var threw = false
        try { ServiceInvite.openBundle(sealed, household, inviteId + "x") } catch (_: Throwable) { threw = true }
        assertTrue("wrong-inviteId open must fail", threw)
        // name-only roundtrips.
        val sealedNameOnly = ServiceInvite.sealBundle(ServiceInvite.Bundle("Alex"), household, inviteId)
        val openedNameOnly = ServiceInvite.openBundle(sealedNameOnly, household, inviteId)
        assertEquals("Alex", openedNameOnly.name)
        assertNull(openedNameOnly.photo)
    }

    @Test fun opensTsSealedBundle() {
        // Cross-IMPLEMENTATION open: a bundle sealed by @flagship/protocol (TS)
        // opens on Kotlin under the SAME household key + inviteId (the box stores
        // TS/webapp-sealed ciphertext; the phone must read it). Hex produced by
        // sealInviteBundle in the TS protocol over the fixture household key.
        val r = root()
        val household = ServerKeys.deriveHouseholdKey(authorUmk(r))
        val inviteId = r.s("inviteId")
        val tsSealed = "cf6bb0370255d5d892aede3f0f676681d6753e5baba18fe47f4905401110fed5" +
            "5e1d6e2878d1afb4aea9228fe186578c184c6164fd32fa35eaf5585c1f0a5101f9be11ad350eb85aed93f82754578583"
        val opened = ServiceInvite.openBundle(tsSealed, household, inviteId)
        assertEquals("Alex", opened.name)
        assertEquals("data:image/png;base64,AAAA", opened.photo)
    }

    @Test fun bundlePlaintextEscapesLikeProtocol() {
        val r = root()
        val household = ServerKeys.deriveHouseholdKey(authorUmk(r))
        val inviteId = r.s("inviteId")
        val tricky = ServiceInvite.Bundle("A\"x\\y/z", "data:,é")
        val sealed = ServiceInvite.sealBundle(tricky, household, inviteId)
        val opened = ServiceInvite.openBundle(sealed, household, inviteId)
        assertEquals("A\"x\\y/z", opened.name)
        assertEquals("data:,é", opened.photo)
    }

    @Test fun forgedSignatureRejected() {
        val r = root()
        val bytes = ServiceInvite.canonicalRevoke(r.s("inviteId"), 1700)
        val irkPub = HexUtil.decode(r.obj("derived").s("authorIrkPubHex"))!!
        assertFalse(ServiceInvite.verify(ByteArray(64), bytes, irkPub))
    }

    // ── v2 Wave 3 ─────────────────────────────────────────────────────────

    @Test fun contactAccountIdMatchesFixture() {
        // contactAid = deriveContactAccountId(friendUmk, authorAid.pub) — the
        // friend's PER-AUTHOR pseudonym (unlinkable across authors).
        val r = root()
        val ca = r.obj("contactAid")
        // The fixture pins the author AID pub it derives the contact id from.
        assertEquals(ca.s("authorAidPubHex"), HexUtil.encode(authorAidPub(r)))
        assertEquals(
            ca.s("contactAidPubHex"),
            HexUtil.encode(ServerKeys.deriveContactAccountIdPub(friendUmk(r), authorAidPub(r))),
        )
    }

    @Test fun createAidSignatureVerifies() {
        // Wave 3: clients sign create with the STABLE AID (box-as-authority verifies
        // against the owner AID). Same pre-image as the v1 `create` vector.
        val r = root()
        val c = r.obj("createAid")
        val bytes = ServiceInvite.canonicalCreate(
            r.s("inviteId"), authorAidPub(r), r.s("serviceRef"), r.s("secretHash"),
            c.s("encryptedBundlePlaceholder"), c.l("issuedAt"),
        )
        assertTrue(ServiceInvite.verify(HexUtil.decode(c.s("sigHex"))!!, bytes, authorAidPub(r)))
        assertEquals(c.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, authorAid(r))))
    }

    @Test fun revokeAidSignatureVerifies() {
        val r = root()
        val rv = r.obj("revokeAid")
        val bytes = ServiceInvite.canonicalRevoke(r.s("inviteId"), rv.l("issuedAt"))
        assertTrue(ServiceInvite.verify(HexUtil.decode(rv.s("sigHex"))!!, bytes, authorAidPub(r)))
        assertEquals(rv.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, authorAid(r))))
    }

    @Test fun acceptSignatureVerifies() {
        // The MANUAL-approve acceptance is signed by the friend's contact AID over
        // { inviteId, serviceRef, contactAID, acceptedAt }.
        val r = root()
        val a = r.obj("accept")
        val contactPub = ServerKeys.deriveContactAccountIdPub(friendUmk(r), authorAidPub(r))
        val bytes = ServiceInvite.canonicalAccept(a.s("inviteId"), a.s("serviceRef"), contactPub, a.l("acceptedAt"))
        assertTrue(ServiceInvite.verify(HexUtil.decode(a.s("sigHex"))!!, bytes, contactPub))
        assertEquals(
            a.s("sigHex"),
            HexUtil.encode(ServiceInvite.signAcceptServiceInvite(a.s("inviteId"), a.s("serviceRef"), contactPub, a.l("acceptedAt"), friendContactAid(r))),
        )
    }

    @Test fun createMaxNSignatureVerifies() {
        // A GROUP create: maxRedemptions + expiresAt appended to the canonical
        // bytes (authorIrk-signed in the fixture; the bytes are what we pin).
        val r = root()
        val c = r.obj("createMaxN")
        val bytes = ServiceInvite.canonicalCreate(
            c.s("inviteId"), authorAidPub(r), r.s("serviceRef"), r.s("secretHash"),
            c.s("encryptedBundlePlaceholder"), c.l("issuedAt"),
            c.l("maxRedemptions").toInt(), c.l("expiresAt"),
        )
        val irkPub = HexUtil.decode(r.obj("derived").s("authorIrkPubHex"))!!
        assertTrue(ServiceInvite.verify(HexUtil.decode(c.s("sigHex"))!!, bytes, irkPub))
        assertEquals(c.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, authorIrk(r))))
    }

    @Test fun createWithoutMaxN_isV1ByteIdentical() {
        // A create with no maxN/exp must sign byte-identically to the v1 `create`.
        val r = root()
        val c = r.obj("create")
        val v1 = ServiceInvite.canonicalCreate(
            r.s("inviteId"), authorAidPub(r), r.s("serviceRef"), r.s("secretHash"),
            c.s("encryptedBundlePlaceholder"), c.l("issuedAt"),
        )
        val v1Again = ServiceInvite.canonicalCreate(
            r.s("inviteId"), authorAidPub(r), r.s("serviceRef"), r.s("secretHash"),
            c.s("encryptedBundlePlaceholder"), c.l("issuedAt"), null, null,
        )
        assertEquals(HexUtil.encode(v1), HexUtil.encode(v1Again))
    }

    @Test fun randomInviteId_is64Hex() {
        val id = ServiceInvite.randomInviteId()
        assertTrue(Regex("^[0-9a-f]{64}$").matches(id))
        assertTrue(id != ServiceInvite.randomInviteId())
    }
}
