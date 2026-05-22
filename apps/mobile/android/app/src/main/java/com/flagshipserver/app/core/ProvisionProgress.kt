// Provisioning progress model for the "your server is being installed"
// UI. Kotlin mirror of packages/protocol/src/provisionProgress.ts — the
// fraction, the four-group labels, and the per-step states must match
// the webapp + iOS renderers byte-for-byte (validated by the shared
// phase ladder + the conformance tests).

package com.flagshipserver.app.core

object ProvisionProgress {

    /** The fine-grained ladder, in order, EXCLUDING the terminal
     *  `failed` phase. Mirror of PROVISION_PHASES minus `failed`. */
    val ladder: List<String> = listOf(
        "boot",
        "cloned",
        "deps",
        "built",
        "identity",
        "registered",
        "tunnel-online",
        "acme-order",
        "dns01-publish-attempt",
        "dns01-publish-ok",
        "dns01-propagation-wait",
        "tlsalpn-served",
        "acme-validating",
        "cert-issued",
        "ready",
    )

    /** Human title per fine-grained phase. Lockstep with the protocol's
     *  PROVISION_PHASE_TITLES + the control-plane push fan-out titles. */
    val phaseTitles: Map<String, String> = mapOf(
        "boot" to "Server booting",
        "cloned" to "Code cloned",
        "deps" to "Installing dependencies",
        "built" to "Build complete",
        "identity" to "Identity generated",
        "registered" to "Registered with Flagship",
        "tunnel-online" to "Tunnel online",
        "acme-order" to "Requesting certificate",
        "dns01-publish-attempt" to "Publishing DNS challenge",
        "dns01-publish-ok" to "DNS challenge published",
        "dns01-propagation-wait" to "Waiting for DNS",
        "tlsalpn-served" to "Serving TLS challenge",
        "acme-validating" to "Validating certificate",
        "cert-issued" to "TLS certificate issued",
        "ready" to "Server is live",
        "failed" to "Provisioning failed",
    )

    enum class StepKey { BOOTING, REGISTERING, SECURING, READY }

    data class StepGroup(val key: StepKey, val label: String, val phases: List<String>)

    /** The four user-facing groups, in order. */
    val stepGroups: List<StepGroup> = listOf(
        StepGroup(StepKey.BOOTING, "Booting", listOf("boot", "cloned", "deps", "built", "identity")),
        StepGroup(StepKey.REGISTERING, "Registering", listOf("registered", "tunnel-online")),
        StepGroup(
            StepKey.SECURING,
            "Securing (TLS certificate)",
            listOf(
                "acme-order",
                "dns01-publish-attempt",
                "dns01-publish-ok",
                "dns01-propagation-wait",
                "tlsalpn-served",
                "acme-validating",
                "cert-issued",
            ),
        ),
        StepGroup(StepKey.READY, "Ready", listOf("ready")),
    )

    enum class StepState { DONE, ACTIVE, PENDING, FAILED }

    data class StepView(
        val key: StepKey,
        val label: String,
        val state: StepState,
        /** Fine-grained phase title for the ACTIVE / FAILED group; null
         *  otherwise. */
        val detail: String?,
    )

    private fun isLadderPhase(p: String): Boolean = ladder.contains(p)

    /** Map a phase to a 0..1 fraction for a determinate progress bar. */
    fun fraction(phase: String?): Double {
        if (phase.isNullOrEmpty()) return 0.0
        if (phase == "ready") return 1.0
        if (phase == "failed") return 0.0
        val idx = ladder.indexOf(phase)
        if (idx < 0) return 0.0
        return (idx + 1).toDouble() / ladder.size.toDouble()
    }

    private fun groupKeyForPhase(phase: String): StepKey {
        for (g in stepGroups) if (g.phases.contains(phase)) return g.key
        return StepKey.BOOTING
    }

    /** Project (phase, lastError, prevPhase) into the per-group checklist
     *  every detail page renders. See the protocol module for the rules. */
    fun stepStates(
        phase: String?,
        lastError: String? = null,
        prevPhase: String? = null,
    ): List<StepView> {
        if (phase == "ready") {
            return stepGroups.map { StepView(it.key, it.label, StepState.DONE, null) }
        }

        if (phase == "failed") {
            val failedPhase = if (prevPhase != null && isLadderPhase(prevPhase)) prevPhase else "boot"
            val failedGroup = groupKeyForPhase(failedPhase)
            val failedIdx = stepGroups.indexOfFirst { it.key == failedGroup }
            return stepGroups.mapIndexed { i, g ->
                when {
                    i < failedIdx -> StepView(g.key, g.label, StepState.DONE, null)
                    i == failedIdx -> {
                        val d = if (lastError.isNullOrEmpty()) phaseTitles["failed"] else lastError
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

        val activeGroup = groupKeyForPhase(phase)
        val activeIdx = stepGroups.indexOfFirst { it.key == activeGroup }
        return stepGroups.mapIndexed { i, g ->
            when {
                i < activeIdx -> StepView(g.key, g.label, StepState.DONE, null)
                i == activeIdx -> StepView(g.key, g.label, StepState.ACTIVE, phaseTitles[phase])
                else -> StepView(g.key, g.label, StepState.PENDING, null)
            }
        }
    }

    /** Should the list (Home) render a thin progress bar for this demo
     *  server? True for any pre-`ready` server; false for ready / none /
     *  absent. */
    fun shouldShowProgressBar(phase: String?, status: String?): Boolean {
        if (status == "up" && (phase == null || phase == "ready")) return false
        if (phase == "ready") return false
        if (status == "none") return false
        return status == "provisioning" || phase != null
    }
}
