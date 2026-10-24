// Approve from watch renews itself in the last two days, only while signing raises no prompt, and
// deposits the per-server copies again to last as long as the new delegate.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.WatchDelegateInfo
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchDelegateRenewalTest {
    private val user = "alice"
    private val now = 1_760_000_000_000L
    private val day = 24 * 3_600_000L
    private val irkSeed = ByteArray(32) { 7 }
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed)
    private val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 3 }).publicKey)
    private val domain = "kitchen.alice.flagship.services"

    private class Store : WatchBootKeyStore {
        private val priv = X25519.generatePrivateKey()
        val copies = HashMap<String, WatchBootCopy>()
        override fun loadOrCreate() = existing()!!
        override fun existing(): BootDecryptKey = object : BootDecryptKey {
            override val publicKey = X25519.publicFromPrivate(priv)
            override fun agree(peerPublicKey: ByteArray) = X25519.computeSharedSecret(priv, peerPublicKey)
        }
        override fun copies(): Map<String, WatchBootCopy> = copies.toMap()
        override fun setCopy(serverDomain: String, copy: WatchBootCopy?) { if (copy == null) copies.remove(serverDomain) else copies[serverDomain] = copy }
        override fun clear() = copies.clear()
    }

    private fun setup(left: Long, silent: Boolean): Triple<WatchDelegateRenewal, MockFlagshipServerClient, MockSecretMailboxClient> {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            nowMs = { now }
            watchDelegatesByUser[user] = mutableListOf(WatchDelegateInfo("g1", pub, listOf("boot-approval"), now - day, now + left))
        }
        val mailbox = MockSecretMailboxClient().apply {
            sealedLuksKeyHex = HexUtil.encode(SecretSeal.sealForEd25519Recipient(ByteArray(64) { 1 }, irkKp.publicKey))
        }
        val irk = object : IrkAccess {
            override suspend fun resolve(reason: String) = IrkMaterial(Ed25519Sign(irkKp.privateKey), irkSeed, HexUtil.encode(irkKp.publicKey))
        }
        val store = Store().apply { setCopy(domain, WatchBootCopy(now + left - 60_000)) }
        val pins = ServerKeyPins(object : ServerKeyPinStore {
            val m = HashMap<String, String>()
            override fun get(serverDomain: String) = m[serverDomain]
            override fun put(serverDomain: String, stkPubHex: String) { m[serverDomain] = stkPubHex }
            override fun remove(serverDomain: String) { m.remove(serverDomain) }
        })
        val optIn = WatchBootOptIn(mailbox, irk, store, pins, { "51".repeat(32) }, now = { now })
        val renewal = WatchDelegateRenewal(
            server, { user }, { pub }, {}, { if (silent) Ed25519Sign(irkKp.privateKey) else null }, optIn, now = { now }, grantIdGen = { "g2" },
        )
        return Triple(renewal, server, mailbox)
    }

    @Test fun notDueWithMoreThanTwoDaysLeft() = runBlocking {
        val (r, server, _) = setup(left = 3 * day, silent = true)
        assertEquals(WatchDelegateRenewal.Outcome.NotDue, r.renewIfDue())
        assertEquals("g1", server.watchDelegatesByUser[user]!!.single().grantId)
    }

    @Test fun neverPromptsWhenTheSessionIsLocked() = runBlocking {
        val (r, server, _) = setup(left = day, silent = false)
        assertEquals(WatchDelegateRenewal.Outcome.NeedsUnlock, r.renewIfDue())
        assertEquals("g1", server.watchDelegatesByUser[user]!!.single().grantId)
    }

    @Test fun renewsForSevenDaysAndDepositsTheCopiesAgain() = runBlocking {
        val (r, server, mailbox) = setup(left = day, silent = true)
        val out = r.renewIfDue() as WatchDelegateRenewal.Outcome.Renewed
        val grant = server.watchDelegatesByUser[user]!!.single()
        assertEquals("g2", grant.grantId)
        assertEquals(pub, grant.delegatePubKey)
        assertEquals(now + 7 * day, grant.expiresAt)
        assertEquals(1, out.copies)
        val dep = mailbox.watchBootPuts.single().first
        assertTrue(dep.expiresAt > now + day && dep.expiresAt < now + 7 * day)
    }
}
