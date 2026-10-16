// "Backup/clone server" (docs/server-backup-and-clone.md): the key that seals an
// archive, the readable header of an archive file, and the wording around both.
// Must pass packages/protocol/test-vectors/server-archive/vectors.json.
// MIRRORS: apps/mobile/shared/Sources/FlagshipCore/ServerArchive.swift

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ServerArchive {
    const val FILE_EXTENSION = "flagship-backup"
    const val UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
    const val HEADER_MAX_BYTES = 64 * 1024

    const val EXCLUDES_NOTE =
        "Holds your apps' source, data and settings, never system images: the server you import onto rebuilds each app, so any Flagship server can open it. Not included: API keys, the server's name and certificate, peer backups, and the Git host."
    const val CLONE_HINT =
        "To clone a server under a new name: add the new server first, then import the backup onto it."

    private val ID_RE = Regex("^[0-9a-f]{32}$")

    fun isArchiveId(s: String): Boolean = ID_RE.matches(s)

    fun newArchiveId(): String {
        val b = ByteArray(16)
        java.security.SecureRandom().nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** HKDF-SHA256(umkSeed, salt: empty, info: "flagship/server-archive/v1|<archiveId>") -> 32 bytes. */
    fun deriveKey(umkSeed: ByteArray, archiveId: String): ByteArray? {
        if (umkSeed.size != 32 || !isArchiveId(archiveId)) return null
        return hkdfSha256(umkSeed, "flagship/server-archive/v1|$archiveId".toByteArray(Charsets.UTF_8), 32)
    }

    private fun hkdfSha256(ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }

    data class Header(
        val archiveId: String,
        val createdAt: Long,
        val sourceServer: String,
        val appNames: List<String>,
    )

    class HeaderException(message: String) : Exception(message)

    /** Reads the readable first line of an archive file (pass its first ~64 KB). */
    fun parseHeader(head: ByteArray): Header {
        val nl = head.indexOf(0x0a.toByte())
        val obj: JsonObject = try {
            if (nl < 0) throw IllegalArgumentException("no header")
            Json.parseToJsonElement(String(head, 0, nl, Charsets.UTF_8)).jsonObject
        } catch (_: Exception) {
            throw HeaderException("That isn't a Flagship backup.")
        }
        fun str(k: String) = obj[k]?.jsonPrimitive?.contentOrNull
        if (str("magic") != "flagship-archive") throw HeaderException("That isn't a Flagship backup.")
        if (obj["v"]?.jsonPrimitive?.intOrNull != 1) {
            throw HeaderException("This backup is from a newer version of Flagship. Update the app and try again.")
        }
        val id = str("archiveId") ?: ""
        if (!isArchiveId(id)) throw HeaderException("This backup's header is damaged.")
        val names = (obj["apps"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.get("name")?.jsonPrimitive?.contentOrNull } ?: emptyList()
        return Header(id, obj["createdAt"]?.jsonPrimitive?.longOrNull ?: 0, str("sourceServer") ?: "", names)
    }

    /** `<server label>-<yyyy-MM-dd>.flagship-backup` */
    fun fileName(sourceServer: String, createdAtMs: Long): String {
        val label = sourceServer.substringBefore('.').filter { it.isLetterOrDigit() || it == '-' }
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return "${label.ifEmpty { "server" }}-${f.format(Date(createdAtMs))}.$FILE_EXTENSION"
    }

    fun formatBytes(n: Long): String = when {
        n < 0 -> ""
        n < 1024 * 1024 -> "${maxOf(1L, Math.round(n / 1024.0))} KB"
        n < 1024L * 1024 * 1024 ->
            if (n < 10L * 1024 * 1024) "%.1f MB".format(Locale.US, n / (1024.0 * 1024)) else "${Math.round(n / (1024.0 * 1024))} MB"
        else -> "%.1f GB".format(Locale.US, n / (1024.0 * 1024 * 1024))
    }
}
