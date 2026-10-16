// Share this server (docs/share-a-server.md §9): the owner's and the other
// account's halves of every flow, over three origins: the control apex (.com
// relays ciphertext it can't open), the boot worker (start-up approvals) and
// the box itself. Every envelope comes from ServerShare; every key that signs
// or opens one comes from [ShareKeys], which sits behind the biometric gate.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom

/** The account keys the share flows use. Each call may raise the biometric prompt. */
interface ShareKeys {
    /** The UMK seed: member, inbox and owner-record keys derive from it. */
    suspend fun umk(reason: String): ByteArray

    /** The sensitive-order key: the admin root when this device holds it, else the IRK. */
    suspend fun sensitive(reason: String): Ed25519Sign

    /** Any account key `.com` accepts for reading the owner's share rows (the IRK). */
    suspend fun accountKey(reason: String): Ed25519Sign

    /** The IRK seed, which opens the disk key the installer sealed to it. */
    suspend fun irkSeed(reason: String): ByteArray

    /** True when a key can be used without prompting (background refreshes skip otherwise). */
    fun unlocked(): Boolean = true
}

class ShareException(val kind: Kind, message: String) : Exception(message) {
    enum class Kind { BadLink, Expired, AlreadyUsed, Ended, NotShared, NotFound, Refused, Invalid }
}

// ── Wire ──────────────────────────────────────────────────────────────────

@Serializable
data class ComShareRow(
    val shareId: String,
    val serverDomain: String,
    val state: String,
    val owner: String,
    val acceptance: String? = null,
    val acceptedAt: Long? = null,
    val endKind: String? = null,
    val endedAt: Long? = null,
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
    val unlock: Boolean = false,
)

@Serializable
data class ComShareList(val shares: List<ComShareRow> = emptyList())

@Serializable
data class ComShareView(
    val shareId: String,
    val serverDomain: String,
    val state: String,
    val offer: String,
    val acceptance: String? = null,
    val endKind: String? = null,
    val expiresAt: Long = 0,
    val unlock: Boolean = false,
)

@Serializable
data class BoxShare(
    val shareId: String,
    val label: String,
    val level: String,
    val unlockAtBoot: Boolean,
    val seeAppData: Boolean,
    val memberPubHex: String = "",
    val issuedAt: Long = 0,
    val sharedAt: Long? = null,
    val lastSeenAt: Long? = null,
)

@Serializable
data class BoxEndedShare(val shareId: String, val label: String = "", val endedAt: Long = 0, val reason: String = "")

@Serializable
data class BoxShares(val shares: List<BoxShare> = emptyList(), val ended: List<BoxEndedShare> = emptyList())

@Serializable
data class ActivityActor(val kind: String, val shareId: String? = null, val label: String? = null)

@Serializable
data class ActivityEntry(
    val ts: Long,
    val actor: ActivityActor,
    val action: String,
    val target: String? = null,
    val ok: Boolean = true,
)

@Serializable
data class ActivityResponse(val entries: List<ActivityEntry> = emptyList())

@Serializable
data class ShareSessionResponse(
    val token: String,
    val expiresAt: Long,
    val level: String,
    val unlockAtBoot: Boolean,
    val seeAppData: Boolean,
)

@Serializable
data class ShareInboxRow(val entryId: String, val ct: String, val createdAt: Long = 0)

@Serializable
data class ShareInboxList(val entries: List<ShareInboxRow> = emptyList())

@Serializable
data class BootShareRequest(
    val serverDomain: String,
    val stkPub: String,
    val purpose: String,
    val nonce: String,
    val issuedAt: Long,
)

@Serializable
data class BootSharePending(
    val request: BootShareRequest,
    val signature: String,
    val postedAt: Long = 0,
    val expiresAt: Long = 0,
)

@Serializable
data class BootSharePendingList(val requests: List<BootSharePending> = emptyList())

@Serializable
private data class SealedKeyWire(val sealedKey: String)

@Serializable
private data class NonceWire(val nonce: String)

@Serializable
data class ShareOfferBody(val offer: ServerShare.Offer, val signature: String, val offerHex: String, val ownerHex: String)

@Serializable
data class ShareListBody(val list: ServerShare.ListRequest, val signature: String)

@Serializable
data class ShareGrantBody(
    val grant: ServerShare.Grant,
    val signature: String,
    val accept: ServerShare.Accept? = null,
    val acceptSignature: String? = null,
)

@Serializable
data class ShareRevokeBody(val revoke: ServerShare.Revoke, val signature: String)

@Serializable
data class ShareUnlockBody(val unlock: ServerShare.Unlock, val signature: String, val sealedKey: String? = null)

@Serializable
data class ShareAcceptBody(val acceptance: String)

@Serializable
data class ShareInboxBody(val request: ServerShare.InboxRequest, val signature: String, val ct: String? = null)

@Serializable
data class ShareSessionBody(val session: ServerShare.Session, val signature: String)

@Serializable
data class ShareLeaveBody(val leave: ServerShare.Leave, val signature: String)

@Serializable
data class SharePushBody(val push: ServerShare.Push, val signature: String, val providerToken: String? = null)

@Serializable
data class ShareUpdateBody(val update: ServerShare.Update, val signature: String)

/** GET /api/shares/me: what this share may do on the box right now. */
@Serializable
data class ShareMe(
    val shareId: String,
    val level: String,
    val unlockAtBoot: Boolean,
    val seeAppData: Boolean,
    val serverDomain: String = "",
    /** Manage level on a box that can update itself; absent on older boxes. */
    val canUpdate: Boolean = false,
)

/** One device's start-up notice registration for a share, as this phone remembers it. */
data class SharePushRegistration(val platform: String, val tokenSha256: String)

/** Where this phone keeps which shares it asked `.com` to wake it for. */
interface SharePushStore {
    fun get(shareId: String): SharePushRegistration?
    fun put(shareId: String, registration: SharePushRegistration)
    fun remove(shareId: String)
}

class InMemorySharePushStore : SharePushStore {
    private val map = HashMap<String, SharePushRegistration>()
    override fun get(shareId: String): SharePushRegistration? = synchronized(map) { map[shareId] }
    override fun put(shareId: String, registration: SharePushRegistration) { synchronized(map) { map[shareId] = registration } }
    override fun remove(shareId: String) { synchronized(map) { map.remove(shareId) } }
}

@Serializable
data class BootShareResponse(
    val serverDomain: String,
    val requestNonceHex: String,
    val purpose: String,
    val sealed: String,
    val issuedAt: Long,
)

@Serializable
data class BootShareResponseBody(val response: BootShareResponse)

// ── What the screens see ─────────────────────────────────────────────────

data class ShareOptions(
    val label: String,
    val level: String,
    val unlockAtBoot: Boolean,
    val seeAppData: Boolean,
)

data class CreatedShare(val shareId: String, val link: String)

/** The owner's view of one server's shares: the box is the truth for who has access. */
data class OwnerShares(
    val active: List<ActiveShare>,
    val pending: List<PendingShare>,
    val accepted: List<AcceptedShare>,
    /** Null when the box answered; otherwise why the active list is missing. */
    val boxProblem: String? = null,
)

data class ActiveShare(
    val shareId: String,
    val label: String,
    val level: String,
    val unlockAtBoot: Boolean,
    val seeAppData: Boolean,
    val memberPubHex: String,
    val issuedAt: Long,
    val lastSeenAt: Long?,
)

data class PendingShare(
    val shareId: String,
    val label: String,
    val level: String,
    val link: String,
    val expiresAt: Long,
)

data class AcceptedShare(
    val shareId: String,
    val label: String,
    val options: ShareOptions,
    val accept: ServerShare.Accept,
    val acceptSignature: String,
    /** `"123456"`, or null when the acceptance doesn't check out. */
    val sas: String?,
)

/** A link opened by the other account, before accepting. */
data class OpenedShare(
    val shareId: String,
    val secretHex: String,
    val state: String,
    val offer: ServerShare.OfferPayload,
    /** The acceptance already on `.com`, if any (this account's, after a re-open). */
    val acceptanceHex: String?,
)

/** One server shared with this account, as its inbox keeps it. */
data class SharedEntry(
    val entryId: String?,
    val shareId: String,
    val secretHex: String,
    val serverDomain: String,
    val serverName: String,
    val acceptedAt: Long,
)

data class ShareSession(
    val token: String,
    val expiresAt: Long,
    val level: String,
    val unlockAtBoot: Boolean,
    val seeAppData: Boolean,
)

sealed interface ShareSignIn {
    data class In(val session: ShareSession) : ShareSignIn
    /** The owner hasn't confirmed yet. */
    data object Waiting : ShareSignIn
    data object Ended : ShareSignIn
}

/** A start-up request the other account may approve: checked against the offer's STK. */
data class ShareStartup(val pending: BootSharePending)

class ServerShareClient(
    private val apex: JsonHttpTransport,
    private val box: JsonHttpTransport,
    private val keys: ShareKeys,
    private val apexBase: () -> String = { Endpoints.controlBaseUrl },
    private val bootBase: () -> String = { Endpoints.bootBaseUrl },
    private val boxBase: (String) -> String = { "https://$it" },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val random: (Int) -> ByteArray = { n -> ByteArray(n).also(rng::nextBytes) },
    private val pushStore: SharePushStore = InMemorySharePushStore(),
    /** This device's push token and its platform, or null when it has none. */
    private val pushToken: suspend () -> Pair<String, String>? = { null },
) {
    companion object {
        private val rng = SecureRandom()
        private val ALL = (100..599).toSet()
        val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        const val SHARE_TOKEN_HEADER = "x-flagship-share-token"
        const val SESSION_HEADER = "x-flagship-session"

        const val NOTICES_NOT_SHARED = "The owner hasn't let you approve this server's start-up."
        const val NOTICES_NO_TOKEN = "This phone can't receive notices right now. Check that notifications are allowed for Flagship."

        /** What to tell the person when the box refuses a co-manager's update order. */
        fun updateRefusalText(code: String?, error: String?): String = when (code) {
            "busy", "pending-verify" -> "An update is already underway."
            "from-commit-mismatch" -> "The server changed version. Refresh and try again."
            "manage-only" -> "Only someone who can manage this server can update it."
            "stale" -> "Your device's clock looks off. Check it and try again."
            else -> error?.takeIf { it.isNotBlank() } ?: "The server refused the update."
        }
    }

    private val sessions = HashMap<String, ShareSession>()

    /** True when a refresh can run without raising the biometric prompt. */
    fun canRunSilently(): Boolean = keys.unlocked()
    private val offers = HashMap<String, ServerShare.OfferPayload>()

    // ── Owner ────────────────────────────────────────────────────────────

    /** Mint a share, seal the offer and the owner record, sign #6 and post the row. */
    suspend fun createOffer(
        username: String,
        serverDomain: String,
        serverName: String,
        stkPubHex: String,
        options: ShareOptions,
    ): CreatedShare {
        val label = ServerShare.normalizeShareLabel(options.label)
            ?: throw ShareException(ShareException.Kind.Invalid, "Give the person a name of up to 64 characters.")
        require(options.level in ServerShare.SHARE_LEVELS)
        val stk = stkPubHex.lowercase()
        if (HexUtil.decode(stk)?.size != 32) {
            throw ShareException(ShareException.Kind.Invalid, "This server has no registered identity yet.")
        }
        val shareId = HexUtil.encode(random(16))
        val secret = random(32)
        val issuedAt = now()
        val expiresAt = issuedAt + ServerShare.SHARE_OFFER_TTL_MS
        val offerHex = ServerShare.sealShareJson(
            ServerShare.shareLinkKey(secret),
            ServerShare.shareAad(ServerShare.AAD_SHARE_OFFER, shareId),
            ServerShare.OfferPayload(
                serverDomain = serverDomain,
                serverName = serverName,
                stkPubHex = stk,
                level = options.level,
                unlockAtBoot = options.unlockAtBoot,
                seeAppData = options.seeAppData,
                expiresAt = expiresAt,
            ).toJson(),
        )
        val reason = "Share $serverName with $label"
        val umk = keys.umk(reason)
        val ownerHex = ServerShare.sealShareJson(
            ServerShare.deriveShareOwnerRecordKey(umk),
            ServerShare.shareAad(ServerShare.AAD_SHARE_OWNER, shareId),
            ServerShare.OwnerRecord(
                secretHex = HexUtil.encode(secret),
                label = label,
                level = options.level,
                unlockAtBoot = options.unlockAtBoot,
                seeAppData = options.seeAppData,
            ).toJson(),
        )
        val offer = ServerShare.Offer(
            username = username,
            serverDomain = serverDomain,
            shareId = shareId,
            tokenHash = ServerShare.shareTokenHash(ServerShare.shareTokenFromSecret(secret)),
            offerSha256 = ServerShare.shareSha256Hex(offerHex),
            ownerSha256 = ServerShare.shareSha256Hex(ownerHex),
            expiresAt = expiresAt,
            issuedAt = issuedAt,
        )
        val signature = ServerShare.signHex(offer, keys.sensitive(reason))
        val res = post(apex, "${apexBase()}/api/users/${enc(username)}/server-shares", ShareOfferBody(offer, signature, offerHex, ownerHex), ShareOfferBody.serializer())
        expectOk(res, "share this server")
        return CreatedShare(shareId, ServerShare.buildShareLink(apexBase(), shareId, secret))
    }

    /** The "Shared with" card: the box's active shares plus `.com`'s offers for this server. */
    suspend fun ownerShares(username: String, serverDomain: String, ownerSession: String?): OwnerShares {
        var boxProblem: String? = null
        val onBox: BoxShares? = if (ownerSession == null) {
            boxProblem = "This phone isn't signed in to this server yet."
            null
        } else {
            try {
                val r = boxCall("GET", serverDomain, "/api/screens/shares", ownerSession)
                if (r.status == 200) decode(r, BoxShares.serializer()) else {
                    boxProblem = "The server didn't list its shares (${r.status})."
                    null
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                boxProblem = "Can't reach this server right now."
                null
            }
        }
        val rows = listRows(username).filter { it.serverDomain.equals(serverDomain, ignoreCase = true) }
        val endedOnBox = onBox?.ended.orEmpty().map { it.shareId }.toSet()
        val activeIds = onBox?.shares.orEmpty().map { it.shareId }.toSet()
        val household = if (rows.any { it.state != "ended" }) {
            ServerShare.deriveShareOwnerRecordKey(keys.umk("Show who this server is shared with"))
        } else {
            null
        }

        val pending = ArrayList<PendingShare>()
        val accepted = ArrayList<AcceptedShare>()
        for (row in rows) {
            if (row.state == "ended" || row.shareId in activeIds || row.shareId in endedOnBox) continue
            val record = openOwnerRecord(household ?: continue, row) ?: continue
            val secret = HexUtil.decode(record.secretHex) ?: continue
            val options = ShareOptions(record.label, record.level, record.unlockAtBoot, record.seeAppData)
            when (row.state) {
                "offered" -> if (row.expiresAt > now()) {
                    pending += PendingShare(row.shareId, record.label, record.level, ServerShare.buildShareLink(apexBase(), row.shareId, secret), row.expiresAt)
                }
                "accepted" -> accepted += checkAcceptance(row, serverDomain, secret, options) ?: continue
            }
        }
        val active = onBox?.shares.orEmpty().map {
            ActiveShare(it.shareId, it.label, it.level, it.unlockAtBoot, it.seeAppData, it.memberPubHex, it.issuedAt, it.lastSeenAt)
        }
        return OwnerShares(active, pending, accepted, boxProblem)
    }

    private fun checkAcceptance(row: ComShareRow, serverDomain: String, secret: ByteArray, options: ShareOptions): AcceptedShare? {
        val hex = row.acceptance ?: return null
        val payload = runCatching {
            ServerShare.parseShareAcceptancePayload(
                ServerShare.openShareJson(
                    ServerShare.shareLinkKey(secret),
                    ServerShare.shareAad(ServerShare.AAD_SHARE_ACCEPTANCE, row.shareId),
                    hex,
                ),
            )
        }.getOrNull()
        val accept = payload?.accept
        val valid = accept != null &&
            accept.serverDomain.equals(serverDomain, ignoreCase = true) &&
            accept.shareId == row.shareId &&
            ServerShare.verify(accept, HexUtil.decode(payload.signature)!!, HexUtil.decode(accept.memberPubHex)!!)
        val shown = accept ?: ServerShare.Accept(serverDomain, row.shareId, "0".repeat(64), 0)
        return AcceptedShare(
            shareId = row.shareId,
            label = options.label,
            options = options,
            accept = shown,
            acceptSignature = payload?.signature.orEmpty(),
            sas = if (valid) ServerShare.shareSas(row.shareId, shown.memberPubHex, secret) else null,
        )
    }

    /** "Their phone shows the same code": sign #1 with the acceptance, then deposit B's boot copy if asked. */
    suspend fun confirm(username: String, serverDomain: String, ownerSession: String, share: AcceptedShare) {
        if (share.sas == null) throw ShareException(ShareException.Kind.Invalid, "This acceptance doesn't check out. Remove it and share again.")
        val grant = ServerShare.Grant(
            serverDomain = serverDomain,
            shareId = share.shareId,
            memberPubHex = share.accept.memberPubHex,
            level = share.options.level,
            unlockAtBoot = share.options.unlockAtBoot,
            seeAppData = share.options.seeAppData,
            label = share.label,
            issuedAt = now(),
        )
        val key = keys.sensitive("Give ${share.label} access to this server")
        val body = ShareGrantBody(grant, ServerShare.signHex(grant, key), share.accept, share.acceptSignature)
        expectOk(boxPost(serverDomain, "/api/screens/shares", ownerSession, body, ShareGrantBody.serializer()), "give access")
        if (share.options.unlockAtBoot) setUnlock(username, serverDomain, share.shareId, share.accept.memberPubHex, on = true)
    }

    /** A new grant for the same share (level, opt-ins); the unlock copy follows the opt-in. */
    suspend fun change(username: String, serverDomain: String, ownerSession: String, share: ActiveShare, level: String, unlockAtBoot: Boolean, seeAppData: Boolean) {
        val unlockOn = unlockAtBoot && !share.unlockAtBoot
        if (unlockOn) setUnlock(username, serverDomain, share.shareId, share.memberPubHex, on = true)
        val grant = ServerShare.Grant(
            serverDomain = serverDomain,
            shareId = share.shareId,
            memberPubHex = share.memberPubHex,
            level = level,
            unlockAtBoot = unlockAtBoot,
            seeAppData = seeAppData,
            label = share.label,
            issuedAt = maxOf(now(), share.issuedAt + 1),
        )
        val key = keys.sensitive("Change what ${share.label} can do on this server")
        expectOk(
            boxPost(serverDomain, "/api/screens/shares", ownerSession, ShareGrantBody(grant, ServerShare.signHex(grant, key)), ShareGrantBody.serializer()),
            "change this share",
        )
        if (!unlockAtBoot && share.unlockAtBoot) setUnlock(username, serverDomain, share.shareId, share.memberPubHex, on = false)
    }

    /** Remove: #2 to the box and to `.com`. Either one ends the share; a `.com` 404 is fine. */
    suspend fun remove(username: String, serverDomain: String, ownerSession: String?, shareId: String, label: String) {
        val revoke = ServerShare.Revoke(serverDomain, shareId, now())
        val body = ShareRevokeBody(revoke, ServerShare.signHex(revoke, keys.sensitive("Stop sharing this server with $label")))
        var boxOk = false
        var boxError: Exception? = null
        if (ownerSession != null) {
            try {
                val r = boxPost(serverDomain, "/api/screens/shares/revoke", ownerSession, body, ShareRevokeBody.serializer())
                boxOk = r.status in 200..299
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                boxError = e
            }
        }
        val com = post(apex, "${apexBase()}/api/users/${enc(username)}/server-shares/$shareId/revoke", body, ShareRevokeBody.serializer())
        val comOk = com.status in 200..299 || com.status == 404
        if (!comOk && !boxOk) {
            boxError?.let { throw it }
            expectOk(com, "stop sharing")
        }
    }

    /** Cancel an offer nobody has used yet: the `.com` revoke only. */
    suspend fun cancel(username: String, serverDomain: String, shareId: String, label: String) {
        val revoke = ServerShare.Revoke(serverDomain, shareId, now())
        val body = ShareRevokeBody(revoke, ServerShare.signHex(revoke, keys.sensitive("Cancel the link for $label")))
        val r = post(apex, "${apexBase()}/api/users/${enc(username)}/server-shares/$shareId/revoke", body, ShareRevokeBody.serializer())
        if (r.status != 404) expectOk(r, "cancel the link")
    }

    /** Put B's boot copy (the disk key sealed to their member key) on `.com`, or withdraw it. */
    suspend fun setUnlock(username: String, serverDomain: String, shareId: String, memberPubHex: String, on: Boolean) {
        val url = "${apexBase()}/api/users/${enc(username)}/server-shares/$shareId/unlock"
        if (!on) {
            val unlock = ServerShare.Unlock(serverDomain, shareId, memberPubHex, ServerShare.SHARE_UNLOCK_OFF, now())
            val sig = ServerShare.signHex(unlock, keys.sensitive("Stop letting them start this server"))
            val r = post(apex, url, ShareUnlockBody(unlock, sig), ShareUnlockBody.serializer())
            if (r.status != 410) expectOk(r, "withdraw the start-up copy")
            return
        }
        val reason = "Let them approve this server's start-up"
        val got = call(apex, "GET", "${apexBase()}/api/server/${enc(serverDomain)}/sealed-luks-key")
        if (got.status == 404) throw ShareException(ShareException.Kind.NotFound, "No disk key is on file for this server, so nobody else can unlock it.")
        expectOk(got, "read the disk key")
        val sealedBlob = HexUtil.decode(decode(got, SealedKeyWire.serializer()).sealedKey)
            ?: throw ShareException(ShareException.Kind.Invalid, "The disk key on file is damaged.")
        val diskKey = try {
            SecretSeal.openWithEd25519Seed(sealedBlob, keys.irkSeed(reason))
        } catch (_: Exception) {
            throw ShareException(ShareException.Kind.Invalid, "This phone's keys can't open this server's disk key.")
        }
        val memberPub = HexUtil.decode(memberPubHex)?.takeIf { it.size == 32 }
            ?: throw ShareException(ShareException.Kind.Invalid, "Their key is malformed.")
        val sealedHex = HexUtil.encode(SecretSeal.sealForEd25519Recipient(diskKey, memberPub))
        diskKey.fill(0)
        val unlock = ServerShare.Unlock(serverDomain, shareId, memberPubHex, ServerShare.shareSha256Hex(sealedHex), now())
        val sig = ServerShare.signHex(unlock, keys.sensitive(reason))
        expectOk(post(apex, url, ShareUnlockBody(unlock, sig, sealedHex), ShareUnlockBody.serializer()), "save the start-up copy")
    }

    suspend fun activity(serverDomain: String, ownerSession: String, limit: Int = 50): List<ActivityEntry> {
        val r = boxCall("GET", serverDomain, "/api/screens/activity?limit=$limit", ownerSession)
        expectOk(r, "read the activity")
        return decode(r, ActivityResponse.serializer()).entries
    }

    private suspend fun listRows(username: String): List<ComShareRow> {
        val list = ServerShare.ListRequest(username, now())
        val sig = ServerShare.signHex(list, keys.accountKey("Show who this server is shared with"))
        val r = post(apex, "${apexBase()}/api/users/${enc(username)}/server-shares/list", ShareListBody(list, sig), ShareListBody.serializer())
        expectOk(r, "list your shares")
        return decode(r, ComShareList.serializer()).shares
    }

    private fun openOwnerRecord(key: ByteArray, row: ComShareRow): ServerShare.OwnerRecord? = runCatching {
        ServerShare.parseShareOwnerRecord(
            ServerShare.openShareJson(key, ServerShare.shareAad(ServerShare.AAD_SHARE_OWNER, row.shareId), row.owner),
        )
    }.getOrNull()

    // ── The other account ────────────────────────────────────────────────

    /** Read and open the offer behind a link. */
    suspend fun open(link: ServerShare.ShareLink): OpenedShare {
        val secret = HexUtil.decode(link.secretHex)!!
        val token = ServerShare.shareTokenFromSecret(secret)
        val r = call(apex, "GET", "${apexBase()}/api/server-shares/${link.shareId}", headers = mapOf(SHARE_TOKEN_HEADER to token))
        when (r.status) {
            404 -> throw ShareException(ShareException.Kind.BadLink, "This link doesn't work. Ask for a new one.")
            410 -> throw ShareException(ShareException.Kind.Expired, "This link has expired. Ask for a new one.")
        }
        expectOk(r, "open the link")
        val view = decode(r, ComShareView.serializer())
        val offer = runCatching {
            ServerShare.parseShareOfferPayload(
                ServerShare.openShareJson(
                    ServerShare.shareLinkKey(secret),
                    ServerShare.shareAad(ServerShare.AAD_SHARE_OFFER, link.shareId),
                    view.offer,
                ),
            )
        }.getOrNull() ?: throw ShareException(ShareException.Kind.BadLink, "This link doesn't work. Ask for a new one.")
        offers[link.shareId] = offer
        return OpenedShare(link.shareId, link.secretHex, view.state, offer, view.acceptance)
    }

    /**
     * Accept: sign #3 with this share's member key, post it sealed, save the
     * share to the inbox, and return the six digits to read to the owner. A
     * re-opened link this account already accepted resumes instead.
     */
    suspend fun accept(opened: OpenedShare): Pair<SharedEntry, String> {
        if (opened.state == "ended") throw ShareException(ShareException.Kind.Ended, "The owner has stopped sharing this server.")
        val secret = HexUtil.decode(opened.secretHex)!!
        val umk = keys.umk("Accept ${opened.offer.serverName}")
        val member = ServerShare.deriveShareMemberKey(umk, opened.shareId)
        val memberPubHex = HexUtil.encode(ServerShare.deriveShareMemberPub(umk, opened.shareId))
        val sas = ServerShare.shareSas(opened.shareId, memberPubHex, secret)
        val serverDomain = opened.offer.serverDomain

        val existing = opened.acceptanceHex?.let { hex ->
            runCatching {
                ServerShare.parseShareAcceptancePayload(
                    ServerShare.openShareJson(ServerShare.shareLinkKey(secret), ServerShare.shareAad(ServerShare.AAD_SHARE_ACCEPTANCE, opened.shareId), hex),
                )
            }.getOrNull()
        }
        if (opened.acceptanceHex != null) {
            val mine = existing?.accept?.takeIf { it.memberPubHex == memberPubHex }
                ?: throw ShareException(ShareException.Kind.AlreadyUsed, "Someone else already used this link. Ask the owner for a new one.")
            val entry = SharedEntry(null, opened.shareId, opened.secretHex, serverDomain, opened.offer.serverName, mine.acceptedAt)
            return saveToInbox(umk, entry) to sas
        }

        val accept = ServerShare.Accept(serverDomain, opened.shareId, memberPubHex, now())
        val payload = ServerShare.AcceptancePayload(accept = accept, signature = ServerShare.signHex(accept, member))
        val sealed = ServerShare.sealShareJson(
            ServerShare.shareLinkKey(secret),
            ServerShare.shareAad(ServerShare.AAD_SHARE_ACCEPTANCE, opened.shareId),
            payload.toJson(),
        )
        val token = ServerShare.shareTokenFromSecret(secret)
        val r = post(apex, "${apexBase()}/api/server-shares/${opened.shareId}/accept", ShareAcceptBody(sealed), ShareAcceptBody.serializer(), mapOf(SHARE_TOKEN_HEADER to token))
        when (r.status) {
            409 -> throw ShareException(ShareException.Kind.AlreadyUsed, "Someone else already used this link. Ask the owner for a new one.")
            410 -> throw ShareException(ShareException.Kind.Expired, "This link has expired. Ask for a new one.")
            404 -> throw ShareException(ShareException.Kind.BadLink, "This link doesn't work. Ask for a new one.")
        }
        expectOk(r, "accept")
        val entry = SharedEntry(null, opened.shareId, opened.secretHex, serverDomain, opened.offer.serverName, accept.acceptedAt)
        return saveToInbox(umk, entry) to sas
    }

    private suspend fun saveToInbox(umk: ByteArray, entry: SharedEntry): SharedEntry {
        val entryId = HexUtil.encode(random(16))
        val ct = ServerShare.sealShareJson(
            ServerShare.deriveShareInboxSealKey(umk),
            ServerShare.shareAad(ServerShare.AAD_SHARE_INBOX_ENTRY, entryId),
            ServerShare.InboxEntry(
                shareId = entry.shareId,
                secretHex = entry.secretHex,
                serverDomain = entry.serverDomain,
                serverName = entry.serverName,
                acceptedAt = entry.acceptedAt,
            ).toJson(),
        )
        val req = ServerShare.InboxRequest(
            inboxPubHex = HexUtil.encode(ServerShare.deriveShareInboxPub(umk)),
            op = ServerShare.OP_PUT,
            entryId = entryId,
            ctSha256 = ServerShare.shareSha256Hex(ct),
            issuedAt = now(),
        )
        val sig = ServerShare.signHex(req, ServerShare.deriveShareInboxKey(umk))
        expectOk(post(apex, "${apexBase()}/api/share-inbox", ShareInboxBody(req, sig, ct), ShareInboxBody.serializer()), "save the share")
        return entry.copy(entryId = entryId)
    }

    /** B's "Shared with me" entries, newest first; entries this phone can't open are skipped. */
    suspend fun inbox(): List<SharedEntry> {
        val umk = keys.umk("Show the servers shared with you")
        val req = ServerShare.InboxRequest(HexUtil.encode(ServerShare.deriveShareInboxPub(umk)), ServerShare.OP_LIST, "", "", now())
        val sig = ServerShare.signHex(req, ServerShare.deriveShareInboxKey(umk))
        val r = post(apex, "${apexBase()}/api/share-inbox", ShareInboxBody(req, sig), ShareInboxBody.serializer())
        expectOk(r, "list the servers shared with you")
        val sealKey = ServerShare.deriveShareInboxSealKey(umk)
        val out = decode(r, ShareInboxList.serializer()).entries.mapNotNull { row ->
            val e = runCatching {
                ServerShare.parseShareInboxEntry(
                    ServerShare.openShareJson(sealKey, ServerShare.shareAad(ServerShare.AAD_SHARE_INBOX_ENTRY, row.entryId), row.ct),
                )
            }.getOrNull() ?: return@mapNotNull null
            SharedEntry(row.entryId, e.shareId, e.secretHex, e.serverDomain, e.serverName, e.acceptedAt)
        }
        return out.groupBy { it.shareId }.map { (_, dupes) -> dupes.maxBy { it.acceptedAt } }.sortedByDescending { it.acceptedAt }
    }

    suspend fun inboxDelete(entryId: String) {
        val umk = keys.umk("Remove a shared server")
        val req = ServerShare.InboxRequest(HexUtil.encode(ServerShare.deriveShareInboxPub(umk)), ServerShare.OP_DELETE, entryId, "", now())
        val sig = ServerShare.signHex(req, ServerShare.deriveShareInboxKey(umk))
        expectOk(post(apex, "${apexBase()}/api/share-inbox", ShareInboxBody(req, sig), ShareInboxBody.serializer()), "remove the share")
    }

    /** The session this phone holds for a share, if it's still fresh. */
    fun cachedSession(shareId: String): ShareSession? =
        synchronized(sessions) { sessions[shareId]?.takeIf { it.expiresAt > now() + 60_000 } }

    fun forgetSession(shareId: String) {
        synchronized(sessions) { sessions.remove(shareId) }
    }

    /** Sign in to the server with this share's member key (#5 over a box nonce). */
    suspend fun signIn(entry: SharedEntry, reuse: Boolean = true): ShareSignIn {
        if (reuse) cachedSession(entry.shareId)?.let { return ShareSignIn.In(it) }
        val umk = keys.umk("Open ${entry.serverName}")
        val member = ServerShare.deriveShareMemberKey(umk, entry.shareId)
        val memberPubHex = HexUtil.encode(ServerShare.deriveShareMemberPub(umk, entry.shareId))
        val n = boxCall("GET", entry.serverDomain, "/api/shares/nonce", null)
        expectOk(n, "reach the server")
        val nonce = decode(n, NonceWire.serializer()).nonce
        val session = ServerShare.Session(entry.serverDomain, entry.shareId, memberPubHex, nonce, now())
        val r = boxPost(entry.serverDomain, "/api/shares/session", null, ShareSessionBody(session, ServerShare.signHex(session, member)), ShareSessionBody.serializer())
        if (r.status == 403) {
            return when (errorCode(r)) {
                "not-shared" -> ShareSignIn.Waiting
                "share-ended" -> {
                    forgetSession(entry.shareId)
                    ShareSignIn.Ended
                }
                else -> throw ShareException(ShareException.Kind.Refused, "The server refused this sign-in: ${errorText(r)}.")
            }
        }
        expectOk(r, "sign in")
        val s = decode(r, ShareSessionResponse.serializer())
        val out = ShareSession(s.token, s.expiresAt, s.level, s.unlockAtBoot, s.seeAppData)
        synchronized(sessions) { sessions[entry.shareId] = out }
        return ShareSignIn.In(out)
    }

    /** `.com`'s view of a share (ended, or the start-up copy's presence). Null when the link no longer reads. */
    suspend fun comState(entry: SharedEntry): ComShareView? {
        val token = ServerShare.shareTokenFromSecret(HexUtil.decode(entry.secretHex)!!)
        val r = call(apex, "GET", "${apexBase()}/api/server-shares/${entry.shareId}", headers = mapOf(SHARE_TOKEN_HEADER to token))
        return if (r.status == 200) decode(r, ComShareView.serializer()) else null
    }

    /** The offer the owner sealed, which pins the server's STK for start-up approvals. */
    suspend fun offerFor(entry: SharedEntry): ServerShare.OfferPayload {
        offers[entry.shareId]?.let { return it }
        return open(ServerShare.ShareLink(entry.shareId, entry.secretHex)).offer
    }

    /** True when this phone asked `.com` to wake it for this share's start-ups. */
    fun startupNotices(shareId: String): Boolean = pushStore.get(shareId) != null

    /** Forget this share's notice registration here (`.com` drops its rows when the share ends). */
    fun forgetStartupNotices(shareId: String) = pushStore.remove(shareId)

    /**
     * Ask `.com` to wake this device when the server waits to start (#10 put,
     * with the token beside it), or stop (#10 delete). Turning it on tells
     * `.com` that this device helps with this server.
     */
    suspend fun setStartupNotices(entry: SharedEntry, on: Boolean) {
        val url = "${apexBase()}/api/server-shares/${entry.shareId}/push"
        val headers = mapOf(SHARE_TOKEN_HEADER to ServerShare.shareTokenFromSecret(HexUtil.decode(entry.secretHex)!!))
        if (!on) {
            val reg = pushStore.get(entry.shareId) ?: return
            val umk = keys.umk("Stop notices for ${entry.serverName}")
            val push = ServerShare.Push(
                entry.serverDomain, entry.shareId, HexUtil.encode(ServerShare.deriveShareMemberPub(umk, entry.shareId)),
                ServerShare.OP_DELETE, reg.platform, reg.tokenSha256, now(),
            )
            val r = post(apex, url, SharePushBody(push, ServerShare.signHex(push, ServerShare.deriveShareMemberKey(umk, entry.shareId))), SharePushBody.serializer(), headers)
            if (r.status !in 200..299 && r.status != 404 && r.status != 410 && errorCode(r) != "unlock-not-shared") expectOk(r, "stop the notices")
            pushStore.remove(entry.shareId)
            return
        }
        val (platform, token) = pushToken()?.takeIf { it.second.isNotEmpty() }
            ?: throw ShareException(ShareException.Kind.Refused, NOTICES_NO_TOKEN)
        val umk = keys.umk("Get notices for ${entry.serverName}")
        val tokenSha256 = ServerShare.shareSha256Hex(token)
        val push = ServerShare.Push(
            entry.serverDomain, entry.shareId, HexUtil.encode(ServerShare.deriveShareMemberPub(umk, entry.shareId)),
            ServerShare.OP_PUT, platform, tokenSha256, now(),
        )
        val body = SharePushBody(push, ServerShare.signHex(push, ServerShare.deriveShareMemberKey(umk, entry.shareId)), token)
        val r = post(apex, url, body, SharePushBody.serializer(), headers)
        if (r.status == 403 && errorCode(r) == "unlock-not-shared") throw ShareException(ShareException.Kind.NotShared, NOTICES_NOT_SHARED)
        if (r.status == 404) throw ShareException(ShareException.Kind.BadLink, "This share's link no longer works.")
        if (r.status == 410) throw ShareException(ShareException.Kind.Ended, "The owner stopped sharing this server.")
        expectOk(r, "turn on the notices")
        pushStore.put(entry.shareId, SharePushRegistration(platform, tokenSha256))
    }

    /** What this share may do on the box right now (`canUpdate` included). */
    suspend fun me(entry: SharedEntry): ShareMe? {
        val s = (signIn(entry) as? ShareSignIn.In)?.session ?: return null
        var r = boxCall("GET", entry.serverDomain, "/api/shares/me", s.token)
        if (r.status == 401) {
            forgetSession(entry.shareId)
            val again = (signIn(entry, reuse = false) as? ShareSignIn.In)?.session ?: return null
            r = boxCall("GET", entry.serverDomain, "/api/shares/me", again.token)
        }
        return if (r.status == 200) decode(r, ShareMe.serializer()) else null
    }

    /**
     * A co-manager moves the server to an endorsed release: #11 signed with
     * this share's member key, straight to the box, which checks the same
     * endorsement as for the owner. Returns once the box took the order.
     */
    suspend fun orderUpdate(entry: SharedEntry, targetCommit: String, fromCommit: String) {
        val umk = keys.umk("Update ${entry.serverName}")
        val update = ServerShare.Update(
            serverDomain = entry.serverDomain,
            shareId = entry.shareId,
            memberPubHex = HexUtil.encode(ServerShare.deriveShareMemberPub(umk, entry.shareId)),
            targetCommit = targetCommit,
            fromCommit = fromCommit,
            nonce = HexUtil.encode(random(32)),
            issuedAt = now(),
        )
        val body = ShareUpdateBody(update, ServerShare.signHex(update, ServerShare.deriveShareMemberKey(umk, entry.shareId)))
        suspend fun send(fresh: Boolean): HttpResponse? {
            val s = (signIn(entry, reuse = !fresh) as? ShareSignIn.In)?.session ?: return null
            return boxPost(entry.serverDomain, "/api/shares/update", s.token, body, ShareUpdateBody.serializer())
        }
        var r = send(fresh = false)
        if (r?.status == 401) {
            forgetSession(entry.shareId)
            r = send(fresh = true)
        }
        if (r == null) throw ShareException(ShareException.Kind.NotShared, "This server isn't shared with you right now.")
        if (r.status in 200..299) return
        throw ShareException(ShareException.Kind.Refused, updateRefusalText(errorCode(r), (errorObject(r)?.get("error") as? JsonPrimitive)?.content))
    }

    /** Leave: #4 to the box and to `.com`, then drop the inbox entry. */
    suspend fun leave(entry: SharedEntry) {
        val umk = keys.umk("Leave ${entry.serverName}")
        val member = ServerShare.deriveShareMemberKey(umk, entry.shareId)
        val memberPubHex = HexUtil.encode(ServerShare.deriveShareMemberPub(umk, entry.shareId))
        val leave = ServerShare.Leave(entry.serverDomain, entry.shareId, memberPubHex, now())
        val body = ShareLeaveBody(leave, ServerShare.signHex(leave, member))
        val boxOk = try {
            boxPost(entry.serverDomain, "/api/shares/leave", null, body, ShareLeaveBody.serializer()).status in 200..299
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
        val token = ServerShare.shareTokenFromSecret(HexUtil.decode(entry.secretHex)!!)
        val com = post(apex, "${apexBase()}/api/server-shares/${entry.shareId}/leave", body, ShareLeaveBody.serializer(), mapOf(SHARE_TOKEN_HEADER to token))
        if (!boxOk && com.status !in 200..299 && com.status != 404) expectOk(com, "leave")
        forgetSession(entry.shareId)
        pushStore.remove(entry.shareId)
        entry.entryId?.let { runCatching { inboxDelete(it) } }
    }

    /** Pending start-ups this share may approve: only requests signed by the STK the owner pinned in the offer. */
    suspend fun pendingStartups(entry: SharedEntry): List<ShareStartup> {
        val offer = offerFor(entry)
        val umk = keys.umk("Check whether ${entry.serverName} is starting")
        val path = "/api/boot/share/pending/${entry.serverDomain}"
        val r = call(apex, "GET", "${bootBase()}$path", headers = mapOf("Authorization" to shareAuth(umk, entry, "GET", path)))
        if (r.status == 403 || r.status == 404) return emptyList()
        expectOk(r, "check for start-ups")
        return decode(r, BootSharePendingList.serializer()).requests
            .filter { verifiedStartup(it, offer, entry.serverDomain) }
            .map { ShareStartup(it) }
    }

    private fun verifiedStartup(p: BootSharePending, offer: ServerShare.OfferPayload, serverDomain: String): Boolean {
        val req = p.request
        if (!req.serverDomain.equals(serverDomain, ignoreCase = true)) return false
        if (!req.stkPub.equals(offer.stkPubHex, ignoreCase = true)) return false
        if (req.purpose != SecretPurpose.UNLOCK_KEY.wire) return false
        if (p.expiresAt != 0L && p.expiresAt <= now()) return false
        val stk = HexUtil.decode(offer.stkPubHex) ?: return false
        val sig = HexUtil.decode(p.signature) ?: return false
        return SecretRequest.verify(sig, stk, req.serverDomain, req.stkPub, SecretPurpose.UNLOCK_KEY, req.nonce, req.issuedAt)
    }

    /** Approve one start-up: open this share's copy of the disk key and seal it for the pinned STK. */
    suspend fun approveStartup(entry: SharedEntry, startup: ShareStartup) {
        val offer = offerFor(entry)
        if (!verifiedStartup(startup.pending, offer, entry.serverDomain)) {
            throw ShareException(ShareException.Kind.Refused, "This start-up request isn't from ${entry.serverName}.")
        }
        val umk = keys.umk("Unlock ${entry.serverName}")
        val keyPath = "/api/boot/share/key/${entry.serverDomain}"
        val got = call(apex, "GET", "${bootBase()}$keyPath", headers = mapOf("Authorization" to shareAuth(umk, entry, "GET", keyPath)))
        if (got.status == 404 || got.status == 403) {
            throw ShareException(ShareException.Kind.NotShared, "The owner hasn't let you start this server.")
        }
        expectOk(got, "read your start-up copy")
        val blob = HexUtil.decode(decode(got, SealedKeyWire.serializer()).sealedKey)
            ?: throw ShareException(ShareException.Kind.Invalid, "Your start-up copy is damaged.")
        val diskKey = try {
            SecretSeal.openWithEd25519Seed(blob, ServerShare.deriveShareMemberKeySeed(umk, entry.shareId))
        } catch (_: Exception) {
            throw ShareException(ShareException.Kind.Invalid, "Your start-up copy can't be opened on this phone.")
        }
        val stk = HexUtil.decode(offer.stkPubHex)!!
        val req = startup.pending.request
        val sealed = HexUtil.encode(SealedSecretResponse.build(diskKey, stk, req.nonce, SecretPurpose.UNLOCK_KEY))
        diskKey.fill(0)
        val path = "/api/boot/response"
        val body = BootShareResponseBody(BootShareResponse(entry.serverDomain, req.nonce, SecretPurpose.UNLOCK_KEY.wire, sealed, now()))
        val r = post(apex, "${bootBase()}$path", body, BootShareResponseBody.serializer(), mapOf("Authorization" to shareAuth(umk, entry, "POST", path)))
        if (r.status == 409) return
        expectOk(r, "approve the start-up")
    }

    private fun shareAuth(umk: ByteArray, entry: SharedEntry, method: String, path: String): String =
        BootAuth.shareHeader(
            serverDomain = entry.serverDomain,
            method = method,
            path = path,
            signer = ServerShare.deriveShareMemberKey(umk, entry.shareId),
            memberPubHex = HexUtil.encode(ServerShare.deriveShareMemberPub(umk, entry.shareId)),
            issuedAt = now(),
            nonce = random(32),
        )

    /** The member key that signs B's manage-level actions (access lists) on this server. */
    suspend fun memberSigner(entry: SharedEntry, reason: String): Ed25519Sign =
        ServerShare.deriveShareMemberKey(keys.umk(reason), entry.shareId)

    // ── Co-manager invites (docs/service-access-gating.md "Co-manager invites") ──

    /** A box call over this share's session, signing in again once if the box says it expired. */
    private suspend fun withShareSession(entry: SharedEntry, send: suspend (String) -> HttpResponse): HttpResponse {
        val notShared = ShareInviteRefusal("not-shared", ShareCoInviteCopy.WHY.getValue("not-shared"))
        val s = (signIn(entry) as? ShareSignIn.In)?.session ?: throw notShared
        val r = send(s.token)
        if (r.status != 401) return r
        forgetSession(entry.shareId)
        val again = (signIn(entry, reuse = false) as? ShareSignIn.In)?.session ?: throw notShared
        return send(again.token)
    }

    private fun inviteRefusal(r: HttpResponse, fallback: String): ShareInviteRefusal {
        val o = errorObject(r)
        val code = (o?.get("code") as? JsonPrimitive)?.content
        val error = (o?.get("error") as? JsonPrimitive)?.content
        return ShareInviteRefusal(code, ShareInviteRefusal.text(code, error, fallback))
    }

    /** Whether B may invite to [serviceRef] and B's own invites there, names opened with B's bundle key. */
    suspend fun coInvites(entry: SharedEntry, serviceRef: String): ShareCoInviteState {
        val r = withShareSession(entry) { boxCall("GET", entry.serverDomain, "/api/shares/invites?service=${enc(serviceRef)}", it) }
        if (r.status !in 200..299) throw inviteRefusal(r, ShareCoInviteCopy.READ_FAILED)
        val body = decode(r, ShareInvitesWire.serializer())
        val umk = keys.umk("See who you invited to ${entry.serverName}")
        return ShareCoInviteState.from(body, ServerShare.deriveShareInviteBundleKey(umk, entry.shareId))
    }

    /**
     * Invite someone (or a group) to an app on the shared server at Member:
     * `flagship/service-invite/create/v1` signed with B's member key, handed to
     * the box, and the link built on the shared server.
     */
    suspend fun createCoInvite(
        entry: SharedEntry,
        serviceRef: String,
        ownerAid: String?,
        name: String,
        group: ShareCoInviteGroup? = null,
    ): ShareCoInviteCreated {
        val label = name.trim()
        if (label.isEmpty()) {
            throw ShareInviteRefusal("no-name", if (group == null) ShareCoInviteCopy.NO_NAME else ShareCoInviteCopy.NO_GROUP_NAME)
        }
        if (ownerAid == null || !Regex("^[0-9a-f]{64}$").matches(ownerAid)) {
            throw ShareInviteRefusal("no-owner", ShareCoInviteCopy.NO_OWNER)
        }
        val umk = keys.umk("Invite someone to ${entry.serverName}")
        val secret = random(32)
        val inviteId = HexUtil.encode(random(32))
        val request = ShareInviteCreateRequest(
            inviteId = inviteId,
            authorAID = ownerAid,
            serviceRef = serviceRef,
            secretHash = ServiceInvite.secretHash(secret),
            encryptedBundle = ServiceInvite.sealBundle(
                ServiceInvite.Bundle(name = label), ServerShare.deriveShareInviteBundleKey(umk, entry.shareId), inviteId,
            ),
            issuedAt = now(),
            maxRedemptions = group?.maxRedemptions,
            expiresAt = group?.expiresAt,
        )
        val sig = HexUtil.encode(ServerShare.deriveShareMemberKey(umk, entry.shareId).sign(request.canonicalBytes()))
        val body = ShareInviteCreateBody(request, sig)
        val r = withShareSession(entry) { boxPost(entry.serverDomain, "/api/shares/invites", it, body, ShareInviteCreateBody.serializer()) }
        if (r.status !in 200..299) throw inviteRefusal(r, ShareCoInviteCopy.CREATE_FAILED)
        val link = InviteLink.shareLink(entry.serverDomain.lowercase(), HexUtil.encode(secret), ownerAid, inviteId, serviceRef)
        return ShareCoInviteCreated(inviteId, link)
    }

    /** Withdraw one of B's own invites: `flagship/service-invite/revoke/v1` signed with B's member key. */
    suspend fun withdrawCoInvite(entry: SharedEntry, inviteId: String) {
        val member = ServerShare.deriveShareMemberKey(keys.umk("Withdraw an invite to ${entry.serverName}"), entry.shareId)
        val revoke = ShareInviteRevoke(inviteId, now())
        val body = ShareInviteWithdrawBody(revoke, HexUtil.encode(member.sign(revoke.canonicalBytes())))
        val r = withShareSession(entry) { boxPost(entry.serverDomain, "/api/shares/invites/withdraw", it, body, ShareInviteWithdrawBody.serializer()) }
        if (r.status !in 200..299) throw inviteRefusal(r, ShareCoInviteCopy.WITHDRAW_FAILED)
    }

    // ── HTTP ─────────────────────────────────────────────────────────────

    private suspend fun call(t: JsonHttpTransport, method: String, url: String, body: String? = null, headers: Map<String, String> = emptyMap()): HttpResponse =
        t.execute(method, url, body?.toByteArray(Charsets.UTF_8), if (body != null) "application/json" else null, headers, ALL)

    private suspend fun <T> post(t: JsonHttpTransport, url: String, body: T, s: KSerializer<T>, headers: Map<String, String> = emptyMap()): HttpResponse =
        call(t, "POST", url, json.encodeToString(s, body), headers)

    private suspend fun boxCall(method: String, serverDomain: String, path: String, session: String?): HttpResponse =
        call(box, method, "${boxBase(serverDomain)}$path", headers = session?.let { mapOf(SESSION_HEADER to it) }.orEmpty())

    private suspend fun <T> boxPost(serverDomain: String, path: String, session: String?, body: T, s: KSerializer<T>): HttpResponse =
        call(box, "POST", "${boxBase(serverDomain)}$path", json.encodeToString(s, body), session?.let { mapOf(SESSION_HEADER to it) }.orEmpty())

    private fun <R> decode(r: HttpResponse, s: KSerializer<R>): R = json.decodeFromString(s, String(r.body, Charsets.UTF_8))

    private fun errorObject(r: HttpResponse): JsonObject? =
        runCatching { Json.parseToJsonElement(String(r.body, Charsets.UTF_8)) as? JsonObject }.getOrNull()

    private fun errorCode(r: HttpResponse): String? {
        val o = errorObject(r) ?: return null
        return ((o["code"] ?: o["error"]) as? JsonPrimitive)?.content
    }

    private fun errorText(r: HttpResponse): String =
        (errorObject(r)?.get("error") as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() } ?: "error ${r.status}"

    private fun expectOk(r: HttpResponse, what: String) {
        if (r.status in 200..299) return
        val kind = when (r.status) {
            404 -> ShareException.Kind.NotFound
            410 -> ShareException.Kind.Ended
            else -> ShareException.Kind.Refused
        }
        throw ShareException(kind, "Couldn't $what: ${errorText(r)}.")
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
}
