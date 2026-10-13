// Runs every case in packages/protocol/test-vectors/server-share/vectors.json
// (docs/share-a-server.md), read from disk so a drift fails here.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServerShareVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/server-share/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
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
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private val keys: JsonObject by lazy { root["keys"]!!.jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String): Long = this[k]!!.jsonPrimitive.long
    private fun JsonObject.b(k: String): Boolean = this[k]!!.jsonPrimitive.boolean
    private fun cases(k: String): List<JsonObject> = root[k]!!.jsonArray.map { it.jsonObject }
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!

    private val ownerUmk by lazy { bytes(keys.s("ownerUmkSeedHex")) }
    private val memberUmk by lazy { bytes(keys.s("memberUmkSeedHex")) }
    private val shareId by lazy { keys.s("shareId") }
    private val secret by lazy { bytes(keys.s("secretHex")) }

    private val ownerKey by lazy { ServerKeys.deriveProtocolIrk(ownerUmk) }
    private val ownerPub by lazy { ServerKeys.deriveProtocolIrkPub(ownerUmk) }
    private val memberKey by lazy { ServerShare.deriveShareMemberKey(memberUmk, shareId) }
    private val memberPub by lazy { ServerShare.deriveShareMemberPub(memberUmk, shareId) }
    private val inboxKey by lazy { ServerShare.deriveShareInboxKey(memberUmk) }
    private val inboxPub by lazy { ServerShare.deriveShareInboxPub(memberUmk) }

    private fun signer(name: String): Ed25519Sign = when (name) {
        "owner" -> ownerKey
        "member" -> memberKey
        "inbox" -> inboxKey
        else -> error("unknown signer $name")
    }

    private fun pub(name: String): ByteArray = when (name) {
        "owner" -> ownerPub
        "member" -> memberPub
        "inbox" -> inboxPub
        else -> error("unknown pub $name")
    }

    private fun envelope(kind: String, f: JsonObject): ServerShare.Envelope = when (kind) {
        "grant" -> ServerShare.Grant(
            f.s("serverDomain"), f.s("shareId"), f.s("memberPubHex"), f.s("level"),
            f.b("unlockAtBoot"), f.b("seeAppData"), f.s("label"), f.l("issuedAt"),
        )
        "revoke" -> ServerShare.Revoke(f.s("serverDomain"), f.s("shareId"), f.l("issuedAt"))
        "accept" -> ServerShare.Accept(f.s("serverDomain"), f.s("shareId"), f.s("memberPubHex"), f.l("acceptedAt"))
        "leave" -> ServerShare.Leave(f.s("serverDomain"), f.s("shareId"), f.s("memberPubHex"), f.l("issuedAt"))
        "session" -> ServerShare.Session(
            f.s("serverDomain"), f.s("shareId"), f.s("memberPubHex"), f.s("nonceHex"), f.l("issuedAt"),
        )
        "offer" -> ServerShare.Offer(
            f.s("username"), f.s("serverDomain"), f.s("shareId"), f.s("tokenHash"),
            f.s("offerSha256"), f.s("ownerSha256"), f.l("expiresAt"), f.l("issuedAt"),
        )
        "list" -> ServerShare.ListRequest(f.s("username"), f.l("issuedAt"))
        "unlock" -> ServerShare.Unlock(
            f.s("serverDomain"), f.s("shareId"), f.s("memberPubHex"), f.s("sealedSha256"), f.l("issuedAt"),
        )
        "inbox" -> ServerShare.InboxRequest(
            f.s("inboxPubHex"), f.s("op"), f.s("entryId"), f.s("ctSha256"), f.l("issuedAt"),
        )
        else -> error("unknown kind $kind")
    }

    private fun parse(kind: String, f: JsonObject): ServerShare.Envelope? = when (kind) {
        "grant" -> ServerShare.parseServerShareGrant(f)
        "revoke" -> ServerShare.parseServerShareRevoke(f)
        "accept" -> ServerShare.parseServerShareAccept(f)
        "leave" -> ServerShare.parseServerShareLeave(f)
        "session" -> ServerShare.parseServerShareSession(f)
        "offer" -> ServerShare.parseServerShareOffer(f)
        "list" -> ServerShare.parseServerShareList(f)
        "unlock" -> ServerShare.parseServerShareUnlock(f)
        "inbox" -> ServerShare.parseShareInboxRequest(f)
        else -> error("unknown kind $kind")
    }

    @Test fun keys() {
        assertEquals(keys.s("ownerSignerPub"), HexUtil.encode(ownerPub))
        val other = ServerKeys.deriveProtocolIrkPub(ByteArray(32) { 0x77 })
        assertEquals(keys.s("otherSignerPub"), HexUtil.encode(other))
        assertEquals(keys.s("memberPubHex"), HexUtil.encode(memberPub))
        assertEquals(
            HexUtil.encode(memberPub),
            HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(ServerShare.deriveShareMemberKeySeed(memberUmk, shareId)).publicKey),
        )
        assertEquals(keys.s("inboxPubHex"), HexUtil.encode(inboxPub))
        assertEquals(keys.s("inboxSealKeyHex"), HexUtil.encode(ServerShare.deriveShareInboxSealKey(memberUmk)))
        val token = ServerShare.shareTokenFromSecret(secret)
        assertEquals(keys.s("token"), token)
        assertEquals(keys.s("tokenHash"), ServerShare.shareTokenHash(token))
        assertEquals(keys.s("linkKeyHex"), HexUtil.encode(ServerShare.shareLinkKey(secret)))
        assertEquals(keys.s("householdKeyHex"), HexUtil.encode(ServerKeys.deriveHouseholdKey(ownerUmk)))
        assertEquals(keys.s("householdKeyHex"), HexUtil.encode(ServerShare.deriveShareOwnerRecordKey(ownerUmk)))
        val sas = ServerShare.shareSas(shareId, keys.s("memberPubHex"), secret)
        assertEquals(keys.s("sas"), sas)
        assertEquals(keys.s("sasFormatted"), ServerShare.formatShareSas(sas))
    }

    @Test fun keyInputsAreChecked() {
        assertThrows { ServerShare.deriveShareMemberKeySeed(memberUmk, shareId.uppercase()) }
        assertThrows { ServerShare.shareTokenFromSecret(ByteArray(31)) }
        assertThrows { ServerShare.shareLinkKey(ByteArray(33)) }
        assertThrows { ServerShare.shareTokenHash(keys.s("token").uppercase()) }
        assertThrows { ServerShare.shareSas(shareId, "ab", secret) }
    }

    @Test fun memberKeyDiffersPerShare() {
        val other = "00112233445566778899aabbccddeeff"
        val a = ServerShare.deriveShareMemberPub(memberUmk, shareId)
        val b = ServerShare.deriveShareMemberPub(memberUmk, other)
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(b))
        val c = ServerShare.deriveShareMemberPub(ownerUmk, shareId)
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(c))
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(inboxPub))
    }

    @Test fun envelopes() {
        val all = cases("envelopes")
        assertEquals(13, all.size)
        for (c in all) {
            val kind = c.s("kind")
            val f = c["fields"]!!.jsonObject
            val env = envelope(kind, f)
            assertEquals(c.toString(), c.s("canonical"), String(env.canonicalBytes(), Charsets.UTF_8))
            val sig = ServerShare.signHex(env, signer(c.s("signer")))
            assertEquals(c.toString(), c.s("signature"), sig)
            assertTrue(c.toString(), ServerShare.verify(env, bytes(sig), pub(c.s("signer"))))
            // A signature from any other signer must not verify.
            for (other in listOf("owner", "member", "inbox").filter { it != c.s("signer") }) {
                assertFalse(c.toString(), ServerShare.verify(env, bytes(sig), pub(other)))
            }
            assertEquals(c.toString(), env, parse(kind, f))
        }
    }

    @Test fun refuse() {
        val all = cases("refuse")
        assertTrue(all.isNotEmpty())
        for (c in all) {
            val kind = c.s("kind")
            val f = c["fields"]!!.jsonObject
            val env = envelope(kind, f)
            try {
                env.canonicalBytes()
                fail("built a refused envelope: ${c.s("why")}")
            } catch (_: IllegalArgumentException) {
            }
            assertNull(c.s("why"), parse(kind, f))
            assertFalse(c.s("why"), ServerShare.verify(env, ByteArray(64), ownerPub))
            assertThrows { ServerShare.sign(env, ownerKey) }
        }
    }

    @Test fun reject() {
        val all = cases("reject")
        assertTrue(all.isNotEmpty())
        for (c in all) {
            val env = envelope(c.s("kind"), c["fields"]!!.jsonObject)
            env.canonicalBytes()
            assertFalse(c.s("why"), ServerShare.verify(env, bytes(c.s("signature")), pub(c.s("pub"))))
        }
    }

    @Test fun sealed() {
        val all = cases("sealed")
        assertEquals(4, all.size)
        for (c in all) {
            val key = bytes(c.s("keyHex"))
            val aad = c.s("aad").toByteArray(Charsets.UTF_8)
            val plain = c.s("plaintext")
            val sealed = ServerShare.sealShareJson(key, aad, plain.toByteArray(Charsets.UTF_8), bytes(c.s("nonceHex")))
            assertEquals(c.s("name"), c.s("sealed"), sealed)
            assertEquals(c.s("name"), plain, String(ServerShare.openShareBytes(key, aad, sealed), Charsets.UTF_8))
            val opened = ServerShare.openShareJson(key, aad, c.s("sealed"))
            assertEquals(c.s("name"), Json.parseToJsonElement(plain), opened)

            // AAD built from its parts matches.
            val prefix = c.s("aad").substringBefore('|')
            val id = c.s("aad").substringAfter('|')
            assertTrue(ServerShare.shareAad(prefix, id).contentEquals(aad))

            // The payload parses and re-encodes to the exact same JSON.
            val reencoded = when (c.s("name")) {
                "offer" -> ServerShare.parseShareOfferPayload(opened)!!.toJson()
                "acceptance" -> ServerShare.parseShareAcceptancePayload(opened)!!.toJson()
                "owner" -> ServerShare.parseShareOwnerRecord(opened)!!.toJson()
                "inbox" -> ServerShare.parseShareInboxEntry(opened)!!.toJson()
                else -> error("unknown sealed ${c.s("name")}")
            }
            assertEquals(c.s("name"), plain, reencoded)

            // Wrong AAD, wrong key and a flipped byte all fail to open.
            assertThrows { ServerShare.openShareJson(key, "$prefix|other".toByteArray(), c.s("sealed")) }
            assertThrows { ServerShare.openShareJson(ByteArray(32), aad, c.s("sealed")) }
            val flipped = c.s("sealed").let { s -> s.substring(0, 30) + (if (s[30] == '0') '1' else '0') + s.substring(31) }
            assertThrows { ServerShare.openShareJson(key, aad, flipped) }
            assertThrows { ServerShare.openShareJson(key, aad, c.s("sealed").uppercase()) }
        }
        assertThrows { ServerShare.sealShareJson(ByteArray(31), ByteArray(0), "{}") }
        assertThrows { ServerShare.sealShareJson(ByteArray(32), ByteArray(0), "{}", ByteArray(11)) }
        assertThrows { ServerShare.openShareJson(ByteArray(32), ByteArray(0), "00".repeat(27)) }
        assertThrows { ServerShare.shareAad(ServerShare.AAD_SHARE_OFFER, "a|b") }
    }

    @Test fun acceptancePayloadCarriesAVerifiableAccept() {
        val c = cases("sealed").first { it.s("name") == "acceptance" }
        val payload = ServerShare.parseShareAcceptancePayload(Json.parseToJsonElement(c.s("plaintext")))!!
        assertTrue(ServerShare.verify(payload.accept, bytes(payload.signature), memberPub))
    }

    @Test fun payloadParsersRefuseBadShapes() {
        val offer = Json.parseToJsonElement(cases("sealed").first { it.s("name") == "offer" }.s("plaintext")).jsonObject
        assertNotNull(ServerShare.parseShareOfferPayload(offer))
        assertNull(ServerShare.parseShareOfferPayload(JsonObject(offer + ("v" to Json.parseToJsonElement("2")))))
        assertNull(ServerShare.parseShareOfferPayload(JsonObject(offer + ("level" to Json.parseToJsonElement("\"admin\"")))))
        assertNull(ServerShare.parseShareOfferPayload(JsonObject(offer + ("unlockAtBoot" to Json.parseToJsonElement("\"true\"")))))
        assertNull(ServerShare.parseShareOfferPayload(JsonObject(offer + ("expiresAt" to Json.parseToJsonElement("-1")))))
        assertNull(ServerShare.parseShareOfferPayload(JsonObject(offer + ("expiresAt" to Json.parseToJsonElement("1.5")))))
        assertNull(ServerShare.parseShareOfferPayload(JsonObject(offer + ("serverDomain" to Json.parseToJsonElement("\"\"")))))
        assertNull(ServerShare.parseShareOfferPayload(JsonNull))
        val owner = Json.parseToJsonElement(cases("sealed").first { it.s("name") == "owner" }.s("plaintext")).jsonObject
        assertNull(ServerShare.parseShareOwnerRecord(JsonObject(owner + ("label" to Json.parseToJsonElement("\"a|b\"")))))
    }

    @Test fun labels() {
        assertEquals("Sam", ServerShare.normalizeShareLabel("  Sam　"))
        assertNull(ServerShare.normalizeShareLabel("   "))
        assertEquals("🌹".repeat(64), ServerShare.normalizeShareLabel("🌹".repeat(64)))
        assertNull(ServerShare.normalizeShareLabel("🌹".repeat(65)))
        assertNull(ServerShare.normalizeShareLabel("a\u007fb"))
        assertNull(ServerShare.normalizeShareLabel("\u001cSam"))
    }

    @Test fun links() {
        val links = root["links"]!!.jsonObject
        val build = links["build"]!!.jsonObject
        assertEquals(build.s("link"), ServerShare.buildShareLink(build.s("apex"), build.s("shareId"), bytes(build.s("secretHex"))))
        assertEquals(build.s("link"), ServerShare.buildShareLink(build.s("apex") + "//", build.s("shareId"), bytes(build.s("secretHex"))))
        assertThrows { ServerShare.buildShareLink(build.s("apex"), "ab", bytes(build.s("secretHex"))) }
        val parse = links["parse"]!!.jsonArray.map { it.jsonObject }
        assertTrue(parse.isNotEmpty())
        for (c in parse) {
            val got = ServerShare.parseShareLink(c.s("in"))
            val out = c["out"]
            if (out == null || out is JsonNull) {
                assertNull(c.s("in"), got)
            } else {
                val o = out.jsonObject
                assertEquals(c.s("in"), ServerShare.ShareLink(o.s("shareId"), o.s("secretHex")), got)
            }
        }
        assertEquals(
            ServerShare.ShareLink(shareId, keys.s("secretHex")),
            ServerShare.parseShareLink(ServerShare.buildShareLink("https://flagshipserver.com", shareId, secret)),
        )
    }

    @Test fun randomShareIds() {
        val a = ServerShare.randomShareId()
        assertTrue(Regex("[0-9a-f]{32}").matches(a))
        assertNotEquals(a, ServerShare.randomShareId())
    }

    private fun assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (_: Exception) {
            return
        }
        fail("expected an exception")
    }
}
