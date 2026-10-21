// One place every provisioning update lands, whichever surface saw it: the
// install-progress screens' polls and the `provision-status` pushes. It keeps
// the ongoing "your server is installing" notification (Android's stand-in for
// iOS's Live Activity) and tells any other listener (the watch) the same.
// The Android twin of iOS's InstallProgressBridge.

package com.flagshipserver.app.companion

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.content.Context
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.ProvisionProgress

/** One provisioning checkpoint for an install, keyed by its order serial (or,
 *  for a box another device created, its address). */
data class ProvisionUpdate(
    val key: String,
    /** The order serial when this device holds it (opens that order's progress). */
    val serial: String?,
    val podName: String?,
    /** Canonical ProvisionStatusPhase wire string. */
    val phase: String,
    val detail: String? = null,
    val serverDomain: String? = null,
    val at: Long = System.currentTimeMillis(),
)

/** What the ongoing notification shows for an update. */
data class ProvisionNotice(
    val title: String,
    val text: String,
    /** 0..100. */
    val progress: Int,
    val ongoing: Boolean,
    val failed: Boolean,
    val tapUrl: String,
    /** Dismiss after this long; null while the install runs. */
    val timeoutMs: Long?,
)

object ProvisionNoticeModel {
    /** iOS ends its Live Activity five minutes after the last frame. */
    const val TERMINAL_TIMEOUT_MS = 5 * 60 * 1000L
    val DEFAULT_TITLE get() = FSStrings.get(R.string.new_server)

    private fun rank(phase: String): Int = ProvisionProgress.ladder.indexOf(phase)

    private fun isTerminal(phase: String) = phase == "live" || phase == "error"

    /** True when [next] should replace [prev]: pushes and polls can arrive out
     *  of order, so a later rung never steps back, and nothing follows an
     *  install's end except a fresh attempt starting over at `booting`. */
    fun advances(prev: String?, next: String): Boolean {
        if (prev == null) return true
        if (next == "error" || next == "live") return prev != next
        if (rank(next) < 0) return false
        if (isTerminal(prev)) return prev == "error" && next == "booting"
        return rank(next) > rank(prev)
    }

    /** The notice for [u], or null for a phase this build doesn't know. */
    fun notice(u: ProvisionUpdate): ProvisionNotice? {
        val title = u.podName?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE
        val tap = Endpoints.appRoute(
            "install-progress",
            u.serial?.let { mapOf("serial" to it) } ?: emptyMap(),
        )
        return when (u.phase) {
            "live" -> ProvisionNotice(
                title = title,
                text = ProvisionProgress.phaseTitles.getValue("live") +
                    (u.serverDomain?.takeIf { it.isNotBlank() }?.let { " at $it" } ?: ""),
                progress = 100,
                ongoing = false,
                failed = false,
                tapUrl = tap,
                timeoutMs = TERMINAL_TIMEOUT_MS,
            )
            "error" -> ProvisionNotice(
                title = title,
                text = ProvisionProgress.failureDetail(u.detail).orEmpty(),
                progress = 0,
                ongoing = false,
                failed = true,
                tapUrl = tap,
                timeoutMs = TERMINAL_TIMEOUT_MS,
            )
            else -> {
                if (rank(u.phase) < 0) return null
                ProvisionNotice(
                    title = title,
                    text = if (u.phase == "installed") ProvisionProgress.INSTALLED_UNPLUG_DETAIL
                    else ProvisionProgress.phaseTitles[u.phase] ?: u.phase,
                    progress = (ProvisionProgress.fraction(u.phase) * 100).toInt(),
                    ongoing = true,
                    failed = false,
                    tapUrl = tap,
                    timeoutMs = null,
                )
            }
        }
    }
}

object ProvisionProgressCenter {
    /** Other surfaces that mirror the install (the watch). */
    @Volatile var listener: ((Context, ProvisionUpdate) -> Unit)? = null

    private val lastPhase = HashMap<String, String>()

    /** Record [u] and refresh the notification. Steps that arrive late or
     *  repeat are dropped. Returns whether it was applied. */
    fun report(context: Context, u: ProvisionUpdate): Boolean {
        val app = context.applicationContext
        val names = ProvisionNames.from(app)
        val named = if (u.podName.isNullOrBlank()) u.copy(podName = names.name(u.key)) else {
            names.remember(u.key, u.podName)
            u
        }
        synchronized(lastPhase) {
            if (!ProvisionNoticeModel.advances(lastPhase[u.key], u.phase)) return false
            lastPhase[u.key] = u.phase
        }
        ProvisionNotifier.show(app, named)
        listener?.invoke(app, named)
        if (u.phase == "live") names.forget(u.key)
        return true
    }

    /** Remember the name an install shows before its first checkpoint, so a
     *  push (which never names the server) reads the same. */
    fun rememberName(context: Context, key: String, podName: String) {
        ProvisionNames.from(context.applicationContext).remember(key, podName)
    }

    internal fun resetForTest() = synchronized(lastPhase) { lastPhase.clear() }
}

/** Device-local install names by order key. */
internal class ProvisionNames(private val prefs: android.content.SharedPreferences) {
    fun name(key: String): String? = prefs.getString(PREFIX + key, null)
    fun remember(key: String, name: String) { prefs.edit().putString(PREFIX + key, name).apply() }
    fun forget(key: String) { prefs.edit().remove(PREFIX + key).apply() }

    companion object {
        private const val PREFIX = "provision-name."
        fun from(context: Context) =
            ProvisionNames(context.getSharedPreferences("flagship.companion", Context.MODE_PRIVATE))
    }
}
