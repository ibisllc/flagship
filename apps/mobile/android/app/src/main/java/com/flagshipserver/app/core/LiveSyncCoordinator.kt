// LiveSync — the Android app-scope single live-update canal. Kotlin mirror of
// the iOS LiveSyncCoordinator.
//
// ONE long-poll loop against the backend hanging GET
//   GET /api/users/:u/stream?cursor=<hex>
// which returns { cursor, pods, pending, … } — a SUPERSET of /pods (same
// pods[] with pendingRequests, same pending[] with phase) plus an opaque
// cursor. We echo the last cursor back; the server HOLDS up to ~25s and returns
// the instant anything meaningful changes (or on timeout, the same cursor). On
// every snapshot we feed the SAME shared state the views already read —
// AppState.pods (via the existing PendingServerReconciler) and the unified Box
// Request Inbox (AppState.boxRequestInbox) — so the UI updates with no manual
// refresh. It collapses the per-screen pollers (the Home 5s approval poll, the
// Home reconciler loop) into ONE channel.
//
// Shape mirrors AiChatAlertPoller: an isActiveGate-gated loop with an injected
// client + scope, app-scope (wired at the shell, NOT one screen), fully
// unit-testable with MockSecretMailboxClient (no real network, no hang).
// GRACEFUL FALLBACK: a stream error drops to a plain /pods fetch (today's
// behavior) so behavior never degrades — /pods stays the net.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodsDirectoryResponse
import com.flagshipserver.app.api.SecretMailboxClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.random.Random

class LiveSyncCoordinator(
    private val app: AppState,
    private val mailbox: SecretMailboxClient,
    /** Gate — only poll while paired + unlocked (mirrors the sliver's
     *  hide-under-lock). The loop self-pauses when false and resumes when true. */
    private val isActiveGate: () -> Boolean,
    /** Build the reconciler used to fold a directory into AppState.pods. Injected
     *  so the SWK-deposit side-effect can be wired by the caller while the test
     *  path stays side-effect-free. */
    private val makeReconciler: () -> PendingServerReconciler,
    /** ± jitter (ms) on each reconnect so a fleet that times out together doesn't
     *  reconnect in lockstep. Injectable for deterministic tests. */
    private val jitterMs: () -> Long = { Random.nextLong(0, JITTER_MS) },
    /** Wait between rounds when /stream is down — the /pods fallback cadence. */
    private val fallbackMs: Long = FALLBACK_MS,
) {
    companion object {
        const val JITTER_MS = 500L
        const val FALLBACK_MS = 5_000L
    }

    /** The last cursor the stream returned — echoed back to detect change. */
    private var cursor: String? = null
    /** Whether the last round fell back to /pods (a prior stream error). */
    var degraded: Boolean = false
        private set

    private var job: Job? = null

    fun start(scope: CoroutineScope) {
        stop()
        job = scope.launch {
            while (isActive) {
                if (isActiveGate()) {
                    val nextDelay = tickOnce()
                    delay(nextDelay)
                } else {
                    // Paused (backgrounded / locked / signed out). Re-check soon;
                    // the next active tick reconnects (cursor preserved).
                    delay(fallbackMs)
                }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** One round-trip. Returns the ms to wait before the next request. On a
     *  successful /stream read we reconnect immediately (+ jitter) — the server
     *  already held. On a fallback /pods read (stream error) we wait the longer
     *  cadence. Always feeds the shared state; never throws to the loop. */
    suspend fun tickOnce(): Long {
        val user = app.currentUser.value
        if (user.isNullOrEmpty()) return fallbackMs
        return try {
            val snap = mailbox.fetchLiveSync(user, cursor)
            degraded = false
            val changed = snap.cursor != cursor
            cursor = snap.cursor
            // Only feed the shared state on a genuine change. A timeout hold
            // returns the same cursor, so a steady stream never churns the UI.
            if (changed) feed(snap.directory)
            // Long-poll: reconnect right away (+ jitter).
            jitterMs()
        } catch (t: Throwable) {
            // /stream unreachable / non-200 → fall back to the plain /pods fetch
            // so behavior never degrades below today's. Then wait the fallback
            // cadence (the next round retries /stream first).
            degraded = true
            // Clear the cursor so the next /stream attempt connects fresh.
            cursor = null
            runCatching { mailbox.fetchPods(user) }.getOrNull()?.let { feed(it) }
            fallbackMs + jitterMs()
        }
    }

    /** Feed the SHARED app state from a directory snapshot: reconcile pods
     *  (pending → online, surface new orders, drop ghosts) AND publish the
     *  unified Box Request Inbox. Exactly what the per-screen pollers used to do
     *  — now driven from the one canal. */
    private suspend fun feed(directory: PodsDirectoryResponse) {
        // Pods + pending: reuse the existing reconciler over the directory we
        // already have (no second round-trip).
        makeReconciler().reconcile(directory)

        // Box Request Inbox: project each pod's pendingRequests digest into the
        // typed inbox (the SAME projection BootApprovalWatcher's pollAwaiting
        // does). Unknown/future purposes a not-yet-updated client can't satisfy
        // are dropped (they need no affordance).
        val inbox = mutableMapOf<String, List<BoxRequest>>()
        for (pod in directory.pods) {
            val reqs = pod.pendingRequests.mapNotNull { r ->
                val purpose = SecretPurpose.fromWire(r.type) ?: return@mapNotNull null
                BoxRequest(
                    nonceHex = r.id,
                    serverDomain = pod.serverDomain,
                    type = purpose,
                    issuedAt = r.issuedAt,
                    expiresAt = r.expiresAt,
                )
            }
            if (reqs.isNotEmpty()) inbox[pod.serverDomain.lowercase()] = reqs
        }
        app.setBoxRequestInbox(inbox)
    }
}
