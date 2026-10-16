// "Backup/clone server" (docs/server-backup-and-clone.md): the account's key for
// a backup (the KEK of its account slot), the names of a backup's two files, and
// the wording around them. The format is ServerBackupFormat.
// Must pass packages/protocol/test-vectors/server-archive/vectors.json.
// MIRRORS: apps/mobile/shared/Sources/FlagshipCore/ServerArchive.swift

package com.flagshipserver.app.core

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ServerArchive {
    const val UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

    const val EXCLUDES_NOTE =
        "Holds your apps' source, data and settings, never system images: the new server rebuilds each app, so any Flagship server can restore it. Not included: the server's keys and certificate, peer backups, and the Git host."
    const val PASSCODE_NOTE =
        "Anyone with the backup file and this passcode can restore the backup, on any account, so keep it somewhere safe and apart from the file. It can't be reset. Your own devices open your backups without it."
    const val IMPORT_INTRO =
        "Pick the backup's .flagship file from wherever you keep it. " +
            "You choose a name; everything else comes from the backup. Then set up the new server as usual, " +
            "and this screen sends it the backup as soon as it comes online."

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
        n < 1024 * 1024 -> "${maxOf(1L, Math.round(n / 1024.0))} KB"
        n < 1024L * 1024 * 1024 ->
            if (n < 10L * 1024 * 1024) "%.1f MB".format(Locale.US, n / (1024.0 * 1024)) else "${Math.round(n / (1024.0 * 1024))} MB"
        else -> "%.1f GB".format(Locale.US, n / (1024.0 * 1024 * 1024))
    }
}
