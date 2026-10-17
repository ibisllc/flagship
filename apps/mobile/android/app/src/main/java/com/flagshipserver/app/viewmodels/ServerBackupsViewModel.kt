// The server page's Backups section (docs/server-backup-and-clone.md, "Backup
// policy" and "Scheduled backups"): the backup policy and its size limit, the
// box's saved backups and their schedule, Back up now into the list, the
// keys an admin device hands the box, and downloading a saved backup.
// MIRRORS the iOS ServerBackupsViewModel.

package com.flagshipserver.app.viewmodels

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.flagshipserver.app.api.BackupKeysRequest
import com.flagshipserver.app.api.BackupPolicyRequest
import com.flagshipserver.app.api.BackupPolicyView
import com.flagshipserver.app.api.BackupSchedule
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.api.SavedBackupsView
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.ArchiveDownloader
import com.flagshipserver.app.core.ArchiveKey
import com.flagshipserver.app.core.ArchiveKeys
import com.flagshipserver.app.core.BackupPolicyOrder
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.HexUtil
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

class ServerBackupsViewModel(
    val serverFqdn: String,
    private val client: ScreensClient,
    /** An admin device of the account (or a demo account): it signs the orders and deposits keys. */
    val isAdmin: Boolean,
    /** Signs canonical bytes with the sensitive-order key (biometric-gated). */
    private val sign: suspend (ByteArray) -> ByteArray,
    /** Fresh archive ids with their account-slot keys (biometric-gated, same session). */
    private val mintKeys: suspend (Int) -> List<ArchiveKey>,
    /** True when signing now would show the biometric prompt. */
    private val signingNeedsPrompt: () -> Boolean = { false },
    /** Where a download's parts land (resumes from here) and the two files end up. */
    private val downloadDir: () -> File,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val pollMs: Long = 2_000,
) {
    var view by mutableStateOf<SavedBackupsView?>(null)
        private set
    var policy by mutableStateOf<BackupPolicyView?>(null)
        private set
    /** Notes about full apps and the disk brake from the box's server-detail `storage` (docs/app-runtimes.md 5.3). */
    var storageNotes by mutableStateOf<List<String>>(emptyList())
        private set
    /** The saved-backups view couldn't load (an older box answers 404). */
    var loadError by mutableStateOf<String?>(null)
        private set
    /** The box's sentence for a refused action. */
    var actionError by mutableStateOf<String?>(null)
        private set
    var policyError by mutableStateOf<String?>(null)
        private set
    /** Signing needs the biometric: an admin taps "Approve backups for this server". */
    var needsApproval by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    /** Download progress (0..1) per archive id while one runs. */
    val downloading = mutableStateMapOf<String, Double>()

    // ── Load ───────────────────────────────────────────────────────

    suspend fun load() {
        coroutineScope {
            val p = async { runCatching { client.backupPolicy() } }
            val s = async { runCatching { client.savedBackups() } }
            val d = async { runCatching { client.serverDetail() } }
            d.await().onSuccess { detail ->
                storageNotes = com.flagshipserver.app.core.AppStorageText.serverNotes(detail.storage) { id ->
                    id.substringAfterLast("--").replaceFirstChar { it.uppercase() }
                }
            }
            p.await().onSuccess { policy = it }
            s.await()
                .onSuccess {
                    view = it
                    loadError = null
                }
                .onFailure { if (it is CancellationException) throw it else loadError = message(it, "The backups couldn't be loaded.") }
        }
        maybeDeposit(auto = true)
        follow()
    }

    /** Hand the box more keys when it asks: silently while the session is
     *  open, else behind the approve button (never a prompt on page open). */
    suspend fun maybeDeposit(auto: Boolean) {
        if (!BackupsText.shouldDeposit(isAdmin, view)) {
            needsApproval = false
            return
        }
        if (auto && signingNeedsPrompt()) {
            needsApproval = true
            return
        }
        deposit()
    }

    /** One approval for the whole batch. */
    suspend fun deposit(): Boolean {
        val v = view ?: return false
        if (!BackupsText.shouldDeposit(isAdmin, v)) return false
        busy = true
        actionError = null
        try {
            val keys = mintKeys(minOf(v.keysWanted, ArchiveKeys.MAX_PER_DEPOSIT))
            val d = ArchiveKeys.deposit(serverFqdn, keys, now())
            val sig = sign(d.canonicalBytes())
            view = client.depositBackupKeys(BackupKeysRequest(d, HexUtil.encode(sig), keys))
            needsApproval = false
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t, "The backups couldn't be approved.")
            needsApproval = true
            return false
        } finally {
            busy = false
        }
    }

    /** Poll every 2 s while a backup runs. */
    suspend fun follow() {
        while (view?.running != null) {
            delay(pollMs)
            try {
                view = client.savedBackups()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                return
            }
        }
    }

    // ── Back up now, schedule, delete ──────────────────────────────

    suspend fun backUpNow() {
        if (!isAdmin) return
        actionError = null
        busy = true
        try {
            try {
                client.runBackupNow()
            } catch (t: Throwable) {
                if (t is CancellationException || !isNoKeys(t)) throw t
                // The box has no keys yet: hand it some, then try once more.
                if (!deposit()) return
                client.runBackupNow()
            }
            view = client.savedBackups()
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t, "The backup couldn't start.")
            return
        } finally {
            busy = false
        }
        follow()
    }

    suspend fun saveSchedule(s: BackupSchedule): Boolean {
        if (!isAdmin) return false
        actionError = null
        return try {
            view = client.putBackupSchedule(s)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t, "The schedule couldn't be saved.")
            false
        }
    }

    suspend fun delete(archiveId: String) {
        if (!isAdmin) return
        actionError = null
        try {
            view = client.deleteSavedBackup(archiveId)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t, "The backup couldn't be deleted.")
        }
    }

    // ── Policy ─────────────────────────────────────────────────────

    /** Sign and send a new policy; the box's sentence on refusal. */
    suspend fun changePolicy(kind: String, phoneReserveBytes: Long): Boolean {
        if (!isAdmin) return false
        policyError = null
        return try {
            val order = BackupPolicyOrder.make(serverFqdn, kind, phoneReserveBytes, now())
            val sig = sign(order.canonicalBytes())
            policy = client.setBackupPolicy(BackupPolicyRequest(order, HexUtil.encode(sig)))
            runCatching { client.savedBackups() }.onSuccess { view = it }
            maybeDeposit(auto = true)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            policyError = message(t, "The backup policy couldn't be changed.")
            false
        }
    }

    // ── Download ───────────────────────────────────────────────────

    /** A saved backup's one `.flagship` file, in 4 MiB parts, several at once,
     *  resuming and checked against the box's SHA-256. The server keeps its copy. */
    suspend fun download(b: SavedBackup): File? {
        if (downloading.containsKey(b.archiveId)) return null
        downloading[b.archiveId] = 0.0
        actionError = null
        val dir = File(downloadDir(), b.archiveId).apply { mkdirs() }
        val part = File(dir, "bundle.part")
        val state = File(dir, "bundle.state.json")
        try {
            ArchiveDownloader.download(
                total = b.bundleBytes,
                sha256 = b.bundleSha256,
                file = part,
                stateFile = state,
                fetch = { offset -> client.savedBackupBundleChunk(b.archiveId, offset) },
                progress = { received -> downloading[b.archiveId] = if (b.bundleBytes > 0) received.toDouble() / b.bundleBytes else 1.0 },
            )
            val bundle = File(dir, b.bundleFileName)
            withContext(Dispatchers.IO) {
                bundle.delete()
                check(part.renameTo(bundle)) { "The backup couldn't be saved on this device." }
            }
            return bundle
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t, "The download didn't finish.")
            return null
        } finally {
            downloading.remove(b.archiveId)
        }
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun isNoKeys(t: Throwable): Boolean {
            if (t !is ScreensError.Http || t.status != 409) return false
            val o = runCatching { json.parseToJsonElement(t.body) as? JsonObject }.getOrNull() ?: return false
            return (o["code"] as? JsonPrimitive)?.content == "no-keys"
        }

        fun message(t: Throwable, fallback: String): String = when (t) {
            is ArchiveDownloader.DownloadException -> t.message ?: fallback
            is ScreensError.Http -> t.boxError() ?: t.userFacing()
            is ScreensError -> t.userFacing()
            is IllegalStateException -> t.message ?: fallback
            else -> t.userFacing()
        }
    }
}
