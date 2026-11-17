// OrgPaymentsCenter (the org wallet, its sync, the org trickle, the rekey exchange and voucher files) against the mock
// `.com` (MockPaymentsClient + MockOrgPlanBackend: the worker's wire and refusal codes).

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.MockPaymentsClient
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OrgPaymentsCenterTest {
    private val DAY = PaymentsConfig.DAY_MS
    private val cfg = PaymentsConfig.DEFAULT
    private val orgId = "0f".repeat(16)
    private var clock = 1_763_400_000_000L

    private inner class World(terms: OrgPlanTerms, liveSeats: Long = 3, admin: Boolean = true) {
        val com = MockPaymentsClient(now = { clock })
        val backend = MockOrgPlanBackend(orgId, cfg, { clock }, terms, liveSeats).also { com.orgs[orgId] = it }
        val keyring = MockOrgWalletKeyring(orgId, admin)
        val key: VoucherKey = runBlocking {
            val k = (com.config()["keys"] as JsonArray)[0] as JsonObject
            VoucherKey(k["keyId"]!!.jsonPrimitive.content, k["nHex"]!!.jsonPrimitive.content, k["eHex"]!!.jsonPrimitive.content)
        }
        val shared = PaymentsUi(loaded = true, config = cfg, keys = listOf(key), issuingKey = key)
        val center = OrgPaymentsCenter(orgId, backend, keyring, com, { shared }, MemoryOrgPaymentsLocal(), { clock }, { 0.5 })

        fun vouchers(n: Int): List<Voucher> = runBlocking {
            val reqs = (0 until n).map { Vouchers.request(key) }
            val sigs = com.testIssue(key.keyId, reqs.map { it.second })
            reqs.mapIndexed { i, r -> Vouchers.finalize(key, r.first, sigs[i]) }
        }

        fun stored(): OrgVoucherWallet? {
            val k = OrgWallets.deriveKey(keyring.ring.keys.getValue(keyring.ring.newest), orgId)
            return backend.blob?.let { OrgWallets.open(k, orgId, it) }
        }
    }

    @Test fun aLapsedOrgPaysAtOnceForItsSeats() = runBlocking {
        val w = World(OrgPlanTerms(clock - 10 * DAY, 10, 0, 0))
        w.center.refresh(interactive = true)
        assertEquals(OrgPlans.LAPSED, w.center.state.value.served?.status)
        assertTrue(w.center.state.value.canPay)
        assertEquals(3L, w.center.state.value.seats)
        assertTrue(w.center.addVouchers(w.vouchers(10)))
        w.center.tick()
        val s = w.center.state.value
        assertEquals(OrgPlans.PAID, s.served?.status)
        assertEquals(3L, w.backend.terms.paidSeats)
        assertEquals(clock + 2 * cfg.orgSeatUnitMs(3), w.backend.terms.paidUntil)
        assertEquals(8, s.balance)
        assertEquals(8, w.stored()!!.balance)
        assertEquals(2, w.stored()!!.spent.size)
        val body = w.com.redeemCalls.last()
        assertEquals(setOf("v", "org", "for", "seats", "vouchers"), body.keys)
        assertEquals("business", body["for"]!!.jsonPrimitive.content)
    }

    @Test fun aTrialWellAheadSpendsNothing() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0))
        w.center.refresh(interactive = true)
        w.center.addVouchers(w.vouchers(5))
        w.center.tick()
        assertEquals(0, w.com.redeemCalls.size)
        assertEquals(OrgPlans.TRIAL, w.center.state.value.served?.status)
    }

    @Test fun theSeatStepperStaysAboveEveryoneWhoHoldsASeat() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0), liveSeats = 5)
        w.center.refresh(interactive = true)
        assertEquals(5L, w.center.state.value.minSeats)
        assertFalse(w.center.setSeats(4))
        assertTrue(w.center.setSeats(7))
        assertEquals(7L, w.stored()!!.settings.seats)
        assertEquals(7L * 6, 7L * w.center.state.value.unitsPerSeatMonth)
    }

    @Test fun aConflictMergesTheOtherAdminsWrite() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0))
        w.center.refresh(interactive = true)
        assertTrue(w.center.addVouchers(w.vouchers(2)))
        val k = OrgWallets.deriveKey(w.keyring.ring.keys.getValue(1), orgId)
        val theirs = OrgWallets.add(w.stored()!!, w.vouchers(3))
        w.backend.conflictNext = OrgWallets.seal(k, orgId, 1, 2, theirs).toJson()
        assertTrue(w.center.addVouchers(w.vouchers(1)))
        assertEquals(6, w.stored()!!.balance)
        assertEquals(3L, w.backend.version)
    }

    @Test fun aRotationThatRetiredAnAdminExchangesEveryVoucher() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0))
        w.center.refresh(interactive = true)
        val old = w.vouchers(4)
        assertTrue(w.center.addVouchers(old))
        w.keyring.ring = OrgWalletRing(w.keyring.ring.keys + (2L to ByteArray(32) { 9 }), setOf(2L))
        w.center.refresh(interactive = true)
        val s = w.center.state.value
        assertEquals(2L, s.keyVersion)
        assertEquals(listOf(4), w.com.exchangeCalls)
        val now = w.stored()!!
        assertEquals(4, now.balance)
        assertTrue(now.vouchers.none { v -> old.any { it.nullifier == v.nullifier } })
        assertNull(OrgWallets.open(OrgWallets.deriveKey(ByteArray(32) { 7 }, orgId), orgId, w.backend.blob))
    }

    @Test fun aVoucherFileIsCheckedThenAdded() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0))
        w.center.refresh(interactive = true)
        val vs = w.vouchers(3)
        assertTrue(w.center.importFile(VoucherFiles.text(vs)))
        assertEquals(3, w.stored()!!.balance)
        assertFalse(w.center.importFile("""{"kind":"flagship-vouchers","v":1,"vouchers":[]}"""))
        assertEquals(OrgPlanNotice.Refused("file-bad"), w.center.state.value.notice)
        val tampered = vs.first().copy(s = vs.last().s)
        assertFalse(w.center.importFile(VoucherFiles.text(listOf(tampered))))
        assertEquals(OrgPlanNotice.Refused("file-bad"), w.center.state.value.notice)
    }

    @Test fun aMemberSeatSeesThePlanButNoWallet() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0), admin = false)
        w.center.refresh(interactive = true)
        val s = w.center.state.value
        assertNotNull(s.served)
        assertFalse(s.isAdmin)
        assertNull(s.wallet)
        assertFalse(w.center.setSeats(4))
    }

    @Test fun aLockedSeatKeyWritesNothing() = runBlocking {
        val w = World(OrgPlanTerms(clock + 20 * DAY, 10, 0, 0))
        w.center.refresh(interactive = true)
        w.keyring.locked = true
        assertFalse(w.center.addVouchers(w.vouchers(1)))
        assertEquals("locked", w.center.state.value.error)
        assertNull(w.backend.blob)
    }
}
