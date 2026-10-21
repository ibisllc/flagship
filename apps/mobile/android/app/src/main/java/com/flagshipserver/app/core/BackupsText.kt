// The server page's Backups section and the create wizard's backup policy
// (docs/server-backup-and-clone.md, "Backup policy" and "Scheduled backups"):
// the wording (the same on iOS and the webapp) and the schedule's local-time
// conversion. The server keeps the schedule in UTC; the apps show and set it in
// the phone's own time zone.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.BackupCap
import com.flagshipserver.app.api.BackupPolicyState
import com.flagshipserver.app.api.BackupSchedule
import com.flagshipserver.app.api.PeerBackupStatus
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.api.SavedBackupsView
import java.text.DateFormat
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.TextStyle
import java.time.temporal.TemporalAdjusters
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Backup choices that are built but not offered yet. Peer backup stays off until a live
 * cross-account restore has passed; a server already on it keeps showing it. The box refuses the
 * choice too (FLAGSHIP_PEER_BACKUP).
 */
object BackupFeatures {
    const val PEER_BACKUP = false
}

object BackupsText {
    const val GB: Long = 1024L * 1024 * 1024

    val PHONE_TITLE get() = FSStrings.get(R.string.phone_side_backups)
    val PHONE_BODY get() =
        FSStrings.get(R.string.your_server_makes_an_encrypted_backup)
    val PEER_TITLE get() = FSStrings.get(R.string.peer_distributed_backups)
    val PEER_BODY get() =
        FSStrings.get(R.string.encrypted_pieces_of_your_backup_are)
    val NONE_TITLE get() = FSStrings.get(R.string.no_backups)
    val NONE_BODY get() =
        FSStrings.get(R.string.nothing_is_backed_up_if_this)

    // Create-server's backup step: short, plain, nothing preselected.
    val CREATE_NONE_TITLE get() = FSStrings.get(R.string.no_backup)
    val CREATE_NONE_BODY get() = FSStrings.get(R.string.nothing_is_saved_off_this_server)
    val CREATE_PHONE_TITLE get() = FSStrings.get(R.string.on_my_phone)
    val CREATE_PHONE_BODY get() = FSStrings.get(R.string.your_phone_keeps_an_encrypted_copy)
    val CREATE_PEER_TITLE get() = FSStrings.get(R.string.on_other_servers)
    val CREATE_PEER_BODY get() = FSStrings.get(R.string.encrypted_pieces_of_your_backup_are_2)
    val CREATE_CHANGE_NOTE get() = FSStrings.get(R.string.you_can_change_this_any_time)

    val NO_BACKUPS get() = FSStrings.get(R.string.no_backups_yet)
    val SCHEDULE_OFF get() = FSStrings.get(R.string.scheduled_backups_are_off)
    val APPROVE get() = FSStrings.get(R.string.approve_backups_for_this_server)
    val KEEP_COPY get() = FSStrings.get(R.string.keep_a_copy_on_this_phone)
    val KEEP_COPY_NOTE get() = FSStrings.get(R.string.only_on_wi_fi_while_charging)
    val DELETE_CONFIRM get() = FSStrings.get(R.string.delete_this_backup_from_the_server)
    val LIST_NOTE get() =
        FSStrings.get(R.string.each_backup_is_one_flagship_file)
    val NOT_CHOSEN get() = FSStrings.get(R.string.not_chosen_yet)
    /** Back up now's passcode step (owner, 2026-10-16). */
    val PASSCODE_WHY get() =
        FSStrings.get(R.string.youll_need_this_passcode_to_import)

    /** The box's own `formatGb`: one decimal under 10 GB, none above. */
    fun gb(n: Long): String {
        val v = n.toDouble() / GB
        return if (n < 10 * GB) "%.1f GB".format(Locale.US, v) else "%.0f GB".format(Locale.US, v)
    }

    fun whenText(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

    private fun sentence(s: String) = s.trim().trimEnd('.')

    // ── Policy ─────────────────────────────────────────────────────

    fun policyTitle(policy: String): String = when (policy) {
        "phone" -> PHONE_TITLE
        "peer" -> PEER_TITLE
        "none" -> NONE_TITLE
        else -> NOT_CHOSEN
    }

    /** "Backup policy: Phone-side backups · up to 32 GB". */
    fun policyLine(p: BackupPolicyState): String {
        val base = FSStrings.get(R.string.backup_policy, policyTitle(p.policy))
        return if (p.policy == "phone" && p.phoneReserveBytes > 0) FSStrings.get(R.string.up_to, base, gb(p.phoneReserveBytes)) else base
    }

    /** "Apps use 3.2 GB of 32 GB"; null until the box has measured. */
    fun usageLine(policy: String, cap: BackupCap): String? {
        val used = cap.usedBytes ?: return null
        val limit = cap.limitBytes
        return when {
            limit == null -> FSStrings.get(R.string.apps_use, gb(used))
            policy == "peer" -> FSStrings.get(R.string.apps_use_of_a_third_of, gb(used), gb(limit))
            else -> FSStrings.get(R.string.apps_use_of, gb(used), gb(limit))
        }
    }

    fun peerStateLabel(state: String): String = when (state) {
        "waiting-for-peers" -> FSStrings.get(R.string.waiting_for_other_servers)
        "filling" -> FSStrings.get(R.string.making_room)
        "placing" -> FSStrings.get(R.string.placing_pieces)
        "protected" -> "Protected"
        "at-risk" -> FSStrings.get(R.string.at_risk)
        "leaving" -> "Leaving"
        else -> "Off"
    }

    fun peerLines(p: PeerBackupStatus): List<String> = buildList {
        add(peerStateLabel(p.state) + (p.reason?.let { ": ${sentence(it)}." } ?: ""))
        if (p.totalBricks > 0) add(FSStrings.get(R.string.of_pieces_safe, p.healthyBricks, p.totalBricks))
        if (p.holders > 0) add(FSStrings.plural(R.plurals.held_by_other_servers, p.holders, p.holders))
        p.lastPlacedAt?.let { add(FSStrings.get(R.string.last_placed, whenText(it))) }
        add(FSStrings.get(R.string.holds_for_other_servers, ServerArchive.formatBytes(p.hostingBytes)))
    }

    /** A phone's default reserve: a quarter of its free space, whole GB, at least 2 GB. */
    fun defaultReserveGb(freeBytes: Long): Int = maxOf(2L, freeBytes / 4 / GB).toInt()

    // ── Saved backups ──────────────────────────────────────────────

    fun size(b: SavedBackup): String = ServerArchive.formatBytes(b.totalBytes)

    /** The status line: running, the newest backup, or none. */
    fun statusLine(v: SavedBackupsView): String {
        v.running?.let { r ->
            val p = r.progress
            return if (p.total > 0) FSStrings.get(R.string.backing_up, p.app, p.done, p.total) else FSStrings.get(R.string.backing_up_2)
        }
        val newest = v.backups.firstOrNull() ?: return NO_BACKUPS
        return FSStrings.get(R.string.last_backup, whenText(newest.createdAt), size(newest))
    }

    fun failedLine(v: SavedBackupsView): String? {
        val r = v.lastRun ?: return null
        if (r.ok || v.running != null) return null
        return FSStrings.get(R.string.the_last_backup_failed, sentence(r.reason ?: "the backup couldn't be made"))
    }

    /** "Next backup: …", or off; null when the keys are out (the waiting reason or the approve button). */
    fun nextLine(v: SavedBackupsView): String? = when {
        v.schedule.frequency == "off" -> SCHEDULE_OFF
        v.nextRunAt != null -> FSStrings.get(R.string.next_backup, whenText(v.nextRunAt))
        else -> null
    }

    fun rowLine(b: SavedBackup): String {
        val kind = if (b.trigger == "now") FSStrings.get(R.string.back_up_now) else "Scheduled"
        val apps = FSStrings.plural(R.plurals.apps_count, b.apps.size, b.apps.size)
        return "${whenText(b.createdAt)} · ${size(b)} · $kind · $apps"
    }

    fun leftLine(b: SavedBackup): String? =
        if (b.left.isEmpty()) null else FSStrings.get(R.string.left_out, b.left.joinToString(", ") { it.name })

    /** Admin + the box asks for keys: the only time a device deposits. */
    fun shouldDeposit(isAdmin: Boolean, v: SavedBackupsView?): Boolean = isAdmin && v != null && v.keysWanted > 0

    // ── Schedule in local time ─────────────────────────────────────

    /** A schedule's time as the phone shows it: the local weekday (0 = Sunday) and minute of the day. */
    data class LocalSlot(val weekday: Int, val minuteOfDay: Int)

    private fun sunday0(d: DayOfWeek): Int = d.value % 7
    private fun dayOf(w: Int): DayOfWeek = DayOfWeek.of(if (w == 0) 7 else w)

    /** The box's UTC slot in [zone], at the next time it happens after [now]. */
    fun toLocal(s: BackupSchedule, zone: ZoneId = ZoneId.systemDefault(), now: Instant = Instant.now()): LocalSlot {
        val nowUtc = now.atZone(ZoneOffset.UTC)
        var t = nowUtc.toLocalDate().atTime(LocalTime.ofSecondOfDay(s.minuteOfDayUtc * 60L)).atZone(ZoneOffset.UTC)
        if (s.frequency == "weekly") t = t.with(TemporalAdjusters.nextOrSame(dayOf(s.weekdayUtc)))
        val local = t.withZoneSameInstant(zone)
        return LocalSlot(sunday0(local.dayOfWeek), local.hour * 60 + local.minute)
    }

    /** The box's schedule for a local weekday and time: the local wall time on
     *  that weekday (its next date after [now]) in UTC. */
    fun toUtc(
        frequency: String,
        local: LocalSlot,
        keepDaily: Int,
        keepWeekly: Int,
        zone: ZoneId = ZoneId.systemDefault(),
        now: Instant = Instant.now(),
    ): BackupSchedule {
        val today = now.atZone(zone).toLocalDate()
        val date: LocalDate = if (frequency == "weekly") today.with(TemporalAdjusters.nextOrSame(dayOf(local.weekday))) else today
        val wall = ZonedDateTime.of(date, LocalTime.of(local.minuteOfDay / 60, local.minuteOfDay % 60), zone)
        val utc = wall.withZoneSameInstant(ZoneOffset.UTC)
        return BackupSchedule(
            frequency = frequency,
            minuteOfDayUtc = utc.hour * 60 + utc.minute,
            weekdayUtc = if (frequency == "weekly") sunday0(utc.dayOfWeek) else 0,
            keepDaily = keepDaily,
            keepWeekly = keepWeekly,
        )
    }

    fun timeText(minuteOfDay: Int, locale: Locale = Locale.getDefault()): String {
        val f = DateFormat.getTimeInstance(DateFormat.SHORT, locale).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return f.format(Date(minuteOfDay * 60_000L))
    }

    fun weekdayName(w: Int, locale: Locale = Locale.getDefault()): String = dayOf(w).getDisplayName(TextStyle.FULL, locale)

    /** "Daily at 3:00 AM · keeps 7 daily and 4 weekly" (in local time). */
    fun scheduleLine(s: BackupSchedule, zone: ZoneId = ZoneId.systemDefault(), now: Instant = Instant.now(), locale: Locale = Locale.getDefault()): String {
        if (s.frequency == "off") return SCHEDULE_OFF
        val l = toLocal(s, zone, now)
        val whenPart = if (s.frequency == "weekly") FSStrings.get(R.string.weekly_on_at, weekdayName(l.weekday, locale), timeText(l.minuteOfDay, locale))
        else FSStrings.get(R.string.daily_at, timeText(l.minuteOfDay, locale))
        return FSStrings.get(R.string.keeps_daily_and_weekly, whenPart, s.keepDaily, s.keepWeekly)
    }
}
