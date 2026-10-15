// "Backup/clone server" (docs/server-backup-and-clone.md): the server page's
// backup flow and Home's import flow. MIRRORS the iOS ServerArchiveViewModels.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerArchiveStatus
import com.flagshipserver.app.api.ServerRestoreApp
import com.flagshipserver.app.api.ServerRestoreCommitRequest
import com.flagshipserver.app.api.ServerRestoreStartRequest
import com.flagshipserver.app.core.ArchiveDownloader
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerArchive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

private fun message(t: Throwable, fallback: String): String = when {
    t is ArchiveDownloader.DownloadException -> t.message ?: fallback
    t is ScreensError.Http -> t.boxError() ?: t.userFacing()
    t is ScreensError -> t.userFacing()
    t is IllegalStateException -> t.message ?: fallback
    else -> t.userFacing()
}

/** The server page: the box makes the backup, this device downloads it to a file. */
class ServerBackupViewModel(
    val serverFqdn: String,
    private val client: ScreensClient,
    /** The key this device derives for an archive id (biometric-gated). */
    private val keyProvider: suspend (archiveId: String) -> ByteArray,
    /** Where parts land while downloading (resumes from here) and the file ends up. */
    private val downloadDir: () -> File,
    private val pollMs: Long = 1_500,
) {
    sealed interface Phase {
        data object Idle : Phase
        data class Building(val label: String, val fraction: Double) : Phase
        data class Ready(val bytes: Long) : Phase
        data class Downloading(val fraction: Double) : Phase
        data class Saved(val file: File, val suggestedName: String) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private var status: ServerArchiveStatus? = null

    /** Apps the backup couldn't include (no source to rebuild from), by name. */
    val leftOut: List<String> get() = status?.left?.map { it.name } ?: emptyList()

    val isBusy: Boolean get() = _phase.value is Phase.Building || _phase.value is Phase.Downloading

    suspend fun start() {
        if (isBusy) return
        _phase.value = Phase.Building("Making the backup…", 0.0)
        try {
            // One already being made (the dialog was closed and reopened): follow it.
            // One already made whose download was interrupted here: resume it.
            val current = runCatching { client.serverArchiveStatus() }.getOrNull()
            if (current != null && current.state == "ready" && current.bytes != null &&
                File(downloadDir(), "${current.archiveId}.json").exists()
            ) {
                status = current
                _phase.value = Phase.Ready(current.bytes)
                return
            }
            if (current?.state != "building") {
                val id = ServerArchive.newArchiveId()
                val key = keyProvider(id)
                client.serverArchiveStart(ServerArchiveStartRequest(id, HexUtil.encode(key)))
            }
            while (true) {
                val s = client.serverArchiveStatus() ?: throw IllegalStateException("The backup disappeared from the server.")
                if (s.state == "failed") throw IllegalStateException("The backup failed: ${s.reason ?: "the backup couldn't be made"}.")
                if (s.state == "ready") {
                    status = s
                    _phase.value = Phase.Ready(s.bytes ?: 0)
                    return
                }
                val p = s.progress
                val total = maxOf(p?.total ?: 0, 0)
                _phase.value = Phase.Building(
                    if (total > 0) "Backing up ${p?.app ?: "apps"} (${minOf((p?.done ?: 0) + 1, total)} of $total)…" else "Making the backup…",
                    if (total > 0) (p?.done ?: 0).toDouble() / total else 0.0,
                )
                delay(pollMs)
            }
        } catch (e: CancellationException) {
            _phase.value = Phase.Idle
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "The backup failed."))
        }
    }

    /** 4 MiB parts, several at once, each written straight to the file; an
     *  interrupted download resumes from the parts already in; the result is
     *  checked against the server's SHA-256. */
    suspend fun download() {
        val s = status
        val total = s?.bytes
        if (_phase.value !is Phase.Ready || s == null || total == null) return
        _phase.value = Phase.Downloading(0.0)
        val dir = downloadDir().apply { mkdirs() }
        val part = File(dir, "${s.archiveId}.part")
        val state = File(dir, "${s.archiveId}.json")
        val name = ServerArchive.fileName(serverFqdn, s.startedAt)
        try {
            ArchiveDownloader.download(
                total = total,
                sha256 = s.sha256,
                file = part,
                stateFile = state,
                fetch = { offset -> client.serverArchiveChunk(offset) },
                progress = { received ->
                    if (_phase.value is Phase.Downloading) {
                        _phase.value = Phase.Downloading(if (total > 0) received.toDouble() / total else 1.0)
                    }
                },
            )
            val final = File(dir, name)
            final.delete()
            check(part.renameTo(final)) { "The backup couldn't be saved on this device." }
            runCatching { client.serverArchiveForget() }
            _phase.value = Phase.Saved(final, name)
        } catch (e: CancellationException) {
            // The parts already in stay for the next try.
            _phase.value = Phase.Ready(total)
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "The download didn't finish."))
        }
    }
}

/** The browser download page's QR: approve downloading that server's backup in
 *  that browser. Shows the page's 6-digit code; the biometric unlocks the
 *  sensitive-order key that signs `flagship/archive-download/v1`, which the
 *  server checks before it serves the file. */
class BackupDownloadApprovalViewModel(
    val serverFqdn: String,
    val archiveId: String,
    val requestId: String,
    private val client: ScreensClient?,
    /** Signs canonical bytes with the sensitive-order key (biometric-gated). */
    private val sign: suspend (bytes: ByteArray) -> ByteArray,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Working : Phase
        data object Approved : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    val code: String = com.flagshipserver.app.api.ArchiveDownloadApproval.code(requestId)

    suspend fun approve() {
        if (_phase.value == Phase.Working || _phase.value == Phase.Approved) return
        val c = client
        if (c == null) {
            _phase.value = Phase.Failed("This phone has no session for ${serverFqdn}. Open it on Home first.")
            return
        }
        _phase.value = Phase.Working
        try {
            val approval = com.flagshipserver.app.api.ArchiveDownloadApproval(serverFqdn.lowercase(), archiveId, requestId, now())
            val sig = sign(approval.canonicalBytes())
            c.serverArchiveApprove(com.flagshipserver.app.api.ServerArchiveApproveRequest(approval, HexUtil.encode(sig)))
            _phase.value = Phase.Approved
        } catch (e: CancellationException) {
            _phase.value = Phase.Idle
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "Couldn't approve the download."))
        }
    }
}

/** A picked backup file, read without loading it whole. */
interface ArchiveSource {
    val size: Long
    suspend fun readHead(): ByteArray
    suspend fun read(offset: Long, length: Int): ByteArray
}

/** Home → Add/Import a server → Import a backup. */
class ImportBackupViewModel(
    val targets: List<Target>,
    private val clientFor: (fqdn: String) -> ScreensClient?,
    private val keyProvider: suspend (archiveId: String) -> ByteArray,
    private val pollMs: Long = 2_000,
) {
    data class Target(val fqdn: String, val label: String)

    sealed interface Phase {
        data object Picking : Phase
        data class Chosen(val header: ServerArchive.Header, val bytes: Long) : Phase
        data class Uploading(val fraction: Double) : Phase
        data class Restoring(val apps: List<ServerRestoreApp>) : Phase
        data class Done(val apps: List<ServerRestoreApp>) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Picking)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private val _selected = MutableStateFlow(targets.firstOrNull()?.fqdn)
    val selectedFqdn: StateFlow<String?> = _selected.asStateFlow()
    private val _fileError = MutableStateFlow<String?>(null)
    val fileError: StateFlow<String?> = _fileError.asStateFlow()
    private var source: ArchiveSource? = null

    fun select(fqdn: String) {
        _selected.value = fqdn
    }

    suspend fun choose(file: ArchiveSource) {
        _fileError.value = null
        try {
            val header = ServerArchive.parseHeader(file.readHead())
            source = file
            _phase.value = Phase.Chosen(header, file.size)
        } catch (e: ServerArchive.HeaderException) {
            _fileError.value = e.message
            _phase.value = Phase.Picking
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            _fileError.value = "That file couldn't be read."
            _phase.value = Phase.Picking
        }
    }

    fun retry() {
        _fileError.value = null
        _phase.value = Phase.Picking
    }

    suspend fun startImport() {
        val chosen = _phase.value as? Phase.Chosen ?: return
        val fqdn = _selected.value ?: return
        val file = source ?: return
        val client = clientFor(fqdn)
        if (client == null) {
            _phase.value = Phase.Failed("This device has no session for that server.")
            return
        }
        _phase.value = Phase.Uploading(0.0)
        try {
            client.serverRestoreStart(ServerRestoreStartRequest(chosen.header.archiveId, chosen.bytes))
            var offset = 0L
            while (offset < chosen.bytes) {
                val len = minOf(ServerArchive.UPLOAD_CHUNK_BYTES.toLong(), chosen.bytes - offset).toInt()
                val chunk = file.read(offset, len)
                check(chunk.isNotEmpty()) { "The backup file couldn't be read all the way through." }
                client.serverRestoreChunk(offset, chunk)
                offset += chunk.size
                _phase.value = Phase.Uploading(offset.toDouble() / chosen.bytes)
            }
            val key = keyProvider(chosen.header.archiveId)
            client.serverRestoreCommit(ServerRestoreCommitRequest(HexUtil.encode(key)))
            _phase.value = Phase.Restoring(emptyList())
            while (true) {
                delay(pollMs)
                val s = client.serverRestoreStatus() ?: throw IllegalStateException("The import disappeared from the server.")
                if (s.state == "failed") throw IllegalStateException("The import failed: ${s.reason ?: "unknown reason"}.")
                if (s.state == "done") {
                    _phase.value = Phase.Done(s.apps)
                    return
                }
                _phase.value = Phase.Restoring(s.apps)
            }
        } catch (e: CancellationException) {
            _phase.value = chosen
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "The import failed."))
        }
    }

    companion object {
        fun describe(a: ServerRestoreApp): String = when (a.state) {
            "done" -> "${a.name}: restored"
            "skipped" -> "${a.name}: skipped (${a.reason ?: "already here"})"
            "failed" -> "${a.name}: couldn't be restored (${a.reason ?: "unknown reason"})"
            "restoring" -> "${a.name}: restoring…"
            else -> "${a.name}: waiting"
        }
    }
}
