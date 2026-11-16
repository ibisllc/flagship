// The owner's call hours, synced between the owner's own devices and never published (owner decision 2026-11-16,
// option c: hours in the page index would show the owner's time zone to anyone): the Kotlin twin of
// packages/protocol/src/voiciCallSettings.ts (vectors: voici-call-modes section `callSettings`). Sealed like the
// Messages state blob under its own key, so `.com` stores ciphertext only. The ringing phone enforces them: outside
// them it doesn't ring, and the unanswered call becomes a missed call.
//
//   key     HKDF-SHA256(ikm UMK seed, salt empty, info "flagship/voici-call-settings/v1", 32)
//   sealed  {version, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce, aad "flagship/voici-call-settings/v1|
//           <username>|<version>", canonical JSON {v:1, hours, updatedAt}); hours null or {days, from, to, zone}

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters

/** When calls ring: [days] seven "0"/"1" from Monday; [from] and [to] "HHMM" (an end before the start runs past midnight). */
data class VoiciCallHours(val days: String, val from: String, val to: String, val zone: String) {
    fun toJson() = JsonObject(linkedMapOf("days" to JsonPrimitive(days), "from" to JsonPrimitive(from), "to" to JsonPrimitive(to), "zone" to JsonPrimitive(zone)))
}

data class VoiciCallHoursSetting(val hours: VoiciCallHours?, val updatedAt: Long) {
    fun toJson() = JsonObject(linkedMapOf("v" to JsonPrimitive(1), "hours" to (hours?.toJson() ?: JsonNull), "updatedAt" to JsonPrimitive(updatedAt)))
}

object VoiciCallHoursSettings {
    const val TAG = "flagship/voici-call-settings/v1"
    const val MAX_BYTES = 4 * 1024
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private val DAYS = Regex("^[01]{7}$")
    private val HHMM = Regex("^([01][0-9]|2[0-3])[0-5][0-9]$")
    private val ZONE = Regex("^(UTC|[A-Za-z]{1,32}(?:/[A-Za-z0-9_+-]{1,32}){1,2})$")

    private fun knownZone(z: String) = runCatching { java.time.ZoneId.of(z) }.isSuccess

    /** Strict shape of the hours (and a time zone this runtime knows). */
    fun parseHours(v: JsonElement?): VoiciCallHours? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("days", "from", "to", "zone"))) return null
        val days = VoiciJs.str(o["days"])?.takeIf { DAYS.matches(it) && it != "0000000" } ?: return null
        val from = VoiciJs.str(o["from"])?.takeIf { HHMM.matches(it) } ?: return null
        val to = VoiciJs.str(o["to"])?.takeIf { HHMM.matches(it) && it != from } ?: return null
        val zone = VoiciJs.str(o["zone"])?.takeIf { ZONE.matches(it) && knownZone(it) } ?: return null
        return VoiciCallHours(days, from, to, zone)
    }

    fun parse(v: JsonElement?): VoiciCallHoursSetting? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("v", "hours", "updatedAt")) || !VoiciJs.isNumEq(o["v"], 1)) return null
        val at = VoiciJs.time(o["updatedAt"]) ?: return null
        if (o["hours"] is JsonNull) return VoiciCallHoursSetting(null, at)
        return VoiciCallHoursSetting(parseHours(o["hours"]) ?: return null, at)
    }

    /** Whether a call may ring at [now] (no hours: always; a bad value never blocks). Run on the ringing device only. */
    fun allow(hours: VoiciCallHours?, now: Long): Boolean {
        val h = hours?.let { parseHours(it.toJson()) } ?: return true
        val t = java.time.Instant.ofEpochMilli(now).atZone(java.time.ZoneId.of(h.zone))
        val day = t.dayOfWeek.value - 1
        val min = t.hour * 60 + t.minute
        fun m(x: String) = x.substring(0, 2).toInt() * 60 + x.substring(2).toInt()
        val start = m(h.from)
        val end = m(h.to)
        fun on(d: Int) = h.days[(d + 7) % 7] == '1'
        return if (start < end) on(day) && min >= start && min < end else (on(day) && min >= start) || (on(day - 1) && min < end)
    }

    fun deriveKey(umkSeed: ByteArray): ByteArray {
        val g = HKDFBytesGenerator(SHA256Digest())
        g.init(HKDFParameters(umkSeed, ByteArray(0), VoiciJs.utf8(TAG)))
        return ByteArray(32).also { g.generateBytes(it, 0, 32) }
    }

    private fun aad(username: String, version: Long) = VoiciJs.utf8("$TAG|$username|$version")

    fun seal(key: ByteArray, username: String, version: Long, s: VoiciCallHoursSetting, nonce: ByteArray = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }): JsonObject {
        require(USERNAME.matches(username) && version >= 1 && nonce.size == 12 && parse(s.toJson()) != null) { TAG }
        val ct = VoiciJs.gcmEncrypt(key, nonce, aad(username, version), WebEnvelopes.canonicalJsonBytes(s.toJson()))
        return JsonObject(linkedMapOf("version" to JsonPrimitive(version), "nonce" to JsonPrimitive(VoiciJs.hex(nonce)), "ct" to JsonPrimitive(WebEnvelopes.b64Encode(ct))))
    }

    fun open(key: ByteArray, username: String, blob: JsonElement?): VoiciCallHoursSetting? {
        val o = VoiciJs.obj(blob) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("version", "nonce", "ct"))) return null
        val version = VoiciJs.time(o["version"]) ?: return null
        val nonce = VoiciJs.str(o["nonce"])?.takeIf { WebEnvelopes.isLowerHex(it, 12) } ?: return null
        val ct = WebEnvelopes.b64Decode(VoiciJs.str(o["ct"])) ?: return null
        if (ct.size > MAX_BYTES + 16) return null
        return try {
            val text = VoiciJs.utf8Fatal(VoiciJs.gcmDecrypt(key, WebEnvelopes.hexToBytes(nonce), aad(username, version), ct)) ?: return null
            val v = VoiciJs.parseJson(text) ?: return null
            if (WebEnvelopes.canonicalJson(v) != text) null else parse(v)
        } catch (_: Exception) {
            null
        }
    }

    /** The stored blob's version (the next write is version + 1). */
    fun version(blob: JsonElement?): Long = VoiciJs.obj(blob)?.let { VoiciJs.time(it["version"]) } ?: 0

    /** A version conflict: the newer settings win. */
    fun merge(local: VoiciCallHoursSetting, remote: VoiciCallHoursSetting): VoiciCallHoursSetting = if (remote.updatedAt > local.updatedAt) remote else local
}
