// Phone <-> Wear OS wire format over the Wearable Data Layer, the Android twin
// of iOS's WatchProtocol (WatchConnectivity). The phone publishes one
// [WatchContext] data item (the latest replaces the previous); the watch asks
// the phone to approve a boot unlock with an [ApproveCommand] request and gets
// an [ApproveReply]. The watch holds no key: the phone runs its own approval,
// re-verifying the request and signing with the watch-delegate key the owner
// enrolled. The command carries no consent; the phone's signature is it.

package com.flagshipserver.companion

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

object WatchPaths {
    /** Data item: the phone's latest [WatchContext]. */
    const val CONTEXT = "/flagship/watch-context"
    /** Request (watch -> phone): [ApproveCommand]; the response is an [ApproveReply]. */
    const val APPROVE_UNLOCK = "/flagship/approve-unlock"
    /** Data map key holding the context JSON. */
    const val CONTEXT_KEY = "json"
}

/** Everything the watch shows, as one snapshot. */
@Serializable
data class WatchContext(
    val status: PodStatusSnapshot = PodStatusSnapshot.EMPTY,
    val pendingApprovals: List<PendingApproval> = emptyList(),
    val recentEvents: List<SecurityAlert> = emptyList(),
    val provision: ProvisionTimeline? = null,
    val updatedAt: Long = 0,
) {
    fun encode(): String = JSON.encodeToString(serializer(), this)

    companion object {
        val EMPTY = WatchContext()
        fun decode(text: String?): WatchContext =
            text?.let { runCatching { JSON.decodeFromString(serializer(), it) }.getOrNull() } ?: EMPTY
    }
}

/** A box waiting for its boot unlock. [requestId] is set when the phone has
 *  fetched the pending request; a box known only from the server list's
 *  "waiting for approval" flag carries its address alone. */
@Serializable
data class PendingApproval(
    val requestId: String? = null,
    val serverFqdn: String,
    val serverName: String? = null,
    val requestedAt: Long = 0,
) {
    val id: String get() = requestId ?: serverFqdn
}

/** One recent account security event (the audit log's kind, detail and time). */
@Serializable
data class SecurityAlert(
    val seq: Int,
    val kind: String,
    val detail: String = "",
    val devicePrefix: String = "",
    val postedAt: Long = 0,
)

/** An install in flight (or just finished), for the watch's progress row. */
@Serializable
data class ProvisionTimeline(
    val key: String,
    val podName: String? = null,
    val serverDomain: String? = null,
    /** Canonical ProvisionStatusPhase wire string. */
    val phase: String,
    val detail: String? = null,
    val updatedAt: Long = 0,
) {
    val active: Boolean get() = phase != "live" && phase != "error"
}

/** Watch -> phone: approve this box's boot unlock. */
@Serializable
data class ApproveCommand(
    val kind: String = KIND,
    val requestId: String? = null,
    val serverFqdn: String,
) {
    fun encode(): ByteArray = JSON.encodeToString(serializer(), this).toByteArray()

    companion object {
        const val KIND = "approve-unlock"
        fun decode(bytes: ByteArray?): ApproveCommand? =
            bytes?.let { runCatching { JSON.decodeFromString(serializer(), String(it)) }.getOrNull() }
    }
}

/** Phone -> watch: what became of the approval. */
@Serializable
data class ApproveReply(
    val serverFqdn: String,
    val ok: Boolean,
    val errorMessage: String? = null,
) {
    fun encode(): ByteArray = JSON.encodeToString(serializer(), this).toByteArray()

    companion object {
        fun decode(bytes: ByteArray?): ApproveReply? =
            bytes?.let { runCatching { JSON.decodeFromString(serializer(), String(it)) }.getOrNull() }
    }
}

private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = true }

/**
 * What a watch line says, without the words: the watch turns each into text from its own string
 * resources ([WatchProjection] runs on the watch, over the raw [WatchContext] the phone sent), so the
 * tile, complication and app read in the watch's language, not the phone's, and this module stays
 * free of user-facing English.
 */
sealed interface WatchText {
    /** An install's phase, the short form ("Sealing"). */
    data class Phase(val phase: String) : WatchText
    /** [count] boxes wait for a boot approval. */
    data class Waiting(val count: Int) : WatchText
    /** [online] of [total] servers are up. */
    data class Up(val online: Int, val total: Int) : WatchText
    /** Nothing from the phone yet, or the phone is signed out: open Flagship there. */
    data object OpenPhone : WatchText
    /** The phone's account has no servers. */
    data object NoServers : WatchText
    /** Under [NoServers]: where to add one. */
    data object AddOnPhone : WatchText
    /** An install with no name yet. */
    data object NewServer : WatchText
    /** Several boxes wait: tap to pick one. */
    data object TapToApprove : WatchText
    /** The leading server's name, marked as leader. */
    data class Leader(val name: String) : WatchText
    /** A name from the owner's data, shown as is. */
    data class Name(val name: String) : WatchText
}

/** Pure projections behind the watch views, tile and complication (iOS's
 *  SecurityAlertsProjection + the complication's text). */
object WatchProjection {
    const val MAX_EVENTS = 5

    /** Waiting boxes, the longest-waiting first; one row per box. */
    fun approvals(ctx: WatchContext): List<PendingApproval> =
        ctx.pendingApprovals
            .groupBy { it.serverFqdn.lowercase() }
            .map { (_, rows) -> rows.firstOrNull { it.requestId != null } ?: rows.first() }
            .sortedBy { it.requestedAt }

    /** Recent events, newest first, de-duplicated, at most [MAX_EVENTS]. */
    fun events(ctx: WatchContext): List<SecurityAlert> =
        ctx.recentEvents.distinctBy { it.seq }.sortedByDescending { it.seq }.take(MAX_EVENTS)

    /** No account on the phone's side (never heard from it, or it is signed out): the
     *  person has to open Flagship there before the watch can show anything. */
    fun needsPhone(ctx: WatchContext): Boolean =
        ctx.status.pods.isEmpty() && ctx.status.username == null &&
            ctx.pendingApprovals.isEmpty() && ctx.provision == null

    /** Short complication / tile text: an install's phase, else how many boxes
     *  wait, else how many servers are online. */
    fun shortText(ctx: WatchContext): WatchText {
        ctx.provision?.takeIf { it.active }?.let { return WatchText.Phase(it.phase) }
        val waiting = approvals(ctx).size
        if (waiting > 0) return WatchText.Waiting(waiting)
        val pods = ctx.status.pods
        if (pods.isEmpty()) return if (needsPhone(ctx)) WatchText.OpenPhone else WatchText.NoServers
        return WatchText.Up(pods.count { it.statusRaw == "online" }, pods.size)
    }

    /** The tile's two lines. [attention] when a box waits or an install failed. */
    data class TileLines(val headline: WatchText, val detail: WatchText?, val attention: Boolean)

    fun tileLines(ctx: WatchContext): TileLines {
        ctx.provision?.let { p ->
            val name = p.podName?.let { WatchText.Name(it) } ?: WatchText.NewServer
            if (p.active) return TileLines(WatchText.Phase(p.phase), name, attention = false)
            if (p.phase == "error") return TileLines(WatchText.Phase(p.phase), name, attention = true)
        }
        val waiting = approvals(ctx)
        if (waiting.isNotEmpty()) {
            val first = waiting.first()
            val detail = if (waiting.size == 1) WatchText.Name(first.serverName ?: first.serverFqdn) else WatchText.TapToApprove
            return TileLines(WatchText.Waiting(waiting.size), detail, attention = true)
        }
        val short = shortText(ctx)
        if (short == WatchText.NoServers) return TileLines(short, WatchText.AddOnPhone, attention = false)
        val leader = ctx.status.headline
        return TileLines(short, leader?.let { if (it.isLeader) WatchText.Leader(it.name) else WatchText.Name(it.name) }, attention = false)
    }

    /** Install progress 0..1 for a ranged complication, or null when idle. */
    fun provisionFraction(ctx: WatchContext): Float? {
        val p = ctx.provision?.takeIf { it.active } ?: return null
        val i = LADDER.indexOf(p.phase)
        return if (i < 0) 0f else (i + 1).toFloat() / LADDER.size
    }

    val LADDER = listOf(
        "booting", "partitioning", "installing", "downloading",
        "registering", "sealing", "installed", "pairing", "live",
    )

    /** The install phases the watch names (provisionStatus.ts); any other shows a generic "setting up". */
    val PHASES = LADDER + "error"

    /** The audit event kinds the watch names (iOS SecurityAlertsProjection.label); any other shows its
     *  kind with the dashes as spaces, as iOS does. */
    val EVENT_KINDS = listOf(
        "device-disconnected", "device-replaced", "device-added", "wipe-restart", "recovery-set-up",
        "recovery-rotated", "app-renamed", "server-created", "server-online", "server-revoked",
        "server-unrevoked", "demo-vps-provisioned", "totp-enrolled", "totp-disabled", "re-pair-initiated",
    )

    /** An event kind the watch has no label for, made readable. */
    fun unknownEventLabel(kind: String): String = kind.replace('-', ' ').replaceFirstChar { it.uppercase() }
}
