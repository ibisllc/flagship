// "Backup/clone server" (docs/server-backup-and-clone.md): the account's key for
// a backup (the KEK of its account slot), the names of a backup's two files, and
// the wording around them. The format is ServerBackupFormat.
// Must pass packages/protocol/test-vectors/server-archive/vectors.json.
// MIRRORS: apps/mobile/shared/Sources/FlagshipCore/ServerArchive.swift

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ServerArchive {
    const val UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

    val EXCLUDES_NOTE get() =
        FSStrings.get(R.string.holds_your_apps_source_data_and)
    val PASSCODE_NOTE get() =
        FSStrings.get(R.string.anyone_with_the_backup_file_and)
    val IMPORT_INTRO get() =
        FSStrings.get(R.string.pick_the_backups_flagship_file_from)

    private val ID_RE = Regex("^[0-9a-f]{32}$")

    fun isArchiveId(s: String): Boolean = ID_RE.matches(s)

    fun newArchiveId(): String = HexUtil.encode(ServerBackupFormat.randomBytes(16))

    /** HKDF-SHA256(umkSeed, salt: empty, info: "flagship/server-archive/v1|<archiveId>"): the key
     *  of a backup's account slot. Independent of any server id, so any device of the
     *  account opens its backups under any new name. */
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

    /** `<server label>-<yyyy-MM-dd>`: the backup file is this plus `.flagship`. */
    fun fileStem(sourceServer: String, createdAtMs: Long): String {
        val label = sourceServer.substringBefore('.').filter { it.isLetterOrDigit() || it == '-' }
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return "${label.ifEmpty { "server" }}-${f.format(Date(createdAtMs))}"
    }

    fun formatBytes(n: Long): String = when {
        n < 0 -> ""
        n < 1024 * 1024 -> FSStrings.get(R.string.kb, maxOf(1L, Math.round(n / 1024.0)))
        n < 1024L * 1024 * 1024 ->
            if (n < 10L * 1024 * 1024) "%.1f MB".format(Locale.US, n / (1024.0 * 1024)) else FSStrings.get(R.string.mb, Math.round(n / (1024.0 * 1024)))
        else -> "%.1f GB".format(Locale.US, n / (1024.0 * 1024 * 1024))
    }
}
