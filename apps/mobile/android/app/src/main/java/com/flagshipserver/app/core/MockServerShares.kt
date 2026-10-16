// Share this server with no backend (smoke mode, `flagship.smokeShares`;
// mirror of iOS ServerShareDemo): an in-memory `.com`, boot worker and boxes
// that answer ServerShareClient the way the real ones do, seeded by running
// the real client flows. The phone owns Home: Alex accepted a link (compare
// the code), Sam can manage it. Two servers are shared with the phone:
// Garage (can manage and approve its start-up, which is waiting) and Photos
// (accepted, the owner hasn't confirmed yet). Mina's Studio is offered to the
// phone and not yet accepted ([MockServerShares.STUDIO_LINK]). Accepting needs
// the joining account's admin proof, which this `.com` and these boxes check
// as the real ones do (docs/share-a-server.md §5.1).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.viewmodels.ServerShareRuntime
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.MessageDigest

object MockServerShares {
    const val OWNER_SESSION = "mock-owner-session"
    const val GARAGE_DOMAIN = "garage.jordan-reyes.flagship.services"
    const val PHOTOS_DOMAIN = "photos.mina-park.flagship.services"
    const val STUDIO_DOMAIN = "studio.mina-park.flagship.services"
    /** A link to Mina's Studio the phone hasn't opened yet (the gym types it in). */
    val STUDIO_LINK: String = ServerShare.buildShareLink("https://flagshipserver.com", "5a".repeat(16), ByteArray(32) { 0x5a })

    /** The share runtime the smoke shell provides: [username] owns [homeDomain]. */
    fun runtime(username: String, homeDomain: String, homeStkPubHex: String, memberScreens: ScreensClient): ServerShareRuntime {
        val world = MockShareWorld(username, homeDomain, homeStkPubHex)
        return ServerShareRuntime(
            client = world.client(world.phone),
            memberScreens = { _, _ -> memberScreens },
            ownerSession = { OWNER_SESSION },
        )
    }
}

/** Fixed account keys: an obviously fake UMK, IRK and admin root per account. */
class MockShareKeys(seed: Byte, val username: String) : ShareKeys {
    private val umkSeed = ByteArray(32) { seed }
    val irk = ByteArray(32) { (seed + 1).toByte() }
    val irkPub: ByteArray = Ed25519Sign.KeyPair.newKeyPairFromSeed(irk).publicKey
    private val adminSeed = ByteArray(32) { (seed + 2).toByte() }
    val adminPubHex: String = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(adminSeed).publicKey)
    override suspend fun umk(reason: String): ByteArray = umkSeed
    override suspend fun sensitive(reason: String): Ed25519Sign = Ed25519Sign(irk)
    override suspend fun accountKey(reason: String): Ed25519Sign = Ed25519Sign(irk)
    override suspend fun irkSeed(reason: String): ByteArray = irk
    override fun adminRootPubHex(): String = adminPubHex
    override suspend fun adminRoot(reason: String): Ed25519Sign = Ed25519Sign(adminSeed)
}

class MockShareWorld(
    private val username: String,
    private val homeDomain: String,
    private val homeStkPubHex: String,
) {
    val phone = MockShareKeys(0x11, username)
    private val sam = MockShareKeys(0x21, "sam-lee")
    private val alex = MockShareKeys(0x31, "alex-kim")
    private val jordan = MockShareKeys(0x41, "jordan-reyes")
    private val mina = MockShareKeys(0x51, "mina-park")
    private val accounts = listOf(phone, sam, alex, jordan, mina).associateBy { it.username }
    private val garageStk = ByteArray(32) { 0x61 }
    private val garageStkPubHex = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(garageStk).publicKey)
    private val diskKey = ByteArray(32) { 0x71 }

    /** Whose IRK each server's disk key is sealed to on `.com`. */
    private val diskKeyOwner = mapOf(
        homeDomain to phone.irkPub,
        MockServerShares.GARAGE_DOMAIN to jordan.irkPub,
        MockServerShares.PHOTOS_DOMAIN to mina.irkPub,
    )

    private class Row(
        val username: String,
        val serverDomain: String,
        val tokenHash: String,
        val offer: String,
        val owner: String,
        val expiresAt: Long,
        var acceptance: String? = null,
        var ended: Boolean = false,
        var unlockCopy: String? = null,
        /** The link secret, for rows this world opens itself (Studio): `/accept` checks the admin proof inside. */
        val secret: ByteArray? = null,
    )

    private val lock = Any()
    private val rows = LinkedHashMap<String, Row>()
    private val inbox = LinkedHashMap<String, String>()
    private val held = HashMap<String, LinkedHashMap<String, ServerShare.Grant>>()
    private val ended = HashMap<String, MutableSet<String>>()
    private val nonces = HashSet<String>()
    private val tokens = HashMap<String, Pair<String, String>>()
    /** Garage waits to start until someone approves it. */
    private var garageWaiting = true

    private val seedLock = Mutex()
    @Volatile private var seeded = false

    private val apiTransport = transport(seedFirst = true)
    private val seedTransport = transport(seedFirst = false)

    fun client(keys: MockShareKeys, seeding: Boolean = false, random: ((Int) -> ByteArray)? = null) = ServerShareClient(
        apex = if (seeding) seedTransport else apiTransport,
        box = if (seeding) seedTransport else apiTransport,
        keys = keys,
        account = { ShareAccount(keys.username, isDemo = false) },
        random = random ?: { n -> ByteArray(n).also(java.security.SecureRandom()::nextBytes) },
    )

    private suspend fun seedOnce() {
        if (seeded) return
        seedLock.withLock {
            if (seeded) return
            seed()
            seeded = true
        }
    }

    /** Runs the real flows once, so every sealed record checks out. */
    private suspend fun seed() {
        val owner = client(phone, seeding = true)
        val homeName = homeDomain.substringBefore('.').replaceFirstChar { it.uppercase() }
        val samLink = owner.createOffer(username, homeDomain, homeName, homeStkPubHex, ShareOptions("Sam", ServerShare.LEVEL_MANAGE, unlockAtBoot = false, seeAppData = false))
        accept(sam, samLink.link)
        owner.ownerShares(username, homeDomain, MockServerShares.OWNER_SESSION).accepted
            .firstOrNull { it.shareId == samLink.shareId }
            ?.let { owner.confirm(username, homeDomain, MockServerShares.OWNER_SESSION, it) }
        val alexLink = owner.createOffer(username, homeDomain, homeName, homeStkPubHex, ShareOptions("Alex", ServerShare.LEVEL_VIEW, unlockAtBoot = false, seeAppData = false))
        accept(alex, alexLink.link)

        val jordanOwner = client(jordan, seeding = true)
        val garage = jordanOwner.createOffer(
            "jordan-reyes", MockServerShares.GARAGE_DOMAIN, "Garage", garageStkPubHex,
            ShareOptions("Bright", ServerShare.LEVEL_MANAGE, unlockAtBoot = true, seeAppData = true),
        )
        accept(phone, garage.link)
        jordanOwner.ownerShares("jordan-reyes", MockServerShares.GARAGE_DOMAIN, MockServerShares.OWNER_SESSION).accepted
            .firstOrNull { it.shareId == garage.shareId }
            ?.let { jordanOwner.confirm("jordan-reyes", MockServerShares.GARAGE_DOMAIN, MockServerShares.OWNER_SESSION, it) }

        val photos = client(mina, seeding = true).createOffer(
            "mina-park", MockServerShares.PHOTOS_DOMAIN, "Photos", HexUtil.encode(mina.irkPub),
            ShareOptions("Bright", ServerShare.LEVEL_VIEW, unlockAtBoot = false, seeAppData = false),
        )
        accept(phone, photos.link)

        // Studio: offered to the phone with a fixed link, not accepted yet.
        val studio = client(mina, seeding = true, random = { n -> ByteArray(n) { 0x5a } }).createOffer(
            "mina-park", MockServerShares.STUDIO_DOMAIN, "Studio", HexUtil.encode(mina.irkPub),
            ShareOptions("Bright", ServerShare.LEVEL_MANAGE, unlockAtBoot = false, seeAppData = false),
        )
        rows[studio.shareId]?.let { rows[studio.shareId] = Row(it.username, it.serverDomain, it.tokenHash, it.offer, it.owner, it.expiresAt, secret = ByteArray(32) { 0x5a }) }
    }

    /** The joining account's admin proof, checked as the shared box does (acceptAdmin.ts): null when it holds. */
    private fun adminRefusal(accept: ServerShare.Accept?, proof: ServerShare.AcceptAdminProof?): Pair<Int, JsonElement>? {
        if (accept == null || proof == null) {
            return 403 to buildJsonObject {
                put("error", "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device.")
                put("code", "accept-not-admin")
            }
        }
        val a = proof.admit
        val known = accounts.values.any { it.adminPubHex == proof.attestation.keyPubHex }
        val ok = known && a.keyKind == ServerShare.KEY_KIND_ADMIN_ROOT && a.keyPubHex == proof.attestation.keyPubHex &&
            a.serverDomain == accept.serverDomain && a.shareId == accept.shareId && a.memberPubHex == accept.memberPubHex &&
            a.acceptedAt == accept.acceptedAt && ServerShare.verify(a, HexUtil.decode(proof.signature)!!, HexUtil.decode(a.keyPubHex)!!)
        if (ok) return null
        return 403 to buildJsonObject {
            put("error", "Their acceptance isn't signed by their account's admin key, so this server can't trust it. Cancel this link and send a new one.")
            put("code", "accept-signature")
        }
    }

    private suspend fun accept(keys: MockShareKeys, link: String) {
        val member = client(keys, seeding = true)
        member.accept(member.open(ServerShare.parseShareLink(link)!!))
    }

    private fun transport(seedFirst: Boolean): JsonHttpTransport = object : JsonHttpTransport {
        override val json: Json = ServerShareClient.json
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            if (seedFirst) seedOnce()
            val obj = body?.let { Json.parseToJsonElement(String(it, Charsets.UTF_8)).jsonObject }
            val (status, out) = synchronized(lock) { handle(method, url, obj, extraHeaders) }
            return HttpResponse(status, out.toString().toByteArray(Charsets.UTF_8), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    private fun ok(o: JsonElement = buildJsonObject { put("ok", true) }) = 200 to o
    private fun err(s: Int, e: String) = s to buildJsonObject { put("error", e); put("code", e) }
    private fun str(o: JsonObject?, k: String) = o?.get(k)?.jsonPrimitive?.content

    private fun tokenOk(row: Row, h: Map<String, String>): Boolean {
        val t = h[ServerShareClient.SHARE_TOKEN_HEADER]?.let(HexUtil::decode) ?: return false
        return HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(t)) == row.tokenHash
    }

    private fun state(r: Row) = if (r.ended) "ended" else if (r.acceptance != null) "accepted" else "offered"

    private fun handle(m: String, url: String, b: JsonObject?, h: Map<String, String>): Pair<Int, JsonElement> {
        val uri = java.net.URI(url)
        val host = uri.host.orEmpty()
        val path = uri.rawPath.orEmpty()
        val users = Regex("/api/users/([^/]+)/server-shares(/list|/([0-9a-f]{32})/(revoke|unlock))?").matchEntire(path)
        val share = Regex("/api/server-shares/([0-9a-f]{32})(/accept|/leave|/push)?").matchEntire(path)
        val luks = Regex("/api/server/([^/]+)/sealed-luks-key").matchEntire(path)
        val boot = Regex("/api/boot/share/(pending|key)/([^/]+)").matchEntire(path)
        val attest = Regex("/api/users/([^/]+)/account-key-attestation").matchEntire(path)
        val demoSign = Regex("/api/dev/sample-user/([^/]+)/share-accept").matchEntire(path)
        return when {
            attest != null -> {
                val who = accounts[java.net.URLDecoder.decode(attest.groupValues[1], "UTF-8")] ?: return err(404, "username not registered")
                val now = System.currentTimeMillis()
                ok(buildJsonObject {
                    put("attestation", buildJsonObject {
                        put("kind", "AccountKeyAttestation"); put("version", 1); put("keyKind", ServerShare.KEY_KIND_ADMIN_ROOT)
                        put("keyPubHex", who.adminPubHex); put("issuedAt", now - 1000); put("expiresAt", now + 14 * 86_400_000L)
                        put("signedBy", "ca".repeat(32)); put("signature", "00".repeat(64))
                    })
                })
            }
            demoSign != null -> err(404, "no such demo user")
            users != null && users.groupValues[1].isNotEmpty() && users.groupValues[2].isEmpty() -> {
                val offer = ServerShare.parseServerShareOffer(b?.get("offer")) ?: return err(400, "malformed offer")
                rows[offer.shareId] = Row(
                    username = offer.username, serverDomain = offer.serverDomain, tokenHash = offer.tokenHash,
                    offer = str(b, "offerHex")!!, owner = str(b, "ownerHex")!!, expiresAt = offer.expiresAt,
                )
                ok()
            }
            users != null && users.groupValues[2] == "/list" -> {
                val who = java.net.URLDecoder.decode(users.groupValues[1], "UTF-8")
                ok(buildJsonObject {
                    put("shares", buildJsonArray {
                        rows.filter { it.value.username == who }.forEach { (id, r) ->
                            add(buildJsonObject {
                                put("shareId", id); put("serverDomain", r.serverDomain); put("state", state(r))
                                put("owner", r.owner); r.acceptance?.let { put("acceptance", it) }
                                put("expiresAt", r.expiresAt); put("unlock", r.unlockCopy != null)
                            })
                        }
                    })
                })
            }
            users != null && users.groupValues[4] == "revoke" -> {
                val r = rows[users.groupValues[3]] ?: return err(404, "no such share")
                r.ended = true
                ok()
            }
            users != null -> {
                val r = rows[users.groupValues[3]] ?: return err(404, "no such share")
                r.unlockCopy = str(b, "sealedKey")
                ok()
            }
            luks != null -> {
                val pub = diskKeyOwner[luks.groupValues[1]] ?: return err(404, "no disk key")
                ok(buildJsonObject { put("sealedKey", HexUtil.encode(SecretSeal.sealForEd25519Recipient(diskKey, pub))) })
            }
            share != null -> {
                val id = share.groupValues[1]
                val row = rows[id] ?: return err(404, "no such share")
                if (!tokenOk(row, h)) return err(404, "no such share")
                when (share.groupValues[2]) {
                    "" -> ok(buildJsonObject {
                        put("shareId", id); put("serverDomain", row.serverDomain); put("state", state(row))
                        put("offer", row.offer); row.acceptance?.let { put("acceptance", it) }
                        put("expiresAt", row.expiresAt); put("unlock", row.unlockCopy != null)
                    })
                    "/accept" -> if (row.acceptance != null) err(409, "this link was already used") else {
                        val sealed = str(b, "acceptance")
                        val secret = row.secret
                        if (secret != null) {
                            val payload = runCatching {
                                ServerShare.parseShareAcceptancePayload(
                                    ServerShare.openShareJson(ServerShare.shareLinkKey(secret), ServerShare.shareAad(ServerShare.AAD_SHARE_ACCEPTANCE, id), sealed!!),
                                )
                            }.getOrNull()
                            adminRefusal(payload?.accept, payload?.admin)?.let { return it }
                        }
                        row.acceptance = sealed
                        ok()
                    }
                    "/push" -> if (row.unlockCopy == null) err(403, "unlock-not-shared") else ok(buildJsonObject { put("ok", true) })
                    else -> {
                        row.ended = true
                        ok()
                    }
                }
            }
            path == "/api/share-inbox" -> {
                val r = ServerShare.parseShareInboxRequest(b?.get("request")) ?: return err(400, "malformed")
                when (r.op) {
                    ServerShare.OP_PUT -> {
                        inbox[r.entryId] = str(b, "ct")!!
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
            boot != null && boot.groupValues[1] == "pending" -> {
                val domain = boot.groupValues[2]
                if (domain != MockServerShares.GARAGE_DOMAIN || !garageWaiting) return ok(buildJsonObject { put("requests", buildJsonArray {}) })
                val now = System.currentTimeMillis()
                val nonce = "6e".repeat(32)
                val sig = Ed25519Sign(garageStk).sign(SecretRequest.canonicalBytes(domain, garageStkPubHex, SecretPurpose.UNLOCK_KEY, nonce, now))
                ok(buildJsonObject {
                    put("requests", buildJsonArray {
                        add(buildJsonObject {
                            put("request", buildJsonObject {
                                put("serverDomain", domain); put("stkPub", garageStkPubHex); put("purpose", SecretPurpose.UNLOCK_KEY.wire)
                                put("nonce", nonce); put("issuedAt", now)
                            })
                            put("signature", HexUtil.encode(sig))
                            put("postedAt", now - 120_000)
                            put("expiresAt", now + 600_000)
                        })
                    })
                })
            }
            boot != null -> {
                val copy = rows.values.firstOrNull { it.serverDomain == boot.groupValues[2] && it.unlockCopy != null }?.unlockCopy
                    ?: return err(404, "no copy for this share")
                ok(buildJsonObject { put("sealedKey", copy) })
            }
            path == "/api/boot/response" -> {
                garageWaiting = false
                ok()
            }
            path == "/api/screens/shares" && m == "GET" -> {
                val box = held[host].orEmpty()
                ok(buildJsonObject {
                    put("shares", buildJsonArray {
                        box.values.forEach { g ->
                            add(buildJsonObject {
                                put("shareId", g.shareId); put("label", g.label); put("level", g.level)
                                put("unlockAtBoot", g.unlockAtBoot); put("seeAppData", g.seeAppData)
                                put("memberPubHex", g.memberPubHex); put("issuedAt", g.issuedAt)
                                put("lastSeenAt", System.currentTimeMillis() - 2 * 3_600_000L)
                            })
                        }
                    })
                    put("ended", buildJsonArray {})
                })
            }
            path == "/api/screens/shares" -> {
                val g = ServerShare.parseServerShareGrant(b?.get("grant")) ?: return err(400, "malformed grant")
                if (held[host]?.containsKey(g.shareId) != true) {
                    adminRefusal(ServerShare.parseServerShareAccept(b?.get("accept")), ServerShare.parseShareAcceptAdminProof(b?.get("acceptAdmin")))?.let { return it }
                }
                held.getOrPut(host) { LinkedHashMap() }[g.shareId] = g
                ok()
            }
            path == "/api/screens/shares/revoke" -> {
                val r = ServerShare.parseServerShareRevoke(b?.get("revoke")) ?: return err(400, "malformed")
                held[host]?.remove(r.shareId)
                ended.getOrPut(host) { HashSet() } += r.shareId
                ok()
            }
            path == "/api/screens/activity" -> {
                val now = System.currentTimeMillis()
                val sam = held[host]?.values?.firstOrNull { it.label == "Sam" }
                ok(buildJsonObject {
                    put("entries", buildJsonArray {
                        if (sam != null) {
                            add(activity(now - 2 * 3_600_000L, sam.shareId, "Sam", "app.access.edit", "bright-maple--plants"))
                            add(activity(now - 2 * 3_600_000L - 60_000L, sam.shareId, "Sam", "share.signed-in", null))
                        }
                    })
                })
            }
            path == "/api/shares/nonce" -> {
                val n = HexUtil.encode(ByteArray(32) { (nonces.size + 1).toByte() })
                nonces += n
                ok(buildJsonObject { put("nonce", n) })
            }
            path == "/api/shares/session" -> {
                val s = ServerShare.parseServerShareSession(b?.get("session")) ?: return err(400, "malformed")
                if (!nonces.remove(s.nonceHex)) return err(403, "unknown or used nonce")
                if (s.shareId in ended[host].orEmpty()) return err(403, "share-ended")
                val g = held[host]?.get(s.shareId)?.takeIf { it.memberPubHex == s.memberPubHex } ?: return err(403, "not-shared")
                val token = "fss_" + s.shareId + "0".repeat(32)
                tokens[token] = host to s.shareId
                ok(buildJsonObject {
                    put("token", token); put("expiresAt", System.currentTimeMillis() + 12 * 3_600_000L)
                    put("level", g.level); put("unlockAtBoot", g.unlockAtBoot); put("seeAppData", g.seeAppData)
                })
            }
            path == "/api/shares/me" -> {
                val (domain, id) = tokens[h[ServerShareClient.SESSION_HEADER]] ?: return err(401, "share-session")
                val g = held[domain]?.get(id) ?: return err(401, "share-session")
                ok(buildJsonObject {
                    put("shareId", g.shareId); put("level", g.level); put("unlockAtBoot", g.unlockAtBoot)
                    put("seeAppData", g.seeAppData); put("serverDomain", domain); put("canUpdate", false)
                })
            }
            path == "/api/shares/leave" -> {
                val l = ServerShare.parseServerShareLeave(b?.get("leave")) ?: return err(400, "malformed")
                held[host]?.remove(l.shareId)
                ended.getOrPut(host) { HashSet() } += l.shareId
                ok()
            }
            else -> err(404, "unrouted $m $path")
        }
    }

    private fun activity(ts: Long, shareId: String, label: String, action: String, target: String?) = buildJsonObject {
        put("ts", ts)
        put("actor", buildJsonObject { put("kind", "share"); put("shareId", shareId); put("label", label) })
        put("action", action)
        target?.let { put("target", it) }
    }
}
