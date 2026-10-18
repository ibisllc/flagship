// The security notice's words (docs/security-notices.md section 6.4 and 6.5),
// exactly as the webapp's NOTICE_COPY has them (native: the update button is
// "Update" on the banner and "Update Flagship" on the lock, and opens the
// store listing). Pure, so a unit test can pin every string.

package com.flagshipserver.app.core

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object SecurityNoticeCopy {
    const val BANNER_DISMISS = "Dismiss"
    const val BANNER_UPDATE = "Update"
    const val LOCK_KICKER = "Security update"
    const val LOCK_TITLE = "Update required"
    const val WHY_LABEL = "Why"
    const val LOCK_REASSURE =
        "Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update."
    const val UPDATE = "Update Flagship"
    const val BACKUP = "Back up my account key"
    const val UNLOCK_FIRST = "Unlock to back up my account key"
    const val SIGN_OUT = "Sign out"
    const val SIGNED_BY = "Signed by the Flagship maintainers"
    const val UPDATE_FAILED = "Couldn't update yet. Check your connection and try again."

    /** The app's own store listing, kept only here and never taken from a notice. */
    const val STORE_URL = "https://play.google.com/store/apps/details?id=com.flagshipserver.app"

    fun advisory(id: String) = "Advisory $id"

    /** A date for a person, in their own locale and zone, never sent anywhere. */
    fun formatDate(ms: Long, locale: Locale = Locale.getDefault(), zone: TimeZone = TimeZone.getDefault()): String {
        val pattern = runCatching { android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEEMMMMdjmm") }
            .getOrNull()?.takeIf { it.isNotEmpty() } ?: "EEEE, MMMM d 'at' h:mm a"
        return SimpleDateFormat(pattern, locale).apply { timeZone = zone }.format(Date(ms))
    }
}

/** The banner's contents for a notice. */
data class BannerModel(val style: String, val text: String, val update: Boolean, val dismiss: String, val action: String?)

/** The lock screen's contents for a notice, top to bottom. */
data class LockModel(
    val kicker: String,
    val title: String,
    val body: String,
    val why: String,
    val reassure: String,
    val update: String,
    val backup: String,
    val signOut: String,
    val meta: String,
)

object SecurityNoticeModels {
    fun banner(b: NoticeOutcome.Banner, formatDate: (Long) -> String = SecurityNoticeCopy::formatDate): BannerModel =
        BannerModel(
            style = b.style,
            text = SecurityNoticeProtocol.text(b.notice, formatDate),
            update = b.style == "update",
            dismiss = SecurityNoticeCopy.BANNER_DISMISS,
            action = if (b.style == "update") SecurityNoticeCopy.BANNER_UPDATE else null,
        )

    fun lock(
        n: SecurityNotice,
        unlocked: Boolean,
        formatDate: (Long) -> String = SecurityNoticeCopy::formatDate,
    ): LockModel = LockModel(
        kicker = SecurityNoticeCopy.LOCK_KICKER,
        title = SecurityNoticeCopy.LOCK_TITLE,
        body = SecurityNoticeProtocol.text(n, formatDate),
        why = if (n.reason.isNotEmpty()) "${SecurityNoticeCopy.WHY_LABEL}: ${n.reason}" else "",
        reassure = SecurityNoticeCopy.LOCK_REASSURE,
        update = SecurityNoticeCopy.UPDATE,
        backup = if (unlocked) SecurityNoticeCopy.BACKUP else SecurityNoticeCopy.UNLOCK_FIRST,
        signOut = SecurityNoticeCopy.SIGN_OUT,
        meta = "${SecurityNoticeCopy.advisory(n.advisoryId)} · ${SecurityNoticeCopy.SIGNED_BY}",
    )
}
