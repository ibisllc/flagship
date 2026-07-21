// Per-service leadership (Phase 6, docs/multi-pod-liveness-session-leadership.md):
// the Cloud Gossip Key (CGK) is NEVER embedded in the recipe (it is the
// per-cloud gossip secret) — it is always delivered to a box AFTER it registers,
// sealed to its registered identity, exactly like the secret-free SWK. This store
// remembers, per server FQDN, that a CGK deposit is still OWED — and, once done,
// that it's been DEPOSITED (so a later reconcile never double-deposits).
//
// The EXACT twin of PendingSwkDepositStore. Keyed by the canonical FQDN. Three
// states per server:
//   absent      -> nothing owed (never created here / already cleared).
//   "pending"   -> owed: the box hasn't come online yet OR the deposit failed.
//   "deposited" -> done: the CGK was accepted by `.com` (idempotency marker).
//
// Unlike the SWK (owed only when embed-secrets is OFF), the CGK is owed on EVERY
// created server — it is never embedded — so the create flow marks it pending
// unconditionally.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class PendingCgkDepositStore(private val prefs: SharedPreferences) {

    /** Record that a CGK deposit is OWED for this server. */
    fun markPending(serverDomain: String) {
        prefs.edit().putString(key(serverDomain), "pending").apply()
    }

    /** Record that the CGK was accepted by `.com` — the idempotency marker. */
    fun markDeposited(serverDomain: String) {
        prefs.edit().putString(key(serverDomain), "deposited").apply()
    }

    /** Clear any record (e.g. the server was cancelled before it came online). */
    fun clear(serverDomain: String) {
        prefs.edit().remove(key(serverDomain)).apply()
    }

    /** True iff a CGK deposit is still owed (recorded pending, not yet deposited). */
    fun isPending(serverDomain: String): Boolean =
        prefs.getString(key(serverDomain), null) == "pending"

    /** True iff the CGK was already deposited for this server. */
    fun isDeposited(serverDomain: String): Boolean =
        prefs.getString(key(serverDomain), null) == "deposited"

    private fun key(serverDomain: String) = PREFIX + serverDomain.lowercase()

    companion object {
        private const val PREFS = "flagship.cgkDeposit"
        private const val PREFIX = "cgk."

        fun from(context: Context): PendingCgkDepositStore =
            PendingCgkDepositStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
