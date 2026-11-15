// What the restore-into-server screens say (docs/restore-into-server.md §7): one comparison line per
// app, each action's name and consequence, the box's refusal codes and the notes on a choice.
// MIRRORS the iOS RestoreMergeViewModel's static text.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.RestoreMergeApp

object RestoreMergeText {
    val ACTION_ORDER = listOf("install", "keep", "replace", "replace-data", "copy", "skip")

    fun comparison(a: RestoreMergeApp): String {
        val box = a.box ?: return if (a.verdict == "runs-elsewhere") FSStrings.get(R.string.rm_cmp_runs_elsewhere, a.alsoOn.joinToString(", "))
        else FSStrings.get(R.string.rm_cmp_not_here)
        val b = a.backup.version
        val x = box.version
        return when (a.code) {
            "same" -> FSStrings.get(R.string.rm_cmp_same, x)
            "backup-older" -> FSStrings.get(if (a.codeByVersion) R.string.rm_cmp_older_probably else R.string.rm_cmp_older, b, x)
            "backup-newer" -> FSStrings.get(if (a.codeByVersion) R.string.rm_cmp_newer_probably else R.string.rm_cmp_newer, b, x)
            "diverged" -> FSStrings.get(R.string.rm_cmp_diverged, b, x)
            else -> FSStrings.get(R.string.rm_cmp_unknown, b, x)
        }
    }

    fun actionName(action: String): String = when (action) {
        "install" -> FSStrings.get(R.string.rm_act_install)
        "skip" -> FSStrings.get(R.string.rm_act_skip)
        "keep" -> FSStrings.get(R.string.rm_act_keep)
        "replace" -> FSStrings.get(R.string.rm_act_replace)
        "replace-data" -> FSStrings.get(R.string.rm_act_replace_data)
        "copy" -> FSStrings.get(R.string.rm_act_copy)
        else -> action
    }

    fun consequence(action: String, a: RestoreMergeApp): String = when (action) {
        "install" -> FSStrings.get(if (a.verdict == "runs-elsewhere") R.string.rm_csq_install_elsewhere else R.string.rm_csq_install)
        "skip" -> FSStrings.get(R.string.rm_csq_skip)
        "keep" -> FSStrings.get(R.string.rm_csq_keep)
        "replace" -> FSStrings.get(R.string.rm_csq_replace)
        "replace-data" -> FSStrings.get(R.string.rm_csq_replace_data)
        "copy" -> FSStrings.get(R.string.rm_csq_copy)
        else -> ""
    }

    fun refusal(code: String?): String = when (code) {
        "not-on-server" -> FSStrings.get(R.string.rm_ref_not_on_server)
        "already-on-server" -> FSStrings.get(R.string.rm_ref_already)
        "different-app" -> FSStrings.get(R.string.rm_ref_different)
        "schema-newer" -> FSStrings.get(R.string.rm_ref_schema_newer)
        "schema-diverged" -> FSStrings.get(R.string.rm_ref_schema_diverged)
        "stores-differ" -> FSStrings.get(R.string.rm_ref_stores_differ)
        "no-copy-name" -> FSStrings.get(R.string.rm_ref_no_copy_name)
        "busy" -> FSStrings.get(R.string.rm_ref_busy)
        else -> FSStrings.get(R.string.rm_ref_other)
    }

    fun notes(a: RestoreMergeApp, action: String): List<String> = buildList {
        if (a.alsoOn.isNotEmpty() && a.box != null) add(FSStrings.get(R.string.rm_note_also_on, a.alsoOn.joinToString(", ")))
        if (a.addressMoves && action == "install") add(FSStrings.get(R.string.rm_note_address))
        if (action in setOf("replace", "replace-data", "install") && a.backup.hasDatabase == true) add(FSStrings.get(R.string.rm_note_jobs))
        if (action in setOf("replace", "replace-data") && a.backup.hasFiles == true) add(FSStrings.get(R.string.rm_note_files))
    }

    fun step(step: String): String = when (step) {
        "done" -> FSStrings.get(R.string.rm_step_done)
        "kept" -> FSStrings.get(R.string.rm_step_kept)
        "skipped" -> FSStrings.get(R.string.rm_step_skipped)
        "failed" -> FSStrings.get(R.string.rm_step_failed)
        "refused-changed" -> FSStrings.get(R.string.rm_step_refused)
        "waiting" -> FSStrings.get(R.string.rm_step_waiting)
        else -> FSStrings.get(R.string.rm_restoring)
    }
}
