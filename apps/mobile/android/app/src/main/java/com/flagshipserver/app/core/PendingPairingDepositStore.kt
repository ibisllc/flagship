// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): the FIRST
// recipe carries ZERO pairing secrets. The default (online) create flow stashes
// the create-time owner-IRK-signed `add-paired-session` order locally and, once
// the box registers with its identity pub, seals it to the box identity and
// deposits it on `.com`'s blind pairing-deposit lane. This store remembers, per
// server FQDN, the STASHED order JSON that is still OWED — and, once done, that
// it's been DEPOSITED (so a later reconcile never double-deposits).
//
// Twin of PendingSwkDepositStore. Keyed by the canonical FQDN. Three states:
//   absent              -> nothing owed (embed-secrets WAS on, or not created here).
//   "<pairingOrderJson>" -> owed: the stashed plaintext order to seal + deposit.
//   "deposited"         -> done: the order was accepted by `.com` (idempotency).

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class PendingPairingDepositStore(private val prefs: SharedPreferences) {

    /** Stash the create-time order JSON — a deposit is OWED (embed-secrets OFF). */
    fun markPending(serverDomain: String, pairingOrderJson: String) {
        prefs.edit().putString(key(serverDomain), pairingOrderJson).apply()
    }

    /** Record that the order was accepted by `.com` — the idempotency marker. */
    fun markDeposited(serverDomain: String) {
        prefs.edit().putString(key(serverDomain), DEPOSITED).apply()
    }

    /** Clear any record (e.g. embed-secrets was ON, or the server was cancelled). */
    fun clear(serverDomain: String) {
        prefs.edit().remove(key(serverDomain)).apply()
    }

    /** The stashed order JSON iff a deposit is still owed, else null. */
    fun pendingOrder(serverDomain: String): String? {
        val v = prefs.getString(key(serverDomain), null)
        return if (v != null && v != DEPOSITED) v else null
    }

    /** True iff the order was already deposited for this server. */
    fun isDeposited(serverDomain: String): Boolean =
        prefs.getString(key(serverDomain), null) == DEPOSITED

    private fun key(serverDomain: String) = PREFIX + serverDomain.lowercase()

    companion object {
        private const val PREFS = "flagship.pairingDeposit"
        private const val PREFIX = "pairing."
        private const val DEPOSITED = "deposited"

        fun from(context: Context): PendingPairingDepositStore =
            PendingPairingDepositStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
