// "Backup/clone server" (docs/server-backup-and-clone.md): the server page's
// backup flow and Home's import (restore) flow. MIRRORS the iOS ServerArchiveViewModels.swift.

package com.flagshipserver.app.viewmodels

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerArchiveStatus
import com.flagshipserver.app.api.PeerRootRequest
import com.flagshipserver.app.api.PeerRootSummary
import com.flagshipserver.app.api.ServerBackupSlot
import com.flagshipserver.app.api.ServerRestoreApp
import com.flagshipserver.app.api.ServerRestoreCommitRequest
import com.flagshipserver.app.api.ServerRestoreStartRequest
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.ArchiveDownloader
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PeerBackup
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.core.ServerBackupFormat
import com.flagshipserver.app.core.ServerLabel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream
import java.text.DateFormat
import java.util.Date

private fun message(t: Throwable, fallback: String): String = when {
    t is ArchiveDownloader.DownloadException -> t.message ?: fallback
    t is ScreensError.Http -> t.boxError() ?: t.userFacing()
    t is ScreensError -> t.userFacing()
    t is IllegalStateException -> t.message ?: fallback
    else -> t.userFacing()
}

/** The server page: the user sets the backup's passcode, this device makes the
 *  content key and its two key slots, the box seals the backup, and this device
 *  downloads its one `.flagship` file for the user to save wherever they like. */
class ServerBackupViewModel(
    val serverFqdn: String,
    private val client: ScreensClient,
    /** This account's key for a backup (the account slot's KEK; biometric-gated). */
    private val accountKek: suspend (archiveId: String) -> ByteArray,
    /** Where parts land while downloading (resumes from here) and the files end up. */
    private val downloadDir: () -> File,
    /** The passcode slot for (archiveId, contentKey, passcode): Argon2id, off the main thread. */
    private val passcodeSlot: suspend (String, ByteArray, String) -> ServerBackupSlot = { id, key, passcode ->
        withContext(Dispatchers.Default) { ServerBackupFormat.passcodeSlot(id, key, passcode) }
    },
    /** The suggested passcode (five groups of four). */
    val suggestedPasscode: String = ServerBackupFormat.generatePasscode(),
    private val pollMs: Long = 1_500,
) {
    sealed interface Phase {
        data object Checking : Phase
        /** Set the passcode (the suggested one, or the user's own). */
        data object Passcode : Phase
        data class Building(val label: String, val fraction: Double) : Phase
        data class Ready(val bytes: Long) : Phase
        data class Downloading(val fraction: Double) : Phase
        /** The one `.flagship` file, on this device until the user saves it. */
        data class Saved(val file: File) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Checking)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private var status: ServerArchiveStatus? = null

    /** The user typed their own instead. */
    var useOwnPasscode by mutableStateOf(false)
    var ownPasscode by mutableStateOf("")
    var ownPasscodeAgain by mutableStateOf("")
    /** "I've saved the passcode somewhere safe." */
    var passcodeSaved by mutableStateOf(false)

    /** Apps the backup couldn't include (no source to rebuild from), by name. */
    val leftOut: List<String> get() = status?.left?.map { it.name } ?: emptyList()

    val isBusy: Boolean
        get() = _phase.value.let { it is Phase.Building || it is Phase.Downloading || it is Phase.Checking }

    /** The passcode the backup gets, or null while the user's own isn't good yet. */
    val chosenPasscode: String?
        get() {
            if (!useOwnPasscode) return suggestedPasscode
            if (ServerBackupFormat.passcodeProblem(ownPasscode) != null || ownPasscode != ownPasscodeAgain) return null
            return ownPasscode
        }

    /** What's wrong with the user's own passcode, for the line under the fields. */
    val ownPasscodeHint: String?
        get() {
            if (!useOwnPasscode) return null
            if (ownPasscode.isEmpty()) return "At least 12 characters with three kinds (lowercase, uppercase, digits, symbols), or 20 of anything."
            ServerBackupFormat.passcodeProblem(ownPasscode)?.let { return it }
            if (ownPasscodeAgain.isNotEmpty() && ownPasscodeAgain != ownPasscode) return "The two don't match."
            return null
        }

    val canStart: Boolean get() = _phase.value == Phase.Passcode && chosenPasscode != null && passcodeSaved

    /** First look: a backup already being made (the dialog was closed and
     *  reopened) is followed, one already made is offered; otherwise ask for
     *  the passcode. */
    suspend fun load() {
        val current = try {
            client.serverArchiveStatus()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        if (current != null && (current.state == "building" || current.state == "ready")) follow() else _phase.value = Phase.Passcode
    }

    /** Make the backup with the chosen passcode. */
    suspend fun start() {
        val passcode = chosenPasscode
        if (!canStart || passcode == null) return
        _phase.value = Phase.Building("Protecting the backup with its passcode…", 0.0)
        val contentKey = ServerBackupFormat.randomBytes(32)
        try {
            val id = ServerArchive.newArchiveId()
            val account = ServerBackupFormat.wrapAccountSlot(id, contentKey, accountKek(id), ServerBackupFormat.randomBytes(12))
            val pass = passcodeSlot(id, contentKey, passcode)
            client.serverArchiveStart(ServerArchiveStartRequest(id, HexUtil.encode(contentKey), listOf(pass, account)))
        } catch (e: CancellationException) {
            _phase.value = Phase.Passcode
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "The backup failed."))
            return
        } finally {
            contentKey.fill(0)
        }
        follow()
    }

    private suspend fun follow() {
        try {
            while (true) {
                val s = client.serverArchiveStatus() ?: throw IllegalStateException("The backup disappeared from the server.")
                if (s.state == "failed") throw IllegalStateException("The backup failed: ${s.reason ?: "the backup couldn't be made"}.")
                if (s.state == "ready") {
                    status = s
                    _phase.value = Phase.Ready(s.bundleBytes ?: s.bytes ?: 0)
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
            _phase.value = Phase.Passcode
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "The backup failed."))
        }
    }

    /** Download the backup's one `.flagship` file in 4 MiB parts, several at
     *  once, resuming an interrupted download and checking the server's SHA-256. */
    suspend fun download() {
        val s = status
        val total = s?.bundleBytes
        if (_phase.value !is Phase.Ready || s == null || total == null) return
        _phase.value = Phase.Downloading(0.0)
        val dir = downloadDir().apply { mkdirs() }
        val stem = ServerArchive.fileStem(serverFqdn, s.startedAt)
        val part = File(dir, "${s.archiveId}.part")
        val state = File(dir, "${s.archiveId}.json")
        val bundle = File(dir, s.bundleFileName ?: "$stem.${ServerBackupFormat.BUNDLE_EXTENSION}")
        try {
            ArchiveDownloader.download(
                total = total,
                sha256 = s.bundleSha256,
                file = part,
                stateFile = state,
                fetch = { offset -> client.serverArchiveBundleChunk(offset) },
                progress = { received ->
                    if (_phase.value is Phase.Downloading) {
                        _phase.value = Phase.Downloading(if (total > 0) received.toDouble() / total else 1.0)
                    }
                },
            )
            withContext(Dispatchers.IO) {
                bundle.delete()
                check(part.renameTo(bundle)) { "The backup couldn't be saved on this device." }
                state.delete()
            }
            runCatching { client.serverArchiveForget() }
            _phase.value = Phase.Saved(bundle)
        } catch (e: CancellationException) {
            // The parts already in stay for the next try.
            _phase.value = Phase.Ready(total)
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(message(t, "The download didn't finish."))
        }
    }

    fun tryAgain() {
        _phase.value = Phase.Passcode
    }
}

/** The browser download page's QR: approve downloading that server's backup in
 *  that browser. Shows the page's 6-digit code; the biometric unlocks the
 *  sensitive-order key that signs `flagship/archive-download/v1`, which the
 *  server checks before it serves the files. */
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

/** A file the user picked, read where it is (never copied onto the phone). */
interface PickedFile {
    val name: String
    val size: Long
    /** A fresh stream from the start; throws when it can't be read. */
    fun open(): InputStream
    /** Stop holding on to the file (its read permission). */
    fun release() {}
}

/** A picked file on this device's own storage (tests, and anything already local). */
class LocalPickedFile(private val file: File) : PickedFile {
    override val name: String get() = file.name
    override val size: Long get() = if (file.isFile) file.length() else 0
    override fun open(): InputStream = file.inputStream()
}

/** One part of a picked file (the data part of a `.flagship` file), streamed
 *  from where it is: never copied or held in memory. */
class PartOfPickedFile(private val whole: PickedFile, private val offset: Long, override val size: Long) : PickedFile {
    override val name: String get() = whole.name
    override fun open(): InputStream {
        val s = whole.open()
        var left = offset
        while (left > 0) {
            val n = s.skip(left)
            if (n > 0) left -= n else if (s.read() < 0) throw java.io.IOException("the file ends early") else left -= 1
        }
        return LimitedInputStream(s, size)
    }
    override fun release() = whole.release()
}

private class LimitedInputStream(private val inner: InputStream, private var left: Long) : java.io.FilterInputStream(inner) {
    override fun read(): Int {
        if (left <= 0) return -1
        val b = inner.read()
        if (b >= 0) left -= 1
        return b
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (left <= 0) return -1
        val n = inner.read(b, off, minOf(len.toLong(), left).toInt())
        if (n > 0) left -= n
        return n
    }
    override fun skip(n: Long): Long {
        val k = inner.skip(minOf(n, left))
        if (k > 0) left -= k
        return k
    }
    override fun available(): Int = minOf(inner.available().toLong(), left).toInt()
}

/** Where "Restore from other servers" gets its facts: the account's servers to
 *  pick the lost one from, the lost server's record (read by a running server of
 *  the account, else from the sealed copy on `.com`), and its PBK. */
interface PeerRestoreSource {
    /** The account's servers, offline or deleted ones first. */
    val lostChoices: List<String>
    suspend fun describe(lost: String): PeerRootSummary
    suspend fun pbkHex(lost: String): String
}

/** Home → Add/Import a server → Import a backup, or a waiting server's "Send
 *  the backup" (docs/server-backup-and-clone.md, "Restore a backup"): pick the
 *  one `.flagship` file, open its metadata part (this account's key, else its
 *  passcode), stream its data part for the check, pick a name, make the server
 *  with the existing create screen, then wait for it and send it the data part. */
class ImportBackupViewModel(
    private val username: String,
    /** Every server name the account uses (pending ones too). */
    takenNames: Set<String>,
    /** Archive id → fqdn of the account's servers waiting for a backup. */
    private val waitingServers: Map<String, String> = emptyMap(),
    /** Opened from a waiting server's "Send the backup". */
    targetFqdn: String? = null,
    /** A screens client for a server, or null while this device has no session there. */
    private val clientFor: suspend (fqdn: String) -> ScreensClient?,
    private val accountKek: suspend (archiveId: String) -> ByteArray,
    private val openWithPasscode: suspend (ServerBackupFormat.File, String) -> ServerBackupFormat.Opened = { file, passcode ->
        withContext(Dispatchers.Default) { ServerBackupFormat.openWithPasscode(file, passcode) }
    },
    /** The server's backup is in (Home stops showing it waiting). */
    private val onRestored: (String) -> Unit = {},
    /** Set for "Restore from other servers": the backup comes back from the pieces
     *  other accounts' servers keep, not from a picked file (docs/peer-backup.md §9). */
    private val peers: PeerRestoreSource? = null,
    private val pollMs: Long = 5_000,
    /** Runs the send, which outlives one composition until [stop]. */
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) {
    sealed interface Phase {
        /** Pick the files (and say which one is still missing). */
        data object Pick : Phase
        /** Restore from other servers: pick the lost server. */
        data object PickLost : Phase
        /** Reading the lost server's record. */
        data object Finding : Phase
        /** The new server is fetching the pieces from other servers. */
        data class Fetching(val fqdn: String, val fraction: Double?) : Phase
        /** The account key didn't open it: ask for the passcode. */
        data object Passcode : Phase
        data object Opening : Phase
        data class Checking(val fraction: Double) : Phase
        /** A server of the account waits for this backup: send it there, or make a new one. */
        data class ChooseTarget(val fqdn: String) : Phase
        data object Name : Phase
        /** The create screen is up ([createTarget] holds what it needs). */
        data object Creating : Phase
        data class Waiting(val fqdn: String) : Phase
        data class Sending(val fqdn: String, val fraction: Double) : Phase
        data class Restoring(val fqdn: String, val apps: List<ServerRestoreApp>) : Phase
        data class Done(val fqdn: String, val apps: List<ServerRestoreApp>) : Phase
        /** [keepsWaiting]: the server stays waiting for its backup (send it again later). */
        data class Failed(val message: String, val keepsWaiting: Boolean) : Phase
    }

    /** What the create screen needs to make the server. */
    data class CreateTarget(
        val name: String,
        val bootUnlockMode: String,
        val diskEncryption: String,
        val restore: RestoreTarget,
    )

    /** The backup a new server is made to wait for (its restore order names it). */
    data class RestoreTarget(val archiveId: String, val bytes: Long, val sha256: String)

    private val _phase = MutableStateFlow<Phase>(if (peers != null) Phase.PickLost else Phase.Pick)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    /** The lost server's address typed or chosen (peer restore). */
    var lost by mutableStateOf("")
    /** The lost server's record once found (peer restore). */
    var peerRoot by mutableStateOf<PeerRootSummary?>(null)
        private set
    val isPeerRestore: Boolean get() = peers != null
    val lostChoices: List<String> get() = peers?.lostChoices.orEmpty()
    /** The picked `.flagship` file and its size. */
    var fileName by mutableStateOf<String?>(null)
        private set
    var fileSize by mutableStateOf<Long?>(null)
        private set
    var opened by mutableStateOf<ServerBackupFormat.Opened?>(null)
        private set
    var fileError by mutableStateOf<String?>(null)
        private set
    var passcode by mutableStateOf("")
    var name by mutableStateOf("")
    var createTarget by mutableStateOf<CreateTarget?>(null)
        private set
    val targetFqdn: String? = targetFqdn?.lowercase()

    private val takenNames: Set<String> = takenNames.map { it.lowercase() }.toSet()
    private var file: ServerBackupFormat.File? = null
    private var picked: PickedFile? = null
    /** The data part of [picked]. */
    private var dataPicked: PickedFile? = null
    private var sendJob: Job? = null
    private var sendingTo: String? = null
    /** Send progress while the create screen is up: shown once the user leaves it. */
    private var held: Phase? = null
    private val lock = Any()

    // ── Files ──────────────────────────────────────────────────────

    /** The user picked a `.flagship` file: read its header and metadata part
     *  only (the data part is streamed later, from where the file is). */
    suspend fun choose(f: PickedFile) {
        fileError = null
        val read = withContext(Dispatchers.IO) {
            runCatching {
                f.open().use { input ->
                    val head = ServerBackupFormat.readUpTo(input, ServerBackupFormat.BUNDLE_HEADER_BYTES)
                    val layout = ServerBackupFormat.parseBundleHeader(head, f.size)
                    val meta = ServerBackupFormat.readUpTo(input, layout.metaLength)
                    if (meta.size != layout.metaLength) throw ServerBackupFormat.BundleException("This backup is cut short: it ends before its data.")
                    layout to ServerBackupFormat.parse(meta)
                }
            }
        }
        val (layout, parsed) = read.getOrElse { t ->
            if (t is CancellationException) throw t
            f.release()
            fileError = when (t) {
                is ServerBackupFormat.BundleException -> t.message
                is ServerBackupFormat.FormatException -> t.message
                else -> "That backup couldn't be read."
            }
            return
        }
        picked?.takeIf { it !== f }?.release()
        picked = f
        dataPicked = PartOfPickedFile(f, layout.dataOffset, layout.dataLength)
        file = parsed
        opened = null
        fileName = f.name
        fileSize = f.size
        advance()
    }

    /** The line under the picker: what's picked. */
    val fileSummary: String
        get() = fileName?.let { "$it (${ServerArchive.formatBytes(fileSize ?: 0)})" } ?: "No backup picked yet"

    /** Find the lost server's backup on other servers and open it with this
     *  account's key (peer restore). */
    suspend fun findPeerBackup() {
        val source = peers ?: return
        if (_phase.value != Phase.PickLost) return
        fileError = null
        _phase.value = Phase.Finding
        try {
            val id = PeerBackup.normalizeServerId(lost)
            val root = source.describe(id)
            val f = ServerBackupFormat.parse(root.archive.backupFile.toByteArray(Charsets.UTF_8))
            val o = ServerBackupFormat.openWithAccountKey(f, accountKek(f.archiveId))
                ?: throw PeerBackup.PeerBackupException("This backup can't be opened with this account's key.")
            val a = root.archive
            if (f.archiveId != a.archiveId || o.body.data.bytes != a.bytes || o.body.data.sha256 != a.sha256) {
                throw PeerBackup.PeerBackupException("The backup record doesn't match its file. Nothing was restored.")
            }
            file = f
            opened = o
            peerRoot = root
            lost = id
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            fileError = when (t) {
                is PeerBackup.PeerBackupException -> t.message
                is ServerBackupFormat.FormatException -> t.message
                else -> message(t, "The backup couldn't be found.")
            }
            _phase.value = Phase.PickLost
            return
        }
        val fqdn = targetFqdn ?: waitingServers[file!!.archiveId]
        if (fqdn != null) _phase.value = Phase.ChooseTarget(fqdn) else showName()
    }

    /** One line on what the backup holds, once it is open. */
    val summary: String?
        get() {
            peerRoot?.let { root ->
                val body = opened?.body
                val apps = if (body == null || body.apps.isEmpty()) "no apps" else body.apps.joinToString(", ") { it.name }
                return PeerBackup.rootLines(root).joinToString(" ") + " Apps: $apps."
            }
            val body = opened?.body ?: return null
            val whenText = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(body.createdAt))
            val apps = if (body.apps.isEmpty()) "no apps" else body.apps.joinToString(", ") { it.name }
            val left = if (body.left.isEmpty()) "" else " Not in this backup: ${body.left.joinToString(", ") { it.name }}."
            return "From ${body.server.domain}, saved $whenText: $apps.$left"
        }

    /** What the new server copies from the backup. */
    val settingsLine: String?
        get() {
            val s = opened?.body?.server ?: return null
            val unlock = if (s.bootUnlockMode == "approve") "asks your phone at every start" else "unlocks on its own after the first start"
            val disk = if (s.diskEncryption == "none") "disk not encrypted" else "disk encrypted"
            return "Copied from the backup: $unlock, $disk."
        }

    private suspend fun advance() {
        val f = file
        if (f == null) {
            _phase.value = Phase.Pick
            return
        }
        if (opened == null) {
            _phase.value = Phase.Opening
            val o = try {
                ServerBackupFormat.openWithAccountKey(f, accountKek(f.archiveId))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                null
            }
            if (o == null) {
                _phase.value = Phase.Passcode
                return
            }
            opened = o
        }
        checkData()
    }

    /** Open with the passcode the user typed. */
    suspend fun unlock() {
        val f = file ?: return
        if (_phase.value != Phase.Passcode || passcode.isEmpty()) return
        fileError = null
        _phase.value = Phase.Opening
        try {
            opened = openWithPasscode(f, passcode)
            passcode = ""
        } catch (e: CancellationException) {
            _phase.value = Phase.Passcode
            throw e
        } catch (t: Throwable) {
            fileError = (t as? ServerBackupFormat.FormatException)?.message ?: "That passcode doesn't open this backup."
            _phase.value = Phase.Passcode
            return
        }
        checkData()
    }

    /** System back on the passcode step returns to choosing the file. */
    fun backFromPasscode() {
        if (_phase.value == Phase.Passcode) { passcode = ""; _phase.value = Phase.Pick }
    }

    private suspend fun checkData() {
        val o = opened ?: return
        val data = dataPicked
        if (data == null) {
            _phase.value = Phase.Pick
            return
        }
        _phase.value = Phase.Checking(0.0)
        val total = maxOf(o.body.data.bytes, 1).toDouble()
        try {
            withContext(Dispatchers.IO) {
                ServerBackupFormat.checkDataFile(data.size, data::open, o.body.data) { read ->
                    _phase.value = Phase.Checking(read / total)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            data.release()
            dataPicked = null
            picked = null
            file = null
            opened = null
            fileName = null
            fileSize = null
            fileError = checkMessage(t)
            _phase.value = Phase.Pick
            return
        }
        val fqdn = targetFqdn ?: waitingServers[o.file.archiveId]
        if (fqdn != null) _phase.value = Phase.ChooseTarget(fqdn) else showName()
    }

    // ── Name and create ────────────────────────────────────────────

    /** Why [name] can't be used, or null (checked as the user types). */
    val nameProblem: String?
        get() {
            val n = name.trim().lowercase()
            if (n.isEmpty()) {
                val saved = opened?.body?.server?.name
                if (saved != null && saved.lowercase() in takenNames) {
                    return "You already have a server called \"$saved\": pick another name."
                }
                return null
            }
            ServerLabel.errorMessage(n)?.let { return it }
            if (n in takenNames) return "You already have a server called \"$n\"."
            return null
        }

    val canCreate: Boolean get() = _phase.value == Phase.Name && name.trim().isNotEmpty() && nameProblem == null

    val previewFqdn: String
        get() = Endpoints.serverFqdn(server = ServerLabel.normalized(name.ifEmpty { "home" }), user = username)

    fun showName() {
        val o = opened ?: return
        if (name.isEmpty()) name = suggestedName(o.body.server.name, takenNames)
        _phase.value = Phase.Name
    }

    /** Hand over to the create screen with the backup's settings. */
    fun create() {
        val o = opened
        if (!canCreate || o == null) return
        createTarget = CreateTarget(
            name = ServerLabel.normalized(name),
            bootUnlockMode = o.body.server.bootUnlockMode,
            diskEncryption = o.body.server.diskEncryption,
            restore = RestoreTarget(o.file.archiveId, o.body.data.bytes, o.body.data.sha256),
        )
        _phase.value = Phase.Creating
    }

    /** Back from the create screen without a server. */
    fun cancelCreate() {
        synchronized(lock) {
            createTarget = null
            held = null
            _phase.value = Phase.Name
        }
    }

    // ── Send ───────────────────────────────────────────────────────

    /** The recipe is out (or the user chose a waiting server): wait for the
     *  server, then send it the backup. Runs until it ends or [stop]. */
    fun send(to: String) {
        val target = to.lowercase()
        if (sendingTo == target && sendJob?.isActive == true) return
        sendJob?.cancel()
        sendingTo = target
        synchronized(lock) {
            if (_phase.value != Phase.Creating) _phase.value = Phase.Waiting(target)
        }
        sendJob = scope.launch { run(target) }
    }

    /** Show the progress of a send that started under the create screen. */
    fun leaveCreate(fqdn: String) {
        synchronized(lock) {
            createTarget = null
            if (_phase.value == Phase.Creating) {
                _phase.value = held ?: Phase.Waiting(fqdn.lowercase())
                held = null
            }
        }
    }

    fun stop() {
        sendJob?.cancel()
        sendJob = null
        sendingTo = null
        picked?.release()
        picked = null
        dataPicked = null
    }

    // While the create screen is up its pages stay visible; the send carries
    // on underneath and shows once the user leaves it.
    private fun setPhase(p: Phase) {
        synchronized(lock) {
            if (_phase.value == Phase.Creating) held = p else _phase.value = p
        }
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }

    private suspend fun run(fqdn: String) {
        val o = opened ?: return
        val lostServer = if (peers != null) lost else null
        val data = dataPicked
        if (lostServer == null && data == null) return
        try {
            // Wait for the server to come online, pair with this device, and say
            // it waits for this backup.
            while (true) {
                currentCoroutineContext().ensureActive()
                val c = attempt { clientFor(fqdn) }
                val st = c?.let { attempt { it.serverRestoreStatus() } }
                if (c != null && st != null) {
                    val waiting = st.waiting
                    if (waiting?.archiveId == o.file.archiveId) {
                        if (st.restore?.state == "checking" || st.restore?.state == "restoring") break
                        if (lostServer != null) pullFromPeers(c, fqdn, lostServer) else upload(c, fqdn, data!!, o)
                        c.serverRestoreCommit(ServerRestoreCommitRequest(HexUtil.encode(o.contentKey)))
                        break
                    }
                    if (waiting == null && st.restore?.state == "done") break
                    if (waiting != null && waiting.archiveId != o.file.archiveId) throw ImportException(ImportException.Kind.OTHER_BACKUP)
                }
                setPhase(Phase.Waiting(fqdn))
                delay(pollMs)
            }
            setPhase(Phase.Restoring(fqdn, emptyList()))
            val c = clientFor(fqdn) ?: throw ImportException(ImportException.Kind.VANISHED)
            while (true) {
                currentCoroutineContext().ensureActive()
                val r = c.serverRestoreStatus().restore ?: throw ImportException(ImportException.Kind.VANISHED)
                if (r.state == "failed") throw ImportException(ImportException.Kind.FAILED, r.reason ?: "unknown reason")
                if (r.state == "done") {
                    onRestored(fqdn)
                    setPhase(Phase.Done(fqdn, r.apps))
                    return
                }
                setPhase(Phase.Restoring(fqdn, r.apps))
                delay(minOf(pollMs, 2_000))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            setPhase(Phase.Failed(importMessage(t), keepsWaiting = true))
        }
    }

    /** Have the waiting server fetch the pieces from other servers, and follow it
     *  until the whole data file is there. Its own sentence comes back when the fetch fails. */
    private suspend fun pullFromPeers(c: ScreensClient, fqdn: String, lostServer: String) {
        val source = peers ?: return
        setPhase(Phase.Fetching(fqdn, null))
        c.serverRestoreFromPeers(PeerRootRequest(lostServer, source.pbkHex(lostServer)))
        while (true) {
            currentCoroutineContext().ensureActive()
            val job = c.serverRestoreStatus().restore ?: throw ImportException(ImportException.Kind.VANISHED)
            val reason = job.reason
            if (!reason.isNullOrEmpty() && job.state in setOf("uploading", "failed")) {
                throw ImportException(ImportException.Kind.FAILED, reason.trimEnd('.', ' '))
            }
            if (job.state in setOf("ready", "checking", "restoring", "done")) return
            setPhase(Phase.Fetching(fqdn, if (job.bytes > 0) job.received.toDouble() / job.bytes else null))
            delay(minOf(pollMs, 2_000))
        }
    }

    private suspend fun upload(c: ScreensClient, fqdn: String, data: PickedFile, o: ServerBackupFormat.Opened) {
        val size = o.body.data.bytes
        val start = ServerRestoreStartRequest(o.file.archiveId, size)
        var offset = c.serverRestoreStart(start).received
        var retries = 0
        var stream: InputStream? = null
        var position = -1L
        setPhase(Phase.Sending(fqdn, offset.toDouble() / maxOf(size, 1)))
        try {
            while (offset < size) {
                currentCoroutineContext().ensureActive()
                val at = offset
                val chunk = withContext(Dispatchers.IO) {
                    try {
                        if (stream == null || position != at) {
                            stream?.close()
                            val s = data.open()
                            stream = s
                            skipFully(s, at)
                            position = at
                        }
                        val d = ServerBackupFormat.readUpTo(stream!!, minOf(ServerArchive.UPLOAD_CHUNK_BYTES.toLong(), size - at).toInt())
                        if (d.isEmpty()) throw ImportException(ImportException.Kind.UNREADABLE)
                        position += d.size
                        d
                    } catch (e: ImportException) {
                        throw e
                    } catch (_: Exception) {
                        throw ImportException(ImportException.Kind.UNREADABLE)
                    }
                }
                try {
                    c.serverRestoreChunk(at, chunk)
                    offset = at + chunk.size
                    retries = 0
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    // Ask the server where it has got to and go on from there.
                    retries += 1
                    if (retries > 5) throw t
                    delay(1_000)
                    offset = c.serverRestoreStart(start).received
                }
                setPhase(Phase.Sending(fqdn, offset.toDouble() / maxOf(size, 1)))
            }
        } finally {
            withContext(Dispatchers.IO) { runCatching { stream?.close() } }
        }
    }

    private fun skipFully(input: InputStream, n: Long) {
        var left = n
        while (left > 0) {
            val skipped = input.skip(left)
            if (skipped > 0) {
                left -= skipped
            } else {
                if (input.read() < 0) throw ImportException(ImportException.Kind.UNREADABLE)
                left -= 1
            }
        }
    }

    class ImportException(val kind: Kind, why: String = "") : Exception(
        when (kind) {
            Kind.UNREADABLE -> "The backup file can't be read any more (was its drive removed?)."
            Kind.VANISHED -> "The restore disappeared from the server."
            Kind.OTHER_BACKUP -> "That server is waiting for a different backup."
            Kind.FAILED -> "The restore failed: $why."
        },
    ) {
        enum class Kind { UNREADABLE, VANISHED, OTHER_BACKUP, FAILED }
    }

    private fun importMessage(t: Throwable): String =
        if (t is ImportException) t.message ?: "The restore failed." else message(t, "The restore failed.")

    companion object {
        /** Why a picked file's data part failed its check, said of the one file. */
        fun checkMessage(t: Throwable): String = when ((t as? ServerBackupFormat.DataCheckException)?.kind) {
            ServerBackupFormat.DataCheckException.Kind.UNREADABLE -> "The backup file can't be read any more (was its drive removed?)."
            null -> "The backup couldn't be checked."
            else -> "This backup was changed or is damaged."
        }

        /** The result's lines: "Restored N apps", then each app that failed, with the box's reason. */
        fun resultLines(apps: List<ServerRestoreApp>): List<String> {
            val ok = apps.count { it.state == "done" }
            return listOf("Restored $ok app${if (ok == 1) "" else "s"}") +
                apps.filter { it.state == "failed" }.map { "Couldn't restore: ${it.name}: ${(it.reason ?: "it couldn't be restored").trimEnd('.', ' ')}" }
        }

        /** The name the form starts with: the saved server's, unless the account uses it. */
        fun suggestedName(saved: String, taken: Set<String>): String {
            val n = saved.lowercase()
            return if (ServerLabel.isValid(n) && n !in taken) n else ""
        }

        fun describe(a: ServerRestoreApp): String = when (a.state) {
            "done" -> "${a.name}: restored"
            "skipped" -> "${a.name}: skipped (${a.reason ?: "already here"})"
            "failed" -> "${a.name}: couldn't be restored (${a.reason ?: "unknown reason"})"
            "restoring" -> "${a.name}: restoring…"
            else -> "${a.name}: waiting"
        }
    }
}
