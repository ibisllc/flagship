package com.flagshipserver.app.core

import com.flagshipserver.app.api.BoxHealthWire

/** The server page's health summary, from the box's latest health report.
 *  Copy is shared word for word with iOS and the webapp. */
data class ServerHealthVerdict(val ok: Boolean, val lines: List<String>) {
    companion object {
        const val STALE_AFTER_MIN = 5L

        /** null when there is no usable report (absent, or no `receivedAt`). */
        fun evaluate(h: BoxHealthWire?, now: Long): ServerHealthVerdict? {
            val receivedAt = h?.receivedAt ?: return null
            val staleMin = Math.floorDiv(now - receivedAt, 60_000L)
            if (staleMin >= STALE_AFTER_MIN) {
                // The rest of the report is as old as this, so it isn't shown.
                return ServerHealthVerdict(
                    ok = false,
                    lines = listOf("No health report for $staleMin min. The server itself may be off or frozen."),
                )
            }
            val memAvail = h.memAvailMB ?: 0
            val memTotal = h.memTotalMB ?: 0
            val disk = h.diskUsedPct ?: 0
            val state = h.daemon?.state ?: "active"
            val restarts = h.daemon?.restarts ?: 0
            val lastExit = h.daemon?.lastExit ?: 0
            val oomKills = h.oomKills ?: 0

            val issues = mutableListOf<String>()
            if (oomKills > 0) {
                issues += "Ran out of memory $oomKills× since it started ($memAvail MB free of $memTotal MB now)."
            }
            if (state != "active") {
                issues += "The server software isn't running ($state; restarted $restarts×, last exit code $lastExit)."
            } else if (restarts >= 3) {
                issues += "The server software restarted $restarts× since it started (last exit code $lastExit)."
            }
            if (h.tunnel == false) issues += "Can't reach the Flagship relay."
            if (disk >= 90) issues += "Disk is $disk% full."

            if (issues.isNotEmpty()) return ServerHealthVerdict(ok = false, lines = issues)
            return ServerHealthVerdict(
                ok = true,
                lines = listOf(
                    "Healthy · $memAvail MB free of $memTotal MB · disk $disk% · up ${uptime(h.uptimeS ?: 0)}",
                ),
            )
        }

        fun uptime(seconds: Long): String {
            val d = seconds / 86_400
            val h = (seconds % 86_400) / 3_600
            val m = (seconds % 3_600) / 60
            return when {
                d >= 1 -> "${d}d ${h}h"
                h >= 1 -> "${h}h ${m}m"
                else -> "${m}m"
            }
        }
    }
}
