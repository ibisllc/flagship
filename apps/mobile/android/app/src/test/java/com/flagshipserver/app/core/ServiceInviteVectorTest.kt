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

    @Test fun visitSignatureVerifies() {
        val r = root()
        val v = r.obj("visit")
        val friendAidPub = ServerKeys.deriveAccountIdPub(friendUmk(r))
        val bytes = ServiceInvite.canonicalVisit(r.s("serverId"), r.s("serviceRef"), friendAidPub, v.l("issuedAt"))
        assertTrue(ServiceInvite.verify(HexUtil.decode(v.s("sigHex"))!!, bytes, friendAidPub))
        assertEquals(v.s("sigHex"), HexUtil.encode(ServiceInvite.sign(bytes, friendAid(r))))
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
}
