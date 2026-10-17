// The server page's Backups section and the create wizard's backup policy
// (docs/server-backup-and-clone.md, "Backup policy" and "Scheduled backups"):
// the wording (the same on iOS and the webapp) and the schedule's local-time
// conversion. The server keeps the schedule in UTC; the apps show and set it in
// the phone's own time zone.

package com.flagshipserver.app.core

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

object BackupsText {
    const val GB: Long = 1024L * 1024 * 1024

    const val PHONE_TITLE = "Phone-side backups"
    const val PHONE_BODY =
        "Your server makes an encrypted backup every night and this phone keeps a copy, over Wi-Fi while charging. Your server's apps can hold up to the space you reserve here."
    const val PEER_TITLE = "Peer-distributed backups"
    const val PEER_BODY =
        "Encrypted pieces of your backup are kept on other Flagship servers, and yours keeps theirs. Your apps can use up to a third of this server's disk; the rest holds other servers' pieces."
    const val NONE_TITLE = "No backups"
    const val NONE_BODY =
        "Nothing is backed up. If this server's disk fails, its apps and data are gone. You can still use Back up now on the server page."

    const val NO_BACKUPS = "No backups yet."
    const val SCHEDULE_OFF = "Scheduled backups are off."
    const val APPROVE = "Approve backups for this server"
    const val KEEP_COPY = "Keep a copy on this phone"
    const val KEEP_COPY_NOTE = "Only on Wi-Fi while charging."
    const val DELETE_CONFIRM = "Delete this backup from the server?"
    const val LIST_NOTE =
        "Each backup is one .flagship file. Import a backup on Home restores it. It opens on your own devices without a passcode."
    const val NOT_CHOSEN = "Not chosen yet"
    /** Back up now's passcode step (owner, 2026-10-16). */
    const val PASSCODE_WHY =
        "You'll need this passcode to import the backup into an account that isn't yours. Your own account opens it without the passcode."

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
        val base = "Backup policy: ${policyTitle(p.policy)}"
        return if (p.policy == "phone" && p.phoneReserveBytes > 0) "$base · up to ${gb(p.phoneReserveBytes)}" else base
    }

    /** "Apps use 3.2 GB of 32 GB"; null until the box has measured. */
    fun usageLine(policy: String, cap: BackupCap): String? {
        val used = cap.usedBytes ?: return null
        val limit = cap.limitBytes
        return when {
            limit == null -> "Apps use ${gb(used)}"
            policy == "peer" -> "Apps use ${gb(used)} of ${gb(limit)} (a third of this server's disk)"
            else -> "Apps use ${gb(used)} of ${gb(limit)}"
        }
    }

    fun peerStateLabel(state: String): String = when (state) {
        "waiting-for-peers" -> "Waiting for other servers"
        "filling" -> "Making room"
        "placing" -> "Placing pieces"
        "protected" -> "Protected"
        "at-risk" -> "At risk"
        "leaving" -> "Leaving"
        else -> "Off"
    }

    fun peerLines(p: PeerBackupStatus): List<String> = buildList {
        add(peerStateLabel(p.state) + (p.reason?.let { ": ${sentence(it)}." } ?: ""))
        if (p.totalBricks > 0) add("${p.healthyBricks} of ${p.totalBricks} pieces safe")
        if (p.holders > 0) add("Held by ${p.holders} other server${if (p.holders == 1) "" else "s"}")
        p.lastPlacedAt?.let { add("Last placed: ${whenText(it)}") }
        add("Holds ${ServerArchive.formatBytes(p.hostingBytes)} for other servers")
    }

    /** A phone's default reserve: a quarter of its free space, whole GB, at least 2 GB. */
    fun defaultReserveGb(freeBytes: Long): Int = maxOf(2L, freeBytes / 4 / GB).toInt()

    // ── Saved backups ──────────────────────────────────────────────

    fun size(b: SavedBackup): String = ServerArchive.formatBytes(b.totalBytes)

    /** The status line: running, the newest backup, or none. */
    fun statusLine(v: SavedBackupsView): String {
        v.running?.let { r ->
            val p = r.progress
            return if (p.total > 0) "Backing up… ${p.app} (${p.done}/${p.total})" else "Backing up…"
        }
        val newest = v.backups.firstOrNull() ?: return NO_BACKUPS
        return "Last backup: ${whenText(newest.createdAt)} · ${size(newest)}"
    }

    fun failedLine(v: SavedBackupsView): String? {
        val r = v.lastRun ?: return null
        if (r.ok || v.running != null) return null
        return "The last backup failed: ${sentence(r.reason ?: "the backup couldn't be made")}."
    }

    /** "Next backup: …", or off; null when the keys are out (the waiting reason or the approve button). */
    fun nextLine(v: SavedBackupsView): String? = when {
        v.schedule.frequency == "off" -> SCHEDULE_OFF
        v.nextRunAt != null -> "Next backup: ${whenText(v.nextRunAt)}"
        else -> null
    }

    fun rowLine(b: SavedBackup): String {
        val kind = if (b.trigger == "now") "Back up now" else "Scheduled"
        val apps = "${b.apps.size} app${if (b.apps.size == 1) "" else "s"}"
        return "${whenText(b.createdAt)} · ${size(b)} · $kind · $apps"
    }

    fun leftLine(b: SavedBackup): String? =
        if (b.left.isEmpty()) null else "Left out: ${b.left.joinToString(", ") { it.name }}"

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
        val whenPart = if (s.frequency == "weekly") "Weekly on ${weekdayName(l.weekday, locale)} at ${timeText(l.minuteOfDay, locale)}"
        else "Daily at ${timeText(l.minuteOfDay, locale)}"
        return "$whenPart · keeps ${s.keepDaily} daily and ${s.keepWeekly} weekly"
    }
}
