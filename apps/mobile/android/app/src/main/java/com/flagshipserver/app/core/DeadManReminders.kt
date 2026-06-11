// Dead-man affirmation reminders. When the lock is armed the phone must be
// nudged to MANUALLY affirm (a biometric tap — never silent) before the
// lease lapses. We schedule reminders at T-6h / T-1h / T-15m relative to
// the lease expiry. See docs/lock-and-poweroff.md.
//
// The OFFSET MATH lives here as a pure function (DeadManReminders.due) so it
// is unit-testable with no Android Context; the AlarmManager wiring is a thin
// shell in the Android scheduler.

package com.flagshipserver.app.core

/** A single scheduled affirmation reminder. */
data class DeadManReminder(
    /** Epoch-ms the reminder should fire. */
    val fireAt: Long,
    /** Human label for the lead time, e.g. "6 hours left". */
    val label: String,
)

object DeadManReminders {
    /** Lead times before lease expiry, in ms. Matches the spec's
     *  T-6h / T-1h / T-15m and the iOS reminder offsets. */
    val LEAD_TIMES_MS: List<Pair<Long, String>> = listOf(
        6L * 3600_000 to "6 hours left",
        1L * 3600_000 to "1 hour left",
        15L * 60_000 to "15 minutes left",
    )

    /**
     * Reminders that are still in the future given [leaseExpiry] and [now].
     * A lead time whose fire-instant has already passed is dropped (e.g. a
     * 5-minute window has no 6h/1h reminder). Result is ascending by fireAt.
     */
    fun due(leaseExpiry: Long, now: Long): List<DeadManReminder> =
        LEAD_TIMES_MS
            .map { (lead, label) -> DeadManReminder(leaseExpiry - lead, label) }
            .filter { it.fireAt > now }
            .sortedBy { it.fireAt }

    /** Whole-minutes time-remaining string for the UI, e.g. "23h 41m left"
     *  / "14m left" / "expired". */
    fun remainingLabel(leaseExpiry: Long, now: Long): String {
        val ms = leaseExpiry - now
        if (ms <= 0) return "expired"
        val totalMin = ms / 60_000
        val h = totalMin / 60
        val m = totalMin % 60
        return if (h > 0) "${h}h ${m}m left" else "${m}m left"
    }
}
