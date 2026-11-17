// The mock `.com` for an org's Business plan (gym runs and unit tests): the worker's wire and refusal codes
// (packages/control-plane/src/orgPlan.ts, blindVouchers.ts handleOrgVoucherRedeem), and a scripted org seat with a
// fixed wallet key. Debug builds only.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.OrgHttp
import com.flagshipserver.app.core.pq.OrgApproval
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.keystore.OrgSeatRecord
import com.flagshipserver.app.keystore.OrgSeatStore
import com.flagshipserver.app.viewmodels.OrgRuntime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class MockOrgPlanBackend(
    val orgId: String,
    private val cfg: PaymentsConfig = PaymentsConfig.DEFAULT,
    private val now: () -> Long = System::currentTimeMillis,
    var terms: OrgPlanTerms = OrgPlans.trialTerms(cfg, System.currentTimeMillis()),
    var liveSeats: Long = 3,
) : OrgPlanBackend {
    var blob: JsonObject? = null
    var version = 0L
    val writes = mutableListOf<JsonObject>()
    /** Another admin's write lands just before this phone's next one (a version conflict). */
    var conflictNext: JsonObject? = null

    private fun refuse(status: Int, code: String, extra: Map<String, JsonElement> = emptyMap()): Nothing =
        throw PaymentsHttpError(status, code, JsonObject(mapOf("error" to JsonPrimitive(code), "code" to JsonPrimitive(code)) + extra))

    override suspend fun plan(orgId: String): OrgPlanServed? {
        if (orgId != this.orgId) return null
        val st = OrgPlans.state(cfg, terms, now())
        return OrgPlanServed(
            orgId, st.status, st.seatLimit, terms.paidSeats, terms.paidUntil, terms.trialEndsAt, st.coveredUntil, liveSeats,
            OrgPrice(cfg.unitUsd, cfg.business.unitsPerSeatMonth, cfg.business.minSeats, cfg.business.maxSeats),
        )
    }

    override suspend fun wallet(orgId: String): JsonObject? = blob

    override suspend fun putWallet(orgId: String, blob: JsonObject, write: JsonObject, approval: OrgApproval): OrgWalletPut {
        conflictNext?.let { other ->
            conflictNext = null
            version = VoiciJs.time(other["version"]) ?: version
            this.blob = other
        }
        val sealed = OrgWallets.parseSealed(blob) ?: refuse(400, "malformed")
        val w = OrgWalletWrite(
            VoiciJs.str(write["orgId"]) ?: "", VoiciJs.time(write["version"]) ?: 0, VoiciJs.time(write["keyVersion"]) ?: 0,
            VoiciJs.str(write["blobSha256"]) ?: "", VoiciJs.time(write["issuedAt"]) ?: 0,
        )
        if (w != OrgWallets.writeFor(orgId, sealed, w.issuedAt)) refuse(400, "malformed")
        if (approval.orderSha256 != OrgAuthority.sha256Hex(OrgWallets.canonicalWrite(w))) refuse(403, "org-bad-signature")
        if (sealed.version != version + 1) return OrgWalletPut.Conflict(this.blob)
        version = sealed.version
        this.blob = blob
        writes += blob
        return OrgWalletPut.Stored(version)
    }

    /** `POST /api/vouchers/redeem` with `org`: the vouchers are verified and spent by the caller. */
    fun redeem(body: JsonObject, fresh: Int, already: List<String>): JsonObject {
        val t = now()
        val what = VoiciJs.str(body["for"])
        if (what != OrgPaymentsCenter.BUSINESS) refuse(400, "malformed")
        val seats = VoiciJs.safeInt(body["seats"]) ?: refuse(400, "org-seats")
        if (!cfg.isOrgSeatCount(seats)) refuse(400, "org-seats", mapOf("min" to JsonPrimitive(cfg.business.minSeats), "max" to JsonPrimitive(cfg.business.maxSeats)))
        if (seats < liveSeats) refuse(409, "org-seats-below-live", mapOf("liveSeats" to JsonPrimitive(liveSeats)))
        if (OrgPlans.aheadMs(cfg, terms, seats, t) > cfg.maxAheadDays * PaymentsConfig.DAY_MS) refuse(409, "plan-paid-ahead")
        if (fresh == 0) refuse(409, "voucher-spent", mapOf("spent" to JsonArray(already.map(::JsonPrimitive))))
        terms = terms.copy(paidSeats = seats, paidUntil = OrgPlans.paidUntilAfterSpend(cfg, terms, seats, fresh.toLong(), t))
        val st = OrgPlans.state(cfg, terms, t)
        return JsonObject(
            mapOf(
                "ok" to JsonPrimitive(true), "for" to JsonPrimitive(what), "credited" to JsonPrimitive(fresh),
                "spent" to JsonArray(already.map(::JsonPrimitive)), "seats" to JsonPrimitive(seats),
                "paidUntil" to JsonPrimitive(terms.paidUntil), "status" to JsonPrimitive(st.status),
            ),
        )
    }
}

/** A seat that holds the org's `wallet` key as a fixed ring (or none, for a non-admin seat). */
class MockOrgWalletKeyring(
    private val orgId: String,
    private val admin: Boolean,
    var ring: OrgWalletRing = OrgWalletRing(mapOf(1L to ByteArray(32) { 7 }), emptySet()),
) : OrgWalletKeyring {
    var locked = false
    override fun isAdmin() = admin
    override suspend fun walletRing(interactive: Boolean): OrgWalletRing? = if (!admin || locked) null else ring
    override fun approve(order: ByteArray): OrgApproval? = if (locked) null else
        OrgApproval(orgId, 1, PqTrust.messagePurpose(order), OrgAuthority.sha256Hex(order), "aa".repeat(16), "bb".repeat(32), Long.MAX_VALUE, 0, "00")
}

/** The gym's one org: Acme, with this phone's seat. */
object MockOrgPlan {
    val ORG_ID = "ac".repeat(16)
    val SEAT_ID = "5e".repeat(16)

    private fun binding(): PqTrust.Wire {
        val kp = PqHybrid.hybridSigKeygen(ByteArray(32) { 1 }, ByteArray(32) { 2 })
        val st = PqTrust.Statement("org-seat-admin", OrgAuthority.seatSubject(ORG_ID, SEAT_ID), PqHex.encode(kp.publicKey.copyOfRange(0, 32)),
            PqHex.encode(kp.publicKey.copyOfRange(32, kp.publicKey.size)), 0)
        return PqTrust.signPqKeyBinding(st) { m -> PqHybrid.hybridSign(kp.secretKey, PqTrust.TAG_PQ_KEY_BINDING, m) }
    }

    class Seats(private val seat: OrgSeatRecord) : OrgSeatStore {
        override fun seats() = listOf(seat)
        override fun makeKey(orgId: String, seatId: String, now: Long): Pair<PqTrust.Wire, ByteArray> = throw UnsupportedOperationException()
        override fun remember(orgId: String, seatId: String, orgName: String, genesisHash: String, binding: PqTrust.Wire, secret: ByteArray) = Unit
        override fun rememberMember(orgId: String, seatId: String, orgName: String, genesisHash: String, memberBinding: PqTrust.Wire) = Unit
        override fun sign(seat: OrgSeatRecord, purpose: String, payload: ByteArray): ByteArray? = null
    }

    /** The org runtime and each seat's plan center for scenario [scenario] (trial | paid | lapsed, "-member"). */
    fun world(scenario: String, payments: com.flagshipserver.app.api.MockPaymentsClient, now: () -> Long = System::currentTimeMillis):
        Pair<OrgRuntime, (OrgSeatRecord) -> OrgPaymentsCenter> {
        val member = scenario.endsWith("-member")
        val seat = OrgSeatRecord(ORG_ID, SEAT_ID, "acme", "00".repeat(32), binding(), memberOnly = member)
        val t = now()
        val cfg = PaymentsConfig.DEFAULT
        val day = PaymentsConfig.DAY_MS
        val terms = when (scenario.removeSuffix("-member")) {
            "paid" -> OrgPlanTerms(t - 40 * day, cfg.business.trialSeats, 5, t + 20 * day)
            "lapsed" -> OrgPlanTerms(t - 10 * day, cfg.business.trialSeats, 0, 0)
            else -> OrgPlanTerms(t + 12 * day, cfg.business.trialSeats, 0, 0)
        }
        val backend = MockOrgPlanBackend(ORG_ID, cfg, now, terms, liveSeats = 3)
        payments.orgs[ORG_ID] = backend
        val keyring = MockOrgWalletKeyring(ORG_ID, admin = !member)
        val http = OrgHttp { _, _, _ -> 404 to JsonObject(mapOf("code" to JsonPrimitive("not-found"))) }
        val rt = OrgRuntime(OrgClient(http), Seats(seat)) { ByteArray(32) }
        val factory = { s: OrgSeatRecord ->
            OrgPaymentsCenter(
                s.orgId, backend, keyring, payments,
                shared = { PaymentsCenter.shared?.state?.value ?: PaymentsUi() },
                local = MemoryOrgPaymentsLocal(),
                now = now,
                rand = { 0.5 },
            )
        }
        return rt to factory
    }
}
