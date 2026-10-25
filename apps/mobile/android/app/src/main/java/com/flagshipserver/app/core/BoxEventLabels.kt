// What the Activity list says for each kind of box event. The same table lives
// in apps/web/public/webapp/lib/activityFeed.js and the iOS BoxEventLabels
// (parity/features.json: activity-feed); unknown kinds are shown humanized.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BoxActivityEntry

object BoxEventLabels {
    private val labels: Map<String, String> = mapOf(
        "server.update.applied" to "Server updated",
        "server.update.rolled-back" to "Update rolled back",
        "server.update.refused" to "Update refused",
        "server.migration.taken-over" to "Took over from the old server",
        "server.decommission.released" to "Stopped serving",
        "server.decommission.awaiting-handoff" to "Waiting to be wiped",
        "server.decommission.wiped" to "Old server wiped",
        "server.decommission.wipe-failed" to "Wipe failed",
        "server.decommission.stood-down" to "Hand-off cancelled",
        "server.decommission.closed" to "Server retired",
        "server.backup.started" to "Backup started",
        "server.backup.created" to "Backup ready",
        "server.backup.downloaded" to "Backup downloaded",
        "server.backup.failed" to "Backup failed",
        "server.restore.started" to "Import started",
        "server.restore.finished" to "Import finished",
        "server.restore.failed" to "Import failed",
        "app.installed" to "App installed",
        "app.updated" to "App redeployed",
        "app.removed" to "App removed",
        "share.granted" to "Shared this server",
        "share.changed" to "Changed a share",
        "share.revoked" to "Ended a share",
        "share.left" to "A person left a share",
        "share.signed-in" to "A shared person signed in",
        "server.update" to "Server updated by a co-manager",
        "server.state.corrupt" to "This server found a damaged settings file and locked it down",
        "server.debug-access.granted" to "Debug access turned on",
        "server.debug-access.renewed" to "Debug access renewed",
        "server.debug-access.expired" to "Debug access ended",
        "server.debug-access.revoked" to "Debug access turned off",
    )

    private val genericWrite = Regex("^(get|post|put|patch|delete) /", RegexOption.IGNORE_CASE)

    private fun humanize(s: String): String {
        val words = s.replace(Regex("[._-]+"), " ").trim()
        return if (words.isEmpty()) "Event" else words.replaceFirstChar { it.uppercase() }
    }

    /** The row's title, or null when the entry isn't worth a row (the log also
     *  records every owner write as a generic `post /api/screens/...` line). */
    fun title(e: BoxActivityEntry): String? {
        if (e.kind == null && genericWrite.containsMatchIn(e.action)) return null
        val key = e.kind ?: e.action
        val by = if (e.actor?.kind == "share" && !e.actor.label.isNullOrEmpty()) " by ${e.actor.label}" else ""
        return (labels[key] ?: humanize(key)) + by
    }
}
