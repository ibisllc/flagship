// The mock `.com` for vouchers and the plan (gym runs and unit tests): the worker's wire and refusal codes
// (packages/control-plane/src/blindVouchers.ts), with its own throwaway RSA key. Debug builds only.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.payments.PaymentsConfig
import com.flagshipserver.app.core.payments.Vouchers
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import kotlin.math.floor

class MockPaymentsClient(
    private val cfg: PaymentsConfig = PaymentsConfig.DEFAULT,
    private val now: () -> Long = System::currentTimeMillis,
    /** The account starts on this plan (null: Free) until this time. */
    startPlan: String? = null,
    startPaidUntil: Long = 0,
    val testIssue: Boolean = true,
    var remainingBytes: Long = 200L * 1024 * 1024 * 1024,
) : PaymentsClient {
    private val n: BigInteger
    private val e: BigInteger
    private val d: BigInteger
    val keyId: String
    private val nHex: String
    private val eHex: String

    init {
        val kp = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        n = (kp.public as RSAPublicKey).modulus
        e = (kp.public as RSAPublicKey).publicExponent
        d = (kp.private as RSAPrivateKey).privateExponent
        nHex = VoiciJs.hex(Vouchers.i2osp(n, (n.bitLength() + 7) / 8))
        eHex = e.toString(16).let { if (it.length % 2 == 1) "0$it" else it }
        keyId = Vouchers.keyId(nHex, eHex)
    }

    var plan: String? = startPlan
    var paidUntil: Long = startPaidUntil
    val spent = HashSet<String>()
    var topUpBytes = 0L
    private var walletVersion = 0L
    private var walletBlob: JsonObject? = null
    val redeemCalls = mutableListOf<JsonObject>()

    private fun refuse(status: Int, code: String, extra: Map<String, JsonElement> = emptyMap()): Nothing =
        throw PaymentsHttpError(status, code, JsonObject(mapOf("error" to JsonPrimitive(code), "code" to JsonPrimitive(code)) + extra))

    override suspend fun config(): JsonObject = JsonObject(
        mapOf(
            "config" to cfg.toJson(),
            "keys" to JsonArray(listOf(JsonObject(mapOf("keyId" to JsonPrimitive(keyId), "nHex" to JsonPrimitive(nHex), "eHex" to JsonPrimitive(eHex), "issueUntil" to JsonPrimitive(0), "acceptUntil" to JsonPrimitive(0), "issuing" to JsonPrimitive(true))))),
            "testIssue" to JsonPrimitive(testIssue),
        ),
    )

    override suspend fun wallet(username: String): JsonObject? = walletBlob

    override suspend fun putWallet(username: String, device: VoiciDeviceSigner, blob: JsonObject) {
        val v = VoiciJs.time(blob["version"]) ?: refuse(400, "malformed")
        if (v != walletVersion + 1) refuse(409, "version-conflict", mapOf("wallet" to (walletBlob ?: kotlinx.serialization.json.JsonNull)))
        walletVersion = v
        walletBlob = blob
    }

    override suspend fun plan(username: String): PlanState {
        val active = plan != null && paidUntil + cfg.graceHours * 3_600_000L >= now()
        return PlanState(if (active) (if (plan == PaymentsConfig.PRO_MAX) "maker" else "hobby") else "free", if (active) paidUntil else 0)
    }

    override suspend fun allowance(username: String) = AllowanceState(0, 250L * 1024 * 1024 * 1024 + topUpBytes, remainingBytes + topUpBytes)

    private fun endAfter(target: String, count: Int, t: Long): Long {
        val unit = cfg.unitMs(target)
        var base = t
        val cur = plan
        if (cur != null && paidUntil > 0 && paidUntil + cfg.graceHours * 3_600_000L >= t) {
            if (cur == target) base = paidUntil
            else if (paidUntil > t) base = t + floor((paidUntil - t).toDouble() * unit / cfg.unitMs(cur)).toLong()
        }
        return base + count * unit
    }

    override suspend fun redeem(body: JsonObject): JsonObject {
        redeemCalls += body
        val t = now()
        val what = VoiciJs.str(body["for"]) ?: refuse(400, "malformed")
        val list = (body["vouchers"] as? JsonArray) ?: refuse(400, "malformed")
        if (list.isEmpty()) refuse(400, "malformed")
        if (list.size > cfg.maxPerRequest) refuse(400, "too-many")
        val key = com.flagshipserver.app.core.payments.VoucherKey(keyId, nHex, eHex)
        val vs = list.map { el ->
            val v = Vouchers.parse(el) ?: refuse(400, "malformed")
            if (!Vouchers.verify(key, v)) refuse(400, "bad-voucher", mapOf("nullifier" to JsonPrimitive(v.nullifier)))
            v
        }
        val active = plan != null && paidUntil + cfg.graceHours * 3_600_000L >= t
        if (what == "overage") {
            if (!active) refuse(409, "overage-needs-plan")
            if (vs.size.toLong() != cfg.overage.blockUnits) refuse(400, "overage-block-size")
            val already = vs.map { it.nullifier }.filter { it in spent }
            if (already.isNotEmpty()) refuse(409, "voucher-spent", mapOf("spent" to JsonArray(already.map(::JsonPrimitive))))
            spent += vs.map { it.nullifier }
            topUpBytes += cfg.overage.blockGb * 1024L * 1024 * 1024
            return JsonObject(mapOf("ok" to JsonPrimitive(true), "for" to JsonPrimitive(what), "credited" to JsonPrimitive(vs.size), "spent" to JsonArray(emptyList()), "topUpBytes" to JsonPrimitive(topUpBytes)))
        }
        if (!PaymentsConfig.isPaidPlan(what)) refuse(400, "malformed")
        if (endAfter(what, 0, t) - t > cfg.maxAheadDays * PaymentsConfig.DAY_MS) refuse(409, "plan-paid-ahead")
        val fresh = vs.filter { spent.add(it.nullifier) }
        val already = vs.filter { it !in fresh }.map { it.nullifier }
        if (fresh.isEmpty()) refuse(409, "voucher-spent", mapOf("spent" to JsonArray(already.map(::JsonPrimitive))))
        paidUntil = endAfter(what, fresh.size, t)
        plan = what
        return JsonObject(
            mapOf(
                "ok" to JsonPrimitive(true), "for" to JsonPrimitive(what), "credited" to JsonPrimitive(fresh.size),
                "spent" to JsonArray(already.map(::JsonPrimitive)), "plan" to JsonPrimitive(what), "paidUntil" to JsonPrimitive(paidUntil),
            ),
        )
    }

    override suspend fun testIssue(keyId: String, blinded: List<String>): List<String> {
        if (!testIssue) refuse(404, "issue-off")
        if (keyId != this.keyId) refuse(409, "no-key")
        if (blinded.size > 30) refuse(400, "too-many")
        return blinded.map { b ->
            val m = BigInteger(1, WebEnvelopes.b64Decode(b) ?: refuse(400, "malformed"))
            WebEnvelopes.b64Encode(Vouchers.i2osp(m.modPow(d, n), (n.bitLength() + 7) / 8))
        }
    }
}
