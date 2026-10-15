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

    /** Short complication / tile text: an install's phase, else how many boxes
     *  wait, else how many servers are online. */
    fun shortText(ctx: WatchContext): String {
        ctx.provision?.takeIf { it.active }?.let { return phaseShort(it.phase) }
        val waiting = approvals(ctx).size
        if (waiting > 0) return "$waiting waiting"
        val pods = ctx.status.pods
        if (pods.isEmpty()) return "No servers"
        return "${pods.count { it.statusRaw == "online" }}/${pods.size} up"
    }

    /** The tile's two lines. [attention] when a box waits or an install failed. */
    data class TileLines(val headline: String, val detail: String?, val attention: Boolean)

    fun tileLines(ctx: WatchContext): TileLines {
        ctx.provision?.let { p ->
            if (p.active) return TileLines(phaseShort(p.phase), p.podName ?: "New server", attention = false)
            if (p.phase == "error") return TileLines(phaseShort(p.phase), p.podName ?: "New server", attention = true)
        }
        val waiting = approvals(ctx)
        if (waiting.isNotEmpty()) {
            val first = waiting.first()
            val detail = if (waiting.size == 1) first.serverName ?: first.serverFqdn else "Tap to approve"
            return TileLines("${waiting.size} waiting", detail, attention = true)
        }
        val leader = ctx.status.headline
        return TileLines(shortText(ctx), leader?.let { if (it.isLeader) "Leader: ${it.name}" else it.name }, attention = false)
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

    fun phaseShort(phase: String): String = when (phase) {
        "booting" -> "Booting"
        "partitioning" -> "Disk"
        "installing" -> "Install"
        "downloading" -> "Download"
        "registering" -> "Register"
        "sealing" -> "Sealing"
        "installed" -> "Unplug"
        "pairing" -> "Pairing"
        "live" -> "Live"
        "error" -> "Problem"
        else -> "Setup"
    }

    /** Canonical phase title (provisionStatus.ts PHASE_TITLES). */
    fun phaseTitle(phase: String): String = when (phase) {
        "booting" -> "Booting up"
        "downloading" -> "Downloading"
        "partitioning" -> "Partitioning disk"
        "installing" -> "Installing"
        "installed" -> "Install complete"
        "registering" -> "Registering with Flagship"
        "sealing" -> "Sealing your disk key"
        "pairing" -> "Pairing with your phone"
        "live" -> "Your server is live"
        "error" -> "Setup hit a problem"
        else -> phase
    }

    /** Human label for an audit event kind (iOS SecurityAlertsProjection.label). */
    fun eventLabel(kind: String): String = when (kind) {
        "device-disconnected" -> "Disconnected device"
        "device-replaced" -> "Replaced device"
        "device-added" -> "Added device"
        "wipe-restart" -> "Wiped & restarted"
        "recovery-set-up" -> "Set up recovery"
        "recovery-rotated" -> "Rotated recovery passkey"
        "app-renamed" -> "Renamed app URL"
        "server-created" -> "Created server"
        "server-online" -> "Server came online"
        "server-revoked" -> "Revoked server"
        "server-unrevoked" -> "Restored server"
        "demo-vps-provisioned" -> "Demo server provisioned"
        "totp-enrolled" -> "Turned on authenticator codes"
        "totp-disabled" -> "Turned off authenticator codes"
        "re-pair-initiated" -> "Started device replacement"
        else -> kind.replace('-', ' ').replaceFirstChar { it.uppercase() }
    }
}
