// The share-a-server client flows (docs/share-a-server.md §9) against a fake
// .com, box and boot worker that check what the real ones check.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest

class ServerShareClientFlowTest {
    private val domain = "home.alice.flagship.services"
    private val apex = "https://flagshipserver.com"
    private val boot = "https://boot.flagshipserver.com"
    private var clock = 1_800_000_000_000L

    private class Keys(val umkSeed: ByteArray, val irk: ByteArray) : ShareKeys {
        val reasons = ArrayList<String>()
        override suspend fun umk(reason: String): ByteArray = umkSeed.also { reasons += reason }
        override suspend fun sensitive(reason: String): Ed25519Sign = Ed25519Sign(irk).also { reasons += reason }
        override suspend fun accountKey(reason: String): Ed25519Sign = Ed25519Sign(irk)
        override suspend fun irkSeed(reason: String): ByteArray = irk
    }

    private val ownerKeys = Keys(ByteArray(32) { 1 }, ByteArray(32) { 2 })
    private val memberKeys = Keys(ByteArray(32) { 3 }, ByteArray(32) { 4 })
    private val ownerPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(ownerKeys.irk).publicKey
    private val stkSeed = ByteArray(32) { 9 }
    private val stkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(stkSeed).publicKey
    private val diskKey = ByteArray(32) { 7 }

    data class Call(val method: String, val url: String, val body: JsonObject?, val headers: Map<String, String>)

    /** One fake world: `.com` rows + inbox, the box's held grants, the boot worker. */
    inner class World {
        val calls = ArrayList<Call>()
        val rows = HashMap<String, MutableMap<String, Any?>>()
        val inbox = LinkedHashMap<String, String>()
        val held = HashMap<String, ServerShare.Grant>()
        val ended = HashSet<String>()
        val nonces = HashSet<String>()
        var unlockCopy: Pair<String, String>? = null
        var pending: List<JsonObject> = emptyList()
        var bootResponse: JsonObject? = null

        fun transport(): JsonHttpTransport = object : JsonHttpTransport {
            override val json: Json = ServerShareClient.json
            override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
                val obj = body?.let { Json.parseToJsonElement(String(it)).jsonObject }
                calls += Call(method, url, obj, extraHeaders)
                val (status, out) = handle(method, url, obj, extraHeaders)
                return HttpResponse(status, out.toString().toByteArray(), emptyMap())
            }
            override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
            override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
            override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
            override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        }

        private fun ok(o: JsonElement = buildJsonObject { put("ok", true) }) = 200 to o
        private fun err(s: Int, e: String) = s to buildJsonObject { put("error", e); put("code", e) }
        private fun sig(o: JsonObject?) = HexUtil.decode(o!!["signature"]!!.jsonPrimitive.content)!!
        private fun tokenOk(row: Map<String, Any?>, h: Map<String, String>): Boolean {
            val t = h[ServerShareClient.SHARE_TOKEN_HEADER] ?: return false
            return HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(HexUtil.decode(t)!!)) == row["tokenHash"]
        }

        private fun handle(m: String, url: String, b: JsonObject?, h: Map<String, String>): Pair<Int, JsonElement> {
            val share = Regex("$apex/api/server-shares/([0-9a-f]{32})(/accept|/leave)?").matchEntire(url)
            val revoke = Regex("$apex/api/users/alice/server-shares/([0-9a-f]{32})/(revoke|unlock)").matchEntire(url)
            return when {
                url == "$apex/api/users/alice/server-shares" -> {
                    val offer = ServerShare.parseServerShareOffer(b!!["offer"])!!
                    if (!ServerShare.verify(offer, sig(b), ownerPub)) return err(403, "invalid signature")
                    if (ServerShare.shareSha256Hex(b["offerHex"]!!.jsonPrimitive.content) != offer.offerSha256) return err(403, "bad")
                    rows[offer.shareId] = mutableMapOf(
                        "serverDomain" to offer.serverDomain, "tokenHash" to offer.tokenHash,
                        "offer" to b["offerHex"]!!.jsonPrimitive.content, "owner" to b["ownerHex"]!!.jsonPrimitive.content,
                        "acceptance" to null, "ended" to false, "expiresAt" to offer.expiresAt,
                    )
                    ok()
                }
                url == "$apex/api/users/alice/server-shares/list" -> {
                    val list = ServerShare.parseServerShareList(b!!["list"])!!
                    if (!ServerShare.verify(list, sig(b), ownerPub)) return err(403, "invalid signature")
                    ok(buildJsonObject {
                        put("shares", buildJsonArray {
                            rows.forEach { (id, r) ->
                                add(buildJsonObject {
                                    put("shareId", id); put("serverDomain", r["serverDomain"] as String)
                                    put("state", if (r["ended"] == true) "ended" else if (r["acceptance"] != null) "accepted" else "offered")
                                    put("owner", r["owner"] as String); (r["acceptance"] as String?)?.let { put("acceptance", it) }
                                    put("expiresAt", r["expiresAt"] as Long); put("unlock", unlockCopy?.first == id)
                                })
                            }
                        })
                    })
                }
                revoke != null && revoke.groupValues[2] == "revoke" -> {
                    val r = ServerShare.parseServerShareRevoke(b!!["revoke"])!!
                    if (!ServerShare.verify(r, sig(b), ownerPub)) return err(403, "invalid signature")
                    val row = rows[revoke.groupValues[1]] ?: return err(404, "no such share")
                    row["ended"] = true
                    ok()
                }
                revoke != null -> {
                    val u = ServerShare.parseServerShareUnlock(b!!["unlock"])!!
                    if (!ServerShare.verify(u, sig(b), ownerPub)) return err(403, "invalid signature")
                    val sealed = b["sealedKey"]?.jsonPrimitive?.content
                    if (sealed != null && ServerShare.shareSha256Hex(sealed) != u.sealedSha256) return err(403, "bad copy")
                    unlockCopy = sealed?.let { revoke.groupValues[1] to it }
                    ok()
                }
                url == "$apex/api/server/$domain/sealed-luks-key" ->
                    ok(buildJsonObject { put("sealedKey", HexUtil.encode(SecretSeal.sealForEd25519Recipient(diskKey, ownerPub))) })
                share != null -> {
                    val row = rows[share.groupValues[1]] ?: return err(404, "no such share")
                    if (!tokenOk(row, h)) return err(404, "no such share")
                    when (share.groupValues[2]) {
                        "" -> ok(buildJsonObject {
                            put("shareId", share.groupValues[1]); put("serverDomain", row["serverDomain"] as String)
                            put("state", if (row["ended"] == true) "ended" else if (row["acceptance"] != null) "accepted" else "offered")
                            put("offer", row["offer"] as String); (row["acceptance"] as String?)?.let { put("acceptance", it) }
                            put("unlock", unlockCopy?.first == share.groupValues[1])
                        })
                        "/accept" -> if (row["acceptance"] != null) err(409, "this link was already used") else {
                            row["acceptance"] = b!!["acceptance"]!!.jsonPrimitive.content
                            ok()
                        }
                        else -> {
                            val l = ServerShare.parseServerShareLeave(b!!["leave"])!!
                            if (!ServerShare.verify(l, sig(b), HexUtil.decode(l.memberPubHex)!!)) return err(403, "invalid signature")
                            row["ended"] = true
                            ok()
                        }
                    }
                }
                url == "$apex/api/share-inbox" -> {
                    val r = ServerShare.parseShareInboxRequest(b!!["request"])!!
                    if (!ServerShare.verify(r, sig(b), HexUtil.decode(r.inboxPubHex)!!)) return err(403, "invalid signature")
                    when (r.op) {
                        ServerShare.OP_PUT -> {
                            inbox[r.entryId] = b["ct"]!!.jsonPrimitive.content
                            ok()
                        }
                        ServerShare.OP_DELETE -> {
                            inbox.remove(r.entryId)
                            ok()
                        }
                        else -> ok(buildJsonObject {
                            put("entries", buildJsonArray { inbox.forEach { (id, ct) -> add(buildJsonObject { put("entryId", id); put("ct", ct) }) } })
                        })
                    }
                }
                url == "https://$domain/api/screens/shares" && m == "GET" -> ok(buildJsonObject {
                    put("shares", buildJsonArray {
                        held.values.forEach { g ->
                            add(buildJsonObject {
                                put("shareId", g.shareId); put("label", g.label); put("level", g.level)
                                put("unlockAtBoot", g.unlockAtBoot); put("seeAppData", g.seeAppData)
                                put("memberPubHex", g.memberPubHex); put("issuedAt", g.issuedAt)
                            })
                        }
                    })
                    put("ended", buildJsonArray {})
                })
                url == "https://$domain/api/screens/shares" -> {
                    if (h[ServerShareClient.SESSION_HEADER] != "owner-session") return err(401, "session")
                    val g = ServerShare.parseServerShareGrant(b!!["grant"])!!
                    if (!ServerShare.verify(g, sig(b), ownerPub)) return err(403, "invalid signature")
                    if (g.shareId !in held) {
                        val a = ServerShare.parseServerShareAccept(b["accept"]) ?: return err(400, "first grant needs the acceptance")
                        val aSig = HexUtil.decode(b["acceptSignature"]!!.jsonPrimitive.content)!!
                        if (a.memberPubHex != g.memberPubHex || !ServerShare.verify(a, aSig, HexUtil.decode(a.memberPubHex)!!)) return err(403, "bad acceptance")
                    }
                    held[g.shareId] = g
                    ok()
                }
                url == "https://$domain/api/screens/shares/revoke" -> {
                    val r = ServerShare.parseServerShareRevoke(b!!["revoke"])!!
                    if (!ServerShare.verify(r, sig(b), ownerPub)) return err(403, "invalid signature")
                    held.remove(r.shareId)
                    ended += r.shareId
                    ok()
                }
                url == "https://$domain/api/shares/nonce" -> {
                    val n = HexUtil.encode(ByteArray(32) { nonces.size.toByte() })
                    nonces += n
                    ok(buildJsonObject { put("nonce", n) })
                }
                url == "https://$domain/api/shares/session" -> {
                    val s = ServerShare.parseServerShareSession(b!!["session"])!!
                    if (!nonces.remove(s.nonceHex)) return err(403, "unknown or used nonce")
                    if (!ServerShare.verify(s, sig(b), HexUtil.decode(s.memberPubHex)!!)) return err(403, "invalid signature")
                    if (s.shareId in ended) return err(403, "share-ended")
                    val g = held[s.shareId]?.takeIf { it.memberPubHex == s.memberPubHex } ?: return err(403, "not-shared")
                    ok(buildJsonObject {
                        put("token", "fss_" + "a".repeat(64)); put("expiresAt", clock + 12 * 3600_000L)
                        put("level", g.level); put("unlockAtBoot", g.unlockAtBoot); put("seeAppData", g.seeAppData)
                    })
                }
                url == "https://$domain/api/shares/leave" -> {
                    val l = ServerShare.parseServerShareLeave(b!!["leave"])!!
                    if (!ServerShare.verify(l, sig(b), HexUtil.decode(l.memberPubHex)!!)) return err(403, "invalid signature")
                    held.remove(l.shareId)
                    ended += l.shareId
                    ok()
                }
                url == "$boot/api/boot/share/pending/$domain" -> ok(buildJsonObject {
                    put("requests", buildJsonArray { pending.forEach { add(it) } })
                })
                url == "$boot/api/boot/share/key/$domain" -> {
                    val copy = unlockCopy ?: return err(404, "no copy for this share")
                    ok(buildJsonObject { put("sealedKey", copy.second) })
                }
                url == "$boot/api/boot/response" -> {
                    bootResponse = b!!["response"]!!.jsonObject
                    ok()
                }
                else -> err(404, "unrouted $m $url")
            }
        }
    }

    private fun client(world: World, keys: ShareKeys): ServerShareClient {
        val t = world.transport()
        var n = 0
        return ServerShareClient(
            apex = t, box = t, keys = keys,
            apexBase = { apex }, bootBase = { boot },
            now = { clock },
            random = { size -> ByteArray(size) { (it + 31 * ++n).toByte() } },
        )
    }

    private fun bootRequest(seed: ByteArray, nonce: String): JsonObject {
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        val sig = Ed25519Sign(seed).sign(SecretRequest.canonicalBytes(domain, pub, SecretPurpose.UNLOCK_KEY, nonce, clock))
        return buildJsonObject {
            put("request", buildJsonObject {
                put("serverDomain", domain); put("stkPub", pub); put("purpose", "unlock-key"); put("nonce", nonce); put("issuedAt", clock)
            })
            put("signature", HexUtil.encode(sig))
            put("expiresAt", clock + 600_000)
        }
    }

    private val options = ShareOptions("Sam", ServerShare.LEVEL_MANAGE, unlockAtBoot = false, seeAppData = false)

    /** Owner shares, member accepts, owner confirms: returns the member's inbox entry. */
    private fun shareAndConfirm(world: World, opts: ShareOptions = options): Triple<ServerShareClient, ServerShareClient, SharedEntry> = runBlocking {
        val owner = client(world, ownerKeys)
        val member = client(world, memberKeys)
        val created = owner.createOffer("alice", domain, "Home", HexUtil.encode(stkPub), opts)
        val link = ServerShare.parseShareLink(created.link)!!
        val opened = member.open(link)
        val (entry, memberSas) = member.accept(opened)
        val shares = owner.ownerShares("alice", domain, "owner-session")
        val accepted = shares.accepted.single()
        assertEquals(memberSas, accepted.sas)
        owner.confirm("alice", domain, "owner-session", accepted)
        Triple(owner, member, entry)
    }

    @Test fun ownerCreateMemberAcceptOwnerConfirm() = runBlocking {
        val world = World()
        val owner = client(world, ownerKeys)
        val member = client(world, memberKeys)

        val created = owner.createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        assertTrue(created.link.startsWith("$apex/share#s=${created.shareId}&k="))
        assertEquals(1, world.rows.size)

        val opened = member.open(ServerShare.parseShareLink(created.link)!!)
        assertEquals("Home", opened.offer.serverName)
        assertEquals(ServerShare.LEVEL_MANAGE, opened.offer.level)
        assertEquals(HexUtil.encode(stkPub), opened.offer.stkPubHex)

        val (entry, memberSas) = member.accept(opened)
        assertEquals(6, memberSas.length)
        assertEquals(1, world.inbox.size)
        assertEquals(entry.entryId, world.inbox.keys.single())

        val before = owner.ownerShares("alice", domain, "owner-session")
        assertTrue(before.active.isEmpty())
        assertTrue(before.pending.isEmpty())
        val accepted = before.accepted.single()
        assertEquals("Sam", accepted.label)
        assertEquals(memberSas, accepted.sas)

        assertEquals(ShareSignIn.Waiting, member.signIn(entry, reuse = false))

        owner.confirm("alice", domain, "owner-session", accepted)
        val grantCall = world.calls.last { it.url == "https://$domain/api/screens/shares" && it.method == "POST" }
        val grant = ServerShare.parseServerShareGrant(grantCall.body!!["grant"])!!
        val memberPub = HexUtil.encode(ServerShare.deriveShareMemberPub(memberKeys.umkSeed, created.shareId))
        assertEquals(memberPub, grant.memberPubHex)
        assertEquals("Sam", grant.label)
        assertEquals(ServerShare.LEVEL_MANAGE, grant.level)
        assertTrue(ServerShare.verify(grant, HexUtil.decode(grantCall.body["signature"]!!.jsonPrimitive.content)!!, ownerPub))
        assertNotNull(grantCall.body["accept"])
        assertNotNull(grantCall.body["acceptSignature"])
        assertEquals("owner-session", grantCall.headers[ServerShareClient.SESSION_HEADER])

        val signedIn = member.signIn(entry, reuse = false)
        assertTrue(signedIn is ShareSignIn.In)
        assertEquals(ServerShare.LEVEL_MANAGE, (signedIn as ShareSignIn.In).session.level)

        val after = owner.ownerShares("alice", domain, "owner-session")
        assertEquals("Sam", after.active.single().label)
        assertTrue(after.accepted.isEmpty())

        assertEquals(entry.shareId, member.inbox().single().shareId)
    }

    @Test fun pendingOfferShowsLinkAndCancelIsComOnly() = runBlocking {
        val world = World()
        val owner = client(world, ownerKeys)
        val created = owner.createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        val pending = owner.ownerShares("alice", domain, "owner-session").pending.single()
        assertEquals(created.link, pending.link)
        world.calls.clear()
        owner.cancel("alice", domain, pending.shareId, pending.label)
        assertEquals(listOf("$apex/api/users/alice/server-shares/${created.shareId}/revoke"), world.calls.map { it.url })
        assertTrue(owner.ownerShares("alice", domain, "owner-session").pending.isEmpty())
    }

    @Test fun aSecondAcceptanceIsRefused() = runBlocking {
        val world = World()
        val owner = client(world, ownerKeys)
        val created = owner.createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        val link = ServerShare.parseShareLink(created.link)!!
        client(world, memberKeys).accept(client(world, memberKeys).open(link))
        val thief = client(world, Keys(ByteArray(32) { 5 }, ByteArray(32) { 6 }))
        try {
            thief.accept(thief.open(link))
            fail("a second acceptance must be refused")
        } catch (e: ShareException) {
            assertEquals(ShareException.Kind.AlreadyUsed, e.kind)
        }
    }

    @Test fun revokeHitsTheBoxAndCom() {
        val world = World()
        val (owner, member, entry) = shareAndConfirm(world)
        runBlocking {
            world.calls.clear()
            owner.remove("alice", domain, "owner-session", entry.shareId, "Sam")
            val urls = world.calls.map { it.method + " " + it.url }
            assertTrue(urls.contains("POST https://$domain/api/screens/shares/revoke"))
            assertTrue(urls.contains("POST $apex/api/users/alice/server-shares/${entry.shareId}/revoke"))
            assertEquals(ShareSignIn.Ended, member.signIn(entry, reuse = false))
        }
    }

    @Test fun leaveHitsTheBoxComAndInbox() {
        val world = World()
        val (_, member, entry) = shareAndConfirm(world)
        runBlocking {
            world.calls.clear()
            member.leave(entry)
            val leaveBox = world.calls.single { it.url == "https://$domain/api/shares/leave" }
            val leaveCom = world.calls.single { it.url == "$apex/api/server-shares/${entry.shareId}/leave" }
            assertEquals(leaveBox.body!!["leave"], leaveCom.body!!["leave"])
            assertNotNull(leaveCom.headers[ServerShareClient.SHARE_TOKEN_HEADER])
            assertTrue(world.inbox.isEmpty())
            assertTrue(world.held.isEmpty())
        }
    }

    @Test fun changeResignsWithALaterGrant() {
        val world = World()
        val (owner, _, entry) = shareAndConfirm(world)
        runBlocking {
            val first = world.held.getValue(entry.shareId)
            val active = owner.ownerShares("alice", domain, "owner-session").active.single()
            owner.change("alice", domain, "owner-session", active, ServerShare.LEVEL_VIEW, active.unlockAtBoot, seeAppData = true)
            val second = world.held.getValue(entry.shareId)
            assertEquals(ServerShare.LEVEL_VIEW, second.level)
            assertTrue(second.seeAppData)
            assertTrue(second.issuedAt > first.issuedAt)
            assertEquals(first.memberPubHex, second.memberPubHex)
        }
    }

    @Test fun startupApprovalUsesTheOffersStkAndRefusesAnother() {
        val world = World()
        val (_, member, entry) = shareAndConfirm(world, options.copy(unlockAtBoot = true))
        runBlocking {
            assertNotNull(world.unlockCopy)
            assertTrue(world.held.getValue(entry.shareId).unlockAtBoot)

            val impostorSeed = ByteArray(32) { 8 }
            val nonceA = "ab".repeat(32)
            val nonceB = "cd".repeat(32)
            world.pending = listOf(bootRequest(impostorSeed, nonceA))
            assertTrue(member.pendingStartups(entry).isEmpty())

            val forged = ServerShareClient.json.decodeFromString(BootSharePending.serializer(), bootRequest(impostorSeed, nonceA).toString())
            try {
                member.approveStartup(entry, ShareStartup(forged))
                fail("a request from another STK must be refused")
            } catch (e: ShareException) {
                assertEquals(ShareException.Kind.Refused, e.kind)
            }
            assertEquals(null, world.bootResponse)

            world.pending = listOf(bootRequest(stkSeed, nonceB))
            val real = member.pendingStartups(entry).single()
            member.approveStartup(entry, real)
            val resp = world.bootResponse!!
            assertEquals(nonceB, resp["requestNonceHex"]!!.jsonPrimitive.content)
            assertEquals("unlock-key", resp["purpose"]!!.jsonPrimitive.content)
            val opened = SecretSeal.openWithEd25519Seed(HexUtil.decode(resp["sealed"]!!.jsonPrimitive.content)!!, stkSeed)
            assertTrue(opened.takeLast(32).toByteArray().contentEquals(diskKey))

            val auth = world.calls.last { it.url == "$boot/api/boot/response" }.headers["Authorization"]!!
            val env = Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(auth.removePrefix("Flagship-Boot-v1 ")))).jsonObject
            assertEquals("share", env["role"]!!.jsonPrimitive.content)
            assertEquals(HexUtil.encode(ServerShare.deriveShareMemberPub(memberKeys.umkSeed, entry.shareId)), env["pubKeyHex"]!!.jsonPrimitive.content)
        }
    }

    @Test fun startupApprovalNeedsTheOwnersUnlockCopy() {
        val world = World()
        val (_, member, entry) = shareAndConfirm(world)
        runBlocking {
            world.pending = listOf(bootRequest(stkSeed, "ef".repeat(32)))
            val real = member.pendingStartups(entry).single()
            try {
                member.approveStartup(entry, real)
                fail("no unlock copy on file must refuse")
            } catch (e: ShareException) {
                assertEquals(ShareException.Kind.NotShared, e.kind)
            }
            assertFalse(world.bootResponse != null)
        }
    }

    @Test fun shareBootHeaderSignsTheCanonicalBytes() {
        val seed = ByteArray(32) { 3 }
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        val header = BootAuth.shareHeader(domain, "get", "/api/boot/share/key/$domain", Ed25519Sign(seed), pub, 42L, ByteArray(32) { 1 })
        val env = Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(header.removePrefix("Flagship-Boot-v1 ")))).jsonObject
        val canon = "flagship/boot-auth/v1|share|$domain|GET|/api/boot/share/key/$domain|$pub|${"01".repeat(32)}|42"
        com.google.crypto.tink.subtle.Ed25519Verify(HexUtil.decode(pub)!!)
            .verify(HexUtil.decode(env["signatureHex"]!!.jsonPrimitive.content)!!, canon.toByteArray())
        assertEquals("GET", env["method"]!!.jsonPrimitive.content)
    }
}
