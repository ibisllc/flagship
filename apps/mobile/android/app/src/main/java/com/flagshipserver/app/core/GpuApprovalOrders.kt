package com.flagshipserver.app.core

import com.flagshipserver.app.api.GpuApprovalBody
import com.flagshipserver.app.api.GpuApprovalRequest
import com.flagshipserver.app.api.GpuApprovalWithdrawBody
import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * The owner's GPU approval for one app installation on one box, which flagship-gpud verifies itself,
 * and its withdrawal. Signed with the sensitive-order key (the admin root, else the IRK on an account
 * without one). Wire parity with packages/protocol/src/gpuApproval.ts; pinned by
 * packages/protocol/test-vectors/gpu-approval/vectors.json.
 *
 *   flagship/gpu-approval/v1|<server>|<appId>|<installationId>|<generation>|<backend>|<maxCount>
 *     |<caps sorted, comma-joined>|<policies sorted, comma-joined>|<isolation>|<secrecy 1|0>
 *     |<trustDomain or empty>|<ownerConsent or empty>|<issuedAt>
 *   flagship/gpu-approval-withdraw/v1|<server>|<appId>|<installationId>|<generation>|<issuedAt>
 */
object GpuApprovalOrders {
    const val TAG = "flagship/gpu-approval/v1"
    const val WITHDRAW_TAG = "flagship/gpu-approval-withdraw/v1"

    val BACKENDS = listOf("nvidia-cuda", "amd-rocm", "intel-level-zero")
    val CAPABILITIES = listOf("compute", "graphics", "video-encode", "video-decode")
    val POLICIES = listOf("exclusive", "partition", "cooperative")
    val ISOLATIONS = listOf("gvisor-nvproxy", "vm-passthrough")
    private const val MAX_GANG = 16

    private val SERVER = Regex("^[a-z0-9.-]{1,253}$")
    private val FIELD = Regex("^[A-Za-z0-9._:-]{1,128}$")

    private fun sortedSet(items: List<String>, allowed: List<String>, what: String): String {
        require(items.isNotEmpty()) { "gpu-approval: no $what" }
        for (i in items) require(i in allowed) { "gpu-approval: unknown $what" }
        return items.toSortedSet().joinToString(",")
    }

    private fun ids(server: String, appId: String, installationId: String, generation: Long, issuedAt: Long) {
        require(SERVER.matches(server)) { "gpu-approval: bad serverDomain" }
        require(FIELD.matches(appId) && FIELD.matches(installationId)) { "gpu-approval: bad app installation" }
        require(generation >= 0) { "gpu-approval: bad generation" }
        require(issuedAt >= 0) { "gpu-approval: bad issuedAt" }
    }

    fun canonical(server: String, r: GpuApprovalRequest, issuedAt: Long): ByteArray {
        ids(server, r.appId, r.installationId, r.generation, issuedAt)
        require(r.maxCount in 1..MAX_GANG) { "gpu-approval: maxCount is 1 to 16" }
        require(r.backend in BACKENDS) { "gpu-approval: unknown backend" }
        require(r.isolation in ISOLATIONS) { "gpu-approval: unknown isolation" }
        fun opt(v: String?, what: String): String {
            if (v == null) return ""
            require(FIELD.matches(v)) { "gpu-approval: bad $what" }
            return v
        }
        return listOf(
            TAG, server, r.appId, r.installationId, r.generation.toString(), r.backend, r.maxCount.toString(),
            sortedSet(r.caps, CAPABILITIES, "capability"), sortedSet(r.policies, POLICIES, "policy"), r.isolation,
            if (r.secrecy) "1" else "0", opt(r.trustDomain, "trust domain"), opt(r.ownerConsent, "consent"), issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun withdrawCanonical(server: String, appId: String, installationId: String, generation: Long, issuedAt: Long): ByteArray {
        ids(server, appId, installationId, generation, issuedAt)
        return listOf(WITHDRAW_TAG, server, appId, installationId, generation.toString(), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** The trust domain an owner's approval of cooperative sharing names: the account's own apps. */
    const val COOPERATIVE_TRUST_DOMAIN = "owner-apps"

    /**
     * The terms the owner signs for a listed request. The box lists a request with no trust domain or
     * consent; sharing a GPU between apps (cooperative) needs both, so the owner's approval names the
     * account's own apps as the trust domain and records this approval as the consent.
     */
    fun ownerTerms(r: GpuApprovalRequest, issuedAt: Long): GpuApprovalRequest =
        if ("cooperative" !in r.policies) r
        else r.copy(trustDomain = r.trustDomain ?: COOPERATIVE_TRUST_DOMAIN, ownerConsent = r.ownerConsent ?: "owner-consent-$issuedAt")

    fun sign(server: String, r: GpuApprovalRequest, issuedAt: Long, signer: Ed25519Sign): GpuApprovalBody =
        GpuApprovalBody(
            server, r.appId, r.installationId, r.generation, r.backend, r.maxCount, r.caps, r.policies, r.isolation, r.secrecy,
            r.trustDomain, r.ownerConsent, issuedAt, HexUtil.encode(signer.sign(canonical(server, r, issuedAt))),
        )

    fun signWithdraw(server: String, r: GpuApprovalRequest, issuedAt: Long, signer: Ed25519Sign): GpuApprovalWithdrawBody =
        GpuApprovalWithdrawBody(
            r.appId, r.installationId, r.generation, issuedAt,
            HexUtil.encode(signer.sign(withdrawCanonical(server, r.appId, r.installationId, r.generation, issuedAt))),
        )

    /** The request an approval body describes (the mock box reads bodies back). */
    fun request(b: GpuApprovalBody): GpuApprovalRequest =
        GpuApprovalRequest(b.server, b.appId, b.installationId, b.generation, b.backend, b.maxCount, b.caps, b.policies, b.isolation,
            b.secrecy, b.trustDomain, b.ownerConsent)
}
