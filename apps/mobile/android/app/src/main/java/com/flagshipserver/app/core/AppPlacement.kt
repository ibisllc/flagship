// Where an app runs (docs/app-placement.md): clients bound to one server, the
// server a screen is working on, and the default server for a new app.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.LiveBuildClient
import com.flagshipserver.app.api.LiveScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SessionStoring
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import okhttp3.OkHttpClient

/** Clients bound to one server's own base URL and session token. */
interface PodClients {
    /** A screens client for [pod], or null when this device has no session there. */
    fun screens(pod: PodInfo): ScreensClient?

    /** A build-modes client for [pod], or null when this device has no session there. */
    fun build(pod: PodInfo): BuildClient?

    companion object {
        /** No per-server clients (previews): screens fall back to the global client. */
        val None: PodClients = object : PodClients {
            override fun screens(pod: PodInfo): ScreensClient? = null
            override fun build(pod: PodInfo): BuildClient? = null
        }
    }
}

/** Live clients, one per server and session token, each pointed at
 *  `https://<fqdn>` with that server's own token from the per-pod store. */
class LivePodClients(
    private val okHttp: OkHttpClient,
    private val sessions: SessionStoring,
) : PodClients {
    private val screensCache = HashMap<String, ScreensClient>()
    private val buildCache = HashMap<String, BuildClient>()

    private fun storeFor(pod: PodInfo): Pair<String, SessionStoring>? {
        if (pod.fqdn.isEmpty()) return null
        val token = sessions.sessionToken(forPodId = pod.podId) ?: return null
        val store = InMemorySessionStore().apply {
            setPodBaseUrl("https://${pod.fqdn}")
            setSessionToken(token)
        }
        return "${pod.fqdn.lowercase()}|$token" to store
    }

    override fun screens(pod: PodInfo): ScreensClient? {
        val (key, store) = storeFor(pod) ?: return null
        return synchronized(screensCache) {
            screensCache.getOrPut(key) { LiveScreensClient(client = okHttp, store = store) }
        }
    }

    override fun build(pod: PodInfo): BuildClient? {
        val (key, store) = storeFor(pod) ?: return null
        return synchronized(buildCache) {
            buildCache.getOrPut(key) { LiveBuildClient(client = okHttp, store = store) }
        }
    }
}

val LocalPodClients = staticCompositionLocalOf<PodClients> { PodClients.None }

/**
 * The server the screens below are working on: an app page opened from a
 * server's page, or a creation flow's chosen server. [choose] is set inside a
 * creation flow that may still change it; [pinned] means it was started from
 * a server's page and isn't asked again.
 */
data class PodScope(
    val pod: PodInfo,
    val pinned: Boolean = false,
    val creation: Boolean = false,
    val choose: ((String) -> Unit)? = null,
)

val LocalPodScope = compositionLocalOf<PodScope?> { null }

/** The default server for a new app, and the servers a creation flow offers. */
object CreationPlacement {
    data class Option(val pod: PodInfo, val available: Boolean)

    val UNAVAILABLE get() = FSStrings.get(R.string.not_set_up_on_this_phone)

    /** Every server that could run an app: registered, not revoked. */
    fun options(pods: List<PodInfo>, isAvailable: (PodInfo) -> Boolean): List<Option> =
        pods.filter { it.status != PodInfo.Status.PENDING && !it.isRevoked && it.fqdn.isNotEmpty() }
            .map { Option(it, isAvailable(it)) }

    /** The chosen server when it can still be used, else the leader, else the
     *  first server this phone can use. */
    fun resolve(
        pods: List<PodInfo>,
        leaderPodId: String?,
        chosenPodId: String?,
        isAvailable: (PodInfo) -> Boolean,
    ): PodInfo? {
        val usable = options(pods, isAvailable).filter { it.available }.map { it.pod }
        chosenPodId?.let { id -> usable.firstOrNull { it.podId == id }?.let { return it } }
        leaderPodId?.let { id -> usable.firstOrNull { it.podId == id }?.let { return it } }
        return usable.firstOrNull()
    }

    /** A server a screen in the back stack was opened on, or a creation
     *  flow's choice. [pinned]: started from that server's page. */
    data class Mark(val podId: String, val pinned: Boolean = false)

    /**
     * The server for a screen, from the marks of the screens under it
     * (nearest last). Outside a creation flow only an explicit mark counts
     * (null = the current server); inside one, an unpinned choice that can't be
     * used any more falls back to the leader.
     */
    fun scope(
        marks: List<Mark?>,
        creation: Boolean,
        pods: List<PodInfo>,
        leaderPodId: String?,
        isAvailable: (PodInfo) -> Boolean,
    ): Pair<PodInfo, Boolean>? {
        val mark = marks.lastOrNull { it != null }
        if (mark != null && (mark.pinned || !creation)) {
            return pods.firstOrNull { it.podId == mark.podId }?.let { it to mark.pinned }
        }
        if (!creation) return null
        return resolve(pods, leaderPodId, mark?.podId, isAvailable)?.let { it to false }
    }

    /** Show the picker: not pinned, and more than one server to choose from. */
    fun showsPicker(scope: PodScope?, options: List<Option>): Boolean =
        scope != null && !scope.pinned && scope.choose != null && options.size > 1
}

/** Each server's own apps list, asked over that server's session (Runs on, §4;
 *  the services list's pill, §6). */
object PodApps {
    sealed interface Answer {
        data class Listed(val apps: List<AppSummary>) : Answer
        /** This phone has no session on that server. */
        data object NoSession : Answer
        /** The server didn't answer. */
        data object Unreachable : Answer
    }

    /** The account's servers that could have apps. */
    fun servers(pods: List<PodInfo>): List<PodInfo> = CreationPlacement.options(pods) { true }.map { it.pod }

    suspend fun ask(pod: PodInfo, clientFor: (PodInfo) -> ScreensClient?): Answer {
        val client = clientFor(pod) ?: return Answer.NoSession
        return try {
            Answer.Listed(client.appsList().apps)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            Answer.Unreachable
        }
    }

    /** Every server in [servers], in parallel, in order. */
    suspend fun askAll(servers: List<PodInfo>, clientFor: (PodInfo) -> ScreensClient?): List<Pair<PodInfo, Answer>> =
        coroutineScope {
            servers.map { pod -> async { pod to ask(pod, clientFor) } }.awaitAll()
        }
}
