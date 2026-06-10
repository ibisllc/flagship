// Provisioning progress model for the "your server is being installed"
// UI. The fraction, the group labels, and the per-step states must match
// the webapp + iOS renderers byte-for-byte — all three derive the SAME
// projection from the ONE canonical phase ladder + the ONE group table.
//
// CANONICAL CHANNEL: order-status. The ONE vocabulary is
// `ProvisionStatusPhase` (packages/control-plane/src/provisionStatus.ts
// PROVISION_STATUS_PHASES). The fine-grained 16-rung ladder + the old
// 4-group StepKey are RETIRED — they survive only as an optional `detail`
// string on the canonical channel, never as a UI vocabulary.

package com.flagshipserver.app.core

object ProvisionProgress {

    /** The ONE ordered ladder, in order, EXCLUDING the terminal `error`
     *  phase. Canonical `ProvisionStatusPhase` wire strings (booting…live).
     *  Mirror of `PROVISION_STATUS_PHASES` minus `error`. */
    val ladder: List<String> = listOf(
        "booting",
        "partitioning",
        "installing",
        // The flagship bootstrap (git clone + apt + nodejs) — the post-install
        // software fetch. The base OS is already on the USB, so this follows
        // `installing` on the wire.
        "downloading",
        "registering",
        "sealing",
        // ACTION-NEEDED: install finished, box registered + sealed, then powered
        // off awaiting the user to unplug the USB + power on. The final
        // pre-poweroff checkpoint — sorts AFTER sealing. NOT success.
        "installed",
        "pairing",
        "live",
    )

    /** Canonical phase title per phase. Single source — every surface
     *  uses these (provisionStatus.ts PHASE_TITLES, byte-identical). */
    val phaseTitles: Map<String, String> = mapOf(
        "booting" to "Booting up",
        "downloading" to "Downloading",
        "partitioning" to "Partitioning disk",
        "installing" to "Installing",
        "installed" to "Install complete — unplug the USB",
        "registering" to "Registering with Flagship",
        "sealing" to "Sealing your disk key",
        "pairing" to "Pairing with your phone",
        "live" to "Your server is live",
        "error" to "Setup hit a problem",
    )

    /** The canonical UI group projection, re-keyed onto the phases.
     *  Mirror of the LOCKED DESIGN §1.2 table — every implementer derives
     *  the SAME grouping from it.
     *
     *  NOTE: `installed` is its OWN rendered rung, positioned AFTER SECURING
     *  (sealing) — the final pre-poweroff checkpoint (registered + sealed,
     *  then powered off awaiting the user). When it's current the box is OFF,
     *  so its row renders ACTIVE (action-needed, nothing spins) carrying the
     *  unplug instruction; `live` is the terminal success. */
    enum class StepKey { BOOTING, INSTALLING, REGISTERING, SECURING, INSTALLED, READY }

    data class StepGroup(val key: StepKey, val label: String, val phases: List<String>)

    /** Detail shown on the Installed row when the current phase is
     *  `installed` (action-needed: install finished, box powered off). */
    const val INSTALLED_UNPLUG_DETAIL =
        "Install complete — unplug the USB, then power the box back on."

    /** The user-facing groups, in order. `installed` is its own rung after
     *  Securing (see above). */
    val stepGroups: List<StepGroup> = listOf(
        StepGroup(StepKey.BOOTING, "Booting", listOf("booting", "partitioning")),
        StepGroup(StepKey.INSTALLING, "Installing", listOf("installing", "downloading")),
        StepGroup(StepKey.REGISTERING, "Registering", listOf("registering", "pairing")),
        StepGroup(StepKey.SECURING, "Securing", listOf("sealing")),
        StepGroup(StepKey.INSTALLED, "Install complete — unplug the USB", listOf("installed")),
        StepGroup(StepKey.READY, "Ready", listOf("live")),
    )

    enum class StepState { DONE, ACTIVE, PENDING, FAILED }

    data class StepView(
        val key: StepKey,
        val label: String,
        val state: StepState,
        /** Canonical phase title for the ACTIVE / FAILED group; null
         *  otherwise. */
        val detail: String?,
    )

    private fun isLadderPhase(p: String): Boolean = ladder.contains(p)

    /** Map a phase to a 0..1 fraction for a determinate progress bar.
     *  `live` = 1.0, `error` = 0.0, off-ladder/null = 0.0. */
    fun fraction(phase: String?): Double {
        if (phase.isNullOrEmpty()) return 0.0
        if (phase == "live") return 1.0
        if (phase == "error") return 0.0
        val idx = ladder.indexOf(phase)
        if (idx < 0) return 0.0
        return (idx + 1).toDouble() / ladder.size.toDouble()
    }

    private fun groupKeyForPhase(phase: String): StepKey {
        for (g in stepGroups) if (g.phases.contains(phase)) return g.key
        return StepKey.BOOTING
    }

    /** Project (phase, lastError, prevPhase) into the per-group checklist
     *  every detail page renders. `error` fails the currently-active
     *  group (derived from `prevPhase`). */
    fun stepStates(
        phase: String?,
        lastError: String? = null,
        prevPhase: String? = null,
    ): List<StepView> {
        if (phase == "live") {
            return stepGroups.map { StepView(it.key, it.label, StepState.DONE, null) }
        }

        if (phase == "error") {
            val failedPhase = if (prevPhase != null && isLadderPhase(prevPhase)) prevPhase else "booting"
            val failedGroup = groupKeyForPhase(failedPhase)
            val failedIdx = stepGroups.indexOfFirst { it.key == failedGroup }
            return stepGroups.mapIndexed { i, g ->
                when {
                    i < failedIdx -> StepView(g.key, g.label, StepState.DONE, null)
                    i == failedIdx -> {
                        val d = if (lastError.isNullOrEmpty()) phaseTitles["error"] else lastError
                        StepView(g.key, g.label, StepState.FAILED, d)
                    }
                    else -> StepView(g.key, g.label, StepState.PENDING, null)
                }
            }
        }

        if (phase == null || !isLadderPhase(phase)) {
            // No checkpoint yet → first group active, no detail.
            return stepGroups.mapIndexed { i, g ->
                StepView(g.key, g.label, if (i == 0) StepState.ACTIVE else StepState.PENDING, null)
            }
        }

        // `installed` is its own ACTIVE rung (after Securing): install finished,
        // box registered + sealed, then powered off awaiting the user. The box
        // is OFF so nothing spins, but the row is ACTIVE (action-needed)
        // carrying the unplug instruction; everything before it is DONE.
        val activeGroup = groupKeyForPhase(phase)
        val activeIdx = stepGroups.indexOfFirst { it.key == activeGroup }
        return stepGroups.mapIndexed { i, g ->
            when {
                i < activeIdx -> StepView(g.key, g.label, StepState.DONE, null)
                i == activeIdx -> {
                    val detail = if (phase == "installed") INSTALLED_UNPLUG_DETAIL else phaseTitles[phase]
                    StepView(g.key, g.label, StepState.ACTIVE, detail)
                }
                else -> StepView(g.key, g.label, StepState.PENDING, null)
            }
        }
    }

    /** Should the list (Home) render a thin progress bar for this demo
     *  server? True for any pre-`live` server; false for live / none /
     *  absent. `status` is the coarse 3-state demo lifecycle
     *  (none/provisioning/up) — distinct from the canonical phase. */
    fun shouldShowProgressBar(phase: String?, status: String?): Boolean {
        if (status == "up" && (phase == null || phase == "live")) return false
        if (phase == "live") return false
        if (status == "none") return false
        return status == "provisioning" || phase != null
    }
}
