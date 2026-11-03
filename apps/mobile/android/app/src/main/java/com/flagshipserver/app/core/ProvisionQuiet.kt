// What a pending server's install progress says when the box goes quiet
// (packages/protocol/test-vectors/provision-quiet, identical on iOS and the
// webapp). d-i reports at least every 2 minutes while it runs, so an
// `installing` status older than 5 minutes means the installer has finished
// (or died); any pre-registration phase older than 20 minutes means the box
// stopped reporting before it registered.

package com.flagshipserver.app.core

import com.flagshipserver.app.R

enum class ProvisionQuiet(val wire: String) {
    NONE("none"),
    INSTALLER_FINISHED("installerFinished"),
    STUCK("stuck");

    /** The current row's detail in place of the stale checkpoint; null for NONE. */
    val detail: String?
        get() = when (this) {
            NONE -> null
            INSTALLER_FINISHED -> FSStrings.get(R.string.provision_quiet_installer_finished)
            STUCK -> FSStrings.get(R.string.provision_quiet_stuck)
        }

    companion object {
        const val INSTALLER_QUIET_AFTER_MS = 300_000L
        const val STUCK_AFTER_MS = 1_200_000L
        /** How often a screen re-judges while no new status arrives. */
        const val RECHECK_MS = 15_000L
        val stuckPhases = setOf("booting", "partitioning", "installing", "downloading", "registering", "sealing")

        fun of(phase: String?, updatedAt: Long?, nowMs: Long): ProvisionQuiet {
            if (phase == null || updatedAt == null) return NONE
            val quietMs = nowMs - updatedAt
            if (quietMs < 0) return NONE
            if (phase in stuckPhases && quietMs >= STUCK_AFTER_MS) return STUCK
            if (phase == "installing" && quietMs >= INSTALLER_QUIET_AFTER_MS) return INSTALLER_FINISHED
            return NONE
        }

        fun stuckAdvice(): String = FSStrings.get(R.string.provision_quiet_stuck_advice)
    }
}
