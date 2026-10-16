// "Keep a copy on this phone" (docs/server-backup-and-clone.md, "Backup
// policy": phone-side). In the background (WorkManager: unmetered network,
// charging), the phone fetches each server's newest saved backup into its own
// private storage, `filesDir/backups/<server>/<archiveId>/`, with the same
// resumable chunk downloader as Back up now, checks its SHA-256, and keeps the
// newest two that fit the space the owner reserved. One `.flagship` file each. Downloading is a session
// read: nothing is opened and the account key is never needed.

package com.flagshipserver.app.core

import android.content.Context
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SavedBackup
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import java.io.File

/** The copies this phone keeps, and the per-server setting. */
class PhoneBackupCopies(
    private val root: File,
    private val prefs: android.content.SharedPreferences?,
) {
    data class Copy(val server: String, val meta: SavedBackup, val dir: File) {
        /** The one `.flagship` file. */
        val file: File get() = File(dir, meta.bundleFileName)
    }

    private val json = Json { ignoreUnknownKeys = true }

    private fun serverDir(server: String) = File(root, server.lowercase())

    /** "Keep a copy on this phone" (default on). */
    fun keepCopy(server: String): Boolean = prefs?.getBoolean("keep.${server.lowercase()}", true) ?: true

    fun setKeepCopy(server: String, on: Boolean) {
        prefs?.edit()?.putBoolean("keep.${server.lowercase()}", on)?.apply()
    }

    /** Why the last run kept no copy (the phone's free space), or null. */
    fun note(server: String): String? = prefs?.getString("note.${server.lowercase()}", null)

    fun setNote(server: String, note: String?) {
        prefs?.edit()?.apply { if (note == null) remove("note.${server.lowercase()}") else putString("note.${server.lowercase()}", note) }?.apply()
    }

    /** The complete copies of [server], newest first. */
    fun copies(server: String): List<Copy> =
        (serverDir(server).listFiles() ?: emptyArray()).mapNotNull { dir ->
            val meta = runCatching { json.decodeFromString(SavedBackup.serializer(), File(dir, META).readText()) }.getOrNull()
                ?: return@mapNotNull null
            Copy(server.lowercase(), meta, dir).takeIf { it.file.isFile }
        }.sortedByDescending { it.meta.createdAt }

    fun has(server: String, archiveId: String): Boolean = copies(server).any { it.meta.archiveId == archiveId }

    /** Keep the newest always, the previous one only while both fit [reserveBytes]
     *  (no reserve: the newest two); everything else, half-downloaded ones of
     *  older backups included, goes. */
    fun prune(server: String, reserveBytes: Long, keepPartial: String? = null) {
        val keep = keepIds(copies(server).map { it.meta }, reserveBytes)
        for (dir in serverDir(server).listFiles() ?: emptyArray()) {
            if (dir.name in keep || dir.name == keepPartial) continue
            dir.deleteRecursively()
        }
    }

    /** Download [b] from [client] into this phone's storage. */
    suspend fun fetch(server: String, b: SavedBackup, client: ScreensClient, progress: (Long) -> Unit = {}) {
        val dir = File(serverDir(server), b.archiveId).apply { mkdirs() }
        val part = File(dir, "bundle.part")
        ArchiveDownloader.download(
            total = b.bundleBytes,
            sha256 = b.bundleSha256,
            file = part,
            stateFile = File(dir, "bundle.state.json"),
            fetch = { offset -> client.savedBackupBundleChunk(b.archiveId, offset) },
            progress = progress,
        )
        val bundle = File(dir, b.bundleFileName)
        bundle.delete()
        check(part.renameTo(bundle)) { "The backup couldn't be saved on this phone." }
        File(dir, META).writeText(json.encodeToString(SavedBackup.serializer(), b))
    }

    companion object {
        private const val META = "backup.json"
        /** Room left on the phone after a copy. */
        const val HEADROOM_BYTES: Long = 1L * 1024 * 1024 * 1024

        fun from(context: Context) = PhoneBackupCopies(
            File(context.filesDir, "backups"),
            context.getSharedPreferences("flagship.phoneBackups", Context.MODE_PRIVATE),
        )

        fun keepIds(newestFirst: List<SavedBackup>, reserveBytes: Long): Set<String> {
            val newest = newestFirst.firstOrNull() ?: return emptySet()
            val prev = newestFirst.getOrNull(1)
            val both = prev != null && (reserveBytes <= 0 || newest.totalBytes + prev.totalBytes <= reserveBytes)
            return if (both) setOf(newest.archiveId, prev!!.archiveId) else setOf(newest.archiveId)
        }

        fun needsSpaceLine(bytes: Long): String = "This phone needs about ${ServerArchive.formatBytes(bytes)} free to keep a copy."
    }
}

/** One background run over the servers this phone has an owner session for. */
class PhoneBackupFetcher(
    private val copies: PhoneBackupCopies,
    /** A screens client for a server (its own session), or null. */
    private val clientFor: (server: String) -> ScreensClient?,
    private val freeBytes: () -> Long,
    private val log: (String) -> Unit = {},
) {
    suspend fun run(servers: List<String>) {
        for (server in servers) {
            try {
                fetchOne(server)
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                log("[backup-fetch] $server: ${t.message}")
            }
        }
    }

    /** Fetch [server]'s newest backup if this phone should keep it. */
    suspend fun fetchOne(server: String) {
        if (!copies.keepCopy(server)) return
        val client = clientFor(server) ?: return
        val policy = runCatching { client.backupPolicy().policy }.getOrNull()
        val kind = policy?.policy ?: "unset"
        if (kind != "phone" && kind != "unset") return
        val reserve = if (kind == "phone") policy?.phoneReserveBytes ?: 0 else 0
        val newest = client.savedBackups().backups.firstOrNull() ?: return
        if (copies.has(server, newest.archiveId)) {
            copies.prune(server, reserve)
            return
        }
        val need = newest.totalBytes + PhoneBackupCopies.HEADROOM_BYTES
        if (freeBytes() < need) {
            copies.setNote(server, PhoneBackupCopies.needsSpaceLine(need))
            return
        }
        copies.fetch(server, newest, client)
        copies.setNote(server, null)
        copies.prune(server, reserve)
    }
}
