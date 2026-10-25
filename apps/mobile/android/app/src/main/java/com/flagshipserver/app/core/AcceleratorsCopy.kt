// The words of the server page's GPU card (packages/server-daemon/src/gpu/http.ts). Kept out of the
// Composables so the unit tests can pin them. Mirror of iOS AcceleratorsCopy and webapp lib/accelerators.js.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.AcceleratorDevice
import com.flagshipserver.app.api.AcceleratorHolder
import com.flagshipserver.app.api.AcceleratorQueueEntry
import com.flagshipserver.app.api.AcceleratorsView
import com.flagshipserver.app.api.GpuApprovalRequest

object AcceleratorsCopy {
    /** An app's name from its id: `<account>--<slug>` shows the slug as the app list does. */
    fun appName(appId: String): String {
        if (appId == "flagship-local-ai") return FSStrings.get(R.string.local_ai_title)
        val slug = appId.substringAfterLast("--").ifEmpty { appId }
        return slug.split("-").joinToString("-") { w -> w.replaceFirstChar { it.uppercaseChar() } }
    }

    fun device(d: AcceleratorDevice): String = FSStrings.get(R.string.accelerators_device, d.id, d.model)

    fun state(s: String): String = FSStrings.get(
        when (s) {
            "free" -> R.string.accelerators_state_free
            "in-use" -> R.string.accelerators_state_in_use
            "quarantined" -> R.string.accelerators_state_quarantined
            "display" -> R.string.accelerators_state_display
            else -> R.string.accelerators_state_unqualified
        },
    )

    fun holder(h: AcceleratorHolder): String {
        val app = appName(h.appId)
        return when (h.state) {
            "reserved", "admitted", "starting" -> FSStrings.get(R.string.accelerators_holder_starting, app)
            "releasing", "stopping" -> FSStrings.get(R.string.accelerators_holder_releasing, app)
            else -> FSStrings.get(R.string.accelerators_holder_using, app)
        }
    }

    fun waiting(q: AcceleratorQueueEntry): String {
        val app = appName(q.appId)
        return if (q.waiting <= 1) FSStrings.get(R.string.accelerators_waiting_one, app)
        else FSStrings.get(R.string.accelerators_waiting_many, app, q.waiting)
    }

    fun stopTitle(h: AcceleratorHolder): String = FSStrings.get(R.string.accelerators_stop_title, appName(h.appId))

    fun stopped(h: AcceleratorHolder): String = FSStrings.get(R.string.accelerators_stopped, appName(h.appId))

    // ---- Approvals (flagship/gpu-approval/v1) ----

    private fun vendor(backend: String) = when (backend) {
        "nvidia-cuda" -> "NVIDIA"
        "amd-rocm" -> "AMD"
        "intel-level-zero" -> "Intel"
        else -> backend
    }

    private fun capability(c: String) = when (c) {
        "compute" -> FSStrings.get(R.string.gpu_cap_compute)
        "graphics" -> FSStrings.get(R.string.gpu_cap_graphics)
        "video-encode" -> FSStrings.get(R.string.gpu_cap_video_encode)
        "video-decode" -> FSStrings.get(R.string.gpu_cap_video_decode)
        else -> c
    }

    private fun policy(p: String) = when (p) {
        "exclusive" -> FSStrings.get(R.string.gpu_policy_exclusive)
        "partition" -> FSStrings.get(R.string.gpu_policy_partition)
        "cooperative" -> FSStrings.get(R.string.gpu_policy_cooperative)
        else -> p
    }

    /** What the app gets: "1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps". */
    fun terms(r: GpuApprovalRequest): String {
        val order = GpuApprovalOrders.CAPABILITIES
        val parts = mutableListOf(FSStrings.get(R.string.gpu_count, r.maxCount, vendor(r.backend)))
        parts += r.caps.distinct().sortedBy { order.indexOf(it).let { i -> if (i < 0) 9 else i } }.map(::capability)
        parts += r.policies.distinct().sorted().map(::policy)
        parts += FSStrings.get(if (r.isolation == "vm-passthrough") R.string.gpu_isolation_vm else R.string.gpu_isolation_sandbox)
        if (r.secrecy) parts += FSStrings.get(R.string.gpu_secrecy)
        return parts.joinToString(", ")
    }

    fun asks(r: GpuApprovalRequest) = FSStrings.get(R.string.gpu_approval_asks, appName(r.appId), terms(r))
    fun allowed(r: GpuApprovalRequest) = FSStrings.get(R.string.gpu_approval_allowed, appName(r.appId), terms(r))
    fun approved(r: GpuApprovalRequest) = FSStrings.get(R.string.gpu_approval_approved, appName(r.appId))
    fun declined(r: GpuApprovalRequest) = FSStrings.get(R.string.gpu_approval_declined, appName(r.appId))
    fun withdrawn(r: GpuApprovalRequest) = FSStrings.get(R.string.gpu_approval_withdrawn, appName(r.appId))

    /** The card shows for a box that has, or had, GPU work to show; a box with no GPU stays quiet. */
    fun shows(v: AcceleratorsView): Boolean {
        if (v.devices.isNotEmpty() || v.queue.isNotEmpty() || v.admissionPaused != null || v.pendingApprovals.isNotEmpty() || v.approvals.isNotEmpty()) return true
        return !(v.reason == null || v.reason == "no-accelerators" || v.reason == "no-gpu-service")
    }
}
