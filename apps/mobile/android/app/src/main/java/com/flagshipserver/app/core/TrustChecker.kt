// Kotlin mirror of FlagshipUI/TrustChecker.swift.
//
// Fetches GET /api/maintainer-blessing from `.com` and yields the verdict to
// the TrustCenter. The client runs the full BAKED_PIN ->
// verifyMandateChainFromPin -> authorizedCaKeys(now) check ITSELF (over the
// served chain), at the CALLER's clock, and requires the served CA pubkey to be
// authorized live now.
//
// Failure-class discipline: a NETWORK error is NO verdict — we never brick on
// the absence of a verdict, only on a valid response that fails verification.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

class TrustChecker(
    private val transport: JsonHttpTransport,
    private val baseUrl: String = "https://flagshipserver.com",
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    @Serializable
    private data class SigJson(val pubkey: String, val sig: String)

    @Serializable
    private data class ApprovalJson(val kind: String, val threshold: Int)

    @Serializable
    private data class ProjectJson(
        val name: String? = null,
        val contact: String? = null,
        val homepage: String? = null,
        val tracks: List<String>? = null,
    )

    @Serializable
    private data class MandateJson(
        val kind: String,
        val version: Int,
        val mandateId: String,
        val track: String,
        val holder: String,
        val issuedAt: String,
        val expiresAt: String,
        val successors: List<String>,
        val approvalRule: ApprovalJson,
        val minSuccessors: Int,
        val maxDurationSeconds: Int,
        val defaultDurationSeconds: Int,
        val project: ProjectJson? = null,
        val signedBy: String,
        val signatures: List<SigJson>,
    )

    @Serializable
    private data class CaEndorsementJson(
        val kind: String,
        val version: Int,
        val endorsementId: String,
        val track: String,
        val caPubkey: String,
        val scope: String,
        val notBefore: String,
        val notAfter: String,
        val issuedAt: String,
        val signedBy: String,
        val signatures: List<SigJson>,
    )

    @Serializable
    private data class BlessingJson(
        val version: Int,
        val pinnedMandateHash: String,
        val caPubkey: String,
        val mandates: List<MandateJson>,
        val caEndorsements: List<CaEndorsementJson>,
    )

    private fun toMandate(j: MandateJson) = Mandate(
        kind = j.kind, version = j.version, mandateId = j.mandateId, track = j.track,
        holder = j.holder, issuedAt = j.issuedAt, expiresAt = j.expiresAt,
        successors = j.successors,
        approvalRule = MaintainersApprovalRule(j.approvalRule.kind, j.approvalRule.threshold),
        minSuccessors = j.minSuccessors, maxDurationSeconds = j.maxDurationSeconds,
        defaultDurationSeconds = j.defaultDurationSeconds,
        project = j.project?.let { MaintainersProject(it.name, it.contact, it.homepage, it.tracks) },
        signedBy = j.signedBy,
        signatures = j.signatures.map { MaintainersSignature(it.pubkey, it.sig) },
    )

    private fun toEndorsement(j: CaEndorsementJson) = CaEndorsement(
        kind = j.kind, version = j.version, endorsementId = j.endorsementId, track = j.track,
        caPubkey = j.caPubkey, scope = j.scope, notBefore = j.notBefore, notAfter = j.notAfter,
        issuedAt = j.issuedAt, signedBy = j.signedBy,
        signatures = j.signatures.map { MaintainersSignature(it.pubkey, it.sig) },
    )

    sealed interface Outcome {
        data object Trusted : Outcome
        data class Untrusted(val failure: TrustFailure) : Outcome
        data object NoVerdict : Outcome
    }

    private val parser = Json { ignoreUnknownKeys = true }

    /** Fetch + verify. Trusted/Untrusted on a VALID response; NoVerdict on a
     *  network/parse failure (caller leaves the center untouched). */
    suspend fun check(): Outcome {
        val blessing: MaintainerBlessing
        try {
            val resp = transport.execute("GET", "$baseUrl/api/maintainer-blessing")
            val j = parser.decodeFromString(BlessingJson.serializer(), String(resp.body, Charsets.UTF_8))
            blessing = MaintainerBlessing(
                pinnedMandateHash = j.pinnedMandateHash,
                caPubkey = j.caPubkey,
                mandates = j.mandates.map(::toMandate),
                caEndorsements = j.caEndorsements.map(::toEndorsement),
            )
        } catch (_: Throwable) {
            return Outcome.NoVerdict // network/parse/non-2xx → no verdict
        }

        return if (MaintainersComTrust.verifyComBlessing(blessing, now())) {
            Outcome.Trusted
        } else {
            Outcome.Untrusted(
                TrustFailure(
                    certClass = TrustCertClass.CONTROL,
                    certHash = TrustException.certHashForCaPubkey(blessing.caPubkey),
                    caPubkey = blessing.caPubkey,
                ),
            )
        }
    }
}
