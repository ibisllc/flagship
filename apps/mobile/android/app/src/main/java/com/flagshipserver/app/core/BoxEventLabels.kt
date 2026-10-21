// What the Activity list says for each kind of box event. The same table lives
// in apps/web/public/webapp/lib/activityFeed.js and the iOS BoxEventLabels
// (parity/features.json: activity-feed); unknown kinds are shown humanized.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.BoxActivityEntry

object BoxEventLabels {
    private val labels: Map<String, String> get() = mapOf(
        "server.update.applied" to FSStrings.get(R.string.server_updated),
        "server.update.rolled-back" to FSStrings.get(R.string.update_rolled_back),
        "server.update.refused" to FSStrings.get(R.string.update_refused),
        "server.migration.taken-over" to FSStrings.get(R.string.took_over_from_the_old_server),
        "server.decommission.released" to FSStrings.get(R.string.stopped_serving),
        "server.decommission.awaiting-handoff" to FSStrings.get(R.string.waiting_to_be_wiped),
        "server.decommission.wiped" to FSStrings.get(R.string.old_server_wiped),
        "server.decommission.wipe-failed" to FSStrings.get(R.string.wipe_failed),
        "server.decommission.stood-down" to FSStrings.get(R.string.hand_off_cancelled),
        "server.decommission.closed" to FSStrings.get(R.string.server_retired),
        "server.backup.started" to FSStrings.get(R.string.backup_started),
        "server.backup.created" to FSStrings.get(R.string.backup_ready),
        "server.backup.downloaded" to FSStrings.get(R.string.backup_downloaded),
        "server.backup.failed" to FSStrings.get(R.string.backup_failed),
        "server.restore.started" to FSStrings.get(R.string.import_started),
        "server.restore.finished" to FSStrings.get(R.string.import_finished),
        "server.restore.failed" to FSStrings.get(R.string.import_failed),
        "app.installed" to FSStrings.get(R.string.app_installed),
        "app.updated" to FSStrings.get(R.string.app_redeployed),
        "app.removed" to FSStrings.get(R.string.app_removed),
        "share.granted" to FSStrings.get(R.string.shared_this_server),
        "share.changed" to FSStrings.get(R.string.changed_a_share),
        "share.revoked" to FSStrings.get(R.string.ended_a_share),
        "share.left" to FSStrings.get(R.string.a_person_left_a_share),
        "share.signed-in" to FSStrings.get(R.string.a_shared_person_signed_in),
        "server.update" to FSStrings.get(R.string.server_updated_by_a_co_manager),
        "server.state.corrupt" to FSStrings.get(R.string.this_server_found_a_damaged_settings),
        "server.debug-access.granted" to FSStrings.get(R.string.debug_access_turned_on),
        "server.debug-access.renewed" to FSStrings.get(R.string.debug_access_renewed),
        "server.debug-access.expired" to FSStrings.get(R.string.debug_access_ended),
        "server.debug-access.revoked" to FSStrings.get(R.string.debug_access_turned_off),
        "app.access.edit" to FSStrings.get(R.string.changed_an_apps_internet_access),
        "app.access.dismiss" to FSStrings.get(R.string.dismissed_an_apps_access_request),
        "app.invite.create" to FSStrings.get(R.string.invited_someone_to_an_app),
        "app.invite.withdraw" to FSStrings.get(R.string.withdrew_an_invite),
        "app.update.accept" to FSStrings.get(R.string.accepted_an_app_update),
        "app.storage.full" to FSStrings.get(R.string.an_app_ran_out_of_space),
        "app.storage.room" to FSStrings.get(R.string.an_app_has_room_again),
        "server.backup.download-approved" to FSStrings.get(R.string.approved_a_backup_download),
        "server.backup.policy" to FSStrings.get(R.string.changed_the_backup_policy),
        "server.backup.schedule" to FSStrings.get(R.string.changed_the_backup_schedule),
        "server.backup.removed" to FSStrings.get(R.string.removed_a_backup),
        "server.backup.over-limit" to FSStrings.get(R.string.backups_are_over_their_limit),
        "server.backup.under-limit" to FSStrings.get(R.string.backups_are_back_under_their_limit),
        "server.disk.full" to FSStrings.get(R.string.the_disk_is_nearly_full),
        "server.disk.room" to FSStrings.get(R.string.the_disk_has_room_again),
        "server.migration.paused" to FSStrings.get(R.string.paused_apps_for_the_move),
        "server.migration.resumed" to FSStrings.get(R.string.apps_running_again_after_the_move),
        "server.restore.pulled" to FSStrings.get(R.string.fetched_the_backup_data),
        "server.restore.waiting" to FSStrings.get(R.string.waiting_for_its_backup),
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
