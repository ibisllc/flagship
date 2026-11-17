package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgKeyKind
import com.flagshipserver.app.core.pq.OrgRotation
import com.flagshipserver.app.core.payments.OrgWallets
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The org's `wallet` key on Android: the first org admin to open the Plan makes version 1 (org-wide, sealed to the
// org admins), later opens read it back, background work never makes one or prompts, and the write order an admin
// approves is the org wallet's.
class OrgWalletKeyringTest {
    private val umk = ByteArray(32) { 7 }

    private fun keyring(w: OrgTestWorld, quiet: ByteArray? = null) =
        LiveOrgWalletKeyring(w.founder, OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { quiet?.copyOf() }, { w.now })

    @Test fun theFirstAdminMakesVersionOneAndOpensIt() = runTest {
        val w = OrgTestWorld()
        assertNull(keyring(w).walletRing(interactive = false))
        assertEquals(0, w.rings.size)
        val ring = keyring(w).walletRing(interactive = true)!!
        assertEquals(setOf(1L), ring.keys.keys)
        assertEquals(1, w.rings.size)
        val r = (w.rings.single()["ring"] as JsonObject)
        assertEquals(JsonPrimitive("wallet"), r["kind"])
        assertEquals(JsonPrimitive("*"), r["scope"])
        val again = keyring(w, quiet = umk).walletRing(interactive = false)!!
        assertTrue(ring.keys.getValue(1).contentEquals(again.keys.getValue(1)))
        assertEquals(1, w.rings.size)
        assertEquals(OrgKeyKind.WALLET, OrgKeyKind.of("wallet"))
        assertEquals("wallet|*", OrgRotation.chainId(OrgKeyKind.WALLET, "*"))
    }

    @Test fun anAdminApprovesTheWalletWrite() = runTest {
        val w = OrgTestWorld()
        val k = keyring(w)
        val ring = k.walletRing(interactive = true)!!
        val key = OrgWallets.deriveKey(ring.keys.getValue(1), w.orgId)
        val sealed = OrgWallets.seal(key, w.orgId, 1, 1, OrgWallets.empty(3, 10))
        val write = OrgWallets.writeFor(w.orgId, sealed, w.now)
        val order = OrgWallets.canonicalWrite(write)
        val a = k.approve(order)!!
        assertEquals(OrgAuthority.sha256Hex(order), a.orderSha256)
        assertEquals(OrgWallets.TAG_WRITE, a.purposeTag)
        assertEquals(w.founder.seatId, a.seatId)
        assertTrue(a.signature.isNotEmpty())
        w.founderSeats.locked = true
        assertNull(k.approve(order))
    }
}
