// The SWK migration hold (docs/server-migration.md invariant 4): the store
// lifecycle + the resolver SwkDepositCoordinator consults before deriving.
// Mirror of iOS MigrationHoldStoreTests / MigrationSwkResolverTests.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MigrationSession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MigrationSwkResolverTest {
    private val migrating = "home.alice.flagship.services"
    private val provisional = "attic.alice.flagship.services"

    private fun freshStore(): MigrationHoldStore {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val prefs = ctx.getSharedPreferences("migrationHold.${System.nanoTime()}", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return MigrationHoldStore(prefs)
    }

    // ── Hold store lifecycle ──────────────────────────────────────────────────

    @Test
    fun holdStoreLifecycle() {
        val store = freshStore()
        assertFalse(store.hasHold(migrating))
        assertTrue(store.holds().isEmpty())
        store.setHold(migrating)
        assertTrue(store.hasHold(migrating))
        assertEquals(listOf(migrating), store.holds())
        store.clearHold(migrating)
        assertFalse(store.hasHold(migrating))
        assertTrue(store.holds().isEmpty())
    }

    @Test
    fun holdsAreLowercasedAndCaseInsensitive() {
        val store = freshStore()
        store.setHold("HOME.Alice.Flagship.Services")
        assertTrue(store.hasHold(migrating))
        assertEquals(listOf(migrating), store.holds())
    }

    // ── Resolver ──────────────────────────────────────────────────────────────

    private fun session(phase: String, newServerDomain: String?) = MigrationSession(
        serverDomain = migrating,
        phase = phase,
        disposition = "wipe-after-handoff",
        oldStkPubHex = "ab".repeat(32),
        newServerDomain = newServerDomain,
        initiatedAt = 1L,
    )

    private fun resolve(
        podDomain: String,
        holds: List<String> = listOf(migrating),
        session: MigrationSession?,
        throwing: Boolean = false,
        cleared: MutableList<String> = mutableListOf(),
    ): MigrationSwkResolution = runBlocking {
        MigrationSwkResolver.resolve(
            podDomain = podDomain,
            holds = holds,
            fetchSession = {
                if (throwing) throw HttpException(0, "offline")
                session
            },
            clearHold = { cleared.add(it) },
        )
    }

    @Test
    fun attachedNewBoxDerivesFromMigratingDomain() {
        val r = resolve(
            podDomain = provisional,
            session = session("provisioned", newServerDomain = provisional),
        )
        assertEquals(MigrationSwkResolution.MigratingDomain(migrating), r)
    }

    @Test
    fun attachedMatchIsCaseInsensitive() {
        val r = resolve(
            podDomain = provisional,
            session = session("provisioned", newServerDomain = "ATTIC.Alice.Flagship.Services"),
        )
        assertEquals(MigrationSwkResolution.MigratingDomain(migrating), r)
    }

    @Test
    fun unattachedLiveSessionDefers() {
        // The migration hasn't attached its new box yet — we cannot tell
        // whether this fresh pod is the provisional one; a wrong-name SWK
        // poisons the restore, so the deposit holds off.
        val r = resolve(
            podDomain = provisional,
            session = session("initiated", newServerDomain = null),
        )
        assertEquals(MigrationSwkResolution.DeferDeposit, r)
    }

    @Test
    fun unreachableComDefers() {
        val r = resolve(podDomain = provisional, session = null, throwing = true)
        assertEquals(MigrationSwkResolution.DeferDeposit, r)
    }

    @Test
    fun unrelatedPodDerivesNormally() {
        // A different pod is the migration's new box — this one is unrelated.
        val r = resolve(
            podDomain = "shed.alice.flagship.services",
            session = session("provisioned", newServerDomain = provisional),
        )
        assertEquals(MigrationSwkResolution.Normal, r)
    }

    @Test
    fun migratingPodItselfDerivesNormally() = runBlocking {
        var fetched = false
        val r = MigrationSwkResolver.resolve(
            podDomain = migrating,
            holds = listOf(migrating),
            fetchSession = { fetched = true; null },
            clearHold = {},
        )
        assertEquals(MigrationSwkResolution.Normal, r)
        assertFalse("the migrating box itself never resolves a session", fetched)
    }

    @Test
    fun terminalSessionClearsHoldAndDerivesNormally() {
        for (terminal in listOf("taken-over", "aborted")) {
            val cleared = mutableListOf<String>()
            val r = resolve(
                podDomain = provisional,
                session = session(terminal, newServerDomain = provisional),
                cleared = cleared,
            )
            assertEquals("phase $terminal", MigrationSwkResolution.Normal, r)
            assertEquals("phase $terminal clears the hold", listOf(migrating), cleared)
        }
    }

    @Test
    fun goneSessionClearsHold() {
        val cleared = mutableListOf<String>()
        val r = resolve(podDomain = provisional, session = null, cleared = cleared)
        assertEquals(MigrationSwkResolution.Normal, r)
        assertEquals(listOf(migrating), cleared)
    }

    @Test
    fun noHoldsIsNormalWithoutFetching() = runBlocking {
        var fetched = false
        val r = MigrationSwkResolver.resolve(
            podDomain = provisional,
            holds = emptyList(),
            fetchSession = { fetched = true; null },
            clearHold = {},
        )
        assertEquals(MigrationSwkResolution.Normal, r)
        assertFalse(fetched)
    }
}
