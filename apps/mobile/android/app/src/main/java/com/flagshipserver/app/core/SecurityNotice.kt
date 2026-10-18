// Security notices (docs/security-notices.md): the Kotlin port of
// packages/protocol/src/securityNotice.ts. A notice is signed OFFLINE by the
// cold ca-track maintainer key, never by `.com`; a client accepts one only when
// its signer is the ca-track authority at THIS device's clock, found by
// walking the response's mandate log forward from the baked pin
// (MaintainersVerifier). Everything fails OPEN: an unreachable endpoint, a bad
// signature, an expired or malformed notice, or an authority that cannot be
// established locks nothing.
//
//   flagship/security-notice/v1|<signedBy>|<seq>|<kind>|<validFrom>|<validUntil>|<eventAt>|<lockFrom>|<platforms>|<advisoryId>|<deprecatesProtocol>|<reason>|<message>
//
// The shared vectors packages/protocol/test-vectors/security-notice pin this
// file to the same canonical bytes and the same decisions as the TypeScript
// reference and the webapp. The notice carries no URL: the store link is the
// app's own (SecurityNoticeCopy.STORE_URL).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A rule a notice breaks; [code] names the first one, in the order docs/security-notices.md lists. */
class SecurityNoticeException(val code: String) : Exception("flagship/security-notice/v1: $code")

data class NoticeMinimum(val minBuild: Long, val minProtocol: Long)

/** What this build is: a notice names the oldest build and protocol level it still accepts. */
data class NoticeClient(val platform: String, val build: Long, val protocol: Long)

data class SecurityNotice(
    val seq: Long,
    val kind: String,
    val validFrom: Long,
    val validUntil: Long,
    val eventAt: Long,
    val lockFrom: Long,
    /** Sorted by name; empty means everyone (none and maintenance only). */
    val platforms: Map<String, NoticeMinimum>,
    val advisoryId: String,
    val deprecatesProtocol: Long,
    val reason: String,
    val message: String,
    val signedBy: String,
    val signature: String,
    /** The document exactly as received, kept so the stored notice can be re-verified byte for byte. */
    val raw: JsonObject,
)

sealed interface NoticeOutcome {
    data class None(val why: String) : NoticeOutcome
    data class Banner(val style: String, val notice: SecurityNotice) : NoticeOutcome
    data class Lock(val notice: SecurityNotice) : NoticeOutcome

    companion object {
        val nothing: NoticeOutcome = None("kind-none")
    }
}

/** What a client persists between launches (the notice is re-verified on load). */
data class NoticeStore(val highestSeq: Long, val notice: SecurityNotice?)

data class NoticeAccept(val store: NoticeStore, val refused: String?)

object SecurityNoticeProtocol {
    const val TAG = "flagship/security-notice/v1"

    /** A notice is valid for at most this long, so a replayed one cannot lock forever. */
    const val MAX_WINDOW_MS = 30L * 24 * 3600_000
    const val MAX_MESSAGE = 280
    const val MAX_REASON = 160

    /**
     * The protocol generation this build speaks: equal to CLIENT_PROTOCOL_LEVEL
     * in packages/protocol/src/securityNotice.ts (a test reads the TypeScript
     * constant and fails on drift). Raise it only when a build ships a breaking
     * change to a signed message or wire contract, and announce it with a notice.
     */
    const val CLIENT_PROTOCOL_LEVEL = 1L

    const val PLATFORM = "android"

    val KINDS = listOf("none", "maintenance", "update-advisory", "update-required")
    val PLATFORMS = listOf("android", "ios", "web")

    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX128 = Regex("^[0-9a-f]{128}$")
    private val ADVISORY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    private const val MAX_SAFE = 9_007_199_254_740_991L

    private fun fail(code: String): Nothing = throw SecurityNoticeException(code)

    /** A non-negative safe integer, or null (a string, a fraction, a negative, a huge number). */
    private fun uint(e: JsonElement?): Long? {
        val p = e as? JsonPrimitive ?: return null
        if (p.isString) return null
        val s = p.content
        if (s.isEmpty() || s.length > 16 || !s.all { it in '0'..'9' }) return null
        val v = s.toLongOrNull() ?: return null
        return if (v in 0..MAX_SAFE) v else null
    }

    private fun str(e: JsonElement?): String? =
        (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun textProblem(s: String?, max: Int): Boolean {
        if (s == null || s.length > max) return true
        for (ch in s) {
            val c = ch.code
            if (c == 0x7c || c <= 0x1f || c == 0x7f) return true
        }
        return false
    }

    /**
     * Check the whole rule set and return the bytes the signature covers. Throws
     * [SecurityNoticeException] whose `code` is the first rule broken.
     */
    fun canonical(b: JsonObject, signedBy: String): ByteArray {
        if (!HEX64.matches(signedBy)) fail("bad-signer")
        val seq = uint(b["seq"])?.takeIf { it >= 1 } ?: fail("bad-seq")
        val kind = str(b["kind"])?.takeIf { it in KINDS } ?: fail("bad-kind")
        val validFrom = uint(b["validFrom"]) ?: fail("bad-time")
        val validUntil = uint(b["validUntil"]) ?: fail("bad-time")
        if (validUntil <= validFrom) fail("window-order")
        if (validUntil - validFrom > MAX_WINDOW_MS) fail("window-too-long")
        val eventAt = uint(b["eventAt"]) ?: fail("bad-event-at")
        if (eventAt != 0L && (eventAt < validFrom || eventAt > validUntil)) fail("bad-event-at")
        val lockFrom = uint(b["lockFrom"]) ?: fail("bad-lock-from")
        val deprecates = uint(b["deprecatesProtocol"]) ?: fail("bad-deprecates")
        val entries = platformEntries(b["platforms"])
        val platforms = entries.joinToString(",") { (n, m) -> "$n:${m.minBuild}:${m.minProtocol}" }

        val advisoryId = str(b["advisoryId"])
        if (textProblem(advisoryId, 64)) fail("bad-advisory")
        if (advisoryId!!.isNotEmpty() && !ADVISORY_ID.matches(advisoryId)) fail("bad-advisory")
        val reason = str(b["reason"])
        if (textProblem(reason, MAX_REASON)) fail("bad-reason")
        val message = str(b["message"])
        if (textProblem(message, MAX_MESSAGE)) fail("bad-message")
        if (message!!.contains("://")) fail("message-has-link")
        if (reason!!.contains("://")) fail("message-has-link")
        if (message.contains("{date}") && eventAt == 0L) fail("date-token-needs-event")

        val carriesMinimums = kind == "update-advisory" || kind == "update-required"
        if (kind == "none") {
            if (entries.isNotEmpty()) fail("platforms-not-allowed")
            if (message.isNotEmpty()) fail("message-not-allowed")
            if (eventAt != 0L) fail("bad-event-at")
        } else if (message.isEmpty()) {
            fail("message-required")
        }
        if (carriesMinimums) {
            if (entries.isEmpty()) fail("platforms-required")
            for ((_, m) in entries) if (m.minBuild == 0L && m.minProtocol == 0L) fail("minimum-required")
        } else {
            for ((_, m) in entries) if (m.minBuild != 0L || m.minProtocol != 0L) fail("minimum-not-allowed")
        }
        if (kind == "update-required") {
            if (advisoryId.isEmpty()) fail("advisory-required")
            if (reason.isEmpty()) fail("reason-required")
            if (lockFrom < validFrom || lockFrom >= validUntil) fail("bad-lock-from")
            if (deprecates != 0L) {
                for ((_, m) in entries) if (m.minProtocol <= deprecates) fail("deprecates-not-enforced")
            }
        } else {
            if (lockFrom != 0L) fail("lock-from-not-allowed")
            if (deprecates != 0L) fail("deprecates-not-allowed")
            if (kind != "update-advisory") {
                if (advisoryId.isNotEmpty()) fail("advisory-not-allowed")
                if (reason.isNotEmpty()) fail("reason-not-allowed")
            }
        }

        return listOf(
            TAG, signedBy, seq.toString(), kind, validFrom.toString(), validUntil.toString(),
            eventAt.toString(), lockFrom.toString(), platforms, advisoryId, deprecates.toString(),
            reason, message,
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    private fun platformEntries(e: JsonElement?): List<Pair<String, NoticeMinimum>> {
        val p = e as? JsonObject ?: fail("bad-platforms")
        val out = ArrayList<Pair<String, NoticeMinimum>>()
        for ((name, v) in p) {
            if (name !in PLATFORMS) fail("bad-platforms")
            val m = v as? JsonObject ?: fail("bad-minimum")
            val build = uint(m["minBuild"]) ?: fail("bad-minimum")
            val proto = uint(m["minProtocol"]) ?: fail("bad-minimum")
            out.add(name to NoticeMinimum(build, proto))
        }
        out.sortBy { it.first }
        return out
    }

    /** Shape-check an untrusted notice and enforce every rule (no signature check). Null when it breaks one. */
    fun parse(v: JsonElement?): SecurityNotice? {
        val r = v as? JsonObject ?: return null
        if (str(r["type"]) != "SecurityNotice") return null
        if (uint(r["version"]) != 1L) return null
        val signedBy = str(r["signedBy"]) ?: return null
        val signature = str(r["signature"]) ?: return null
        if (!HEX64.matches(signedBy) || !HEX128.matches(signature)) return null
        val kind = str(r["kind"]) ?: return null
        val advisoryId = str(r["advisoryId"]) ?: return null
        val reason = str(r["reason"]) ?: return null
        val message = str(r["message"]) ?: return null
        if (r["platforms"] !is JsonObject) return null
        try {
            canonical(r, signedBy)
        } catch (_: SecurityNoticeException) {
            return null
        }
        // canonical() accepted every field, so each of these reads is total.
        return SecurityNotice(
            seq = uint(r["seq"])!!,
            kind = kind,
            validFrom = uint(r["validFrom"])!!,
            validUntil = uint(r["validUntil"])!!,
            eventAt = uint(r["eventAt"])!!,
            lockFrom = uint(r["lockFrom"])!!,
            platforms = platformEntries(r["platforms"]).toMap(),
            advisoryId = advisoryId,
            deprecatesProtocol = uint(r["deprecatesProtocol"])!!,
            reason = reason,
            message = message,
            signedBy = signedBy,
            signature = signature,
            raw = r,
        )
    }

    /** Is the signature good, and is the signer one of [authorityKeys]? Null when yes, else the reason. */
    fun verify(n: SecurityNotice, authorityKeys: List<String>): String? {
        val bytes = try {
            canonical(n.raw, n.signedBy)
        } catch (_: SecurityNoticeException) {
            return "malformed"
        }
        if (!HEX128.matches(n.signature)) return "malformed"
        if (n.signedBy !in authorityKeys) return "unauthorized-signer"
        return if (MaintainersEd25519.verify(n.signature, bytes, n.signedBy)) null else "signature-invalid"
    }

    /** Is this client below the notice's minimum for its platform? (false when the platform isn't listed.) */
    fun clientBelowMinimum(n: SecurityNotice, c: NoticeClient): Boolean {
        val m = n.platforms[c.platform] ?: return false
        return (m.minBuild > 0 && c.build < m.minBuild) || (m.minProtocol > 0 && c.protocol < m.minProtocol)
    }

    /**
     * What a client shows for an already VERIFIED notice. Fail open: outside
     * [validFrom, validUntil) nothing; only update-required, from lockFrom, for a
     * client below the minimum, locks.
     */
    fun outcome(n: SecurityNotice, c: NoticeClient, now: Long): NoticeOutcome {
        if (n.kind == "none") return NoticeOutcome.None("kind-none")
        if (now < n.validFrom) return NoticeOutcome.None("not-yet")
        if (now >= n.validUntil) return NoticeOutcome.None("expired")
        if (n.kind == "maintenance") {
            if (n.platforms.isNotEmpty() && c.platform !in n.platforms) return NoticeOutcome.None("other-platform")
            return NoticeOutcome.Banner("maintenance", n)
        }
        if (c.platform !in n.platforms) return NoticeOutcome.None("other-platform")
        if (!clientBelowMinimum(n, c)) return NoticeOutcome.None("up-to-date")
        if (n.kind == "update-required" && now >= n.lockFrom) return NoticeOutcome.Lock(n)
        return NoticeOutcome.Banner("update", n)
    }

    /**
     * Fold a fetched candidate into the store. A candidate that is malformed,
     * unsigned by the authority, or not newer than the highest seq verified is
     * dropped and the store stays as it was.
     */
    fun accept(store: NoticeStore, candidate: JsonElement?, authorityKeys: List<String>): NoticeAccept {
        if (candidate == null || candidate is JsonNull) return NoticeAccept(store, null)
        val n = parse(candidate) ?: return NoticeAccept(store, "malformed")
        verify(n, authorityKeys)?.let { return NoticeAccept(store, it) }
        if (n.seq <= store.highestSeq) return NoticeAccept(store, "stale")
        return NoticeAccept(NoticeStore(n.seq, n), null)
    }

    /** The stored notice's outcome, re-verified against the authority NOW; unverifiable means nothing. */
    fun storedOutcome(store: NoticeStore, authorityKeys: List<String>, client: NoticeClient, now: Long): NoticeOutcome {
        val n = store.notice ?: return NoticeOutcome.nothing
        if (verify(n, authorityKeys) != null) return NoticeOutcome.nothing
        return outcome(n, client, now)
    }

    /** The notice's message with `{date}` replaced by the caller's rendering of eventAt. */
    fun text(n: SecurityNotice, formatDate: (Long) -> String): String =
        if (n.eventAt == 0L) n.message else n.message.split("{date}").joinToString(formatDate(n.eventAt))

    /**
     * The ca-track maintainer authority at [nowMs], from the mandate log a
     * response carries, walked forward from [pin]. [minTip] is the issuedAt of
     * the newest authority mandate this device has verified: an older one is
     * refused, so a hostile carrier cannot replay a chain from before a rotation.
     */
    fun authority(mandates: List<Mandate>, nowMs: Long, pin: String, minTip: Long): NoticeAuthority {
        val none = NoticeAuthority(emptyList(), minTip)
        if (mandates.isEmpty()) return none
        val auth = try {
            MaintainersVerifier.currentAuthority(
                MaintainersVerifier.verifyMandateChainFromPin(pin, mandates),
                nowMs,
            )
        } catch (_: Throwable) {
            null
        } ?: return none
        val issued = MaintainersTime.epochMs(auth.mandate.issuedAt) ?: return none
        if (issued < minTip) return none
        return NoticeAuthority(listOf(auth.holder), maxOf(issued, minTip))
    }

    /** Parse the mandate log a notice response carries; null when any entry is malformed. */
    fun parseMandates(arr: JsonElement?): List<Mandate>? {
        val list = arr as? JsonArray ?: return null
        val out = ArrayList<Mandate>(list.size)
        for (e in list) out.add(parseMandate(e) ?: return null)
        return out
    }

    private fun parseMandate(e: JsonElement): Mandate? {
        val o = e as? JsonObject ?: return null
        return try {
            fun s(k: String) = str(o[k]) ?: throw IllegalArgumentException(k)
            fun i(k: String) = (uint(o[k]) ?: throw IllegalArgumentException(k)).toInt()
            val rule = o["approvalRule"] as? JsonObject ?: return null
            val proj = (o["project"] as? JsonObject)?.let {
                MaintainersProject(
                    name = str(it["name"]),
                    contact = str(it["contact"]),
                    homepage = str(it["homepage"]),
                    tracks = (it["tracks"] as? JsonArray)?.map { t -> str(t) ?: throw IllegalArgumentException("tracks") },
                )
            }
            Mandate(
                kind = s("kind"),
                version = i("version"),
                mandateId = s("mandateId"),
                track = s("track"),
                holder = s("holder"),
                issuedAt = s("issuedAt"),
                expiresAt = s("expiresAt"),
                successors = (o["successors"] as? JsonArray)?.map { t -> str(t) ?: throw IllegalArgumentException("successors") }
                    ?: return null,
                approvalRule = MaintainersApprovalRule(str(rule["kind"]) ?: return null, (uint(rule["threshold"]) ?: return null).toInt()),
                minSuccessors = i("minSuccessors"),
                maxDurationSeconds = i("maxDurationSeconds"),
                defaultDurationSeconds = i("defaultDurationSeconds"),
                project = proj,
                signedBy = s("signedBy"),
                signatures = (o["signatures"] as? JsonArray)?.map { sg ->
                    val so = sg as? JsonObject ?: throw IllegalArgumentException("signatures")
                    MaintainersSignature(str(so["pubkey"]) ?: throw IllegalArgumentException("pubkey"), str(so["sig"]) ?: throw IllegalArgumentException("sig"))
                } ?: return null,
            )
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** The JSON a store keeps for a notice: an `{"version":1,"notice":…,"mandates":[…]}` document. */
    fun document(notice: JsonObject, mandates: JsonElement): JsonObject = buildJsonObject {
        put("version", 1)
        put("notice", notice)
        put("mandates", mandates)
    }

    val json = Json { ignoreUnknownKeys = true }
}

data class NoticeAuthority(val keys: List<String>, val tip: Long)
