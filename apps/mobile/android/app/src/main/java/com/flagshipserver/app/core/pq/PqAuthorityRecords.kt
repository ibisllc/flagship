package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.AdminRootRotation
import com.flagshipserver.app.core.DeviceCapabilityGrant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Quantum-safe stage 1 (docs/architecture-v2/pq-suites.md §20): the hybrid companions of
 * admin-root rotations and device capability grants. Kotlin twin of
 * `packages/protocol/src/pqAuthorityRecords.ts`; every port reads
 * `packages/protocol/test-vectors/pq-authority/vectors.json`.
 */
object PqAuthorityRecords {
    const val TAG_ROTATION_V2 = "flagship/admin-root-rotation/v2"
    const val TAG_DEVICE_GRANT = "flagship/device-capability-grant/v2"
    private val KEY_ID = Regex("^[0-9a-f]{64}$")

    /** What travels beside a v1 rotation: the old root's hybrid signature and the new root's binding. */
    data class RotationCompanion(val signature: PqTrust.SignatureEnvelope, val newRootBinding: PqTrust.Wire) {
        fun toJson(): JsonObject = buildJsonObject {
            put("signature", envelopeJson(signature))
            put("newRootBinding", newRootBinding.toJson())
        }
    }

    fun envelopeJson(e: PqTrust.SignatureEnvelope): JsonObject = buildJsonObject {
        put("suite", e.suite)
        put("signature", e.signature)
    }

    /** The hybrid key id of a binding's two keys (no signature check). */
    fun bindingKeyIdHex(ed25519PubHex: String, mldsaPubHex: String): String =
        PqHex.encode(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, PqTrust.pqBindingPublicKey(ed25519PubHex, mldsaPubHex)))

    /** `flagship/admin-root-rotation/v2|<username>|<oldRootHex>|<newRootHex>|<issuedAt>|<newRootKeyIdHex>`. */
    fun canonicalRotationV2(r: AdminRootRotation, newRootKeyIdHex: String): ByteArray {
        if (r.username.any { it == '|' || it.code <= 0x1f || it.code == 0x7f } || !KEY_ID.matches(newRootKeyIdHex) ||
            r.issuedAt < 0 || r.issuedAt > (1L shl 53) - 1
        ) throw PqTrustException("binding-malformed")
        return listOf(TAG_ROTATION_V2, r.username, r.oldAdminRootPub.lowercase(), r.newAdminRootPub.lowercase(), r.issuedAt.toString(), newRootKeyIdHex)
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** The companion; [oldRootSign] is the old root's hybrid signer (purpose, payload) → signature. */
    fun signRotation(r: AdminRootRotation, newRootBinding: PqTrust.Wire, oldRootSign: (String, ByteArray) -> ByteArray): RotationCompanion {
        val msg = canonicalRotationV2(r, bindingKeyIdHex(newRootBinding.ed25519PubHex, newRootBinding.mldsaPubHex))
        return RotationCompanion(PqTrust.SignatureEnvelope(PqTrust.SUITE_HYBRID, PqHex.encode(oldRootSign(TAG_ROTATION_V2, msg))), newRootBinding)
    }

    /** A grant's canonical bytes, as every port builds them. */
    fun grantBytes(grantId: String, username: String, deviceId: String, devicePubHex: String, scopes: List<String>, issuedAt: Long, expiresAt: Long): ByteArray =
        DeviceCapabilityGrant.canonicalBytes(grantId, username, deviceId, devicePubHex, scopes, issuedAt, expiresAt)

    /** A grant's companion: the signing root's hybrid signature over the grant's own bytes. */
    fun signGrant(grantBytes: ByteArray, rootSign: (String, ByteArray) -> ByteArray): PqTrust.SignatureEnvelope =
        PqTrust.SignatureEnvelope(PqTrust.SUITE_HYBRID, PqHex.encode(rootSign(TAG_DEVICE_GRANT, grantBytes)))

    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun envelope(raw: JsonElement?): PqTrust.SignatureEnvelope {
        val o = raw as? JsonObject ?: throw PqTrustException("bad-signature")
        val suite = str(o["suite"]) ?: throw PqTrustException("bad-signature")
        val sig = str(o["signature"]) ?: throw PqTrustException("bad-signature")
        if (suite != PqTrust.SUITE_HYBRID) throw PqTrustException(if (suite == PqTrust.SUITE_ED25519) "strict-requires-hybrid" else "unknown-suite")
        return PqTrust.SignatureEnvelope(suite, sig)
    }

    /** Verifies a rotation's companion and returns the new root's verified binding. */
    fun verifyRotation(r: AdminRootRotation, pq: JsonElement?, oldRootBinding: PqTrust.VerifiedBinding?, policy: AssurancePolicy.PolicyState, now: Long): PqTrust.VerifiedBinding {
        val o = pq as? JsonObject ?: throw PqTrustException("strict-requires-hybrid")
        val env = envelope(o["signature"])
        val wire = PqTrust.pqKeyBindingFromWire(o["newRootBinding"])
        val nb = PqTrust.verifyPqKeyBinding(wire, PqTrust.Expectation("admin-root", r.username.lowercase(), r.newAdminRootPub.lowercase(), now = now))
        PqTrust.verifyCriticalSignature(canonicalRotationV2(r, nb.keyIdHex), TAG_ROTATION_V2, env, r.oldAdminRootPub, oldRootBinding, policy)
        return nb
    }

    /** Verifies a grant's companion under the binding of the root its classical signature verified under. */
    fun verifyGrant(grantBytes: ByteArray, pq: JsonElement?, signerPubHex: String, signerBinding: PqTrust.VerifiedBinding?, policy: AssurancePolicy.PolicyState) {
        PqTrust.verifyCriticalSignature(grantBytes, TAG_DEVICE_GRANT, envelope(pq), signerPubHex, signerBinding, policy)
    }
}
