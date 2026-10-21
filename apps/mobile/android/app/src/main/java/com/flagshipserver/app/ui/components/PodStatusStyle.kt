package com.flagshipserver.app.ui.components

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
            return if (seen != null) FSStrings.get(R.string.offline_last_seen, seen) else FSStrings.get(R.string.offline)
        }
        return label(liveness, pod.status)
    }

    fun label(liveness: PodInfo.LivenessState, status: PodInfo.Status): String =
        when (liveness) {
            PodInfo.LivenessState.REVOKED -> FSStrings.get(R.string.revoked)
            PodInfo.LivenessState.DEAD -> FSStrings.get(R.string.never_came_online)
            // HONEST LIVENESS (Fix A) — a previously-live box that's gone stale.
            PodInfo.LivenessState.OFFLINE -> FSStrings.get(R.string.offline)
            PodInfo.LivenessState.WAITING_FOR_APPROVAL -> FSStrings.get(R.string.waiting_for_approval)
            PodInfo.LivenessState.COMING_ONLINE ->
                if (status == PodInfo.Status.PENDING) FSStrings.get(R.string.pending) else FSStrings.get(R.string.coming_online)
            PodInfo.LivenessState.ONLINE -> when (status) {
                PodInfo.Status.ONLINE -> FSStrings.get(R.string.online)
                PodInfo.Status.OFFLINE -> FSStrings.get(R.string.offline)
                PodInfo.Status.UNKNOWN -> FSStrings.get(R.string.checking_2)
                PodInfo.Status.PENDING -> FSStrings.get(R.string.pending)
            }
        }

    fun pillKind(liveness: PodInfo.LivenessState, status: PodInfo.Status): FSPillKind =
        if (status == PodInfo.Status.PENDING) FSPillKind.Pending else
        when (liveness) {
            PodInfo.LivenessState.REVOKED -> FSPillKind.Offline
            PodInfo.LivenessState.DEAD -> FSPillKind.Offline
            PodInfo.LivenessState.OFFLINE -> FSPillKind.Offline
            PodInfo.LivenessState.WAITING_FOR_APPROVAL -> FSPillKind.Provisioning
            PodInfo.LivenessState.COMING_ONLINE -> FSPillKind.Provisioning
            PodInfo.LivenessState.ONLINE -> when (status) {
                PodInfo.Status.ONLINE -> FSPillKind.Online
                PodInfo.Status.OFFLINE -> FSPillKind.Offline
                PodInfo.Status.UNKNOWN -> FSPillKind.Idle
                PodInfo.Status.PENDING -> FSPillKind.Pending
            }
        }
}

/**
 * Home server-list status filter (the chip row). `All` shows everything; the
 * others narrow by derived liveness. Pure presentation. Mirror of iOS
 * `HomeStatusFilter`.
 *
 * Bucketing: Pending = waiting-for-approval + coming-online (and a still-pending
 * online box); Offline = dead + offline + revoked; Online = strictly live.
 */
enum class HomeStatusFilter {
    ALL, ONLINE, PENDING, OFFLINE;

    val label: String
        get() = when (this) {
            ALL -> FSStrings.get(R.string.all)
            ONLINE -> FSStrings.get(R.string.online)
            PENDING -> FSStrings.get(R.string.pending)
            OFFLINE -> FSStrings.get(R.string.offline)
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
                PodInfo.LivenessState.DEAD, PodInfo.LivenessState.OFFLINE,
                PodInfo.LivenessState.REVOKED -> false
            }
            OFFLINE -> when (liveness) {
                // DEAD (never came online) + OFFLINE (was live, now stale) both bucket here.
                PodInfo.LivenessState.DEAD, PodInfo.LivenessState.OFFLINE,
                PodInfo.LivenessState.REVOKED -> true
                PodInfo.LivenessState.ONLINE -> status == PodInfo.Status.OFFLINE
                else -> false
            }
        }

    companion object {
        /** Convenience for a chip row: all cases in display order. */
        fun allCases(): List<HomeStatusFilter> = entries.toList()
    }
}
