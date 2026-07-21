// Kotlin mirror of FlagshipCore/ActiveOperationsCenter.swift.
//
// App-wide registry of in-progress operations — a server being deployed,
// a service being built, and (by design) anything we add later. The
// global "operations" sliver (the teal strip the whole shell slides down
// to reveal, modelled on WhatsApp's active-call bar) renders the
// `primary` one and a "+N" hint for the rest; tapping deep-links to that
// operation. Implemented with StateFlow so Compose / Flow consumers
// observe changes idiomatically, the same way ToastCenter is.

package com.flagshipserver.app.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One operation currently running on the user's behalf. `target` is the
 *  deep link a tap on the sliver follows to that operation's own screen.
 *  `seq` is assigned by the center and orders the sliver — it is never
 *  shown. */
data class ActiveOperation(
    val id: String,
    val kind: Kind,
    /** The headline noun: the server name (deploy) or the service name (build). */
    val subject: String,
    /** Build only — the server the service is being built on. null drops the
     *  "on <server>" clause; deploy operations always leave it null. */
    val onServer: String? = null,
    /** Where tapping the sliver navigates. */
    val target: DeepLink,
    /** Monotonic insertion order assigned by [ActiveOperationsCenter]. The
     *  most recently started operation (highest [seq]) is the one the single-
     *  line sliver shows. Ordering only — never rendered. */
    val seq: Int = 0,
) {
    enum class Kind { DEPLOY, BUILD }

    /** The sentence shown in the sliver. The two canonical shapes are
     *  "deploying server <name>" and "building <service> on <server>"; a
     *  build with no known server collapses to "building <service>". */
    val label: String
        get() = when (kind) {
            Kind.DEPLOY -> "deploying server $subject"
            Kind.BUILD ->
                if (!onServer.isNullOrEmpty()) "building $subject on $onServer"
                else "building $subject"
        }
}

/**
 * App-wide registry of in-progress operations. Mirrors the [ToastCenter]
 * pattern — a singleton provided into the composition at the App scope so
 * it outlives any one screen and is the single source of truth the sliver
 * reads.
 *
 * Two feeders, deliberately different in shape:
 *   - **Deploy** operations are *derived* from the pending-pod list via
 *     [syncDeployOperations] — pods are already global, persistent, and
 *     polled, so a deploying server stays in the sliver across navigation
 *     with zero extra plumbing.
 *   - **Build** operations are *registered* imperatively
 *     ([upsertBuild] / [removeBuild]) by the in-app build lifecycle,
 *     because a service build has no global signal today.
 */
class ActiveOperationsCenter {
    private val _operations = MutableStateFlow<List<ActiveOperation>>(emptyList())
    val operations: StateFlow<List<ActiveOperation>> = _operations.asStateFlow()

    private var nextSeq: Int = 0

    /** The single operation the sliver shows: the most recently started. */
    val primary: ActiveOperation?
        get() = _operations.value.maxByOrNull { it.seq }

    /** Operations running beyond the primary, for the sliver's "+N" hint. */
    val additionalCount: Int
        get() = maxOf(0, _operations.value.size - 1)

    // ── Build operations (imperative) ──────────────────────────────

    /** Register or refresh a build operation. An existing id keeps its [seq]
     *  so a mid-build label refresh (the service name arriving, say) doesn't
     *  jump it to the front of the sliver. Churn-free: identical upserts
     *  don't touch [operations], so steady polling never spams observers. */
    fun upsertBuild(id: String, subject: String, onServer: String?, target: DeepLink) {
        val opId = buildId(id)
        val current = _operations.value
        val idx = current.indexOfFirst { it.id == opId }
        if (idx >= 0) {
            val updated = ActiveOperation(
                id = opId, kind = ActiveOperation.Kind.BUILD, subject = subject,
                onServer = onServer, target = target, seq = current[idx].seq,
            )
            if (current[idx] != updated) {
                _operations.value = current.toMutableList().also { it[idx] = updated }
            }
        } else {
            _operations.value = current + ActiveOperation(
                id = opId, kind = ActiveOperation.Kind.BUILD, subject = subject,
                onServer = onServer, target = target, seq = bump(),
            )
        }
    }

    fun removeBuild(id: String) {
        val opId = buildId(id)
        if (_operations.value.any { it.id == opId }) {
            _operations.value = _operations.value.filterNot { it.id == opId }
        }
    }

    // ── Deploy operations (derived from pending pods) ──────────────

    /**
     * Reconcile deploy operations against the current pods.
     *
     * **Bug-3 decision — SUPPRESS deploy ops for pending pods.** A freshly-
     * created server is [PodInfo.Status.PENDING] the moment its recipe is minted
     * — i.e. while it is merely AWAITING A BURN, long before any box boots. The
     * in-list [PodInfo] for a pending pod carries NO install-phase/liveness
     * signal that distinguishes "awaiting burn / not booted yet" from "actually
     * booting/installing" (real USB-burn pods only gain a phase via a separate
     * timeline poller, not on this model; once a box registers it LEAVES
     * pending). With no reliable signal to gate on, showing a spinning
     * "deploying server <name>" for an unburned recipe is wrong — so we emit
     * nothing for pending pods. Home's status pill already shows "Pending" /
     * "coming online" for these.
     *
     * This therefore PRUNES any deploy ops and never creates new ones, while
     * leaving build operations completely untouched. Mirror of iOS
     * ActiveOperationsCenter.syncDeployOperations.
     */
    @Suppress("UNUSED_PARAMETER")
    fun syncDeployOperations(pods: List<PodInfo>) {
        // Drop every deploy op; keep build ops as-is.
        val next = _operations.value.filter { it.kind != ActiveOperation.Kind.DEPLOY }
        if (next != _operations.value) _operations.value = next
    }

    // ── Internals ──────────────────────────────────────────────────

    private fun bump(): Int {
        nextSeq += 1
        return nextSeq
    }

    /** Namespaced ids keep the two feeders from ever colliding (a pod and a
     *  build session could share a raw string). */
    private fun deployId(podId: String): String = "deploy:$podId"
    private fun buildId(id: String): String = "build:$id"
}
