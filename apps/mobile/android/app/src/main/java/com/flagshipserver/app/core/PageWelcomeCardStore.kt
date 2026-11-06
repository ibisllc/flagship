// Home's pointer to the account's voi.ci page (docs/voici-and-messages.md §11): the page is managed at the top of
// the Messages tab; Home shows a welcome card until the page was first public or dismissed, then a compact row. The card
// shows until the account has a page (published, or a change waiting to be) or the person dismisses it; the dismissal is kept per
// account on this device. Mirrors iOS FlagshipCore/PageWelcomeCard.swift and the webapp's `shouldShowPageWelcome`.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PAGE_WELCOME_PREFS = "flagship.pageWelcome"

/** What Home shows for the page. */
sealed interface PagePointer {
    data object Hidden : PagePointer
    data object Welcome : PagePointer
    data class Row(val isPublic: Boolean) : PagePointer
}

class PageWelcomeCardStore(private val prefs: SharedPreferences) {

    private val _dismissed = MutableStateFlow(
        prefs.all.keys.filter { it.startsWith(KEY_PREFIX) && prefs.getBoolean(it, false) }.map { it.removePrefix(KEY_PREFIX) }.toSet(),
    )

    /** The accounts (lowercased usernames) that dismissed the card on this device. */
    val dismissed: StateFlow<Set<String>> = _dismissed.asStateFlow()

    fun isDismissed(username: String?): Boolean {
        val u = username?.lowercase()?.takeIf { it.isNotEmpty() } ?: return true
        return u in _dismissed.value
    }

    fun dismiss(username: String?) {
        val u = username?.lowercase()?.takeIf { it.isNotEmpty() } ?: return
        prefs.edit().putBoolean(KEY_PREFIX + u, true).apply()
        _dismissed.value = _dismissed.value + u
    }

    companion object {
        const val KEY_PREFIX = "dismissed.v1."

        fun fromContext(ctx: Context): PageWelcomeCardStore =
            PageWelcomeCardStore(ctx.getSharedPreferences(PAGE_WELCOME_PREFS, Context.MODE_PRIVATE))

        /**
         * @param hasAccount the account can have a page (a real account, not a sample one).
         * @param checked `.com` answered for the page at least once, so "no page" is known, not a failed read.
         * @param published `.com` holds a published page for the account.
         * @param pendingChanges edits made on any device and not yet published (the person already found the editor).
         */
        fun shouldShow(hasAccount: Boolean, checked: Boolean, published: Boolean, pendingChanges: Int, dismissed: Boolean): Boolean =
            hasAccount && checked && !published && pendingChanges == 0 && !dismissed

        /**
         * Home points to the page at the top of the Messages tab: the welcome card until the page was first public
         * ([everPublished]: this device kept a published index, also after a removal), changes were started, or the card
         * was dismissed; then the compact row, which stays. Same rule as iOS PageWelcomeCardStore.pointer.
         */
        fun pointer(hasAccount: Boolean, checked: Boolean, published: Boolean, everPublished: Boolean, pendingChanges: Int, dismissed: Boolean): PagePointer = when {
            !hasAccount || !checked -> PagePointer.Hidden
            shouldShow(hasAccount, checked, published || everPublished, pendingChanges, dismissed) -> PagePointer.Welcome
            else -> PagePointer.Row(isPublic = published)
        }
    }
}
