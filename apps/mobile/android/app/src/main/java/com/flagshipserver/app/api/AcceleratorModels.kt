// Wire shapes of the box's GPU screen (packages/server-daemon/src/gpu/http.ts):
// GET /api/screens/accelerators. Mirror of the webapp and iOS models.

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

@Serializable
data class AcceleratorsView(
    val available: Boolean = false,
    /** `no-accelerators`, `no-gpu-service`, another code from the GPU service, or null. */
    val reason: String? = null,
    /** Set while the GPU service admits no new work (running work keeps its device). */
    val admissionPaused: String? = null,
    val catalog: AcceleratorCatalog = AcceleratorCatalog(),
    val devices: List<AcceleratorDevice> = emptyList(),
    val queue: List<AcceleratorQueueEntry> = emptyList(),
    /** Apps asking to use a GPU: gpud refuses their claims until the owner signs flagship/gpu-approval/v1. */
    val pendingApprovals: List<GpuApprovalRequest> = emptyList(),
    /** The approvals in force. */
    val approvals: List<GpuApprovalRequest> = emptyList(),
)

/** One app installation's GPU terms as the box lists them (what the owner approves or withdraws). */
@Serializable
data class GpuApprovalRequest(
    val server: String = "",
    val appId: String,
    val installationId: String,
    val generation: Long,
    /** `nvidia-cuda`, `amd-rocm` or `intel-level-zero`. */
    val backend: String,
    val maxCount: Int,
    val caps: List<String>,
    val policies: List<String>,
    /** `gvisor-nvproxy` or `vm-passthrough`. */
    val isolation: String,
    val secrecy: Boolean,
    val trustDomain: String? = null,
    val ownerConsent: String? = null,
    /** When the owner signed it (granted approvals only). */
    val issuedAt: Long? = null,
) {
    val key: String get() = "$appId|$installationId|$generation"
}

/** `POST /api/screens/accelerators/approvals`: the listed terms, issuedAt and the signature. */
@Serializable
data class GpuApprovalBody(
    val server: String,
    val appId: String,
    val installationId: String,
    val generation: Long,
    val backend: String,
    val maxCount: Int,
    val caps: List<String>,
    val policies: List<String>,
    val isolation: String,
    val secrecy: Boolean,
    val trustDomain: String?,
    val ownerConsent: String?,
    val issuedAt: Long,
    val signature: String,
)

/** `POST /api/screens/accelerators/approvals/withdraw`. */
@Serializable
data class GpuApprovalWithdrawBody(val appId: String, val installationId: String, val generation: Long, val issuedAt: Long, val signature: String)

@Serializable
data class AcceleratorCatalog(val status: String = "unknown", val serial: Long? = null)

@Serializable
data class AcceleratorDevice(
    val id: String,
    val model: String,
    val vendor: String = "",
    val memoryMiB: Long = 0,
    /** `free`, `in-use`, `quarantined`, `unqualified` or `display`. */
    val state: String = "unqualified",
    val holders: List<AcceleratorHolder> = emptyList(),
)

@Serializable
data class AcceleratorHolder(val appId: String, val allocationId: String, val state: String = "running")

@Serializable
data class AcceleratorQueueEntry(val appId: String, val waiting: Int = 1)
