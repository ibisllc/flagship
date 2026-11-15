// Restore a backup into a running server, app by app (docs/restore-into-server.md §7). The backup
// is opened on the phone with the account key, the box takes it under a signed stage order and says
// what each app is to this server, the owner picks per app (the accepted defaults are preselected),
// and a second signed order carries exactly that plan. Admin devices only; every order is signed
// with the account's admin root. MIRRORS the iOS RestoreMergeViewModel.

package com.flagshipserver.app.viewmodels

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.flagshipserver.app.R
import com.flagshipserver.app.api.RestoreMergeApp
import com.flagshipserver.app.api.RestoreMergeLine
import com.flagshipserver.app.api.RestoreMergePlanOrder
import com.flagshipserver.app.api.RestoreMergePlanRequest
import com.flagshipserver.app.api.RestoreMergePreview
import com.flagshipserver.app.api.RestoreMergeRun
import com.flagshipserver.app.api.RestoreMergeStageOrder
import com.flagshipserver.app.api.RestoreMergeStageRequest
import com.flagshipserver.app.api.RestoreMergeUndoOrder
import com.flagshipserver.app.api.RestoreMergeUndoPoint
import com.flagshipserver.app.api.RestoreMergeUndoRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerBackupFormat
import com.flagshipserver.app.core.ServerRestoreMerge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.InputStream

class RestoreMergeViewModel(
    serverFqdn: String,
    private val client: ScreensClient,
    /** An admin device of the account: it signs every order (others see the entries disabled). */
    val isAdmin: Boolean,
    /** Signs canonical bytes with the admin root, behind the biometric (the reason is the prompt's line). */
    private val sign: suspend (reason: String, bytes: ByteArray) -> ByteArray,
    /** This account's key for one archive id (the backup's account slot). */
    private val accountKek: suspend (archiveId: String) -> ByteArray,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val pollMs: Long = 1_500,
) {
    sealed interface Source {
        /** A backup saved on this server (no transfer). */
        data class Saved(val archiveId: String) : Source
        /** A `.flagship` file picked on this device. */
        data class FileSource(val file: PickedFile) : Source
    }

    sealed interface Phase {
        data object Idle : Phase
        data object Opening : Phase
        data class Sending(val fraction: Double) : Phase
        data object Checking : Phase
        data object Choosing : Phase
        data object Restoring : Phase
        data object Done : Phase
        data class Failed(val message: String) : Phase
    }

    /** The owner's choice for one app. */
    data class Choice(val action: String, val copyName: String, val sameApp: Boolean = false)

    enum class Group { NEW, ALREADY, DIFFERENT }

    val serverFqdn: String = serverFqdn.lowercase()
    var phase by mutableStateOf<Phase>(Phase.Idle)
        private set
    var preview by mutableStateOf<RestoreMergePreview?>(null)
        private set
    var run by mutableStateOf<RestoreMergeRun?>(null)
        private set
    var undoPoints by mutableStateOf<List<RestoreMergeUndoPoint>>(emptyList())
        private set
    var actionError by mutableStateOf<String?>(null)
        private set
    var busyUndo by mutableStateOf<String?>(null)
        private set
    val choices = mutableStateMapOf<String, Choice>()

    private var archiveId = ""
    private var dataSha256 = ""
    private var staged = false

    // ── Undo points ────────────────────────────────────────────────

    suspend fun loadUndoPoints() {
        runCatching { client.restoreMergeStatus() }.onSuccess { v ->
            undoPoints = v.undo
            if (run == null && v.run?.state == "running") run = v.run
        }.onFailure { if (it is CancellationException) throw it }
    }

    suspend fun undo(p: RestoreMergeUndoPoint, discard: Boolean) {
        if (!isAdmin) {
            actionError = FSStrings.get(R.string.rm_admin_only)
            return
        }
        busyUndo = p.id
        actionError = null
        try {
            val order = RestoreMergeUndoOrder(serverFqdn, p.restoreId, p.serviceId, if (discard) "discard" else "undo", now())
            val bytes = ServerRestoreMerge.undoBytes(ServerRestoreMerge.UndoOrder(order.serverDomain, order.restoreId, order.serviceId, order.action, order.issuedAt))
            val reason = if (discard) FSStrings.get(R.string.rm_reason_discard, p.name) else FSStrings.get(R.string.rm_reason_undo, p.name)
            client.restoreMergeUndo(RestoreMergeUndoRequest(order, HexUtil.encode(sign(reason, bytes))))
            loadUndoPoints()
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t)
        } finally {
            busyUndo = null
        }
    }

    // ── Opening a backup ───────────────────────────────────────────

    suspend fun start(source: Source) {
        if (!isAdmin) {
            phase = Phase.Failed(FSStrings.get(R.string.rm_admin_only))
            return
        }
        phase = Phase.Opening
        actionError = null
        try {
            val file: ServerBackupFormat.File
            var data: PickedFile? = null
            when (source) {
                is Source.Saved -> file = ServerBackupFormat.parse(client.savedBackupFile(source.archiveId))
                is Source.FileSource -> {
                    val (layout, parsed) = withContext(Dispatchers.IO) { readBundle(source.file) }
                    file = parsed
                    data = PartOfPickedFile(source.file, layout.dataOffset, layout.dataLength)
                }
            }
            val opened = ServerBackupFormat.openWithAccountKey(file, accountKek(file.archiveId))
                ?: throw RestoreMergeException(FSStrings.get(R.string.rm_not_this_account))
            if (data != null && data.size != opened.body.data.bytes) throw RestoreMergeException(FSStrings.get(R.string.rm_cut_short))
            archiveId = file.archiveId
            dataSha256 = opened.body.data.sha256
            val order = RestoreMergeStageOrder(serverFqdn, archiveId, opened.body.data.bytes, dataSha256, if (data == null) "saved" else "upload", now())
            val bytes = ServerRestoreMerge.stageBytes(ServerRestoreMerge.StageOrder(order.serverDomain, order.archiveId, order.bytes, order.sha256, order.source, order.issuedAt))
            val started = client.restoreMergeStage(RestoreMergeStageRequest(order, HexUtil.encode(sign(FSStrings.get(R.string.rm_reason_check, serverFqdn), bytes))))
            staged = true
            if (data != null) send(data, started.received)
            phase = Phase.Checking
            client.restoreMergeCommit(HexUtil.encode(opened.contentKey))
            waitForPreview()
        } catch (e: CancellationException) {
            phase = Phase.Idle
            throw e
        } catch (t: Throwable) {
            phase = Phase.Failed(message(t))
        }
    }

    private fun readBundle(f: PickedFile): Pair<ServerBackupFormat.BundleLayout, ServerBackupFormat.File> =
        f.open().use { input ->
            val head = ServerBackupFormat.readUpTo(input, ServerBackupFormat.BUNDLE_HEADER_BYTES)
            val layout = ServerBackupFormat.parseBundleHeader(head, f.size)
            val meta = ServerBackupFormat.readUpTo(input, layout.metaLength)
            if (meta.size != layout.metaLength) throw RestoreMergeException(FSStrings.get(R.string.rm_cut_short))
            layout to ServerBackupFormat.parse(meta)
        }

    /** The data part, in 4 MiB parts from where the box has got to; a 409 names the offset it wants. */
    private suspend fun send(data: PickedFile, from: Long) {
        val size = data.size
        var offset = from
        var stream: InputStream? = null
        var position = -1L
        phase = Phase.Sending(if (size == 0L) 1.0 else offset.toDouble() / size)
        try {
            while (offset < size) {
                val at = offset
                val chunk = withContext(Dispatchers.IO) {
                    try {
                        if (stream == null || position != at) {
                            stream?.close()
                            val s = data.open()
                            var left = at
                            while (left > 0) {
                                val n = s.skip(left)
                                if (n > 0) left -= n else if (s.read() < 0) throw java.io.IOException("short") else left -= 1
                            }
                            stream = s
                            position = at
                        }
                        val d = ServerBackupFormat.readUpTo(stream!!, minOf(CHUNK_BYTES.toLong(), size - at).toInt())
                        if (d.isEmpty()) throw java.io.IOException("short")
                        position += d.size
                        d
                    } catch (_: java.io.IOException) {
                        throw RestoreMergeException(FSStrings.get(R.string.rm_unreadable))
                    }
                }
                try {
                    client.restoreMergeChunk(at, chunk)
                    offset = at + chunk.size
                } catch (e: ScreensError.Http) {
                    offset = receivedFrom(e) ?: throw e
                }
                phase = Phase.Sending(offset.toDouble() / size)
            }
        } finally {
            withContext(Dispatchers.IO) { runCatching { stream?.close() } }
        }
    }

    private suspend fun waitForPreview() {
        while (true) {
            val v = client.restoreMergeStatus()
            val p = v.preview
            if (p != null && v.stage?.state == "previewed") {
                preview = p
                choices.clear()
                p.apps.forEach { choices[it.archivedServiceId] = Choice(it.recommended, slug(it.copyServiceId ?: "")) }
                undoPoints = v.undo
                phase = Phase.Choosing
                return
            }
            if (v.stage?.state == "failed") throw RestoreMergeException(v.stage.reason ?: FSStrings.get(R.string.rm_couldnt_open))
            delay(pollMs)
        }
    }

    /** Drop what was staged (it changes no app); nothing to do once the plan was sent. */
    suspend fun cancel() {
        if (staged && phase != Phase.Restoring && phase != Phase.Done) runCatching { client.restoreMergeCancel() }
        preview = null
        phase = Phase.Idle
    }

    // ── Choosing ───────────────────────────────────────────────────

    fun apps(g: Group): List<RestoreMergeApp> = preview?.apps.orEmpty().filter {
        when (g) {
            Group.NEW -> it.verdict == "new" || it.verdict == "runs-elsewhere"
            Group.ALREADY -> it.verdict == "same"
            Group.DIFFERENT -> it.verdict == "clash" || it.verdict == "clash-maybe"
        }
    }

    fun choose(app: RestoreMergeApp, action: String) {
        if (action !in app.allowed) return
        val c = choices[app.archivedServiceId] ?: Choice(app.recommended, slug(app.copyServiceId ?: ""))
        choices[app.archivedServiceId] = c.copy(action = action, sameApp = action == "replace" && app.verdict == "clash-maybe")
    }

    fun setCopyName(app: RestoreMergeApp, name: String) {
        choices[app.archivedServiceId]?.let { choices[app.archivedServiceId] = it.copy(copyName = name.lowercase()) }
    }

    /** Something other than keep and skip is chosen, and every copy has a valid name (Restore stays off otherwise). */
    val canRestore: Boolean
        get() = isAdmin && phase == Phase.Choosing &&
            choices.values.any { it.action != "keep" && it.action != "skip" } &&
            choices.values.filter { it.action == "copy" }.all { validSlug(it.copyName) }

    private val account: String get() = serverFqdn.split('.').getOrNull(1).orEmpty()

    fun lines(): List<RestoreMergeLine> = preview?.apps.orEmpty().map { a ->
        val c = choices[a.archivedServiceId] ?: Choice(a.recommended, "")
        val guarded = c.action == "replace" || c.action == "replace-data"
        RestoreMergeLine(
            archivedServiceId = a.archivedServiceId,
            action = c.action,
            targetServiceId = if (c.action == "copy") "$account--${c.copyName}" else null,
            sameApp = c.sameApp,
            guardCode = if (guarded) a.guards?.guardCode else null,
            guardSchema = if (guarded) a.guards?.guardSchema else null,
            guardGen = if (guarded) a.guards?.guardGen else null,
        )
    }

    suspend fun restore() {
        val p = preview ?: return
        if (!canRestore) return
        actionError = null
        try {
            val lines = lines()
            val planSha = ServerRestoreMerge.planSha256(lines.map {
                ServerRestoreMerge.PlanLine(it.archivedServiceId, it.action, it.targetServiceId, it.sameApp, it.guardCode, it.guardSchema, it.guardGen)
            })
            val issued = now()
            val order = RestoreMergePlanOrder(serverFqdn, p.restoreId, archiveId, dataSha256, planSha, issued, issued + PLAN_TTL_MS)
            val bytes = ServerRestoreMerge.mergeBytes(
                ServerRestoreMerge.MergeOrder(order.serverDomain, order.restoreId, order.archiveId, order.sha256, order.planSha256, order.issuedAt, order.expiresAt),
            )
            client.restoreMergePlan(RestoreMergePlanRequest(order, HexUtil.encode(sign(FSStrings.get(R.string.rm_reason_restore, serverFqdn), bytes)), lines))
            phase = Phase.Restoring
            while (true) {
                val v = client.restoreMergeStatus()
                run = v.run
                undoPoints = v.undo
                if (v.run?.state == "done") {
                    phase = Phase.Done
                    return
                }
                delay(pollMs)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            actionError = message(t)
        }
    }

    class RestoreMergeException(message: String) : Exception(message)

    companion object {
        const val CHUNK_BYTES = 4 * 1024 * 1024
        const val PLAN_TTL_MS = 6L * 3_600_000
        private val SLUG = Regex("^[a-z0-9](-?[a-z0-9]){0,29}$")
        private val json = Json { ignoreUnknownKeys = true }

        fun validSlug(s: String): Boolean = SLUG.matches(s)

        fun slug(serviceId: String): String = serviceId.substringAfterLast("--")

        /** The offset a 409 `code: offset` names, or null for any other refusal. */
        fun receivedFrom(e: ScreensError.Http): Long? {
            if (e.status != 409) return null
            val o = runCatching { json.parseToJsonElement(e.body) as? JsonObject }.getOrNull() ?: return null
            if ((o["code"] as? JsonPrimitive)?.content != "offset") return null
            return (o["received"] as? JsonPrimitive)?.content?.toLongOrNull()
        }

        fun message(t: Throwable): String = when (t) {
            is RestoreMergeException -> t.message ?: FSStrings.get(R.string.rm_didnt_start)
            is ServerBackupFormat.BundleException -> t.message ?: FSStrings.get(R.string.rm_didnt_start)
            is ServerBackupFormat.FormatException -> t.message ?: FSStrings.get(R.string.rm_didnt_start)
            is ScreensError.Http -> t.boxError() ?: t.userFacing()
            is ScreensError -> t.userFacing()
            else -> t.userFacing()
        }
    }
}
