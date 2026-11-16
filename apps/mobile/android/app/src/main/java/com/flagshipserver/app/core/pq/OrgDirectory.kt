package com.flagshipserver.app.core.pq

import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters

/**
 * The org directory (packages/protocol/src/orgDirectory.ts; docs/org-directory.md §2): each seat's names,
 * sealed under the org directory key (key-ring kind `directory-key`, org admins only). Byte for byte the
 * TypeScript forms, pinned by test-vectors/org-directory. Free text travels as base64url so no field can
 * carry the `|` separator.
 */
data class OrgDirectoryEntry(
    val seatId: String, val pendingId: String = "", val pseudonym: String, val displayName: String = "", val email: String = "",
    val externalId: String = "", val source: String = "manual", val groups: List<String> = emptyList(), val updatedAt: Long,
)

data class OrgDirectorySealed(val orgId: String, val entryId: String, val keyVersion: Long, val sizeBucket: Int, val sealedHex: String, val issuedAt: Long)

object OrgDirectory {
    const val TAG = "flagship/org-directory-entry/v1"
    val BUCKETS = listOf(256, 512, 1024, 2048, 4096, 8192)
    const val MAX_GROUPS = 32

    private val HEX16 = Regex("^[0-9a-f]{32}$")
    private val SOURCE = Regex("^[a-z][a-z0-9-]{1,31}$")
    private val B64U = Regex("^[A-Za-z0-9_-]*$")
    private val UINT = Regex("^(0|[1-9][0-9]{0,15})$")

    private fun fail(d: String): Nothing = throw OrgAuthorityException("malformed", d)
    private fun join(vararg p: Any): ByteArray = p.joinToString("|").toByteArray(Charsets.UTF_8)
    private fun b64u(b: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    private fun unb64u(s: String): ByteArray {
        if (!B64U.matches(s) || s.length % 4 == 1) fail("base64url")
        val b = try { Base64.getUrlDecoder().decode(s) } catch (_: IllegalArgumentException) { fail("base64url") }
        if (b64u(b) != s) fail("base64url not canonical")
        return b
    }
    private fun utf8(b: ByteArray): String {
        val d = Charsets.UTF_8.newDecoder()
        return try { d.decode(java.nio.ByteBuffer.wrap(b)).toString() } catch (_: java.nio.charset.CharacterCodingException) { fail("utf8") }
    }

    private fun text(name: String, v: String, max: Int, required: Boolean = false) {
        if (required && v.isBlank()) fail(name)
        val bad = v.any { it.code < 0x20 || it.code == 0x7f || it.code == 0x2028 || it.code == 0x2029 }
        if (bad || !Normalizer.isNormalized(v, Normalizer.Form.NFC) || v.toByteArray(Charsets.UTF_8).size > max) fail(name)
    }

    fun check(e: OrgDirectoryEntry) {
        if (e.seatId.isNotEmpty() && !HEX16.matches(e.seatId)) fail("seatId")
        if (e.pendingId.isNotEmpty() && !HEX16.matches(e.pendingId)) fail("pendingId")
        if (e.seatId.isEmpty() == e.pendingId.isEmpty()) fail("exactly one of seatId and pendingId")
        text("pseudonym", e.pseudonym, 128, required = true)
        text("displayName", e.displayName, 256)
        text("email", e.email, 320)
        text("externalId", e.externalId, 256)
        if (!SOURCE.matches(e.source)) fail("source")
        if (e.groups.size > MAX_GROUPS) fail("groups")
        for (g in e.groups) text("group", g, 256, required = true)
        val sorted = e.groups.sorted()
        if (sorted.toSet().size != sorted.size || sorted != e.groups) fail("groups not sorted and unique")
        if (e.updatedAt < 0) fail("updatedAt")
    }

    fun canonicalBody(e: OrgDirectoryEntry): ByteArray {
        check(e)
        val t = { s: String -> b64u(s.toByteArray(Charsets.UTF_8)) }
        return join(TAG, "body", e.seatId, e.pendingId, t(e.pseudonym), t(e.displayName), t(e.email), t(e.externalId), e.source,
            e.groups.joinToString(",") { t(it) }, e.updatedAt)
    }

    fun parseBody(bytes: ByteArray): OrgDirectoryEntry {
        val p = utf8(bytes).split("|")
        if (p.size != 11 || p[0] != TAG || p[1] != "body" || !UINT.matches(p[10])) fail("body")
        val txt = { x: String -> utf8(unb64u(x)) }
        val e = OrgDirectoryEntry(p[2], p[3], txt(p[4]), txt(p[5]), txt(p[6]), txt(p[7]), p[8],
            if (p[9].isEmpty()) emptyList() else p[9].split(",").map(txt), p[10].toLong())
        if (!canonicalBody(e).contentEquals(bytes)) fail("body not canonical")
        return e
    }

    private fun checkHeader(s: OrgDirectorySealed) {
        if (!HEX16.matches(s.orgId)) fail("orgId")
        if (!HEX16.matches(s.entryId)) fail("entryId")
        if (s.keyVersion < 1) fail("keyVersion")
        if (s.sizeBucket !in BUCKETS) fail("sizeBucket")
    }

    private fun aad(s: OrgDirectorySealed): ByteArray {
        checkHeader(s)
        return join(TAG, "seal", s.orgId, s.entryId, s.keyVersion, s.sizeBucket)
    }

    /** What an org admin's approval signs to store an entry on `.com`. */
    fun canonicalWrite(s: OrgDirectorySealed): ByteArray {
        checkHeader(s)
        val sealed = PqHex.decode(s.sealedHex)
        if (sealed == null || sealed.size != 12 + s.sizeBucket + 16 || s.issuedAt < 0) fail("sealedHex")
        return join(TAG, s.orgId, s.entryId, s.keyVersion, s.sizeBucket, OrgAuthority.sha256Hex(sealed), s.issuedAt)
    }

    fun entryKey(directoryKey: ByteArray, orgId: String, entryId: String, keyVersion: Long): ByteArray {
        if (directoryKey.size != 32 || !HEX16.matches(orgId) || !HEX16.matches(entryId) || keyVersion < 0) fail("entry key")
        val g = HKDFBytesGenerator(SHA256Digest())
        g.init(HKDFParameters(directoryKey, ByteArray(0), join(TAG, "key", orgId, entryId, keyVersion)))
        return ByteArray(32).also { g.generateBytes(it, 0, 32) }
    }

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); updateAAD(aad) }

    fun seal(orgId: String, entryId: String, keyVersion: Long, directoryKey: ByteArray, entry: OrgDirectoryEntry, issuedAt: Long, nonce: ByteArray? = null): OrgDirectorySealed {
        val body = canonicalBody(entry)
        val bucket = BUCKETS.firstOrNull { it >= body.size + 2 } ?: fail("entry too large")
        val padded = ByteArray(bucket)
        padded[0] = (body.size shr 8).toByte(); padded[1] = (body.size and 255).toByte()
        body.copyInto(padded, 2)
        val n = nonce ?: ByteArray(12).also { SecureRandom().nextBytes(it) }
        if (n.size != 12) fail("nonce")
        val header = OrgDirectorySealed(orgId, entryId, keyVersion, bucket, "", issuedAt)
        val ct = gcm(Cipher.ENCRYPT_MODE, entryKey(directoryKey, orgId, entryId, keyVersion), n, aad(header)).doFinal(padded)
        return header.copy(sealedHex = PqHex.encode(n + ct)).also { canonicalWrite(it) }
    }

    fun open(s: OrgDirectorySealed, directoryKey: ByteArray): OrgDirectoryEntry {
        canonicalWrite(s)
        val sealed = PqHex.decode(s.sealedHex)!!
        val padded = try {
            gcm(Cipher.DECRYPT_MODE, entryKey(directoryKey, s.orgId, s.entryId, s.keyVersion), sealed.copyOfRange(0, 12), aad(s)).doFinal(sealed, 12, sealed.size - 12)
        } catch (_: java.security.GeneralSecurityException) { fail("does not open") }
        val len = ((padded[0].toInt() and 255) shl 8) or (padded[1].toInt() and 255)
        if (len + 2 > padded.size || (2 + len until padded.size).any { padded[it] != 0.toByte() }) fail("padding")
        return parseBody(padded.copyOfRange(2, 2 + len))
    }

    class Named(val entry: OrgDirectoryEntry, val entryId: String)

    /** The newest entry per seat and per pending person, from every entry this admin's keys open. */
    fun openAll(orgId: String, sealed: List<OrgDirectorySealed>, keys: Map<Long, ByteArray>): Pair<Map<String, Named>, Map<String, Named>> {
        val bySeat = HashMap<String, Named>()
        val byPending = HashMap<String, Named>()
        for (s in sealed) {
            if (s.orgId != orgId) continue
            val k = keys[s.keyVersion] ?: continue
            val e = try { open(s, k) } catch (_: OrgAuthorityException) { continue }
            val (map, id) = if (e.seatId.isNotEmpty()) bySeat to e.seatId else byPending to e.pendingId
            if ((map[id]?.entry?.updatedAt ?: -1) < e.updatedAt) map[id] = Named(e, s.entryId)
        }
        return bySeat to byPending
    }
}

/** Directory keys from a verified plan: every `directory-key` version `seat:<seatId>` can open, by version. */
fun OrgDirectory.keys(plan: OrgRotationPlan, seatId: String, kemSecret: ByteArray): Map<Long, ByteArray> {
    val out = HashMap<Long, ByteArray>()
    for (b in plan.chains[OrgRotation.chainId(OrgKeyKind.DIRECTORY_KEY, "*")] ?: emptyList()) {
        runCatching { OrgServers.openKeyRing(b.ring, b.recipients, "seat:$seatId", kemSecret) }.getOrNull()?.let { out[b.ring.version] = it }
    }
    return out
}

/** The newest verified directory-key version, or null before the first one exists. */
fun OrgDirectory.newestVersion(plan: OrgRotationPlan): Long? = plan.chains[OrgRotation.chainId(OrgKeyKind.DIRECTORY_KEY, "*")]?.lastOrNull()?.ring?.version

/** A member's slice of the directory (packages/protocol/src/orgDirectory.ts, `flagship/org-directory-slice/v1`). */
data class OrgDirectorySlice(val orgId: String, val seatId: String, val kemKeyId: String, val tagKeyVersion: Long, val contentTag: String, val sealedHex: String, val issuedAt: Long)

class OrgSliceContent(val entries: List<OrgDirectoryEntry>, val servers: List<String>)

object OrgDirectorySlices {
    const val TAG = "flagship/org-directory-slice/v1"
    private val HEX16 = Regex("^[0-9a-f]{32}$")
    private val HEX32 = Regex("^[0-9a-f]{64}$")
    private val DOMAIN = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private fun fail(d: String): Nothing = throw OrgAuthorityException("malformed", d)
    private fun join(vararg p: Any): ByteArray = p.joinToString("|").toByteArray(Charsets.UTF_8)
    private fun b64u(b: ByteArray) = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    private fun serverTargets(roles: List<OrgSeatRole>, all: List<String>): Set<String> = roles.flatMap { r ->
        when (r) { is OrgSeatRole.ServerAdmin -> r.servers ?: all; is OrgSeatRole.Unlock -> r.servers; else -> emptyList() }
    }.toSet()
    private fun appTargets(roles: List<OrgSeatRole>): Set<String> = roles.flatMap { if (it is OrgSeatRole.ServiceAdmin) it.apps else emptyList() }.toSet()

    /** Every org admin, each live seat whose roles name a server or app this seat's roles name, and those servers. */
    fun shares(st: OrgAuthorityState, book: OrgSeatBook, seatId: String, servers: List<String>, now: Long): Pair<List<String>, List<String>> {
        val mine = book.seats[seatId]
        val myServers = mine?.let { serverTargets(it.roles, servers) } ?: emptySet()
        val myApps = mine?.let { appTargets(it.roles) } ?: emptySet()
        val seats = st.current.admins.filter { it.kind == OrgAdminKind.ADMIN }.map { it.seatId }.toMutableSet()
        for ((id, s) in book.seats) {
            if (id == seatId || id in book.revoked || s.grant.expiresAt <= now) continue
            if (serverTargets(s.roles, servers).any { it in myServers } || appTargets(s.roles).any { it in myApps }) seats += id
        }
        seats -= seatId
        return seats.sorted() to myServers.filter { it in servers }.sorted()
    }

    fun content(st: OrgAuthorityState, book: OrgSeatBook, seatId: String, bySeat: Map<String, OrgDirectoryEntry>, servers: List<String>, now: Long): OrgSliceContent {
        val (seats, srv) = shares(st, book, seatId, servers, now)
        return OrgSliceContent(seats.mapNotNull { bySeat[it] }.map { it.copy(email = "", externalId = "", updatedAt = 0) }, srv)
    }

    fun payload(orgId: String, seatId: String, c: OrgSliceContent): ByteArray {
        if (!HEX16.matches(orgId) || !HEX16.matches(seatId) || c.entries.size > 2000 || c.servers.size > 512) fail("slice")
        val bodies = c.entries.map { b64u(OrgDirectory.canonicalBody(it)) }.sorted()
        for (s in c.servers) if (!DOMAIN.matches(s)) fail("server")
        if (c.servers != c.servers.toSortedSet().toList()) fail("servers not sorted and unique")
        return join(TAG, "payload", orgId, seatId, bodies.joinToString(","), c.servers.joinToString(","))
    }

    fun parsePayload(b: ByteArray, orgId: String, seatId: String): OrgSliceContent {
        val p = String(b, Charsets.UTF_8).split("|")
        if (p.size != 6 || p[0] != TAG || p[1] != "payload" || p[2] != orgId || p[3] != seatId) fail("slice payload")
        val entries = if (p[4].isEmpty()) emptyList() else p[4].split(",").map { OrgDirectory.parseBody(java.util.Base64.getUrlDecoder().decode(it)) }
        val c = OrgSliceContent(entries, if (p[5].isEmpty()) emptyList() else p[5].split(","))
        if (!payload(orgId, seatId, c).contentEquals(b)) fail("slice payload not canonical")
        return c
    }

    fun contentTag(directoryKey: ByteArray, payload: ByteArray): String {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(directoryKey, "HmacSHA256"))
        return PqHex.encode(mac.doFinal("$TAG|tag|".toByteArray(Charsets.UTF_8) + payload))
    }

    fun canonicalWrite(s: OrgDirectorySlice): ByteArray {
        val sealed = PqHex.decode(s.sealedHex)
        if (!HEX16.matches(s.orgId) || !HEX16.matches(s.seatId) || !HEX32.matches(s.kemKeyId) || !HEX32.matches(s.contentTag) || s.tagKeyVersion < 1 || s.issuedAt < 0 || sealed == null || sealed.isEmpty()) fail("slice")
        return join(TAG, s.orgId, s.seatId, s.kemKeyId, s.tagKeyVersion, s.contentTag, OrgAuthority.sha256Hex(sealed), s.issuedAt)
    }

    fun seal(orgId: String, seatId: String, kemPub: ByteArray, kemKeyId: String, c: OrgSliceContent, directoryKey: ByteArray, tagKeyVersion: Long, issuedAt: Long): OrgDirectorySlice {
        val p = payload(orgId, seatId, c)
        val sealed = PqHybrid.hybridSeal(kemPub, PqHybrid.HybridSealOptions(purpose = TAG, senderKeyId = ByteArray(32), issuedAt = issuedAt),
            listOf(orgId.toByteArray(), seatId.toByteArray()), p)
        return OrgDirectorySlice(orgId, seatId, kemKeyId, tagKeyVersion, contentTag(directoryKey, p), PqHex.encode(sealed), issuedAt).also { canonicalWrite(it) }
    }

    fun open(s: OrgDirectorySlice, kemSecret: ByteArray): OrgSliceContent {
        canonicalWrite(s)
        val plain = try {
            PqHybrid.hybridOpen(kemSecret, TAG, listOf(s.orgId.toByteArray(), s.seatId.toByteArray()), PqHex.decode(s.sealedHex)!!).plaintext
        } catch (e: Exception) { fail("slice does not open") }
        return parsePayload(plain, s.orgId, s.seatId)
    }

    /** A member's check that one org admin (still one now) approved its slice. */
    fun verifyApproval(st: OrgAuthorityState, book: OrgSeatBook, s: OrgDirectorySlice, approvals: List<OrgApproval>, now: Long) {
        OrgRotation.recordedApprovals(st, book, canonicalWrite(s), approvals, approvals.firstOrNull()?.oarVersion ?: -1, now, null)
        if (approvals.none { a -> st.current.admins.any { it.seatId == a.seatId && it.kind == OrgAdminKind.ADMIN } }) fail("not an org admin now")
    }

    fun fromJson(o: kotlinx.serialization.json.JsonObject): OrgDirectorySlice {
        fun s(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: fail(k)
        return OrgDirectorySlice(s("orgId"), s("seatId"), s("kemKeyId"), s("tagKeyVersion").toLong(), s("contentTag"), s("sealedHex"), s("issuedAt").toLong())
    }

    fun json(sl: OrgDirectorySlice) = kotlinx.serialization.json.buildJsonObject {
        put("orgId", kotlinx.serialization.json.JsonPrimitive(sl.orgId)); put("seatId", kotlinx.serialization.json.JsonPrimitive(sl.seatId))
        put("kemKeyId", kotlinx.serialization.json.JsonPrimitive(sl.kemKeyId)); put("tagKeyVersion", kotlinx.serialization.json.JsonPrimitive(sl.tagKeyVersion))
        put("contentTag", kotlinx.serialization.json.JsonPrimitive(sl.contentTag)); put("sealedHex", kotlinx.serialization.json.JsonPrimitive(sl.sealedHex))
        put("issuedAt", kotlinx.serialization.json.JsonPrimitive(sl.issuedAt))
    }
}
