package com.flagshipserver.app.core

import com.flagshipserver.app.R
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
                    lines = listOf(FSStrings.get(R.string.no_health_report_for_min_the, staleMin)),
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
                issues += FSStrings.get(R.string.ran_out_of_memory_since_it, oomKills, memAvail, memTotal)
            }
            if (state != "active") {
                issues += FSStrings.get(R.string.the_server_software_isnt_running_restarted, state, restarts, lastExit)
            } else if (restarts >= 3) {
                issues += FSStrings.get(R.string.the_server_software_restarted_since_it, restarts, lastExit)
            }
            if (h.tunnel == false) issues += FSStrings.get(R.string.cant_reach_the_flagship_relay)
            if (disk >= 90) issues += FSStrings.get(R.string.disk_is_full, disk)

            if (issues.isNotEmpty()) return ServerHealthVerdict(ok = false, lines = issues)
            return ServerHealthVerdict(
                ok = true,
                lines = listOf(
                    FSStrings.get(R.string.healthy_mb_free_of_mb_disk, memAvail, memTotal, disk, uptime(h.uptimeS ?: 0)),
                ),
            )
        }

        fun uptime(seconds: Long): String {
            val d = seconds / 86_400
            val h = (seconds % 86_400) / 3_600
            val m = (seconds % 3_600) / 60
            return when {
                d >= 1 -> FSStrings.get(R.string.d_h, d, h)
                h >= 1 -> FSStrings.get(R.string.h_m, h, m)
                else -> "${m}m"
            }
        }
    }
}
