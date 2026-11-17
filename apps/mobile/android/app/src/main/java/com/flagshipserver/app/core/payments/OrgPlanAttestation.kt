// `.com`'s CA signature over an org's Business plan: the Kotlin twin of the org variant in
// packages/protocol/src/planAttestation.ts (vectors: test-vectors/org-plan `attestation`). The phone shows the plan
// `.com` serves; the attestation is what a box enforces. An attestation that doesn't verify means "plan unknown".
//
//   flagship/org-plan-attestation/v1|<orgId>|<status>|<seatLimit>|<paidSeats>|<trialEndsAt>|<paidUntil>|<issuedAt>|<expiresAt>

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonElement

data class OrgPlanAttestation(
    val orgId: String,
    val status: String,
    val seatLimit: Long,
    val paidSeats: Long,
    val trialEndsAt: Long,
    val paidUntil: Long,
    val issuedAt: Long,
    val expiresAt: Long,
    val signedBy: String = "",
    val signatures: List<Pair<String, String>> = emptyList(),
)

object OrgPlanAttestations {
    const val TAG = "flagship/org-plan-attestation/v1"
    private val ORG_ID = Regex("^[0-9a-f]{32}$")

    fun canonical(a: OrgPlanAttestation): ByteArray {
        require(ORG_ID.matches(a.orgId)) { TAG }
        require(a.status in OrgPlans.STATUSES) { TAG }
        require(listOf(a.seatLimit, a.paidSeats, a.trialEndsAt, a.paidUntil, a.issuedAt, a.expiresAt).all { it in 0..9_007_199_254_740_991 }) { TAG }
        require(a.expiresAt > a.issuedAt) { TAG }
        return VoiciJs.utf8(
            listOf(TAG, a.orgId, a.status, a.seatLimit, a.paidSeats, a.trialEndsAt, a.paidUntil, a.issuedAt, a.expiresAt).joinToString("|"),
        )
    }

    /** Shape-check an untrusted attestation (no signature check). */
    fun parse(v: JsonElement?): OrgPlanAttestation? {
        val o = VoiciJs.obj(v) ?: return null
        if (VoiciJs.str(o["kind"]) != "OrgPlanAttestation" || !VoiciJs.isNumEq(o["version"], 1)) return null
        val signedBy = VoiciJs.str(o["signedBy"]) ?: return null
        val sigs = VoiciJs.arr(o["signatures"])?.map { e ->
            val x = VoiciJs.obj(e) ?: return null
            (VoiciJs.str(x["pubkey"]) ?: return null) to (VoiciJs.str(x["sig"]) ?: return null)
        } ?: return null
        fun n(k: String) = VoiciJs.safeInt(o[k])
        val a = OrgPlanAttestation(
            VoiciJs.str(o["orgId"]) ?: return null,
            VoiciJs.str(o["status"]) ?: return null,
            n("seatLimit") ?: return null,
            n("paidSeats") ?: return null,
            n("trialEndsAt") ?: return null,
            n("paidUntil") ?: return null,
            n("issuedAt") ?: return null,
            n("expiresAt") ?: return null,
            signedBy,
            sigs,
        )
        return if (runCatching { canonical(a) }.isSuccess) a else null
    }

    /** True when one signature by [pubHex] (and named as `signedBy`) verifies and [now] is inside the validity window. */
    fun verify(a: OrgPlanAttestation, pubHex: String, now: Long): Boolean {
        if (now < a.issuedAt || now >= a.expiresAt) return false
        val pub = pubHex.lowercase()
        if (a.signedBy.lowercase() != pub || !WebEnvelopes.isLowerHex(pub, 32)) return false
        val msg = runCatching { canonical(a) }.getOrNull() ?: return false
        return a.signatures.any { (k, s) ->
            k.lowercase() == pub && WebEnvelopes.isLowerHex(s.lowercase(), 64) &&
                runCatching { PqHybrid.ed25519VerifyStrict(WebEnvelopes.hexToBytes(s.lowercase()), msg, WebEnvelopes.hexToBytes(pub)) }.getOrDefault(false)
        }
    }
}
