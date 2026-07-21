// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): when a server
// is created WITHOUT embedding the SWK in the recipe (the default), the phone
// must deposit the SWK to `.com` AFTER the box registers (so the box claims it
// and turns on its service platform). This store remembers, per server FQDN,
// that a deposit is OWED — and, once done, that it's been DEPOSITED (so a later
// reconcile never double-deposits).
//
// Keyed by the canonical FQDN, mirroring ServerSettingsStore / the iOS
// PendingSwkDepositStore. Three states per server:
//   absent      -> nothing owed (embed-secrets WAS on, or never created here).
//   "pending"   -> owed: the box hasn't come online yet OR the deposit failed.
//   "deposited" -> done: the SWK was accepted by `.com` (idempotency marker).

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class PendingSwkDepositStore(private val prefs: SharedPreferences) {

    /** Record that a deposit is OWED for this server (embed-secrets was OFF). */
    fun markPending(serverDomain: String) {
        prefs.edit().putString(key(serverDomain), "pending").apply()
    }

    /** Record that the SWK was accepted by `.com` — the idempotency marker. */
    fun markDeposited(serverDomain: String) {
        prefs.edit().putString(key(serverDomain), "deposited").apply()
    }

    /** Clear any record (e.g. the server was cancelled before it came online). */
    fun clear(serverDomain: String) {
        prefs.edit().remove(key(serverDomain)).apply()
    }

    /** True iff a deposit is still owed (recorded pending, not yet deposited). */
    fun isPending(serverDomain: String): Boolean =
        prefs.getString(key(serverDomain), null) == "pending"

    /** True iff the SWK was already deposited for this server. */
    fun isDeposited(serverDomain: String): Boolean =
        prefs.getString(key(serverDomain), null) == "deposited"

    private fun key(serverDomain: String) = PREFIX + serverDomain.lowercase()

    companion object {
        private const val PREFS = "flagship.swkDeposit"
        private const val PREFIX = "swk."

        fun from(context: Context): PendingSwkDepositStore =
            PendingSwkDepositStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
