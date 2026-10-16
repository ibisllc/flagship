// Polls `.com`'s `GET /api/order/<serial>/status` (the one canonical
// provisioning channel) for every pending server this device created, while
// the app runs, so the ongoing setup notification and the Wear timeline move
// without a push or an open install screen. Each checkpoint goes to
// [com.flagshipserver.app.companion.ProvisionProgressCenter]; `live` flips the
// pod online on Home; `error` stops (the notification shows the failure).
// One watcher per pending pod, every 5 s, for at most an hour. Kotlin twin of
// iOS PendingPodWatcher / PendingPodWatcherRegistry.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ProvisionStatusPhase
import com.flagshipserver.app.companion.ProvisionUpdate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class PendingPodWatchers(
    private val app: AppState,
    private val server: () -> FlagshipServerClient,
    private val report: (ProvisionUpdate) -> Unit,
    private val pollIntervalMs: Long = POLL_INTERVAL_MS,
    private val timeoutMs: Long = WATCH_TIMEOUT_MS,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val jobs = HashMap<String, Job>()

    /** Start a watcher for each newly pending pod with a serial; stop the
     *  ones whose pod went online, was removed, or the user signed out. */
    fun sync(scope: CoroutineScope) {
        val pending = app.pods.value.filter {
            it.status == PodInfo.Status.PENDING && !it.pendingAuthCodeSerial.isNullOrEmpty()
        }
        val ids = pending.map { it.podId }.toSet()
        synchronized(jobs) {
            jobs.keys.filter { it !in ids }.forEach { jobs.remove(it)?.cancel() }
            for (pod in pending) {
                if (jobs[pod.podId]?.isActive == true) continue
                val serial = pod.pendingAuthCodeSerial ?: continue
                jobs[pod.podId] = scope.launch { watch(pod.podId, serial) }
            }
        }
    }

    fun stopAll() = synchronized(jobs) {
        jobs.values.forEach { it.cancel() }
        jobs.clear()
    }

    private suspend fun watch(podId: String, serial: String) {
        val startedAt = now()
        while (kotlinx.coroutines.currentCoroutineContext().isActive) {
            if (now() - startedAt > timeoutMs) return
            if (!stillPending(podId)) return
            if (pollOnce(podId, serial)) return
            delay(pollIntervalMs)
        }
    }

    private fun stillPending(podId: String): Boolean =
        app.pods.value.firstOrNull { it.podId == podId }?.status == PodInfo.Status.PENDING

    /** One poll. Returns true once the install reached a terminal phase. */
    internal suspend fun pollOnce(podId: String, serial: String): Boolean {
        val status = try {
            server().fetchProvisionStatus(serial)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        } ?: return false
        val pod = app.pods.value.firstOrNull { it.podId == podId }
        report(
            ProvisionUpdate(
                key = serial, serial = serial, podName = pod?.name?.takeIf { it.isNotBlank() },
                phase = status.phase, detail = status.detail, serverDomain = status.serverDomain,
            ),
        )
        return when (ProvisionStatusPhase.fromWire(status.phase)) {
            ProvisionStatusPhase.LIVE -> {
                if (pod != null) {
                    val fqdn = status.serverDomain?.takeIf { it.isNotBlank() } ?: pod.fqdn
                    if (fqdn.isNotEmpty()) {
                        if (!pod.fqdn.equals(fqdn, ignoreCase = true)) app.removePod(pod.podId)
                        app.upsertRegisteredPod(fqdn = fqdn, name = pod.name, description = pod.description)
                    }
                }
                true
            }
            ProvisionStatusPhase.ERROR -> true
            else -> false
        }
    }

    companion object {
        const val POLL_INTERVAL_MS = 5_000L
        const val WATCH_TIMEOUT_MS = 60 * 60_000L
    }
}
