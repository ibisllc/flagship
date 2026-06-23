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

    private fun coordinator(store: PendingSwkDepositStore, mailbox: MockSecretMailboxClient) =
        SwkDepositCoordinator(
            username = "alice",
            mailbox = mailbox,
            store = store,
            deriveIrkAndSwk = { Triple(Ed25519Sign(irkKp.privateKey), HexUtil.encode(irkKp.publicKey), HexUtil.encode(swk)) },
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
}
