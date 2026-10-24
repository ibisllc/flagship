package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** JSON for [AssurancePolicy] changes, states and served chains, as `.com` sends them. */
object AssurancePolicyWire {
    private fun JsonObject.s(k: String): String = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: throw IllegalArgumentException("assurance-policy: \"$k\" must be a string")

    fun changeFromJson(o: JsonObject): AssurancePolicy.Change {
        val scope = o["scope"]!!.jsonObject
        val reentry = (o["reentry"] as? JsonObject)?.let {
            AssurancePolicy.StrictReentryEvidence(it.s("verifierChecksDigest"), it.s("enrollmentDigest"), it.s("rekeyReceiptDigest"), it.s("recoveryTestDigest"))
        }
        return AssurancePolicy.Change(
            account = o.s("account"),
            scope = AssurancePolicy.Scope(scope.s("kind"), scope.s("id")),
            prior = o.s("prior"),
            next = o.s("next"),
            generation = o["generation"]!!.jsonPrimitive.long,
            prevDigest = o.s("prevDigest"),
            affectedPeersDigest = o.s("affectedPeersDigest"),
            acknowledgedLoss = o["acknowledgedLoss"]!!.jsonArray.map { it.jsonPrimitive.content },
            reentry = reentry,
            signerKind = o.s("signerKind"),
            signerKeyId = o.s("signerKeyId"),
            suite = o.s("suite"),
            issuedAt = o["issuedAt"]!!.jsonPrimitive.long,
        )
    }

    fun changeToJson(c: AssurancePolicy.Change): JsonObject = buildJsonObject {
        put("account", c.account)
        putJsonObject("scope") { put("kind", c.scope.kind); put("id", c.scope.id) }
        put("prior", c.prior)
        put("next", c.next)
        put("generation", c.generation)
        put("prevDigest", c.prevDigest)
        put("affectedPeersDigest", c.affectedPeersDigest)
        putJsonArray("acknowledgedLoss") { c.acknowledgedLoss.forEach { add(JsonPrimitive(it)) } }
        c.reentry?.let { r ->
            putJsonObject("reentry") {
                put("verifierChecksDigest", r.verifierChecksDigest)
                put("enrollmentDigest", r.enrollmentDigest)
                put("rekeyReceiptDigest", r.rekeyReceiptDigest)
                put("recoveryTestDigest", r.recoveryTestDigest)
            }
        }
        put("signerKind", c.signerKind)
        put("signerKeyId", c.signerKeyId)
        put("suite", c.suite)
        put("issuedAt", c.issuedAt)
    }

    /** A served chain: `{ chain: [{ change, signature: { suite, signature } }] }`. */
    fun chainFromJson(body: JsonElement): List<AssurancePolicy.SignedChange> {
        val arr = (body as? JsonObject)?.get("chain") as? JsonArray ?: return emptyList()
        return arr.map { e ->
            val o = e.jsonObject
            val sig = o["signature"]!!.jsonObject
            AssurancePolicy.SignedChange(changeFromJson(o["change"]!!.jsonObject), PqTrust.SignatureEnvelope(sig.s("suite"), sig.s("signature")))
        }
    }
}
