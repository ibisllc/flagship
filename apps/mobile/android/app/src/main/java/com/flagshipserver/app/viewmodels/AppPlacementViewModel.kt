// "Runs on" on an app's page (docs/app-placement.md §4–5). Each of the
// account's servers is asked, over its own session, whether it has the app;
// exactly those are ticked, and one that can't be reached is unknown, never
// ticked. Ticking a server copies the app there (an owner-signed
// `flagship/app-copy/v1` order sent to that server); unticking removes it with
// the owner-signed uninstall. The last copy can't be unticked here.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppCopyGrantBody
import com.flagshipserver.app.api.AppCopyRecord
import com.flagshipserver.app.api.AppCopyRequest
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppCopy
import com.flagshipserver.app.core.AppStatus
import com.flagshipserver.app.core.PodApps
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.UninstallServiceOrder
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.math.roundToInt

class AppPlacementViewModel(
    val serviceId: String,
    private val appName: String,
    /** The account's servers. */
    private val pods: () -> List<PodInfo>,
    /** A screens client bound to one server's session, or null without one. */
    private val clientFor: (PodInfo) -> ScreensClient?,
    /** The server whose page this is: the preferred source of a copy. */
    private val pagePodId: () -> String? = { null },
    /** The sensitive-order key (admin root when held, else the owner IRK). */
    private val copySigner: suspend (String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** The owner IRK, which a box checks a signed uninstall against. */
    private val uninstallSigner: suspend (String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Presence {
        data class Has(val app: AppSummary) : Presence
        data object Absent : Presence
        data class Copying(val progress: Double?) : Presence
        /** No session on this phone, or the server didn't answer. */
        data class Unknown(val reason: String) : Presence
        /** A tick or untick is being sent. */
        data object Working : Presence
    }

    data class Row(val pod: PodInfo, val presence: Presence) {
        val ticked: Boolean get() = presence is Presence.Has || presence is Presence.Copying
    }

    private val _rows = MutableStateFlow<List<Row>>(emptyList())
    val rows: StateFlow<List<Row>> = _rows.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    /** The latest refusal or failure, in plain words. */
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private var lastIssuedAt = 0L

    val copyCount: Int get() = _rows.value.count { it.presence is Presence.Has }
    val anyCopying: Boolean get() = _rows.value.any { it.presence is Presence.Copying }

    fun dismissMessage() { _message.value = null }

    /** Ask every server whether it has the app. */
    suspend fun load() {
        _loading.value = true
        try {
            _rows.value = PodApps.askAll(PodApps.servers(pods()), clientFor)
                .map { (pod, answer) -> Row(pod, presence(answer)) }
        } finally {
            _loading.value = false
        }
    }

    private suspend fun presenceOn(pod: PodInfo): Presence = presence(PodApps.ask(pod, clientFor))

    private fun presence(answer: PodApps.Answer): Presence = when (answer) {
        PodApps.Answer.NoSession -> Presence.Unknown(NO_SESSION)
        PodApps.Answer.Unreachable -> Presence.Unknown(UNREACHABLE)
        is PodApps.Answer.Listed -> {
            val app = answer.apps.firstOrNull { it.serviceId == serviceId }
            when {
                app == null -> Presence.Absent
                app.copying != null -> Presence.Copying(app.copying.progress)
                else -> Presence.Has(app)
            }
        }
    }

    /** Whether [row]'s box can be changed here, and why not. */
    fun blockedReason(row: Row): String? = when (val p = row.presence) {
        is Presence.Unknown -> p.reason
        is Presence.Working -> null
        is Presence.Copying -> null
        is Presence.Has -> if (copyCount <= 1) LAST_COPY else null
        is Presence.Absent -> if (copyCount == 0) NO_SOURCE else null
    }

    fun canChange(row: Row): Boolean = when (row.presence) {
        is Presence.Has -> copyCount > 1
        is Presence.Absent -> copyCount > 0
        else -> false
    }

    /** Tick [podId]: sign a copy order and send it to that server. */
    suspend fun copyTo(podId: String): Boolean {
        val target = _rows.value.firstOrNull { it.pod.podId == podId } ?: return false
        if (target.presence !is Presence.Absent) return false
        val source = sourceRow() ?: run {
            _message.value = NO_SOURCE
            return false
        }
        val client = clientFor(target.pod) ?: run {
            _message.value = NO_SESSION
            return false
        }
        _message.value = null
        set(podId, Presence.Working)
        val key = try {
            copySigner("Copy $appName to ${target.pod.name}")
        } catch (e: CancellationException) {
            set(podId, Presence.Absent)
            throw e
        } catch (t: Throwable) {
            set(podId, Presence.Absent)
            _message.value = "Couldn't access your account key: ${t.message}"
            return false
        }
        val issuedAt = maxOf(now(), lastIssuedAt + 1)
        lastIssuedAt = issuedAt
        return try {
            val signed = AppCopy.sign(key, source.pod.fqdn, target.pod.fqdn, serviceId, issuedAt)
            val g = signed.grant
            client.serviceCopy(
                AppCopyRequest(
                    grant = AppCopyGrantBody(g.sourceServer, g.targetServer, g.serviceId, g.issuedAt),
                    signature = signed.signatureHex,
                ),
            )
            set(podId, Presence.Copying(0.0))
            true
        } catch (e: CancellationException) {
            set(podId, Presence.Absent)
            throw e
        } catch (t: Throwable) {
            set(podId, Presence.Absent)
            _message.value = copyFailure(t, appName, target.pod.name)
            false
        }
    }

    /** Untick [podId]: the owner-signed uninstall on that server. The last
     *  copy can't be removed here. */
    suspend fun removeFrom(podId: String): Boolean {
        val target = _rows.value.firstOrNull { it.pod.podId == podId } ?: return false
        val has = target.presence as? Presence.Has ?: return false
        if (copyCount <= 1) {
            _message.value = LAST_COPY
            return false
        }
        val client = clientFor(target.pod) ?: run {
            _message.value = NO_SESSION
            return false
        }
        val parts = has.app.creator.takeIf { it.isNotEmpty() }?.let { it to has.app.slug }
            ?: UninstallServiceOrder.split(serviceId)
            ?: run {
                _message.value = "Couldn't tell which app to remove."
                return false
            }
        _message.value = null
        set(podId, Presence.Working)
        val key = try {
            uninstallSigner("Remove $appName from ${target.pod.name}")
        } catch (e: CancellationException) {
            set(podId, has)
            throw e
        } catch (t: Throwable) {
            set(podId, has)
            _message.value = "Couldn't access your account key: ${t.message}"
            return false
        }
        return try {
            val issuedAt = maxOf(now(), lastIssuedAt + 1)
            lastIssuedAt = issuedAt
            client.uninstallService(
                serviceId,
                UninstallServiceOrder.body(key, target.pod.fqdn, parts.first, parts.second, issuedAt),
            )
            set(podId, Presence.Absent)
            true
        } catch (e: CancellationException) {
            set(podId, has)
            throw e
        } catch (t: Throwable) {
            set(podId, has)
            _message.value = "Couldn't remove $appName from ${target.pod.name}: ${t.boxError() ?: t.userFacing()}"
            false
        }
    }

    /** Follow the copies underway: progress, done (ticked) or failed (with
     *  the box's reason). */
    suspend fun refreshCopying() {
        val copying = _rows.value.filter { it.presence is Presence.Copying }
        for (row in copying) {
            val client = clientFor(row.pod) ?: continue
            val app = try {
                client.appsList().apps.firstOrNull { it.serviceId == serviceId }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                continue
            }
            val next: Presence = when {
                app != null && app.copying == null -> {
                    latestCopy(client)?.pendingEnv?.takeIf { it.isNotEmpty() }?.let { names ->
                        _message.value = pendingEnvText(appName, row.pod.name, names)
                    }
                    Presence.Has(app)
                }
                app != null -> Presence.Copying(app.copying!!.progress ?: (row.presence as Presence.Copying).progress)
                else -> {
                    val record = latestCopy(client)
                    when {
                        record == null -> row.presence
                        record.state == "failed" -> {
                            _message.value = "Couldn't copy $appName to ${row.pod.name}" +
                                (record.reason?.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: ".")
                            Presence.Absent
                        }
                        record.state == "done" -> presenceOn(row.pod)
                        else -> Presence.Copying(record.progress)
                    }
                }
            }
            set(row.pod.podId, next)
        }
    }

    private suspend fun latestCopy(client: ScreensClient): AppCopyRecord? = try {
        client.serviceCopies().copies.filter { it.serviceId == serviceId }.maxByOrNull { it.startedAt }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }

    private fun sourceRow(): Row? {
        val holders = _rows.value.filter { it.presence is Presence.Has }
        val page = pagePodId()
        return holders.firstOrNull { it.pod.podId == page } ?: holders.firstOrNull()
    }

    private fun set(podId: String, presence: Presence) {
        _rows.update { rows -> rows.map { if (it.pod.podId == podId) it.copy(presence = presence) else it } }
    }

    companion object {
        const val NO_SESSION = "Not set up on this phone"
        const val UNREACHABLE = "Can't reach this server right now"
        const val LAST_COPY = "This is the only copy. To delete it, use Uninstall below."
        const val NO_SOURCE = "No server has this app to copy it from."
        const val NEEDS_UPDATE = "This server needs an update to receive copies."

        fun copyFailure(t: Throwable, appName: String, server: String): String {
            if (t is ScreensError.NotImplemented) return NEEDS_UPDATE
            if (t !is ScreensError.Http) return t.userFacing()
            val box = t.boxError()
            return when (t.status) {
                404 -> NEEDS_UPDATE
                409 -> "$appName is already on $server, or a copy is on its way there."
                403 -> "$server refused the copy" + (box?.let { ": $it." } ?: ". Check this phone's clock and try again.")
                400 -> box ?: "$server couldn't read the copy order."
                else -> box ?: t.userFacing()
            }
        }

        fun pendingEnvText(appName: String, server: String, names: List<String>): String =
            "$appName is on $server. Its ${if (names.size == 1) "setting" else "settings"} " +
                "${names.joinToString(", ")} didn't come along: set ${if (names.size == 1) "it" else "them"} " +
                "in its environment on $server."

        /** "Copying…", or with its progress (0..1; a box reporting 0..100 reads too). */
        fun progressText(progress: Double?): String {
            val p = progress?.takeIf { it.isFinite() && it >= 0 } ?: return "Copying…"
            val pct = if (p <= 1.0) (p * 100).roundToInt() else p.roundToInt().coerceAtMost(100)
            return "Copying… $pct%"
        }

        /** That server's state of the app (§6); a copy underway shows its
         *  progress in the note instead, and "unknown" shows nothing. */
        fun rowPill(row: Row): AppStatus.Pill? = (row.presence as? Presence.Has)?.let { AppStatus.pill(it.app) }

        fun rowNote(vm: AppPlacementViewModel, row: Row): String? = when (val p = row.presence) {
            is Presence.Copying -> progressText(p.progress)
            is Presence.Working -> "Working…"
            else -> vm.blockedReason(row)
        }
    }
}
