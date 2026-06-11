// Live install-progress poller — Kotlin mirror of the iOS
// ProvisionTimelineViewModel. Polls the ONE canonical provisioning channel
// (GET /api/order/<serial>/status) and exposes the latest
// ProvisionStatusRecord; every Android install surface reads from here.
//
// DIRECTORY FALLBACK — the per-order endpoint needs the raw auth-code
// serial, which only the order's CREATING device holds (the unauthenticated
// `/pods` list carries opaque orderRefs, never the serial — it's a
// provision-status write capability). A pending pod surfaced on a
// non-creating device therefore polls the `/pods` directory instead and
// synthesizes a phase-only status from its `pending[].phase` (the ladder
// derives row states from the current phase alone), flipping to terminal
// `live` when the fqdn shows up registered. Without this fallback such a
// pod sat forever on the empty "Booting up" ladder.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PodsDirectoryResponse
import com.flagshipserver.app.api.ProvisionStatusPhase
import com.flagshipserver.app.api.ProvisionStatusRecord
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class ProvisionTimelineViewModel private constructor(private val mode: Mode) {

    private sealed interface Mode {
        data class Order(val serial: String, val server: FlagshipServerClient) : Mode
        data class Directory(
            val username: String,
            val fqdn: String,
            /** Fetches the merged `/pods` directory. Null ⇒ couldn't reach
             *  it this pass; the poller just tries again next tick. */
            val fetch: suspend (username: String) -> PodsDirectoryResponse?,
        ) : Mode
    }

    /** Order mode — deep per-order progress with the raw auth-code serial
     *  (only the creating device holds it). */
    constructor(serial: String, server: FlagshipServerClient) :
        this(Mode.Order(serial, server))

    /** Directory mode — list-level progress for a serial-less pod (surfaced
     *  from `/pods` on a non-creating device). */
    constructor(
        username: String,
        fqdn: String,
        fetchDirectory: suspend (username: String) -> PodsDirectoryResponse?,
    ) : this(Mode.Directory(username, fqdn, fetchDirectory))

    /** The latest canonical status (synthesized phase-only in directory
     *  mode); null until the box first reports. */
    private val _status = MutableStateFlow<ProvisionStatusRecord?>(null)
    val status: StateFlow<ProvisionStatusRecord?> = _status.asStateFlow()

    /** True once a terminal phase (live / error) was observed. */
    val isDone: Boolean
        get() = _status.value?.let { ProvisionStatusPhase.fromWire(it.phase).isTerminal } == true

    /** One poll round-trip. Returns true if a terminal phase was observed
     *  so the caller's loop can stop without sleeping. A 404 (no checkpoint
     *  yet) or a network blip leaves the state untouched (returns false). */
    suspend fun pollOnce(): Boolean = when (val m = mode) {
        is Mode.Order -> {
            // The single canonical channel — per-order status (every phase
            // the box reports, once each).
            val next = runCatching { m.server.fetchProvisionStatus(m.serial) }.getOrNull()
            if (next == null) false else apply(next)
        }
        is Mode.Directory -> {
            val directory = m.fetch(m.username)
            if (directory == null) {
                false
            } else {
                val target = m.fqdn.lowercase()
                val registered = directory.pods.any {
                    it.serverDomain.lowercase() == target && it.revokedAt == null
                }
                if (registered) {
                    // A registered fqdn is the terminal good outcome — the
                    // box made it all the way; the reconciler flips the
                    // list pod online.
                    apply(synthesized(ProvisionStatusPhase.LIVE.wire))
                } else {
                    val raw = directory.pending
                        .firstOrNull { it.fqdn.lowercase() == target }
                        ?.phase
                    // An unrecognised / absent phase is "no checkpoint yet".
                    if (raw == null || ProvisionStatusPhase.fromWire(raw) == ProvisionStatusPhase.UNKNOWN) {
                        false
                    } else {
                        apply(synthesized(raw))
                    }
                }
            }
        }
    }

    /** Poll until terminal, sleeping [pollMs] between rounds. Cancellation
     *  (the screen leaving composition) stops the loop. */
    suspend fun runUntilTerminal(pollMs: Long = POLL_INTERVAL_MS) {
        while (!pollOnce()) delay(pollMs)
    }

    private fun apply(next: ProvisionStatusRecord): Boolean {
        _status.value = next
        return ProvisionStatusPhase.fromWire(next.phase).isTerminal
    }

    /** Directory mode never sees the serial or a history — synthesize a
     *  phase-only record the ladder can project. */
    private fun synthesized(phase: String): ProvisionStatusRecord =
        ProvisionStatusRecord(
            serial = "",
            serverDomain = (mode as Mode.Directory).fqdn,
            phase = phase,
            updatedAt = System.currentTimeMillis(),
            history = emptyList(),
        )

    companion object {
        /** Production cadence — matches the existing install-progress poll. */
        const val POLL_INTERVAL_MS = 3_000L
    }
}
