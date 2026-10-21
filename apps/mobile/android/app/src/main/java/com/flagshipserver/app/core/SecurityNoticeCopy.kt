// The security notice's words (docs/security-notices.md section 6.4 and 6.5),
// exactly as the webapp's NOTICE_COPY has them (native: the update button is
// "Update" on the banner and "Update Flagship" on the lock, and opens the
// store listing). Pure, so a unit test can pin every string.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object SecurityNoticeCopy {
    const val BANNER_DISMISS = "Dismiss"
    const val BANNER_UPDATE = "Update"
    val LOCK_KICKER get() = FSStrings.get(R.string.security_update)
    val LOCK_TITLE get() = FSStrings.get(R.string.update_required)
    const val WHY_LABEL = "Why"
    val LOCK_REASSURE get() =
        FSStrings.get(R.string.your_accounts_and_servers_are_unchanged)
    val UPDATE get() = FSStrings.get(R.string.update_flagship)
    val BACKUP get() = FSStrings.get(R.string.back_up_my_account_key)
    val UNLOCK_FIRST get() = FSStrings.get(R.string.unlock_to_back_up_my_account)
    val SIGN_OUT get() = FSStrings.get(R.string.sign_out_2)
    val SIGNED_BY get() = FSStrings.get(R.string.signed_by_the_flagship_maintainers)
    val UPDATE_FAILED get() = FSStrings.get(R.string.couldnt_update_yet_check_your_connection)

    /** The app's own store listing, kept only here and never taken from a notice. */
    const val STORE_URL = "https://play.google.com/store/apps/details?id=com.flagshipserver.app"

    fun advisory(id: String) = FSStrings.get(R.string.advisory, id)

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
