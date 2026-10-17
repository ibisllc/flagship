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

    private class Keys(val umkSeed: ByteArray, val irk: ByteArray, val adminSeed: ByteArray? = ByteArray(32) { (irk[0] + 40).toByte() }) : ShareKeys {
        val reasons = ArrayList<String>()
        val adminPubHex: String? = adminSeed?.let { HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(it).publicKey) }
        override suspend fun umk(reason: String): ByteArray = umkSeed.also { reasons += reason }
        override suspend fun sensitive(reason: String): Ed25519Sign = Ed25519Sign(irk).also { reasons += reason }
        override suspend fun accountKey(reason: String): Ed25519Sign = Ed25519Sign(irk)
        override suspend fun irkSeed(reason: String): ByteArray = irk
        override fun adminRootPubHex(): String? = adminPubHex
        override suspend fun adminRoot(reason: String): Ed25519Sign = Ed25519Sign(adminSeed!!).also { reasons += "admin: $reason" }
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
        val pushRows = HashMap<String, MutableMap<String, String>>()
        var updates = ArrayList<ServerShare.Update>()
        val usedUpdateNonces = HashSet<String>()
        var boxCommit = "1".repeat(40)
        /** The admin root `.com` attests for "bob" (the member account). */
        var bobAdminPubHex: String? = memberKeys.adminPubHex
        val demoSigned = ArrayList<ServerShare.AcceptAdmin>()

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
            val share = Regex("$apex/api/server-shares/([0-9a-f]{32})(/accept|/leave|/push)?").matchEntire(url)
            val revoke = Regex("$apex/api/users/alice/server-shares/([0-9a-f]{32})/(revoke|unlock)").matchEntire(url)
            return when {
                url == "$apex/api/users/bob/account-key-attestation" -> {
                    val key = bobAdminPubHex ?: return err(404, "username not registered")
                    ok(buildJsonObject {
                        put("attestation", buildJsonObject {
                            put("kind", "AccountKeyAttestation"); put("version", 1); put("keyKind", "admin-root"); put("keyPubHex", key)
                            put("issuedAt", clock - 1000); put("expiresAt", clock + 14 * 86_400_000L)
                            put("signedBy", "ca".repeat(32)); put("signature", "00".repeat(64))
                        })
                    })
                }
                url == "$apex/api/dev/sample-user/bob/share-accept" -> {
                    val admit = ServerShare.parseServerShareAcceptAdmin(b!!["admit"]) ?: return err(400, "malformed")
                    demoSigned += admit
                    ok(buildJsonObject { put("signature", ServerShare.signHex(admit, Ed25519Sign(memberKeys.adminSeed!!))) })
                }
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
                        "/push" -> {
                            if (row["ended"] == true) return err(410, "share ended")
                            val p = ServerShare.parseServerSharePush(b!!["push"]) ?: return err(400, "malformed push")
                            if (!ServerShare.verify(p, sig(b), HexUtil.decode(p.memberPubHex)!!)) return err(403, "invalid signature")
                            val id = share.groupValues[1]
                            val member = held[id]?.memberPubHex
                            if (unlockCopy?.first != id || member != p.memberPubHex) return err(403, "unlock-not-shared")
                            val rows = pushRows.getOrPut(id) { mutableMapOf() }
                            if (p.op == ServerShare.OP_PUT) {
                                val token = b["providerToken"]?.jsonPrimitive?.content ?: return err(400, "providerToken required")
                                if (ServerShare.shareSha256Hex(token) != p.tokenSha256) return err(403, "token is not the one that was signed")
                                rows[p.tokenSha256] = "${p.platform}|$token"
                                ok(buildJsonObject { put("ok", true); put("push", true) })
                            } else {
                                rows.remove(p.tokenSha256)
                                ok(buildJsonObject { put("ok", true); put("push", false) })
                            }
                        }
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
                        // Only an admin device of the joining account accepts (the box's acceptAdmin.ts).
                        val proof = ServerShare.parseShareAcceptAdminProof(b["acceptAdmin"])
                            ?: return 403 to buildJsonObject {
                                put("error", "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device.")
                                put("code", "accept-not-admin")
                            }
                        val ad = proof.admit
                        if (ad.shareId != a.shareId || ad.memberPubHex != a.memberPubHex || ad.acceptedAt != a.acceptedAt ||
                            ad.keyPubHex != proof.attestation.keyPubHex || !ServerShare.verify(ad, HexUtil.decode(proof.signature)!!, HexUtil.decode(ad.keyPubHex)!!)
                        ) return err(403, "accept-signature")
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
                url == "https://$domain/api/shares/me" -> {
                    val g = held.values.firstOrNull() ?: return err(401, "share-session")
                    ok(buildJsonObject {
                        put("shareId", g.shareId); put("level", g.level); put("unlockAtBoot", g.unlockAtBoot)
                        put("seeAppData", g.seeAppData); put("serverDomain", domain); put("canUpdate", g.level == ServerShare.LEVEL_MANAGE)
                    })
                }
                url == "https://$domain/api/shares/update" -> {
                    if (h[ServerShareClient.SESSION_HEADER]?.startsWith("fss_") != true) return err(401, "share-session")
                    val u = ServerShare.parseServerShareUpdate(b!!["update"]) ?: return err(400, "malformed")
                    val g = held[u.shareId] ?: return err(401, "share-session")
                    if (g.level != ServerShare.LEVEL_MANAGE) return err(403, "manage-only")
                    if (g.memberPubHex != u.memberPubHex) return err(403, "not-this-share")
                    if (!ServerShare.verify(u, sig(b), HexUtil.decode(u.memberPubHex)!!)) return err(403, "invalid-signature")
                    if (u.fromCommit != boxCommit) return 409 to buildJsonObject { put("error", "from-commit-mismatch"); put("code", "from-commit-mismatch") }
                    if (!usedUpdateNonces.add(u.nonce)) return 409 to buildJsonObject { put("error", "replayed-nonce"); put("code", "replayed-nonce") }
                    updates += u
                    202 to buildJsonObject { put("ok", true); put("accepted", true); put("targetCommit", u.targetCommit) }
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

    private fun client(world: World, keys: ShareKeys, pushToken: Pair<String, String>? = null, pushStore: SharePushStore = InMemorySharePushStore()): ServerShareClient {
        val t = world.transport()
        var n = 0
        return ServerShareClient(
            apex = t, box = t, keys = keys,
            apexBase = { apex }, bootBase = { boot },
            now = { clock },
            random = { size -> ByteArray(size) { (it + 31 * ++n).toByte() } },
            pushStore = pushStore,
            pushToken = { pushToken },
            account = { ShareAccount(if (keys === ownerKeys) "alice" else "bob", isDemo = demo) },
        )
    }

    /** The member account is a demo account (its devices hold no admin root). */
    private var demo = false

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
        // Bob's admin device signed #12 with its admin root, behind the UMK's biometric.
        val proof = ServerShare.parseShareAcceptAdminProof(grantCall.body["acceptAdmin"])!!
        assertEquals(memberKeys.adminPubHex, proof.admit.keyPubHex)
        assertEquals(ServerShare.KEY_KIND_ADMIN_ROOT, proof.admit.keyKind)
        assertTrue(ServerShare.verify(proof.admit, HexUtil.decode(proof.signature)!!, HexUtil.decode(memberKeys.adminPubHex!!)!!))
        assertTrue(memberKeys.reasons.any { it.startsWith("admin: ") })
        assertEquals("owner-session", grantCall.headers[ServerShareClient.SESSION_HEADER])

        val signedIn = member.signIn(entry, reuse = false)
        assertTrue(signedIn is ShareSignIn.In)
        assertEquals(ServerShare.LEVEL_MANAGE, (signedIn as ShareSignIn.In).session.level)

        val after = owner.ownerShares("alice", domain, "owner-session")
        assertEquals("Sam", after.active.single().label)
        assertTrue(after.accepted.isEmpty())

        assertEquals(entry.shareId, member.inbox().single().shareId)
    }

    @Test fun aNonAdminDeviceCantAccept() = runBlocking {
        val world = World()
        val created = client(world, ownerKeys).createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        val phone = Keys(memberKeys.umkSeed, memberKeys.irk, adminSeed = null)
        val member = client(world, phone)
        try {
            member.accept(member.open(ServerShare.parseShareLink(created.link)!!))
            fail("a non-admin device must not accept")
        } catch (e: ShareException) {
            assertEquals(ShareException.Kind.NotAdmin, e.kind)
            assertEquals("Only an admin device of your account can accept a co-manage invitation.", e.message)
        }
        assertTrue("no prompt, nothing posted", phone.reasons.isEmpty())
        assertTrue(world.calls.none { it.url.endsWith("/accept") || it.url.endsWith("/account-key-attestation") })
    }

    @Test fun aStaleAdminRootIsNoAdmin() = runBlocking {
        val world = World()
        val created = client(world, ownerKeys).createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        world.bobAdminPubHex = "ee".repeat(32)
        val member = client(world, memberKeys)
        try {
            member.accept(member.open(ServerShare.parseShareLink(created.link)!!))
            fail("an admin root the account no longer pins must not accept")
        } catch (e: ShareException) {
            assertEquals(ShareException.Kind.NotAdmin, e.kind)
        }
        assertTrue(world.calls.none { it.url.endsWith("/accept") })
    }

    @Test fun aDemoAccountsAcceptanceIsSignedByComsDemoSigner() = runBlocking {
        val world = World()
        val owner = client(world, ownerKeys)
        val created = owner.createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        demo = true
        val phone = Keys(memberKeys.umkSeed, memberKeys.irk, adminSeed = null)
        val member = client(world, phone)
        member.accept(member.open(ServerShare.parseShareLink(created.link)!!))
        assertEquals(created.shareId, world.demoSigned.single().shareId)
        assertTrue(phone.reasons.none { it.startsWith("admin: ") })
        demo = false
        owner.confirm("alice", domain, "owner-session", owner.ownerShares("alice", domain, "owner-session").accepted.single())
        assertEquals(created.shareId, world.held.keys.single())
    }

    @Test fun theOwnerSeesTheBoxsSentenceForAnAcceptanceWithoutProof() = runBlocking {
        val world = World()
        val owner = client(world, ownerKeys)
        val created = owner.createOffer("alice", domain, "Home", HexUtil.encode(stkPub), options)
        val member = client(world, memberKeys)
        member.accept(member.open(ServerShare.parseShareLink(created.link)!!))
        val accepted = owner.ownerShares("alice", domain, "owner-session").accepted.single()
        assertNotNull(accepted.acceptAdmin)
        try {
            owner.confirm("alice", domain, "owner-session", accepted.copy(acceptAdmin = null))
            fail("the server refuses an acceptance with no admin proof")
        } catch (e: ShareException) {
            assertEquals(
                "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device.",
                e.message,
            )
        }
        assertTrue(world.held.isEmpty())
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

    @Test fun startupNoticesRegisterAndDropThisDevicesToken() {
        val world = World()
        val (_, _, entry) = shareAndConfirm(world, options.copy(unlockAtBoot = true))
        val store = InMemorySharePushStore()
        val token = "fcm-token-for-this-phone"
        val member = client(world, memberKeys, "fcm" to token, store)
        runBlocking {
            assertFalse(member.startupNotices(entry.shareId))
            member.setStartupNotices(entry, on = true)
            val put = world.calls.last { it.url == "$apex/api/server-shares/${entry.shareId}/push" }
            assertNotNull(put.headers[ServerShareClient.SHARE_TOKEN_HEADER])
            assertEquals(token, put.body!!["providerToken"]!!.jsonPrimitive.content)
            val p = ServerShare.parseServerSharePush(put.body["push"])!!
            assertEquals(ServerShare.OP_PUT, p.op)
            assertEquals("fcm", p.platform)
            assertEquals(ServerShare.shareSha256Hex(token), p.tokenSha256)
            assertEquals(HexUtil.encode(ServerShare.deriveShareMemberPub(memberKeys.umkSeed, entry.shareId)), p.memberPubHex)
            assertTrue(member.startupNotices(entry.shareId))
            assertEquals(1, world.pushRows.getValue(entry.shareId).size)

            member.setStartupNotices(entry, on = false)
            val del = world.calls.last { it.url == "$apex/api/server-shares/${entry.shareId}/push" }
            val d = ServerShare.parseServerSharePush(del.body!!["push"])!!
            assertEquals(ServerShare.OP_DELETE, d.op)
            assertEquals(p.tokenSha256, d.tokenSha256)
            assertEquals(null, del.body["providerToken"])
            assertFalse(member.startupNotices(entry.shareId))
            assertTrue(world.pushRows.getValue(entry.shareId).isEmpty())
        }
    }

    @Test fun startupNoticesNeedTheOwnersUnlockCopyAndAToken() {
        val world = World()
        val (_, _, entry) = shareAndConfirm(world)
        runBlocking {
            try {
                client(world, memberKeys, "fcm" to "t").setStartupNotices(entry, on = true)
                fail("no unlock copy must refuse")
            } catch (e: ShareException) {
                assertEquals(ShareException.Kind.NotShared, e.kind)
                assertEquals(ServerShareClient.NOTICES_NOT_SHARED, e.message)
            }
            try {
                client(world, memberKeys, null).setStartupNotices(entry, on = true)
                fail("no push token must refuse")
            } catch (e: ShareException) {
                assertEquals(ServerShareClient.NOTICES_NO_TOKEN, e.message)
            }
        }
    }

    @Test fun leavingForgetsTheNoticeRegistration() {
        val world = World()
        val (_, _, entry) = shareAndConfirm(world, options.copy(unlockAtBoot = true))
        val store = InMemorySharePushStore()
        val member = client(world, memberKeys, "fcm" to "t", store)
        runBlocking {
            member.setStartupNotices(entry, on = true)
            assertNotNull(store.get(entry.shareId))
            member.leave(entry)
            assertEquals(null, store.get(entry.shareId))
        }
    }

    @Test fun aCoManagerOrdersAnUpdateSignedWithItsMemberKey() {
        val world = World()
        val (_, member, entry) = shareAndConfirm(world)
        runBlocking {
            assertTrue(member.me(entry)!!.canUpdate)
            val target = "2".repeat(40)
            member.orderUpdate(entry, target, world.boxCommit)
            val call = world.calls.last { it.url == "https://$domain/api/shares/update" }
            assertTrue(call.headers[ServerShareClient.SESSION_HEADER]!!.startsWith("fss_"))
            val u = world.updates.single()
            assertEquals(target, u.targetCommit)
            assertEquals(world.boxCommit, u.fromCommit)
            assertEquals(64, u.nonce.length)
            assertEquals(entry.shareId, u.shareId)
            val memberPub = ServerShare.deriveShareMemberPub(memberKeys.umkSeed, entry.shareId)
            assertTrue(ServerShare.verify(u, HexUtil.decode(call.body!!["signature"]!!.jsonPrimitive.content)!!, memberPub))
            assertFalse(ServerShare.verify(u, HexUtil.decode(call.body["signature"]!!.jsonPrimitive.content)!!, ownerPub))

            try {
                member.orderUpdate(entry, target, "3".repeat(40))
                fail("a stale base must be refused")
            } catch (e: ShareException) {
                assertEquals("The server changed version. Refresh and try again.", e.message)
            }
        }
    }

    @Test fun aViewerCantOrderAnUpdate() {
        val world = World()
        val (_, member, entry) = shareAndConfirm(world, options.copy(level = ServerShare.LEVEL_VIEW))
        runBlocking {
            assertFalse(member.me(entry)!!.canUpdate)
            try {
                member.orderUpdate(entry, "2".repeat(40), world.boxCommit)
                fail("view level must be refused")
            } catch (e: ShareException) {
                assertEquals("Only someone who can manage this server can update it.", e.message)
            }
            assertTrue(world.updates.isEmpty())
        }
    }

    @Test fun updateRefusalsReadPlainly() {
        assertEquals("An update is already underway.", ServerShareClient.updateRefusalText("busy", "x"))
        assertEquals("An update is already underway.", ServerShareClient.updateRefusalText("pending-verify", "x"))
        assertEquals("Your device's clock looks off. Check it and try again.", ServerShareClient.updateRefusalText("stale", "x"))
        assertEquals("the server said no", ServerShareClient.updateRefusalText("wrong-domain", "the server said no"))
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
