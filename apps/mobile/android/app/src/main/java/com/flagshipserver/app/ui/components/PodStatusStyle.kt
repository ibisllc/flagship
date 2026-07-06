package com.flagshipserver.app.ui.components

import com.flagshipserver.app.core.PodInfo

/**
 * Single source of truth for how a pod's derived liveness + raw status maps to
 * a user-facing label + [FSPillKind]. Shared by Home's server rows so the pill
 * wording never drifts. Byte-for-byte mirror of iOS `PodStatusStyle`.
 *
 * Pure (no Compose) so it's unit-testable.
 */
object PodStatusStyle {
    /** Pod-aware label: an [PodInfo.LivenessState.OFFLINE] (Fix A — previously
     *  live, now stale) box reads "Offline — last seen <…>" when `lastSeenMsAgo`
     *  is known. Falls through to [label] for every other state. */
    fun label(pod: PodInfo, liveness: PodInfo.LivenessState): String {
        if (liveness == PodInfo.LivenessState.OFFLINE) {
            val seen = pod.humanizedLastSeen()
            return if (seen != null) "Offline — last seen $seen" else "Offline"
        }
        return label(liveness, pod.status)
    }

    fun label(liveness: PodInfo.LivenessState, status: PodInfo.Status): String =
        when (liveness) {
            PodInfo.LivenessState.DEAD -> "Never came online"
            // HONEST LIVENESS (Fix A) — a previously-live box that's gone stale.
            PodInfo.LivenessState.OFFLINE -> "Offline"
            PodInfo.LivenessState.WAITING_FOR_APPROVAL -> "Waiting for approval"
            PodInfo.LivenessState.COMING_ONLINE ->
                if (status == PodInfo.Status.PENDING) "Pending" else "Coming online…"
            PodInfo.LivenessState.ONLINE -> when (status) {
                PodInfo.Status.ONLINE -> "Online"
                PodInfo.Status.OFFLINE -> "Offline"
                PodInfo.Status.UNKNOWN -> "Checking"
                PodInfo.Status.PENDING -> "Pending"
            }
        }

    fun pillKind(liveness: PodInfo.LivenessState, status: PodInfo.Status): FSPillKind =
        when (liveness) {
            PodInfo.LivenessState.DEAD -> FSPillKind.Offline
            PodInfo.LivenessState.OFFLINE -> FSPillKind.Offline
            PodInfo.LivenessState.WAITING_FOR_APPROVAL -> FSPillKind.Provisioning
            PodInfo.LivenessState.COMING_ONLINE -> FSPillKind.Provisioning
            PodInfo.LivenessState.ONLINE -> when (status) {
                PodInfo.Status.ONLINE -> FSPillKind.Online
                PodInfo.Status.OFFLINE -> FSPillKind.Offline
                PodInfo.Status.UNKNOWN -> FSPillKind.Idle
                PodInfo.Status.PENDING -> FSPillKind.Provisioning
            }
        }
}

/**
 * Home server-list status filter (the chip row). `All` shows everything; the
 * others narrow by derived liveness. Pure presentation. Mirror of iOS
 * `HomeStatusFilter`.
 *
 * Bucketing: Pending = waiting-for-approval + coming-online (and a still-pending
 * online box); Offline = dead + offline; Online = strictly live.
 */
enum class HomeStatusFilter {
    ALL, ONLINE, PENDING, OFFLINE;

    val label: String
        get() = when (this) {
            ALL -> "All"
            ONLINE -> "Online"
            PENDING -> "Pending"
            OFFLINE -> "Offline"
        }

    /** Whether a pod (given its derived liveness + status) belongs in this filter. */
    fun matches(liveness: PodInfo.LivenessState, status: PodInfo.Status): Boolean =
        when (this) {
            ALL -> true
            ONLINE -> liveness == PodInfo.LivenessState.ONLINE && status == PodInfo.Status.ONLINE
            PENDING -> when (liveness) {
                PodInfo.LivenessState.WAITING_FOR_APPROVAL,
                PodInfo.LivenessState.COMING_ONLINE -> true
                PodInfo.LivenessState.ONLINE ->
                    status == PodInfo.Status.PENDING || status == PodInfo.Status.UNKNOWN
                PodInfo.LivenessState.DEAD, PodInfo.LivenessState.OFFLINE -> false
            }
            OFFLINE -> when (liveness) {
                // DEAD (never came online) + OFFLINE (was live, now stale) both bucket here.
                PodInfo.LivenessState.DEAD, PodInfo.LivenessState.OFFLINE -> true
                PodInfo.LivenessState.ONLINE -> status == PodInfo.Status.OFFLINE
                else -> false
            }
        }

    companion object {
        /** Convenience for a chip row: all cases in display order. */
        fun allCases(): List<HomeStatusFilter> = entries.toList()
    }
}
