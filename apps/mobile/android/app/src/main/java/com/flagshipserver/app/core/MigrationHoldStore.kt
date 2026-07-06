// SWK migration hold (docs/server-migration.md invariant 4) — the device-local
// record that a migration was initiated HERE for a domain. While a hold is
// live, the SWK deposit for any OTHER pod of this account must first resolve
// the migration session (MigrationSwkResolver): the migration's provisional
// new pod needs the MIGRATING domain's SWK (`ServerKeys.deriveSwk` DOTS
// "flagship.swk.v1|<serverId>"), NOT its own name's — a wrong-name SWK poisons
// the restore. Mirror of the webapp's `flagship.migrationHold.*` localStorage
// keys / iOS MigrationHoldStore; SharedPreferences-keyed like
// PendingSwkDepositStore.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class MigrationHoldStore(private val prefs: SharedPreferences) {

    /** Record at initiate: the NEXT added pod may be this migration's new box. */
    fun setHold(migratingDomain: String) {
        prefs.edit().putBoolean(key(migratingDomain), true).apply()
    }

    /** Clear on aborted / taken-over (the session is terminal). */
    fun clearHold(migratingDomain: String) {
        prefs.edit().remove(key(migratingDomain)).apply()
    }

    fun hasHold(migratingDomain: String): Boolean =
        prefs.getBoolean(key(migratingDomain), false)

    /** Every migrating domain with a live hold (lowercased). */
    fun holds(): List<String> =
        prefs.all.keys
            .filter { it.startsWith(PREFIX) }
            .map { it.removePrefix(PREFIX) }
            .sorted()

    private fun key(migratingDomain: String) = PREFIX + migratingDomain.lowercase()

    companion object {
        private const val PREFS = "flagship.migrationHold"
        private const val PREFIX = "flagship.migrationHold."

        fun from(context: Context): MigrationHoldStore =
            MigrationHoldStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
