// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): the
// PendingSwkDepositStore lifecycle + the SwkDepositCoordinator deposit (seals to
// the box identity, signs under the owner IRK, idempotent, retry-on-failure).

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SwkDepositTest {
    private val serverDomain = "kitchen.alice.flagship.services"

    private fun freshStore(): PendingSwkDepositStore {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val prefs = ctx.getSharedPreferences("swk.${System.nanoTime()}", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return PendingSwkDepositStore(prefs)
    }

    @Test
    fun storeLifecycle() {
        val store = freshStore()
        assertFalse(store.isPending(serverDomain))
        assertFalse(store.isDeposited(serverDomain))
        store.markPending(serverDomain)
        assertTrue(store.isPending(serverDomain))
        store.markDeposited(serverDomain)
        assertFalse(store.isPending(serverDomain))
        assertTrue(store.isDeposited(serverDomain))
        store.clear(serverDomain)
        assertFalse(store.isPending(serverDomain))
        assertFalse(store.isDeposited(serverDomain))
    }

    // Deterministic owner IRK + box identity for the test.
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 7 })
    private val boxSeed = ByteArray(32) { 9 }
    private val boxPubHex = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(boxSeed).publicKey)
    private val swk = ByteArray(32) { 0x33 }

    private fun freshPairingStore(): PendingPairingDepositStore {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val prefs = ctx.getSharedPreferences("pairing.${System.nanoTime()}", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return PendingPairingDepositStore(prefs)
    }

    private fun freshCgkStore(): PendingCgkDepositStore {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val prefs = ctx.getSharedPreferences("cgk.${System.nanoTime()}", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return PendingCgkDepositStore(prefs)
    }

    private val cgk = ByteArray(32) { 0x55 }

    private fun coordinator(
        store: PendingSwkDepositStore,
        mailbox: MockSecretMailboxClient,
        pairingStore: PendingPairingDepositStore = freshPairingStore(),
        cgkStore: PendingCgkDepositStore = freshCgkStore(),
        resolution: MigrationSwkResolution = MigrationSwkResolution.Normal,
        /** Records the serverId each SWK derivation used (the migration seam's
         *  observable output). */
        derivedServerIds: MutableList<String> = mutableListOf(),
    ) =
        SwkDepositCoordinator(
            username = "alice",
            mailbox = mailbox,
            store = store,
            pairingStore = pairingStore,
            cgkStore = cgkStore,
            deriveIrkAndSwk = { serverId, _ ->
                derivedServerIds.add(serverId)
                Triple(Ed25519Sign(irkKp.privateKey), HexUtil.encode(irkKp.publicKey), HexUtil.encode(swk))
            },
            deriveCgkHex = { HexUtil.encode(cgk) },
            resolveMigrationSwk = { resolution },
        )

    @Test
    fun noOpWhenNothingOwed() = runBlocking {
        val store = freshStore()
        val mailbox = MockSecretMailboxClient()
        coordinator(store, mailbox).depositIfNeeded(serverDomain, boxPubHex)
        assertTrue(mailbox.swkDeposits.isEmpty())
    }

    @Test
    fun depositsWhenPendingSealsToBoxVerifiesUnderOwnerIrk() = runBlocking {
        val store = freshStore()
        store.markPending(serverDomain)
        val mailbox = MockSecretMailboxClient()
        coordinator(store, mailbox).depositIfNeeded(serverDomain, boxPubHex)

        assertEquals(1, mailbox.swkDeposits.size)
        val (domain, body) = mailbox.swkDeposits[0]
        assertEquals(serverDomain, domain)
        // The deposit binds the box's REGISTERED identity (I2).
        assertEquals(boxPubHex, body.deposit.stkPub)
        assertEquals(serverDomain, body.deposit.serverDomain)

        // Re-verify the way the BOX does: parse the carrier, check the owner-IRK
        // signature over canonical bytes, unseal the SWK with the box identity.
        val carrierJson = String(HexUtil.decode(body.deposit.sealed)!!, Charsets.UTF_8)
        val obj = Json.parseToJsonElement(carrierJson).jsonObject
        val sealed = HexUtil.decode(obj["sealed"]!!.jsonPrimitive.content)!!
        val sig = HexUtil.decode(obj["signature"]!!.jsonPrimitive.content)!!
        val issuedAt = obj["issuedAt"]!!.jsonPrimitive.content.toLong()
        val delivery = SwkDelivery.Delivery(serverDomain, sealed, issuedAt)
        Ed25519Verify(irkKp.publicKey).verify(sig, SwkDelivery.canonicalBytes(delivery))
        val opened = SecretSeal.openWithEd25519Seed(sealed, boxSeed)
        assertEquals(HexUtil.encode(swk), HexUtil.encode(opened))

        // Idempotent: marked deposited, second pass does not re-deposit.
        assertTrue(store.isDeposited(serverDomain))
        coordinator(store, mailbox).depositIfNeeded(serverDomain, boxPubHex)
        assertEquals(1, mailbox.swkDeposits.size)
    }

    @Test
    fun failureKeepsPendingForRetry() = runBlocking {
        val store = freshStore()
        store.markPending(serverDomain)
        val mailbox = MockSecretMailboxClient()
        mailbox.swkDepositError = HttpException(500, "boom")
        coordinator(store, mailbox).depositIfNeeded(serverDomain, boxPubHex)
        assertFalse(store.isDeposited(serverDomain))
        assertTrue(store.isPending(serverDomain))
    }

    // ── Secret-free PAIRING (riding the same coordinator) ──

    @Test
    fun pairingStoreLifecycle() {
        val store = freshPairingStore()
        val json = "{\"request\":{},\"signature\":\"ab\"}"
        assertEquals(null, store.pendingOrder(serverDomain))
        assertFalse(store.isDeposited(serverDomain))
        store.markPending(serverDomain, json)
        assertEquals(json, store.pendingOrder(serverDomain))
        store.markDeposited(serverDomain)
        assertEquals(null, store.pendingOrder(serverDomain))
        assertTrue(store.isDeposited(serverDomain))
        store.clear(serverDomain)
        assertFalse(store.isDeposited(serverDomain))
    }

    private fun stashedOrderJson(): String =
        CreateTimePairing.build(
            serverDomain = serverDomain, label = "iPhone",
            irk = Ed25519Sign(irkKp.privateKey), now = 1_750_000_000_000L, token = "ab".repeat(32),
        ).pairingOrderJson

    @Test
    fun depositsPairingOrderSealsToBoxOpensVerbatim() = runBlocking {
        val swkStore = freshStore()
        val pairingStore = freshPairingStore()
        val json = stashedOrderJson()
        pairingStore.markPending(serverDomain, json)
        val mailbox = MockSecretMailboxClient()

        coordinator(swkStore, mailbox, pairingStore).depositIfNeeded(serverDomain, boxPubHex)

        // No SWK owed; only the pairing deposit went out.
        assertTrue(mailbox.swkDeposits.isEmpty())
        assertEquals(1, mailbox.pairingDeposits.size)
        val (_, body) = mailbox.pairingDeposits[0]
        assertEquals(boxPubHex, body.deposit.stkPub)
        // The box opens deposit.sealed with its identity seed → the exact JSON.
        val plain = SecretSeal.openWithEd25519Seed(HexUtil.decode(body.deposit.sealed)!!, boxSeed)
        assertEquals(json, String(plain, Charsets.UTF_8))

        // Idempotent: marked deposited, second pass does not re-deposit.
        assertTrue(pairingStore.isDeposited(serverDomain))
        coordinator(swkStore, mailbox, pairingStore).depositIfNeeded(serverDomain, boxPubHex)
        assertEquals(1, mailbox.pairingDeposits.size)
    }

    @Test
    fun pairingNoOpWhenNothingOwed() = runBlocking {
        val mailbox = MockSecretMailboxClient()
        coordinator(freshStore(), mailbox, freshPairingStore()).depositIfNeeded(serverDomain, boxPubHex)
        assertTrue(mailbox.pairingDeposits.isEmpty())
        assertTrue(mailbox.swkDeposits.isEmpty())
    }

    // ── Server-migration SWK contract (docs/server-migration.md invariant 4) ──
    //
    // The coordinator consults the migration resolver BEFORE deriving, so a
    // migration's provisional new pod gets the MIGRATING domain's SWK (DOTS
    // `flagship.swk.v1|<migrating domain>`) and an ambiguous pod (live
    // migration, no attached box yet) DEFERS instead of depositing a
    // wrong-name SWK that would poison the restore.

    private val migratingDomain = "home.alice.flagship.services"

    @Test
    fun migrationAttachedNewPodDerivesFromMigratingDomain() = runBlocking {
        val store = freshStore()
        store.markPending(serverDomain)
        val mailbox = MockSecretMailboxClient()
        val derived = mutableListOf<String>()
        coordinator(
            store, mailbox,
            resolution = MigrationSwkResolution.MigratingDomain(migratingDomain),
            derivedServerIds = derived,
        ).depositIfNeeded(serverDomain, boxPubHex)

        assertEquals(
            "SWK derives from the MIGRATING domain, not the pod's own name",
            listOf(migratingDomain), derived,
        )
        assertEquals(1, mailbox.swkDeposits.size)
        // The deposit still ADDRESSES the provisional pod (it claims the blob).
        assertEquals(serverDomain, mailbox.swkDeposits[0].first)
        assertEquals(serverDomain, mailbox.swkDeposits[0].second.deposit.serverDomain)
        assertTrue(store.isDeposited(serverDomain))
    }

    @Test
    fun migrationDeferHoldsTheDepositAndKeepsPending() = runBlocking {
        val store = freshStore()
        store.markPending(serverDomain)
        val mailbox = MockSecretMailboxClient()
        val derived = mutableListOf<String>()
        coordinator(
            store, mailbox,
            resolution = MigrationSwkResolution.DeferDeposit,
            derivedServerIds = derived,
        ).depositIfNeeded(serverDomain, boxPubHex)

        assertTrue("no deposit while the migration hasn't attached its new box", mailbox.swkDeposits.isEmpty())
        assertTrue("nothing owed ⇒ no biometric derivation at all", derived.isEmpty())
        assertTrue("the pending marker stays — the next reconcile retries", store.isPending(serverDomain))
    }

    @Test
    fun migrationNormalResolutionDerivesFromOwnName() = runBlocking {
        val store = freshStore()
        store.markPending(serverDomain)
        val mailbox = MockSecretMailboxClient()
        val derived = mutableListOf<String>()
        coordinator(store, mailbox, derivedServerIds = derived)
            .depositIfNeeded(serverDomain, boxPubHex)

        assertEquals(listOf(serverDomain), derived)
        assertEquals(1, mailbox.swkDeposits.size)
    }

    @Test
    fun migrationDeferStillDeliversAnOwedCgk() = runBlocking {
        // The defer is SWK-scoped: the CGK is per-cloud (not serverId-derived),
        // so an owed CGK still goes out on the same pass.
        val store = freshStore()
        store.markPending(serverDomain)
        val cgkStore = freshCgkStore()
        cgkStore.markPending(serverDomain)
        val mailbox = MockSecretMailboxClient()
        coordinator(
            store, mailbox, cgkStore = cgkStore,
            resolution = MigrationSwkResolution.DeferDeposit,
        ).depositIfNeeded(serverDomain, boxPubHex)

        assertTrue(mailbox.swkDeposits.isEmpty())
        assertTrue(store.isPending(serverDomain))
        assertEquals(1, mailbox.cgkDeposits.size)
        assertTrue(cgkStore.isDeposited(serverDomain))
    }
}
