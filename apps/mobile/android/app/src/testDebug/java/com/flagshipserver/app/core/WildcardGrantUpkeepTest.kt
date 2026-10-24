package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockScreensClient
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Grant upkeep (docs/first-contact.md): a pinned server answering `granted: false` gets the
 *  grant waiting for it, or one an admin device signs silently while its session is unlocked. */
class WildcardGrantUpkeepTest {
    private val user = "bright-maple"
    private val box = MockScreensClient(simulatedLatencyMs = 0)
    private val domain get() = runBlocking { box.boxFqdn() }
    private val stk = "ab".repeat(32)
    private val admin = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val pins = ServerKeyPins(InMemoryServerKeyPinStore())
    private val outbox = InMemoryWildcardGrantOutbox()
    private var unlocked = true
    private var adminDevice = true

    private fun upkeep() = WildcardGrantUpkeep(
        username = user,
        pins = pins,
        outbox = outbox,
        isAdminDevice = { adminDevice },
        silentSigner = { if (unlocked) Ed25519Sign(admin.privateKey) else null },
        now = { 1_760_000_000_000L },
    )

    private fun run() = runBlocking { upkeep().run(listOf(domain to box)) }

    @Test fun anAdminDeviceSignsSilentlyOverThePinnedKey() {
        pins.recordFirstSeen(domain, stk)
        assertEquals(1, run())
        val (at, sig) = box.wildcardGrantPosts.single()
        Ed25519Verify(admin.publicKey).verify(HexUtil.decode(sig)!!, ServerWildcardGrant.canonicalBytes(user, domain, stk, at))
        assertEquals("the box holds one now: nothing more is sent", 0, run())
        assertEquals(1, box.wildcardGrantPosts.size)
    }

    @Test fun noPinNoGrant() {
        assertEquals(0, run())
        assertTrue(box.wildcardGrantPosts.isEmpty())
    }

    @Test fun aLockedSessionOrANonAdminDeviceSignsNothing() {
        pins.recordFirstSeen(domain, stk)
        unlocked = false
        assertEquals(0, run())
        unlocked = true
        adminDevice = false
        assertEquals(0, run())
        assertTrue(box.wildcardGrantPosts.isEmpty())
    }

    @Test fun aWaitingGrantGoesWithoutASignatureAndOnlyForThePinnedKey() {
        pins.recordFirstSeen(domain, stk)
        adminDevice = false
        outbox.put(domain, PendingWildcardGrant("cd".repeat(32), 1L, "00".repeat(64)))
        assertEquals("a grant over another key is never sent", 0, run())
        val good = WildcardGrants.sign(user, domain, stk, 5L, Ed25519Sign(admin.privateKey))!!
        outbox.put(domain, good)
        assertEquals(1, run())
        assertEquals(5L to good.signatureHex, box.wildcardGrantPosts.single())
        assertNull(outbox.get(domain))
    }

    @Test fun aBoxThatCantBeReachedKeepsTheGrantWaiting() {
        pins.recordFirstSeen(domain, stk)
        box.failure = java.io.IOException("offline")
        assertEquals(0, run())
        box.failure = null
        assertNull("not reached: nothing signed yet", outbox.get(domain))
        assertNotNull(WildcardGrants.sign(user, domain, stk, 1L, Ed25519Sign(admin.privateKey)))
    }
}
