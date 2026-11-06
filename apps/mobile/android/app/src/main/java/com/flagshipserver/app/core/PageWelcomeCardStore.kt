// Home's welcome card that introduces the account's voi.ci page (docs/voici-and-messages.md §11). It shows until
// the account has a page (published, or a change waiting to be) or the person dismisses it; the dismissal is kept per
// account on this device. Mirrors iOS FlagshipCore/PageWelcomeCard.swift and the webapp's `shouldShowPageWelcome`.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PAGE_WELCOME_PREFS = "flagship.pageWelcome"

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
    }
}
