// Which serverId should the SWK for a pod derive from? Consulted by the
// SwkDepositCoordinator BEFORE deriving (docs/server-migration.md invariant 4;
// the webapp's `migrationSwkServerId` / iOS MigrationSwkResolver).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MigrationSession

sealed interface MigrationSwkResolution {
    /** This pod is the migration's attached new box — derive with the
     *  MIGRATING domain as the serverId (the whole point). */
    data class MigratingDomain(val domain: String) : MigrationSwkResolution

    /** A live migration hasn't attached its new box yet (or `.com` is
     *  unreachable) — hold the deposit off; the pending marker stays and the
     *  next reconcile retries. */
    data object DeferDeposit : MigrationSwkResolution

    /** No migration involvement — derive from the pod's own name. */
    data object Normal : MigrationSwkResolution
}

object MigrationSwkResolver {
    /** `fetchSession` returns null for "no session" (404) and THROWS on an
     *  unreachable `.com` — the two are conservatively different: no session
     *  clears the hold, unreachable defers (a wrong-name SWK poisons the
     *  restore, a deferred one just retries). */
    suspend fun resolve(
        podDomain: String,
        holds: List<String>,
        fetchSession: suspend (String) -> MigrationSession?,
        clearHold: (String) -> Unit,
    ): MigrationSwkResolution {
        val pod = podDomain.lowercase()
        for (migrating in holds) {
            // The migrating box itself derives normally.
            if (migrating == pod) continue
            val session = try {
                fetchSession(migrating)
            } catch (_: Throwable) {
                return MigrationSwkResolution.DeferDeposit
            }
            if (session == null || session.phase !in ServerMigrationTimeline.ACTIVE_PHASES) {
                if (session == null || session.phase == "taken-over" || session.phase == "aborted") {
                    clearHold(migrating)
                }
                continue
            }
            val attached = session.newServerDomain?.lowercase()
            if (attached == pod) return MigrationSwkResolution.MigratingDomain(migrating)
            if (attached == null) return MigrationSwkResolution.DeferDeposit
            // A different pod is the migration's new box — this one is unrelated.
        }
        return MigrationSwkResolution.Normal
    }
}
