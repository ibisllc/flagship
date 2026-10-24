package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.security.MessageDigest

/**
 * The PQ half of a CA endorsement lease (packages/protocol/src/caLeasePq.ts, pq-suites.md §16.3),
 * checked on the phone where a lease makes `.com`'s CA key trusted. Empty pin: every lease counts
 * as before. Once [PIN] names a key, a lease counts only with its verified hybrid companion (under
 * a `release-key` binding, subject `flagship-ca-track`, whose key id is pinned), unless its v1
 * digest is in `legacyLeases`. Vectors: test-vectors/ca-lease-pq/vectors.json.
 */
object CaLeasePq {
    const val TAG_CA_LEASE_V2 = "flagship/ca-lease/v2"
    const val BINDING_SUBJECT = "flagship-ca-track"

    data class Pin(val keyIds: List<String>, val legacyLeases: List<String>)

    /** Mirrors `CA_LEASE_PQ_PIN` in caLeasePq.ts (a test keeps them equal). */
    val PIN = Pin(keyIds = emptyList(), legacyLeases = emptyList())

    fun v1Digest(e: CaEndorsement): String? = runCatching {
        PqHex.encode(MessageDigest.getInstance("SHA-256").digest(MaintainersCanonical.canonicalCaEndorsement(e)))
    }.getOrNull()

    private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The leases that may give authority (the classical checks still run on them after). */
    fun gate(leases: List<CaEndorsement>, bindings: List<JsonElement>, endorsements: List<JsonElement>, pin: Pin = PIN, nowMs: Long): List<CaEndorsement> {
        if (pin.keyIds.isEmpty()) return leases
        val pinned = pin.keyIds.map { it.lowercase() }.toSet()
        val verified = mutableMapOf<String, PqTrust.VerifiedBinding>()
        for (raw in bindings) {
            val ed = (raw as? JsonObject)?.let { str(it, "ed25519PubHex") } ?: continue
            val b = runCatching { PqTrust.verifyPqKeyBinding(raw, PqTrust.Expectation("release-key", BINDING_SUBJECT, ed, null, nowMs)) }.getOrNull() ?: continue
            if (b.keyIdHex in pinned) verified[b.keyIdHex] = b
        }
        return leases.filter { e ->
            val digest = v1Digest(e) ?: return@filter false
            if (digest in pin.legacyLeases) return@filter true
            endorsements.any { raw ->
                val w = raw as? JsonObject ?: return@any false
                if (str(w, "kind") != "CaEndorsementPq" || (w["version"] as? JsonPrimitive)?.intOrNull != 2) return@any false
                if (str(w, "endorsementId") != e.endorsementId || str(w, "v1Digest") != digest || str(w, "suite") != "hybrid-ed25519-mldsa65/v1") return@any false
                val keyId = str(w, "keyId") ?: return@any false
                val sig = str(w, "signature")?.let { PqHex.decode(it) } ?: return@any false
                val b = verified[keyId] ?: return@any false
                if (b.ed25519PubHex != e.signedBy.lowercase()) return@any false
                val msg = listOf(TAG_CA_LEASE_V2, e.endorsementId, digest, e.signedBy.lowercase(), keyId).joinToString("|").toByteArray(Charsets.UTF_8)
                runCatching { PqHybrid.hybridVerify(b.hybridPublicKey, TAG_CA_LEASE_V2, msg, sig) }.isSuccess
            }
        }
    }
}
