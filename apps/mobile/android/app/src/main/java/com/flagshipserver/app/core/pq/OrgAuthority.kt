package com.flagshipserver.app.core.pq

import java.security.MessageDigest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters

/**
 * Enterprise org authority (docs/enterprise-accounts.md): canonical forms, approvals, the chain, the
 * seat book and the predicate. Kotlin twin of packages/protocol/src/orgAuthority.ts; every port
 * reads packages/protocol/test-vectors/org-authority/vectors.json.
 */
class OrgAuthorityException(val code: String, detail: String = "") : Exception(if (detail.isEmpty()) code else "$code: $detail")

enum class OrgAdminKind(val wire: String) { ADMIN("admin"), BOARD("board"), RECOVERY("recovery") }

/**
 * Where a seat's admin key lives (docs/webapp-key-custody.md items 1 and 3): HARDWARE (a phone, the default) or
 * BROWSER ("Browser: software key, unlocked with a passkey"). Encoded only when BROWSER.
 */
enum class OrgCustody(val wire: String) { HARDWARE("hardware"), BROWSER("browser") }

data class OrgAdminEntry(val seatId: String, val kind: OrgAdminKind, val binding: PqTrust.Wire, val custody: OrgCustody = OrgCustody.HARDWARE)

/**
 * [overturnSeats] null = every admin; [overturnK] 0 = a majority of the set. [hardwareAdmins]: admin keys must be
 * hardware custody. [quorumHardware] (default): a quorum of two or more needs a hardware-custody approval.
 */
data class OrgBylaws(val overturnSeats: List<String>?, val overturnK: Int, val vetoK: Int, val hardwareAdmins: Boolean = false, val quorumHardware: Boolean = true)

data class OrgAuthorityRecord(
    val orgId: String, val version: Long, val prevHash: String, val admins: List<OrgAdminEntry>, val bylaws: OrgBylaws,
    val founderSeatId: String, val kGov: Int, val kGrant: Int, val kDestroy: Int, val kSite: Int, val issuedAt: Long,
) {
    val authorityAdmins: List<OrgAdminEntry> get() = admins.filter { it.kind == OrgAdminKind.ADMIN }
}

data class OrgApproval(
    val orgId: String, val oarVersion: Long, val purposeTag: String, val orderSha256: String, val seatId: String,
    val adminKeyId: String, val notAfter: Long, val issuedAt: Long, val signature: String,
)

data class OrgSigned<T>(val body: T, val approvals: List<OrgApproval>)
data class OrgDelayedChange(val orgId: String, val oarVersion: Long, val kind: String, val nextRecordSha256: String, val effectiveAt: Long, val issuedAt: Long)
data class OrgVeto(val orgId: String, val noticeSha256: String, val issuedAt: Long)
data class OrgSeatFreeze(val orgId: String, val seatId: String, val untilMs: Long, val oarVersion: Long, val issuedAt: Long)
data class OrgOverturn(val orgId: String, val freezeSha256: String, val oarVersion: Long, val issuedAt: Long)
data class OrgAuthorityEntry(val record: OrgAuthorityRecord, val via: String, val approvals: List<OrgApproval>, val notice: OrgSigned<OrgDelayedChange>?, val overturnOf: Long?)

sealed class OrgSeatRole {
    object Member : OrgSeatRole()
    object ServersAdd : OrgSeatRole()
    data class ServerAdmin(val servers: List<String>?) : OrgSeatRole()
    data class ServiceAdmin(val apps: List<String>) : OrgSeatRole()
    data class Unlock(val servers: List<String>) : OrgSeatRole()
    val raisesAdmin: Boolean get() = this is ServerAdmin || this is ServiceAdmin || this is ServersAdd
}

data class OrgSeatGrant(
    val orgId: String, val seatId: String, val labelSha256: String, val memberKeyId: String, val adminKeyId: String,
    val rolesHash: String, val oarVersion: Long, val issuedAt: Long, val expiresAt: Long,
    val custody: OrgCustody = OrgCustody.HARDWARE,
)
data class OrgSeatGrantBundle(val grant: OrgSeatGrant, val roles: List<OrgSeatRole>, val memberBinding: PqTrust.Wire, val adminBinding: PqTrust.Wire?, val approvals: List<OrgApproval>)
data class OrgSeatRevokeBundle(val orgId: String, val seatId: String, val reason: String, val oarVersion: Long, val issuedAt: Long, val approvals: List<OrgApproval>, val selfSignature: String?)
data class OrgVerifiedFreeze(val seatId: String, val bySeatId: String, val issuedAt: Long, val untilMs: Long, val sha256: String)
class OrgSeat(val seatId: String, val roles: List<OrgSeatRole>, val member: PqTrust.VerifiedBinding, val admin: PqTrust.VerifiedBinding?, val grant: OrgSeatGrant)
class OrgSeatBook(val seats: MutableMap<String, OrgSeat> = mutableMapOf(), val revoked: MutableSet<String> = mutableSetOf(), var freezes: List<OrgVerifiedFreeze> = emptyList(), val refused: MutableList<Pair<String, String>> = mutableListOf())

class OrgAuthorityState internal constructor(val records: List<OrgAuthorityRecord>, internal val bindings: Map<String, PqTrust.VerifiedBinding>) {
    val orgId: String get() = records[0].orgId
    val current: OrgAuthorityRecord get() = records.last()
    fun record(v: Long) = records.firstOrNull { it.version == v }
    internal fun binding(v: Long, seat: String) = bindings["$v:$seat"]
}

sealed class OrgAction {
    data class SeatGrant(val roles: List<OrgSeatRole>) : OrgAction()
    object SeatInvite : OrgAction()
    object SeatRevoke : OrgAction()
    object Freeze : OrgAction()
    object AddServer : OrgAction()
    object Destroy : OrgAction()
    object Site : OrgAction()
    data class Operate(val server: String) : OrgAction()
    data class AppAdmin(val server: String, val serviceRef: String) : OrgAction()
}

object OrgAuthority {
    const val TAG_AUTHORITY = "flagship/org-authority/v1"
    const val TAG_ADMINS = "flagship/org-admins/v1"
    const val TAG_BYLAWS = "flagship/org-bylaws/v1"
    const val TAG_APPROVAL = "flagship/org-approval/v1"
    const val TAG_DELAYED_CHANGE = "flagship/org-delayed-change/v1"
    const val TAG_VETO = "flagship/org-veto/v1"
    const val TAG_SEAT_INVITE = "flagship/org-seat-invite/v1"
    const val TAG_SEAT_ACCEPT = "flagship/org-seat-accept/v1"
    const val TAG_SEAT_GRANT = "flagship/org-seat-grant/v1"
    const val TAG_SEAT_ROLES = "flagship/org-seat-roles/v1"
    const val TAG_SEAT_REVOKE = "flagship/org-seat-revoke/v1"
    const val TAG_SEAT_FREEZE = "flagship/org-seat-freeze/v1"
    const val TAG_OVERTURN = "flagship/org-overturn/v1"
    const val TAG_SEAT_SAS = "flagship/org-seat-sas/v1"
    const val TAG_SEAT_MEMBER_KDF = "flagship/org-seat-member/v1"
    const val TAG_SEAT_MEMBER_PQ_KDF = "flagship/org-seat-member-pq/v1"
    const val TAG_INVITE_OFFER_KDF = "flagship/org-invite-offer/v1"
    const val TAG_INVITE_KEY_KDF = "flagship/org-invite-key/v1"
    const val TAG_INVITE_READ = "flagship/org-invite-read/v1"
    const val TAG_INVITE_WITHDRAW = "flagship/org-invite-withdraw/v1"

    private const val HOUR = 3_600_000L
    private const val DAY = 24 * HOUR
    const val FREEZE_MAX_MS = 72 * HOUR
    const val FREEZE_COOLDOWN_MS = 7 * DAY
    const val FOUNDER_NOTICE_MS = 7 * DAY
    const val RECOVERY_NOTICE_MS = 14 * DAY
    const val PREVIOUS_OAR_GRACE_MS = 24 * HOUR
    const val APPROVAL_MAX_LIFETIME_MS = 7 * DAY
    const val GRANT_MAX_LIFETIME_MS = 400 * DAY
    const val INVITE_MAX_LIFETIME_MS = 14 * DAY
    const val MAX_SKEW_MS = 5 * 60 * 1000L
    const val K_MAX = 7
    const val MAX_ADMINS = 32
    val GENESIS_PREV = "0".repeat(64)

    private fun fail(code: String, detail: String = ""): Nothing = throw OrgAuthorityException(code, detail)
    private fun need(ok: Boolean, code: String, detail: String = "") { if (!ok) fail(code, detail) }
    private fun hex(s: String, n: Int) = s.length == n && PqHex.isHex(s)
    private fun join(vararg p: Any): ByteArray = p.joinToString("|").toByteArray(Charsets.UTF_8)
    fun sha256Hex(b: ByteArray): String = PqHex.encode(MessageDigest.getInstance("SHA-256").digest(b))
    fun seatSubject(orgId: String, seatId: String) = "$orgId:$seatId"

    fun canonicalAdmins(admins: List<OrgAdminEntry>): ByteArray {
        val lines = admins.map {
            need(hex(it.seatId, 32) && hex(it.binding.ed25519PubHex, 64) && hex(it.binding.mldsaPubHex, 3904), "malformed", "admins")
            "${it.seatId}:${it.kind.wire}:${it.binding.ed25519PubHex}:${it.binding.mldsaPubHex}" + if (it.custody == OrgCustody.BROWSER) ":browser" else ""
        }
        return "$TAG_ADMINS|${lines.sorted().joinToString(",")}".toByteArray(Charsets.UTF_8)
    }

    fun canonicalBylaws(b: OrgBylaws): ByteArray {
        need(b.overturnK >= 0 && b.vetoK >= 0, "malformed", "bylaws k")
        val seats = b.overturnSeats?.let { s ->
            need(s.isNotEmpty(), "bylaws", "overturnSeats")
            s.forEach { need(hex(it, 32), "malformed", "overturnSeats") }
            s.sorted().joinToString(",")
        } ?: "*"
        val extra = (if (b.hardwareAdmins) "|hardware-admins" else "") + (if (b.quorumHardware) "" else "|browser-quorums")
        return "$TAG_BYLAWS|${b.overturnK}|$seats|${b.vetoK}$extra".toByteArray(Charsets.UTF_8)
    }

    fun canonicalAuthority(r: OrgAuthorityRecord): ByteArray {
        need(hex(r.orgId, 32) && hex(r.prevHash, 64) && hex(r.founderSeatId, 32), "malformed", "record ids")
        need(r.version >= 0 && r.issuedAt >= 0 && listOf(r.kGov, r.kGrant, r.kDestroy, r.kSite).all { it >= 0 }, "malformed", "numbers")
        return join(TAG_AUTHORITY, r.orgId, r.version, r.prevHash, sha256Hex(canonicalAdmins(r.admins)), sha256Hex(canonicalBylaws(r.bylaws)),
            r.founderSeatId, r.kGov, r.kGrant, r.kDestroy, r.kSite, r.issuedAt)
    }

    fun authorityHash(r: OrgAuthorityRecord) = sha256Hex(canonicalAuthority(r))
    fun overturnSet(r: OrgAuthorityRecord): List<String> = r.bylaws.overturnSeats ?: r.authorityAdmins.map { it.seatId }
    fun overturnThreshold(r: OrgAuthorityRecord) = if (r.bylaws.overturnK == 0) overturnSet(r).size / 2 + 1 else r.bylaws.overturnK
    fun bylawsThreshold(r: OrgAuthorityRecord): Int {
        val n = r.authorityAdmins.size
        return minOf(n, maxOf(r.kGov, r.kDestroy, r.kSite, overturnThreshold(r), (2 * n + 2) / 3))
    }

    fun checkShape(r: OrgAuthorityRecord) {
        canonicalAuthority(r)
        need(r.admins.isNotEmpty() && r.admins.size <= MAX_ADMINS, "malformed", "admins")
        need(r.admins.map { it.seatId }.toSet().size == r.admins.size, "malformed", "duplicate seat")
        need(r.admins.map { it.binding.ed25519PubHex }.toSet().size == r.admins.size, "malformed", "duplicate key")
        val n = r.authorityAdmins.size
        need(n > 0, "thresholds", "no admin")
        need(r.admins.firstOrNull { it.seatId == r.founderSeatId }?.kind == OrgAdminKind.ADMIN, "founder")
        listOf(r.kGov, r.kGrant, r.kDestroy, r.kSite).forEach { need(it in 1..minOf(n, K_MAX), "thresholds") }
        need(r.kGov >= minOf(2, n) && r.kDestroy >= minOf(2, n), "thresholds", "floor")
        r.bylaws.overturnSeats?.let { s ->
            need(s.toSet().size == s.size, "bylaws", "duplicate seat")
            s.forEach { x -> need(r.admins.any { it.seatId == x && it.kind != OrgAdminKind.RECOVERY }, "bylaws", "overturn seat") }
        }
        val size = overturnSet(r).size
        need(size > 0 && overturnThreshold(r) <= size && overturnThreshold(r) <= K_MAX, "bylaws", "overturnK")
        need(r.bylaws.vetoK in 1..K_MAX, "bylaws", "vetoK")
        if (r.bylaws.hardwareAdmins) r.admins.forEach { need(it.custody == OrgCustody.HARDWARE, "custody", it.seatId) }
    }

    /** The bylaws' quorum rule: a quorum of two or more needs a hardware-custody approval, unless turned off. */
    fun checkQuorumCustody(r: OrgAuthorityRecord, k: Int, signers: List<String>, custodyOf: (String) -> OrgCustody) {
        if (!r.bylaws.quorumHardware || k < 2 || signers.isEmpty()) return
        need(signers.any { custodyOf(it) == OrgCustody.HARDWARE }, "custody", "a quorum of two or more needs a hardware approval")
    }

    private fun browserSuffix(c: OrgCustody): ByteArray = if (c == OrgCustody.BROWSER) "|browser".toByteArray(Charsets.UTF_8) else ByteArray(0)

    private fun adminCustody(r: OrgAuthorityRecord): (String) -> OrgCustody = { s -> r.admins.firstOrNull { it.seatId == s }?.custody ?: OrgCustody.HARDWARE }

    private val PURPOSE = Regex("^flagship/[a-z0-9/-]+/v[1-9][0-9]*$")

    fun canonicalApproval(a: OrgApproval): ByteArray {
        need(hex(a.orgId, 32) && hex(a.orderSha256, 64) && hex(a.seatId, 32) && hex(a.adminKeyId, 64), "malformed", "approval ids")
        need(PURPOSE.matches(a.purposeTag), "malformed", "purposeTag")
        need(a.oarVersion >= 0 && a.notAfter >= 0 && a.issuedAt >= 0, "malformed", "numbers")
        return join(TAG_APPROVAL, a.orgId, a.oarVersion, a.purposeTag, a.orderSha256, a.seatId, a.adminKeyId, a.notAfter, a.issuedAt)
    }

    fun keyIdHex(ed25519PubHex: String, mldsaPubHex: String): String =
        PqHex.encode(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, PqTrust.pqBindingPublicKey(ed25519PubHex, mldsaPubHex)))

    /** One admin's approval of [order]; [sign] is the seat admin key's hybrid signer (purpose, payload). */
    fun signApproval(orgId: String, oarVersion: Long, order: ByteArray, seatId: String, adminKeyId: String, issuedAt: Long, notAfter: Long, sign: (String, ByteArray) -> ByteArray): OrgApproval {
        val unsigned = OrgApproval(orgId, oarVersion, PqTrust.messagePurpose(order), sha256Hex(order), seatId, adminKeyId, notAfter, issuedAt, "")
        return unsigned.copy(signature = PqHex.encode(sign(TAG_APPROVAL, canonicalApproval(unsigned))))
    }

    fun canonical(c: OrgDelayedChange): ByteArray {
        need(hex(c.orgId, 32) && hex(c.nextRecordSha256, 64) && (c.kind == "founder-removal" || c.kind == "recovery"), "malformed", "notice")
        return join(TAG_DELAYED_CHANGE, c.orgId, c.oarVersion, c.kind, c.nextRecordSha256, c.effectiveAt, c.issuedAt)
    }
    fun canonical(v: OrgVeto): ByteArray { need(hex(v.orgId, 32) && hex(v.noticeSha256, 64), "malformed", "veto"); return join(TAG_VETO, v.orgId, v.noticeSha256, v.issuedAt) }
    fun canonical(f: OrgSeatFreeze): ByteArray { need(hex(f.orgId, 32) && hex(f.seatId, 32), "malformed", "freeze"); return join(TAG_SEAT_FREEZE, f.orgId, f.seatId, f.untilMs, f.oarVersion, f.issuedAt) }
    fun canonical(o: OrgOverturn): ByteArray { need(hex(o.orgId, 32) && hex(o.freezeSha256, 64), "malformed", "overturn"); return join(TAG_OVERTURN, o.orgId, o.freezeSha256, o.oarVersion, o.issuedAt) }

    fun canonicalSeatInvite(orgId: String, seatId: String, labelSha256: String, rolesHash: String, oarVersion: Long, issuedAt: Long, expiresAt: Long, inviteKeyPub: String): ByteArray {
        need(hex(labelSha256, 64), "label-missing")
        need(hex(orgId, 32) && hex(seatId, 32) && hex(rolesHash, 64), "malformed", "invite")
        need(expiresAt > issuedAt && expiresAt - issuedAt <= INVITE_MAX_LIFETIME_MS, "malformed", "expiresAt")
        need(hex(inviteKeyPub, 2 * INVITE_KEY_PUB_LEN), "malformed", "inviteKeyPub")
        return join(TAG_SEAT_INVITE, orgId, seatId, labelSha256, rolesHash, oarVersion, issuedAt, expiresAt, inviteKeyPub)
    }

    /** An invite as served (`invite` of `GET /invites/<seat>` or `/seats`): its canonical bytes, or null when malformed. */
    fun canonicalSeatInvite(invite: JsonObject): ByteArray? = runCatching {
        fun s(k: String) = (invite[k] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail("malformed", k)
        fun n(k: String) = wireNum(invite[k]) ?: fail("malformed", k)
        canonicalSeatInvite(s("orgId"), s("seatId"), s("labelSha256"), s("rolesHash"), n("oarVersion"), n("issuedAt"), n("expiresAt"), s("inviteKeyPub"))
    }.getOrNull()

    // ── the invite link's keys (docs/enterprise-accounts.md §7) ──

    private const val INVITE_KEY_PUB_LEN = 1984

    private fun wireNum(e: JsonElement?): Long? {
        val p = e as? JsonPrimitive ?: return null
        if (p.isString) return null
        val d = p.content.toDoubleOrNull() ?: return null
        return if (d.isNaN() || d != Math.floor(d) || d < 0 || d > PqHybrid.MAX_SAFE_INTEGER) null else d.toLong()
    }

    /** What an invite link's key k derives: the offer key (AES-256-GCM) and the invite key (hybrid). Wipe after use. */
    class InviteKeys(val offerKey: ByteArray, val secret: ByteArray, val publicKey: ByteArray) {
        val inviteKeyPub: String get() = PqHex.encode(publicKey)
        fun wipe() { offerKey.fill(0); secret.fill(0) }
    }

    fun inviteKeys(linkKey: ByteArray): InviteKeys {
        need(linkKey.size == 32, "malformed", "link key")
        fun derive(tag: String, n: Int): ByteArray {
            val g = HKDFBytesGenerator(SHA256Digest())
            g.init(HKDFParameters(linkKey, ByteArray(0), tag.toByteArray(Charsets.UTF_8)))
            return ByteArray(n).also { g.generateBytes(it, 0, n) }
        }
        val seed = derive(TAG_INVITE_KEY_KDF, 64)
        val kp = try { PqHybrid.hybridSigKeygen(seed.copyOfRange(0, 32), seed.copyOfRange(32, 64)) } finally { seed.fill(0) }
        return InviteKeys(derive(TAG_INVITE_OFFER_KDF, 32), kp.secretKey, kp.publicKey)
    }

    fun canonicalInviteRead(orgId: String, seatId: String, issuedAt: Long): ByteArray {
        need(hex(orgId, 32) && hex(seatId, 32) && issuedAt >= 0, "malformed", "invite read")
        return join(TAG_INVITE_READ, orgId, seatId, issuedAt)
    }

    /** The invite-key proof `GET /api/orgs/<orgId>/invites/<seatId>` needs (hex), fresh for 5 minutes. */
    fun inviteReadSignature(secret: ByteArray, orgId: String, seatId: String, issuedAt: Long, deterministic: Boolean = false): String =
        PqHex.encode(PqHybrid.hybridSign(secret, TAG_INVITE_READ, canonicalInviteRead(orgId, seatId, issuedAt), deterministic))

    private fun hybridOk(pubHex: String?, purpose: String, payload: ByteArray, sigHex: String?): Boolean {
        val pub = pubHex?.takeIf { hex(it, 2 * INVITE_KEY_PUB_LEN) }?.let { PqHex.decode(it) } ?: return false
        val sig = sigHex?.takeIf { hex(it, 6746) }?.let { PqHex.decode(it) } ?: return false
        return runCatching { PqHybrid.hybridVerify(pub, purpose, payload, sig) }.isSuccess
    }

    fun verifyInviteRead(orgId: String, seatId: String, inviteKeyPub: String?, issuedAt: Long, signature: String?, now: Long): Boolean {
        if (issuedAt < 0 || kotlin.math.abs(now - issuedAt) > MAX_SKEW_MS) return false
        val msg = runCatching { canonicalInviteRead(orgId, seatId, issuedAt) }.getOrNull() ?: return false
        return hybridOk(inviteKeyPub, TAG_INVITE_READ, msg, signature)
    }

    /** The invite key's signature over the accept's canonical bytes (hex): the joiner held the link. */
    fun inviteAcceptSignature(secret: ByteArray, acceptBytes: ByteArray, deterministic: Boolean = false): String =
        PqHex.encode(PqHybrid.hybridSign(secret, TAG_SEAT_ACCEPT, acceptBytes, deterministic))

    /** True when the served accept names [invite] and [signature] is its invite key's signature over the accept. */
    fun verifyInviteAccept(invite: JsonObject, accept: JsonObject, signature: String?): Boolean {
        fun s(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val inv = canonicalSeatInvite(invite) ?: return false
        if (s(accept, "orgId") != s(invite, "orgId") || s(accept, "seatId") != s(invite, "seatId") || s(accept, "inviteSha256") != sha256Hex(inv)) return false
        val custody = when (s(accept, "custody")) { null, "hardware" -> OrgCustody.HARDWARE; "browser" -> OrgCustody.BROWSER; else -> return false }
        val msg = runCatching {
            canonicalSeatAccept(s(accept, "orgId")!!, s(accept, "seatId")!!, s(accept, "inviteSha256")!!, s(accept, "memberKeyId") ?: "", s(accept, "adminKeyId") ?: "", wireNum(accept["issuedAt"])!!, custody)
        }.getOrNull() ?: return false
        return hybridOk(s(invite, "inviteKeyPub"), TAG_SEAT_ACCEPT, msg, signature)
    }

    /** An admin's order withdrawing an invitation not yet admitted (one org admin, as the invite). */
    fun canonicalInviteWithdraw(orgId: String, seatId: String, oarVersion: Long, issuedAt: Long): ByteArray {
        need(hex(orgId, 32) && hex(seatId, 32) && oarVersion >= 0 && issuedAt >= 0, "malformed", "withdraw")
        return join(TAG_INVITE_WITHDRAW, orgId, seatId, oarVersion, issuedAt)
    }

    fun canonicalSeatAccept(orgId: String, seatId: String, inviteSha256: String, memberKeyId: String, adminKeyId: String, issuedAt: Long, custody: OrgCustody = OrgCustody.HARDWARE): ByteArray {
        need(hex(orgId, 32) && hex(seatId, 32) && hex(inviteSha256, 64) && hex(memberKeyId, 64) && (adminKeyId.isEmpty() || hex(adminKeyId, 64)), "malformed", "accept")
        need(custody == OrgCustody.HARDWARE || adminKeyId.isNotEmpty(), "malformed", "custody without an admin key")
        return join(TAG_SEAT_ACCEPT, orgId, seatId, inviteSha256, memberKeyId, adminKeyId, issuedAt) + browserSuffix(custody)
    }

    fun canonical(g: OrgSeatGrant): ByteArray {
        need(hex(g.labelSha256, 64), "label-missing")
        need(hex(g.orgId, 32) && hex(g.seatId, 32) && hex(g.memberKeyId, 64) && (g.adminKeyId.isEmpty() || hex(g.adminKeyId, 64)) && hex(g.rolesHash, 64), "malformed", "grant")
        need(g.expiresAt > g.issuedAt && g.expiresAt - g.issuedAt <= GRANT_MAX_LIFETIME_MS, "malformed", "expiresAt")
        return join(TAG_SEAT_GRANT, g.orgId, g.seatId, g.labelSha256, g.memberKeyId, g.adminKeyId, g.rolesHash, g.oarVersion, g.issuedAt, g.expiresAt) + browserSuffix(g.custody)
    }

    private val REASON = Regex("^[a-z0-9][a-z0-9-]{0,47}$")
    fun canonical(v: OrgSeatRevokeBundle): ByteArray {
        need(hex(v.orgId, 32) && hex(v.seatId, 32) && REASON.matches(v.reason), "malformed", "revoke")
        return join(TAG_SEAT_REVOKE, v.orgId, v.seatId, v.reason, v.oarVersion, v.issuedAt)
    }

    private val SERVER = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private val REF = Regex("^[a-z0-9][a-z0-9._-]{0,127}$")

    fun canonicalRoles(roles: List<OrgSeatRole>): ByteArray {
        need(roles.isNotEmpty() && roles.size <= 8, "malformed", "roles")
        fun list(xs: List<String>, re: Regex): String {
            need(xs.isNotEmpty() && xs.size <= 256 && xs.toSet().size == xs.size && xs.all { re.matches(it) }, "malformed", "role targets")
            return xs.sorted().joinToString(",")
        }
        val lines = roles.map {
            when (it) {
                OrgSeatRole.Member -> "member"
                OrgSeatRole.ServersAdd -> "servers-add"
                is OrgSeatRole.ServerAdmin -> "server-admin:" + (it.servers?.let { s -> list(s, SERVER) } ?: "*")
                is OrgSeatRole.ServiceAdmin -> "service-admin:" + list(it.apps, REF)
                is OrgSeatRole.Unlock -> "unlock:" + list(it.servers, SERVER)
            }
        }
        need(lines.map { it.substringBefore(":") }.toSet().size == lines.size, "malformed", "role twice")
        return "$TAG_SEAT_ROLES|${lines.sorted().joinToString(";")}".toByteArray(Charsets.UTF_8)
    }

    fun rolesHash(roles: List<OrgSeatRole>) = sha256Hex(canonicalRoles(roles))
    fun grantThreshold(r: OrgAuthorityRecord, roles: List<OrgSeatRole>) =
        if (roles.any { it.raisesAdmin }) maxOf(r.kGrant, minOf(2, r.authorityAdmins.size)) else r.kGrant

    /** The 6-digit code both phones show before an admin approves a seat. */
    fun seatSas(inviteSha256: String, memberKeyId: String, adminKeyId: String): String {
        need(hex(inviteSha256, 64) && hex(memberKeyId, 64) && (adminKeyId.isEmpty() || hex(adminKeyId, 64)), "malformed", "sas")
        val d = MessageDigest.getInstance("SHA-256").digest(join(TAG_SEAT_SAS, inviteSha256, memberKeyId, adminKeyId))
        val n = ((d[0].toLong() and 0xff) shl 24) or ((d[1].toLong() and 0xff) shl 16) or ((d[2].toLong() and 0xff) shl 8) or (d[3].toLong() and 0xff)
        return (n % 1_000_000).toString().padStart(6, '0')
    }

    /** The seat member key's (Ed25519 seed, ML-DSA seed), from the person's UMK, for this org only. */
    fun memberSeeds(umk: ByteArray, orgId: String): Pair<ByteArray, ByteArray> {
        need(umk.size == 32 && hex(orgId, 32), "malformed", "seeds")
        fun derive(tag: String): ByteArray {
            val g = HKDFBytesGenerator(SHA256Digest())
            g.init(HKDFParameters(umk, ByteArray(0), "$tag|$orgId".toByteArray(Charsets.UTF_8)))
            return ByteArray(32).also { g.generateBytes(it, 0, 32) }
        }
        return derive(TAG_SEAT_MEMBER_KDF) to derive(TAG_SEAT_MEMBER_PQ_KDF)
    }

    private fun seatBinding(w: PqTrust.Wire, role: String, orgId: String, seatId: String, now: Long): PqTrust.VerifiedBinding = try {
        PqTrust.verifyPqKeyBinding(w, PqTrust.Expectation(role, seatSubject(orgId, seatId), w.ed25519PubHex, now = now))
    } catch (e: PqTrustException) {
        fail("binding", e.code)
    }

    internal fun checkApprovals(
        approvals: List<OrgApproval>, orgId: String, oarVersion: Long, order: ByteArray, now: Long,
        keyOf: (String) -> PqTrust.VerifiedBinding?, frozenAt: (String, Long) -> Boolean,
    ): List<String> {
        val purpose = PqTrust.messagePurpose(order)
        val digest = sha256Hex(order)
        val seen = mutableListOf<String>()
        for (a in approvals) {
            val msg = canonicalApproval(a)
            need(a.orgId == orgId, "wrong-org")
            need(a.oarVersion == oarVersion, "stale-oar")
            need(a.purposeTag == purpose && a.orderSha256 == digest, "order-mismatch")
            need(a.issuedAt <= now + MAX_SKEW_MS, "future")
            need(a.notAfter >= a.issuedAt && a.notAfter - a.issuedAt <= APPROVAL_MAX_LIFETIME_MS, "malformed", "notAfter")
            need(a.seatId !in seen, "duplicate-signer")
            seen += a.seatId
            val b = keyOf(a.seatId)
            if (b == null || b.keyIdHex != a.adminKeyId) fail("unknown-signer", a.seatId)
            val sig = PqHex.decode(a.signature)
            if (sig == null || sig.size != PqHybrid.HYBRID_SIG_LEN) fail("bad-signature")
            try { PqHybrid.hybridVerify(b.hybridPublicKey, TAG_APPROVAL, msg, sig) } catch (e: Exception) { fail("bad-signature") }
            need(!frozenAt(a.seatId, a.issuedAt), "frozen-signer", a.seatId)
        }
        return seen
    }

    fun founderRemovalOf(p: OrgAuthorityRecord, target: String, issuedAt: Long): OrgAuthorityRecord {
        need(target != p.founderSeatId, "founder")
        need(p.admins.firstOrNull { it.seatId == target }?.kind == OrgAdminKind.ADMIN, "seat-unknown")
        val admins = p.admins.filter { it.seatId != target }
        val n = admins.count { it.kind == OrgAdminKind.ADMIN }
        fun clamp(k: Int) = maxOf(1, minOf(k, n))
        var bylaws = p.bylaws
        val s = bylaws.overturnSeats
        if (s != null && target in s) {
            val seats = s.filter { it != target }
            bylaws = bylaws.copy(overturnSeats = seats.ifEmpty { null }, overturnK = if (bylaws.overturnK == 0) 0 else minOf(bylaws.overturnK, if (seats.isEmpty()) n else seats.size))
        }
        return p.copy(version = p.version + 1, prevHash = authorityHash(p), admins = admins, bylaws = bylaws,
            kGov = clamp(p.kGov), kGrant = clamp(p.kGrant), kDestroy = clamp(p.kDestroy), kSite = clamp(p.kSite), issuedAt = issuedAt)
    }

    fun overturnOf(p: OrgAuthorityRecord, before: OrgAuthorityRecord, after: OrgAuthorityRecord, issuedAt: Long): OrgAuthorityRecord {
        val admins = p.admins.toMutableList()
        for (a in before.admins) if (after.admins.none { it.seatId == a.seatId } && admins.none { it.seatId == a.seatId }) admins += a
        return p.copy(version = p.version + 1, prevHash = authorityHash(p), admins = admins, issuedAt = issuedAt)
    }

    private fun verifiedFreezes(records: List<OrgAuthorityRecord>, bindings: Map<String, PqTrust.VerifiedBinding>, orgId: String,
                                freezes: List<OrgSigned<OrgSeatFreeze>>, overturns: List<OrgSigned<OrgOverturn>>, now: Long): List<OrgVerifiedFreeze> {
        val out = mutableListOf<OrgVerifiedFreeze>()
        val lastBy = mutableMapOf<String, Long>()
        for (f in freezes.sortedBy { it.body.issuedAt }) {
            val v = try { checkFreeze(f, records, bindings, orgId, now, out) } catch (e: Exception) { continue }
            val last = lastBy[v.bySeatId]
            if (last != null && v.issuedAt - last < FREEZE_COOLDOWN_MS) continue
            lastBy[v.bySeatId] = v.issuedAt
            if (overturns.any { o -> overturns(o, v, records, bindings, orgId, now) }) continue
            out += v
        }
        return out
    }

    private fun checkFreeze(f: OrgSigned<OrgSeatFreeze>, records: List<OrgAuthorityRecord>, bindings: Map<String, PqTrust.VerifiedBinding>,
                            orgId: String, now: Long, earlier: List<OrgVerifiedFreeze>): OrgVerifiedFreeze {
        val b = f.body
        val order = canonical(b)
        need(b.orgId == orgId, "wrong-org")
        val r = records.firstOrNull { it.version == b.oarVersion } ?: fail("stale-oar")
        need(b.untilMs > b.issuedAt, "malformed")
        need(b.untilMs - b.issuedAt <= FREEZE_MAX_MS, "freeze-too-long")
        val signers = checkApprovals(f.approvals, orgId, b.oarVersion, order, now, { bindings["${b.oarVersion}:$it"] }) { s, t ->
            earlier.any { it.seatId == s && it.issuedAt <= t && t < it.untilMs }
        }
        need(signers.size == 1, "threshold")
        need(r.admins.firstOrNull { it.seatId == signers[0] }?.kind == OrgAdminKind.ADMIN, "not-an-admin")
        need(signers[0] != b.seatId, "freeze-self")
        return OrgVerifiedFreeze(b.seatId, signers[0], b.issuedAt, b.untilMs, sha256Hex(order))
    }

    private fun overturns(o: OrgSigned<OrgOverturn>, v: OrgVerifiedFreeze, records: List<OrgAuthorityRecord>,
                          bindings: Map<String, PqTrust.VerifiedBinding>, orgId: String, now: Long): Boolean = try {
        if (o.body.orgId != orgId || o.body.freezeSha256 != v.sha256) false else {
            val r = records.first { it.version == o.body.oarVersion }
            val signers = checkApprovals(o.approvals, orgId, r.version, canonical(o.body), now, { bindings["${r.version}:$it"] }) { _, _ -> false }
            val set = overturnSet(r).filter { it != v.seatId }.toSet()
            signers.count { it in set } >= overturnThreshold(r)
        }
    } catch (e: Exception) {
        false
    }

    fun verifyChain(
        entries: List<OrgAuthorityEntry>, genesisHash: String, now: Long,
        freezes: List<OrgSigned<OrgSeatFreeze>> = emptyList(), overturns: List<OrgSigned<OrgOverturn>> = emptyList(),
        vetoes: List<OrgSigned<OrgVeto>> = emptyList(),
        /** When `.com` observed each delayed-change notice open, by its sha256 (`noticeOpenedAt` on the authority read). */
        noticeOpenedAt: Map<String, Long> = emptyMap(),
    ): OrgAuthorityState {
        need(entries.isNotEmpty(), "malformed", "empty chain")
        val records = mutableListOf<OrgAuthorityRecord>()
        val bindings = mutableMapOf<String, PqTrust.VerifiedBinding>()
        // One delayed change at a time: each is observed only after the one before it took effect.
        var lastDelayedAt = -1L
        for (e in entries) {
            val r = e.record
            checkShape(r)
            need(r.issuedAt <= now + MAX_SKEW_MS, "future")
            val verified = r.admins.associate { it.seatId to seatBinding(it.binding, "org-seat-admin", r.orgId, it.seatId, now) }
            val order = canonicalAuthority(r)
            val p = records.lastOrNull()
            if (p == null) {
                need(e.via == "genesis" && r.version == 0L && r.prevHash == GENESIS_PREV, "version-gap", "genesis")
                need(authorityHash(r) == genesisHash, "prev-hash", "genesis hash")
                val signers = checkApprovals(e.approvals, r.orgId, 0, order, now, { verified[it] }) { _, _ -> false }
                r.admins.forEach { need(it.seatId in signers, "consent-missing", it.seatId) }
            } else {
                need(r.orgId == p.orgId, "wrong-org")
                need(r.version == p.version + 1, "version-gap")
                need(r.prevHash == authorityHash(p), "prev-hash")
                need(r.issuedAt > p.issuedAt, "not-after-previous")
                val fs = verifiedFreezes(records, bindings, r.orgId, freezes, overturns, now)
                val frozen = { s: String, t: Long -> fs.any { it.seatId == s && it.issuedAt <= t && t < it.untilMs } }
                transition(e, p, records, bindings, verified, frozen, vetoes, now, noticeOpenedAt, lastDelayedAt)
                if (e.via == "founder-removal" || e.via == "recovery") lastDelayedAt = r.issuedAt
            }
            records += r
            verified.forEach { (s, b) -> bindings["${r.version}:$s"] = b }
        }
        return OrgAuthorityState(records.toList(), bindings.toMap())
    }

    private fun transition(
        e: OrgAuthorityEntry, p: OrgAuthorityRecord, records: List<OrgAuthorityRecord>, bindings: Map<String, PqTrust.VerifiedBinding>,
        verified: Map<String, PqTrust.VerifiedBinding>, frozen: (String, Long) -> Boolean, vetoes: List<OrgSigned<OrgVeto>>, now: Long,
        noticeOpenedAt: Map<String, Long>, lastDelayedAt: Long,
    ) {
        val r = e.record
        val order = canonicalAuthority(r)
        val prevKey = { s: String -> bindings["${p.version}:$s"] }
        val kindOf = { s: String -> p.admins.firstOrNull { it.seatId == s }?.kind }
        val removed = p.admins.filter { a -> r.admins.none { it.seatId == a.seatId } }.map { it.seatId }
        val newcomers = r.admins.filter { a ->
            val old = p.admins.firstOrNull { it.seatId == a.seatId }
            old == null || old.binding.ed25519PubHex != a.binding.ed25519PubHex || old.binding.mldsaPubHex != a.binding.mldsaPubHex
        }.map { it.seatId }
        val bylawsChanged = !canonicalBylaws(p.bylaws).contentEquals(canonicalBylaws(r.bylaws))
        val founderMoved = p.founderSeatId != r.founderSeatId
        val consent = e.approvals.filter { it.seatId in newcomers && it.oarVersion == r.version }
        val ordinary = e.approvals.filter { it !in consent }
        val consenting = checkApprovals(consent, r.orgId, r.version, order, now, { verified[it] }) { _, _ -> false }
        newcomers.forEach { need(it in consenting, "consent-missing", it) }
        if (founderMoved && r.founderSeatId !in newcomers) need(ordinary.any { it.seatId == r.founderSeatId }, "consent-missing", "new founder")

        // A veto counts inside the window `.com` observed: [openedAt, openedAt + wait).
        fun vetoSigners(v: OrgSigned<OrgVeto>, noticeHash: String, openedAt: Long, wait: Long): List<String>? = try {
            if (v.body.orgId != p.orgId || v.body.noticeSha256 != noticeHash || v.body.issuedAt < openedAt || v.body.issuedAt >= openedAt + wait) null
            else checkApprovals(v.approvals, p.orgId, p.version, canonical(v.body), now, prevKey, frozen)
        } catch (ex: Exception) {
            null
        }
        // The notice is dated near when `.com` saw it, seen after the previous delayed change took effect, and
        // applies only once `wait` has passed since then. Returns the observed open time.
        fun checkNotice(n: OrgSigned<OrgDelayedChange>, wait: Long): Long {
            val b = n.body
            val hash = sha256Hex(canonical(b))
            need(b.orgId == p.orgId && b.oarVersion == p.version, "notice-invalid", "version")
            need(r.issuedAt == b.effectiveAt, "notice-invalid", "date")
            need(b.nextRecordSha256 == authorityHash(r), "notice-invalid", "names another record")
            need(b.effectiveAt == b.issuedAt + wait, "notice-invalid", "period")
            need(b.issuedAt >= p.issuedAt, "notice-invalid", "older")
            val openedAt = noticeOpenedAt[hash]?.takeIf { it >= 0 } ?: fail("notice-unobserved")
            need(openedAt >= lastDelayedAt, "notice-overlap")
            need(kotlin.math.abs(b.issuedAt - openedAt) <= MAX_SKEW_MS, "notice-backdated")
            need(now >= maxOf(b.effectiveAt, openedAt + wait), "notice-early")
            return openedAt
        }
        when (e.via) {
            "direct" -> {
                val signers = checkApprovals(ordinary, r.orgId, p.version, order, now, prevKey, frozen)
                signers.forEach {
                    need(kindOf(it) == OrgAdminKind.ADMIN, "not-an-admin", it)
                    need(it !in removed, "removed-signer", it)
                }
                val k = if (bylawsChanged || founderMoved) bylawsThreshold(p) else p.kGov
                need(signers.size >= k, "threshold")
                checkQuorumCustody(p, k, signers, adminCustody(p))
            }
            "founder-removal" -> {
                val n = e.notice?.takeIf { it.body.kind == "founder-removal" } ?: fail("notice-invalid")
                need(removed.size == 1, "notice-invalid", "exactly one admin")
                need(authorityHash(founderRemovalOf(p, removed[0], r.issuedAt)) == authorityHash(r), "notice-invalid", "record is not the removal")
                val openedAt = checkNotice(n, FOUNDER_NOTICE_MS)
                val signers = checkApprovals(n.approvals, p.orgId, p.version, canonical(n.body), now, prevKey, frozen)
                need(signers == listOf(p.founderSeatId), "notice-invalid", "only the founder")
                val noticeHash = sha256Hex(canonical(n.body))
                val eligible = p.admins.filter { it.kind == OrgAdminKind.ADMIN && it.seatId != p.founderSeatId && it.seatId != removed[0] }.map { it.seatId }.toSet()
                val set = overturnSet(p).filter { it != removed[0] }.toSet()
                for (v in vetoes) {
                    val c = vetoSigners(v, noticeHash, openedAt, FOUNDER_NOTICE_MS) ?: continue
                    if (c.count { it in eligible } >= p.bylaws.vetoK) fail("notice-vetoed")
                    if (c.count { it in set } >= overturnThreshold(p)) fail("notice-vetoed")
                }
                need(e.approvals.size == consent.size, "malformed", "stray approvals")
            }
            "recovery" -> {
                val n = e.notice?.takeIf { it.body.kind == "recovery" } ?: fail("notice-invalid")
                val openedAt = checkNotice(n, RECOVERY_NOTICE_MS)
                val signers = checkApprovals(n.approvals, p.orgId, p.version, canonical(n.body), now, prevKey, frozen)
                signers.forEach { need(kindOf(it) == OrgAdminKind.ADMIN || kindOf(it) == OrgAdminKind.RECOVERY, "not-an-admin", it) }
                need(signers.any { kindOf(it) == OrgAdminKind.RECOVERY }, "notice-invalid", "no recovery seat")
                val k = if (bylawsChanged || founderMoved) bylawsThreshold(p) else p.kGov
                need(signers.size >= k, "threshold")
                checkQuorumCustody(p, k, signers, adminCustody(p))
                val noticeHash = sha256Hex(canonical(n.body))
                val eligible = p.admins.filter { it.kind == OrgAdminKind.ADMIN && it.seatId !in signers }.map { it.seatId }.toSet()
                for (v in vetoes) if (vetoSigners(v, noticeHash, openedAt, RECOVERY_NOTICE_MS)?.any { it in eligible } == true) fail("notice-vetoed")
                need(e.approvals.size == consent.size, "malformed", "stray approvals")
            }
            "overturn" -> {
                val at = e.overturnOf ?: fail("overturn-invalid")
                val idx = records.indexOfFirst { it.version == at }
                need(at >= 1 && at <= p.version && idx >= 1, "overturn-invalid")
                val after = records[idx]
                val before = records[idx - 1]
                need(before.founderSeatId == after.founderSeatId, "overturn-invalid")
                val removedThen = before.admins.filter { a -> after.admins.none { it.seatId == a.seatId } }
                need(removedThen.size == 1, "overturn-invalid", "not a founder removal")
                need(authorityHash(founderRemovalOf(before, removedThen[0].seatId, after.issuedAt)) == authorityHash(after), "overturn-invalid", "not a founder removal")
                val restored = removedThen[0].seatId
                need(p.admins.none { it.seatId == restored }, "overturn-invalid", "already back")
                need(authorityHash(overturnOf(p, before, after, r.issuedAt)) == authorityHash(r), "overturn-invalid", "record is not the restore")
                val restoredConsent = e.approvals.filter { it.seatId == restored && it.oarVersion == r.version }
                val others = e.approvals.filter { it !in restoredConsent }
                val back = checkApprovals(restoredConsent, r.orgId, r.version, order, now, { if (it == restored) verified[it] else null }) { _, _ -> false }
                need(restored in back, "consent-missing", restored)
                val signers = checkApprovals(others, r.orgId, p.version, order, now, prevKey, frozen)
                val set = overturnSet(p).toSet()
                need(signers.all { it in set }, "not-an-admin", "outside the overturn set")
                need(signers.size >= overturnThreshold(p), "threshold")
                checkQuorumCustody(p, overturnThreshold(p), signers, adminCustody(p))
            }
            else -> fail("malformed", "via")
        }
    }

    fun buildSeatBook(st: OrgAuthorityState, grants: List<OrgSeatGrantBundle>, revokes: List<OrgSeatRevokeBundle>,
                      freezes: List<OrgSigned<OrgSeatFreeze>> = emptyList(), overturns: List<OrgSigned<OrgOverturn>> = emptyList(), now: Long): OrgSeatBook {
        val book = OrgSeatBook()
        book.freezes = verifiedFreezes(st.records, st.bindings, st.orgId, freezes, overturns, now)
        val frozen = { s: String, t: Long -> book.freezes.any { it.seatId == s && it.issuedAt <= t && t < it.untilMs } }
        fun code(e: Exception) = (e as? OrgAuthorityException)?.code ?: "malformed"
        for (v in revokes) {
            try { verifyRevoke(st, v, grants, frozen, now); book.revoked += v.seatId } catch (e: Exception) { book.refused += v.seatId to code(e) }
        }
        for (g in grants.sortedBy { it.grant.issuedAt }) {
            try {
                need(g.grant.seatId !in book.revoked, "seat-revoked")
                val seat = verifyGrant(st, g, frozen, now)
                val prev = book.seats[seat.seatId]
                if (prev == null || prev.grant.issuedAt < seat.grant.issuedAt) book.seats[seat.seatId] = seat
            } catch (e: Exception) {
                book.refused += g.grant.seatId to code(e)
            }
        }
        return book
    }

    fun verifyGrant(st: OrgAuthorityState, b: OrgSeatGrantBundle, frozen: (String, Long) -> Boolean, now: Long): OrgSeat {
        val g = b.grant
        val order = canonical(g)
        need(g.orgId == st.orgId, "wrong-org")
        need(rolesHash(b.roles) == g.rolesHash, "order-mismatch", "roles")
        need(g.expiresAt > now, "expired")
        val r = st.record(g.oarVersion) ?: fail("stale-oar")
        val member = seatBinding(b.memberBinding, "org-seat-member", g.orgId, g.seatId, now)
        need(member.keyIdHex == g.memberKeyId, "binding", "member key id")
        val admin = if (g.adminKeyId.isNotEmpty()) {
            val ab = b.adminBinding ?: fail("binding", "admin binding missing")
            seatBinding(ab, "org-seat-admin", g.orgId, g.seatId, now).also { need(it.keyIdHex == g.adminKeyId, "binding", "admin key id") }
        } else {
            need(b.roles.none { it.raisesAdmin }, "binding", "an admin role needs an admin key")
            null
        }
        if (g.custody == OrgCustody.BROWSER) {
            need(g.adminKeyId.isNotEmpty(), "malformed", "custody without an admin key")
            need(!(r.bylaws.hardwareAdmins && b.roles.any { it.raisesAdmin }), "custody", "the bylaws need hardware custody for admins")
        }
        val signers = checkApprovals(b.approvals, g.orgId, g.oarVersion, order, now, { st.binding(g.oarVersion, it) }, frozen)
        signers.forEach { s -> need(r.admins.firstOrNull { it.seatId == s }?.kind == OrgAdminKind.ADMIN, "not-an-admin", s) }
        need(signers.size >= grantThreshold(r, b.roles), "threshold")
        checkQuorumCustody(r, grantThreshold(r, b.roles), signers, adminCustody(r))
        return OrgSeat(g.seatId, b.roles, member, admin, g)
    }

    private fun verifyRevoke(st: OrgAuthorityState, v: OrgSeatRevokeBundle, grants: List<OrgSeatGrantBundle>, frozen: (String, Long) -> Boolean, now: Long) {
        val order = canonical(v)
        need(v.orgId == st.orgId, "wrong-org")
        need(st.current.admins.none { it.seatId == v.seatId }, "seat-is-org-admin")
        val r = st.record(v.oarVersion) ?: fail("stale-oar")
        val selfSig = v.selfSignature
        if (selfSig != null) {
            need(v.reason == "left", "malformed", "a leave says left")
            for (g in grants) {
                if (g.grant.seatId != v.seatId || g.grant.orgId != v.orgId) continue
                val ok = try {
                    val m = seatBinding(g.memberBinding, "org-seat-member", v.orgId, v.seatId, now)
                    m.keyIdHex == g.grant.memberKeyId && run { PqHybrid.hybridVerify(m.hybridPublicKey, TAG_SEAT_REVOKE, order, PqHex.decode(selfSig)!!); true }
                } catch (e: Exception) {
                    false
                }
                if (ok) return
            }
            fail("bad-signature", "leave")
        }
        val signers = checkApprovals(v.approvals, v.orgId, v.oarVersion, order, now, { st.binding(v.oarVersion, it) }, frozen)
        need(signers.isNotEmpty(), "threshold")
        signers.forEach { s -> need(r.admins.firstOrNull { it.seatId == s }?.kind == OrgAdminKind.ADMIN, "not-an-admin", s) }
    }

    internal fun covers(seat: OrgSeat, action: OrgAction): Boolean = seat.roles.any { r ->
        when {
            action is OrgAction.AddServer && r is OrgSeatRole.ServersAdd -> true
            action is OrgAction.Operate && r is OrgSeatRole.ServerAdmin -> r.servers == null || action.server in r.servers
            action is OrgAction.AppAdmin && r is OrgSeatRole.ServerAdmin -> r.servers == null || action.server in r.servers
            action is OrgAction.AppAdmin && r is OrgSeatRole.ServiceAdmin -> action.serviceRef in r.apps
            else -> false
        }
    }

    /** Who authorizes [order] for [action]; the second value is the scoped seat when one seat outside the org admins did. */
    fun authorize(state: OrgAuthorityState, book: OrgSeatBook, action: OrgAction, order: ByteArray, approvals: List<OrgApproval>, now: Long): Pair<List<String>, String?> {
        val cur = state.current
        val first = approvals.firstOrNull() ?: fail("threshold", "no approvals")
        val prev = state.record(cur.version - 1)
        val version = first.oarVersion
        need(version == cur.version || (prev != null && version == prev.version && now - cur.issuedAt <= PREVIOUS_OAR_GRACE_MS), "stale-oar")
        val at = if (version == cur.version) cur else prev!!
        val frozen = { s: String, t: Long -> book.freezes.any { it.seatId == s && ((it.issuedAt <= t && t < it.untilMs) || (it.issuedAt <= now && now < it.untilMs)) } }
        val keyOf = { s: String ->
            val here = at.admins.firstOrNull { it.seatId == s }
            if (here != null) {
                if (cur.admins.any { it.seatId == s && it.kind == here.kind && it.binding.ed25519PubHex == here.binding.ed25519PubHex && it.binding.mldsaPubHex == here.binding.mldsaPubHex }) state.binding(at.version, s) else null
            } else if (s in book.revoked) null else book.seats[s]?.admin
        }
        approvals.forEach { need(it.notAfter >= now, "expired", it.seatId) }
        val signers = checkApprovals(approvals, state.orgId, version, order, now, keyOf, frozen)
        val orgAdmins = signers.filter { s -> at.admins.firstOrNull { it.seatId == s }?.kind == OrgAdminKind.ADMIN }
        val others = signers.filter { it !in orgAdmins }
        others.forEach { s ->
            need(at.admins.none { it.seatId == s }, "not-an-admin", s)
            need(s !in book.revoked, "seat-revoked", s)
        }
        fun needK(k: Int): Pair<List<String>, String?> {
            need(others.isEmpty(), "scope", "a seat outside the org admins")
            need(orgAdmins.size >= k, "threshold")
            checkQuorumCustody(at, k, orgAdmins, adminCustody(at))
            return signers to null
        }
        return when (action) {
            is OrgAction.SeatGrant -> needK(grantThreshold(at, action.roles))
            OrgAction.SeatInvite, OrgAction.SeatRevoke, OrgAction.Freeze -> needK(1)
            OrgAction.Destroy -> needK(at.kDestroy)
            OrgAction.Site -> needK(at.kSite)
            OrgAction.AddServer, is OrgAction.Operate, is OrgAction.AppAdmin -> {
                if (orgAdmins.isNotEmpty() && others.isEmpty()) return signers to null
                need(signers.size == 1, "scope", "one scoped seat signs alone")
                val seat = book.seats[others[0]]?.takeIf { it.grant.expiresAt > now } ?: fail("seat-unknown")
                need(covers(seat, action), "scope")
                signers to seat.seatId
            }
        }
    }

    /**
     * The seats whose pending approvals of [order] verify (a ceremony's approvals, a veto, as `.com` takes them):
     * anyone in the current record or a seat with an admin key, each approval unexpired, not frozen when it signed
     * nor now, under the current record (or the previous one within 24 h). Counts nothing (`verifyOrgApprovers`).
     */
    fun verifyApprovers(state: OrgAuthorityState, book: OrgSeatBook, order: ByteArray, approvals: List<OrgApproval>, now: Long, allowFrozenSeat: String? = null): List<String> {
        val cur = state.current
        val first = approvals.firstOrNull() ?: fail("threshold", "no approvals")
        val prev = state.record(cur.version - 1)
        val version = first.oarVersion
        need(version == cur.version || (prev != null && version == prev.version && now - cur.issuedAt <= PREVIOUS_OAR_GRACE_MS), "stale-oar")
        val at = if (version == cur.version) cur else prev!!
        approvals.forEach { need(it.notAfter >= now, "expired", it.seatId) }
        val keyOf = { s: String ->
            val here = at.admins.firstOrNull { it.seatId == s }
            if (here != null) {
                if (cur.admins.any { it.seatId == s && it.kind == here.kind && it.binding.ed25519PubHex == here.binding.ed25519PubHex && it.binding.mldsaPubHex == here.binding.mldsaPubHex }) state.binding(at.version, s) else null
            } else if (s in book.revoked) null else book.seats[s]?.admin
        }
        val frozen = { s: String, t: Long ->
            s != allowFrozenSeat && book.freezes.any { it.seatId == s && ((it.issuedAt <= t && t < it.untilMs) || (it.issuedAt <= now && now < it.untilMs)) }
        }
        return checkApprovals(approvals, state.orgId, version, order, now, keyOf, frozen)
    }
}

/** JSON (kotlinx) into the org authority types, as `.com` serves them and the vectors hold them. */
object OrgAuthorityWire {
    private fun bad(what: String): Nothing = throw OrgAuthorityException("malformed", what)
    private fun JsonObject.s(k: String): String = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: bad(k)
    private fun JsonObject.n(k: String): Long = num(this[k]) ?: bad(k)
    private fun num(e: JsonElement?): Long? {
        val p = e as? JsonPrimitive ?: return null
        if (p.isString) return null
        val d = p.content.toDoubleOrNull() ?: return null
        return if (d.isNaN() || d != Math.floor(d) || d < 0 || d > PqHybrid.MAX_SAFE_INTEGER) null else d.toLong()
    }
    private fun obj(e: JsonElement?, what: String): JsonObject = e as? JsonObject ?: bad(what)
    private fun strings(e: JsonElement?): List<String> = (e as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: bad("string list") } ?: bad("string list")

    fun binding(e: JsonElement?): PqTrust.Wire = try { PqTrust.pqKeyBindingFromWire(e) } catch (x: PqTrustException) { throw OrgAuthorityException("binding", x.code) }

    fun approval(e: JsonElement?): OrgApproval {
        val o = obj(e, "approval")
        if (o.keys.sorted().joinToString(",") != "adminKeyId,issuedAt,notAfter,oarVersion,orderSha256,orgId,purposeTag,seatId,signature") bad("approval keys")
        val a = OrgApproval(o.s("orgId"), o.n("oarVersion"), o.s("purposeTag"), o.s("orderSha256"), o.s("seatId"), o.s("adminKeyId"), o.n("notAfter"), o.n("issuedAt"), o.s("signature"))
        if (a.signature.length != 6746 || !PqHex.isHex(a.signature)) bad("approval signature")
        OrgAuthority.canonicalApproval(a)
        return a
    }

    fun approvals(e: JsonElement?): List<OrgApproval> = (e as? JsonArray ?: bad("approvals")).map { approval(it) }

    fun record(e: JsonElement?): OrgAuthorityRecord {
        val o = obj(e, "record")
        val b = obj(o["bylaws"], "bylaws")
        val seatsEl = b["overturnSeats"]
        val seats = if (seatsEl is JsonPrimitive && seatsEl.isString && seatsEl.content == "*") null else strings(seatsEl)
        val admins = (o["admins"] as? JsonArray ?: bad("admins")).map { a ->
            val x = obj(a, "admin")
            val kind = OrgAdminKind.values().firstOrNull { it.wire == x.s("kind") } ?: bad("kind")
            OrgAdminEntry(x.s("seatId"), kind, binding(x["binding"]), custody(x))
        }
        val hardwareAdmins = when (val v = b["adminCustody"]) {
            null, is JsonNull -> false
            is JsonPrimitive -> if (v.isString && (v.content == "any" || v.content == "hardware")) v.content == "hardware" else throw OrgAuthorityException("bylaws", "adminCustody")
            else -> throw OrgAuthorityException("bylaws", "adminCustody")
        }
        val quorumHardware = when (val v = b["quorumHardware"]) {
            null, is JsonNull -> true
            is JsonPrimitive -> if (!v.isString && (v.content == "true" || v.content == "false")) v.content == "true" else throw OrgAuthorityException("bylaws", "quorumHardware")
            else -> throw OrgAuthorityException("bylaws", "quorumHardware")
        }
        return OrgAuthorityRecord(o.s("orgId"), o.n("version"), o.s("prevHash"), admins, OrgBylaws(seats, b.n("overturnK").toInt(), b.n("vetoK").toInt(), hardwareAdmins, quorumHardware),
            o.s("founderSeatId"), o.n("kGov").toInt(), o.n("kGrant").toInt(), o.n("kDestroy").toInt(), o.n("kSite").toInt(), o.n("issuedAt"))
    }

    fun entry(e: JsonElement?): OrgAuthorityEntry {
        val o = obj(e, "entry")
        val notice = (o["notice"] as? JsonObject)?.let { n ->
            val b = obj(n["body"], "notice")
            OrgSigned(OrgDelayedChange(b.s("orgId"), b.n("oarVersion"), b.s("kind"), b.s("nextRecordSha256"), b.n("effectiveAt"), b.n("issuedAt")), approvals(n["approvals"]))
        }
        return OrgAuthorityEntry(record(o["record"]), o.s("via"), approvals(o["approvals"]), notice, num(o["overturnOf"]))
    }

    fun freeze(e: JsonElement?): OrgSigned<OrgSeatFreeze> {
        val o = obj(e, "freeze"); val b = obj(o["body"], "freeze")
        return OrgSigned(OrgSeatFreeze(b.s("orgId"), b.s("seatId"), b.n("untilMs"), b.n("oarVersion"), b.n("issuedAt")), approvals(o["approvals"]))
    }

    fun overturn(e: JsonElement?): OrgSigned<OrgOverturn> {
        val o = obj(e, "overturn"); val b = obj(o["body"], "overturn")
        return OrgSigned(OrgOverturn(b.s("orgId"), b.s("freezeSha256"), b.n("oarVersion"), b.n("issuedAt")), approvals(o["approvals"]))
    }

    /** `.com`'s observed open time of each delayed-change notice (`noticeOpenedAt`); anything malformed is left out. */
    fun noticeOpenedAt(e: JsonElement?): Map<String, Long> =
        (e as? JsonObject)?.entries?.mapNotNull { (k, v) -> num(v)?.takeIf { k.length == 64 && PqHex.isHex(k) && k == k.lowercase() }?.let { k to it } }?.toMap() ?: emptyMap()

    fun veto(e: JsonElement?): OrgSigned<OrgVeto> {
        val o = obj(e, "veto"); val b = obj(o["body"], "veto")
        return OrgSigned(OrgVeto(b.s("orgId"), b.s("noticeSha256"), b.n("issuedAt")), approvals(o["approvals"]))
    }

    fun roles(e: JsonElement?): List<OrgSeatRole> = (e as? JsonArray ?: bad("roles")).map { r ->
        val o = obj(r, "role")
        when (o.s("role")) {
            "member" -> OrgSeatRole.Member
            "servers-add" -> OrgSeatRole.ServersAdd
            "server-admin" -> {
                val s = o["servers"]
                if (s is JsonPrimitive && s.isString && s.content == "*") OrgSeatRole.ServerAdmin(null) else OrgSeatRole.ServerAdmin(strings(s))
            }
            "service-admin" -> OrgSeatRole.ServiceAdmin(strings(o["apps"]))
            "unlock" -> OrgSeatRole.Unlock(strings(o["servers"]))
            else -> bad("role")
        }
    }

    /** `custody`: absent or "hardware" = HARDWARE, "browser" = BROWSER; anything else is refused. */
    fun custody(o: JsonObject): OrgCustody = when (val v = o["custody"]) {
        null, is JsonNull -> OrgCustody.HARDWARE
        is JsonPrimitive -> OrgCustody.values().firstOrNull { v.isString && it.wire == v.content } ?: bad("custody")
        else -> bad("custody")
    }

    fun grantBundle(e: JsonElement?): OrgSeatGrantBundle {
        val o = obj(e, "grant bundle"); val g = obj(o["grant"], "grant")
        val grant = OrgSeatGrant(g.s("orgId"), g.s("seatId"), g.s("labelSha256"), g.s("memberKeyId"), g.s("adminKeyId"), g.s("rolesHash"), g.n("oarVersion"), g.n("issuedAt"), g.n("expiresAt"), custody(g))
        val admin = o["adminBinding"].let { if (it == null || it is JsonNull) null else binding(it) }
        return OrgSeatGrantBundle(grant, roles(o["roles"]), binding(o["memberBinding"]), admin, approvals(o["approvals"]))
    }

    fun revokeBundle(e: JsonElement?): OrgSeatRevokeBundle {
        val o = obj(e, "revoke bundle"); val r = obj(o["revoke"], "revoke")
        val self = (o["selfSignature"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return OrgSeatRevokeBundle(r.s("orgId"), r.s("seatId"), r.s("reason"), r.n("oarVersion"), r.n("issuedAt"), approvals(o["approvals"]), self)
    }

    fun action(e: JsonElement?): OrgAction {
        val o = obj(e, "action")
        return when (o.s("kind")) {
            "seat-grant" -> OrgAction.SeatGrant(roles(o["roles"]))
            "seat-invite" -> OrgAction.SeatInvite
            "seat-revoke" -> OrgAction.SeatRevoke
            "freeze" -> OrgAction.Freeze
            "add-server" -> OrgAction.AddServer
            "destroy" -> OrgAction.Destroy
            "site" -> OrgAction.Site
            "operate" -> OrgAction.Operate(o.s("server"))
            "app-admin" -> OrgAction.AppAdmin(o.s("server"), o.s("serviceRef"))
            else -> bad("action")
        }
    }
}
