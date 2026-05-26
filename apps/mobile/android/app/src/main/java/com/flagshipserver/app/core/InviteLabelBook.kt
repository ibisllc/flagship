// P6 — owner-only label book mirroring the canonical webapp `labelBook.js`
// and iOS `FlagshipCore/InviteLabelBook.swift`.
//
// Privacy invariant: this data NEVER leaves the device. The daemon only
// sees `opaqueTag` + the redeemer's IRK pubkey hex after they redeem;
// the human-readable "John (work)" mapping stays here.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.security.SecureRandom

@Serializable
data class InviteLabel(
    val displayName: String,
    val channel: String,
    val sentTo: String,
    val notes: String,
    val sentAt: Long,
)

@Serializable
data class InviteLabelRow(
    val serviceId: String,
    val opaqueTagHex: String,
    val label: InviteLabel,
)

interface InviteLabelBook {
    fun put(serviceId: String, opaqueTagHex: String, label: InviteLabel)
    fun get(serviceId: String, opaqueTagHex: String): InviteLabel?
    fun list(serviceId: String): List<InviteLabelRow>
    fun remove(serviceId: String, opaqueTagHex: String)
}

/** SharedPreferences-backed implementation. Single-blob storage keeps
 *  the write path lock-free + race-free for the expected volumes (tens
 *  of invites per app). */
class SharedPreferencesInviteLabelBook(
    private val prefs: SharedPreferences,
    private val storageKey: String = "flagship.inviteLabelBook.v1",
    private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) : InviteLabelBook {

    @Synchronized
    override fun put(serviceId: String, opaqueTagHex: String, label: InviteLabel) {
        val blob = readBlob().toMutableMap()
        val key = makeKey(serviceId, opaqueTagHex)
        blob[key] = InviteLabelRow(serviceId, opaqueTagHex.lowercase(), label)
        writeBlob(blob)
    }

    @Synchronized
    override fun get(serviceId: String, opaqueTagHex: String): InviteLabel? =
        readBlob()[makeKey(serviceId, opaqueTagHex)]?.label

    @Synchronized
    override fun list(serviceId: String): List<InviteLabelRow> =
        readBlob().values
            .filter { it.serviceId == serviceId }
            .sortedByDescending { it.label.sentAt }

    @Synchronized
    override fun remove(serviceId: String, opaqueTagHex: String) {
        val blob = readBlob().toMutableMap()
        blob.remove(makeKey(serviceId, opaqueTagHex))
        writeBlob(blob)
    }

    private fun makeKey(serviceId: String, opaqueTagHex: String): String =
        "$serviceId|${opaqueTagHex.lowercase()}"

    private val mapSerializer = MapSerializer(String.serializer(), InviteLabelRow.serializer())

    private fun readBlob(): Map<String, InviteLabelRow> {
        val raw = prefs.getString(storageKey, null) ?: return emptyMap()
        return runCatching { json.decodeFromString(mapSerializer, raw) }.getOrDefault(emptyMap())
    }

    private fun writeBlob(blob: Map<String, InviteLabelRow>) {
        val raw = json.encodeToString(mapSerializer, blob)
        prefs.edit().putString(storageKey, raw).apply()
    }

    companion object {
        fun fromContext(context: Context): SharedPreferencesInviteLabelBook =
            SharedPreferencesInviteLabelBook(
                context.getSharedPreferences("flagship.inviteLabels", Context.MODE_PRIVATE),
            )
    }
}

/** In-memory implementation for tests + previews. */
class InMemoryInviteLabelBook : InviteLabelBook {
    private val blob = mutableMapOf<String, InviteLabelRow>()

    @Synchronized
    override fun put(serviceId: String, opaqueTagHex: String, label: InviteLabel) {
        blob[key(serviceId, opaqueTagHex)] = InviteLabelRow(serviceId, opaqueTagHex.lowercase(), label)
    }

    @Synchronized
    override fun get(serviceId: String, opaqueTagHex: String): InviteLabel? =
        blob[key(serviceId, opaqueTagHex)]?.label

    @Synchronized
    override fun list(serviceId: String): List<InviteLabelRow> =
        blob.values
            .filter { it.serviceId == serviceId }
            .sortedByDescending { it.label.sentAt }

    @Synchronized
    override fun remove(serviceId: String, opaqueTagHex: String) {
        blob.remove(key(serviceId, opaqueTagHex))
    }

    private fun key(serviceId: String, opaqueTagHex: String): String =
        "$serviceId|${opaqueTagHex.lowercase()}"
}

// ---------- Opaque-tag minting + share-url builder ---------------------

object InviteUtil {
    private val random = SecureRandom()

    /** Mint a 16-byte opaque tag (lowercase hex, 32 chars). Mirrors
     *  `apps/web/public/webapp/lib/labelBook.js#generateOpaqueTag`. */
    fun generateOpaqueTag(): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /** Build the share URL the recipient redeems through. Mirrors the
     *  webapp's `buildShareUrl(appUrl, secretHex, serviceId)`. */
    fun buildShareUrl(appUrl: String, secretHex: String, serviceId: String): String {
        val base = appUrl.trimEnd('/')
        return "$base/invite#k=$secretHex&a=${urlEncodePath(serviceId)}"
    }

    /** Mirrors RFC 3986 `pchar` minimally — the webapp uses encodeURIComponent
     *  which is overly aggressive for the path segment use here; this
     *  matches the iOS `urlPathAllowed` percent-encoder. */
    private fun urlEncodePath(s: String): String {
        val sb = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val ch = b.toInt() and 0xff
            val isUnreserved = ch in 0x30..0x39 || ch in 0x41..0x5a || ch in 0x61..0x7a ||
                ch == 0x2d || ch == 0x2e || ch == 0x5f || ch == 0x7e ||
                ch == 0x21 || ch == 0x24 || ch == 0x26 || ch == 0x27 ||
                ch == 0x28 || ch == 0x29 || ch == 0x2a || ch == 0x2b ||
                ch == 0x2c || ch == 0x3a || ch == 0x3b || ch == 0x3d ||
                ch == 0x40
            if (isUnreserved) sb.append(ch.toChar())
            else sb.append("%%%02X".format(ch))
        }
        return sb.toString()
    }
}
