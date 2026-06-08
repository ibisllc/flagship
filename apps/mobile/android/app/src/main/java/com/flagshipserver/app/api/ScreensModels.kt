// Flagship `/api/screens/*` BFF contract — Kotlin mirror.
//
// MIRRORS: packages/server-daemon/src/screens/types.ts
// When the daemon's BFF contract changes, update this file in lockstep.
// Field names + JSON keys must match exactly so kotlinx-serialization
// round-trips with the daemon's `JSON.stringify(...)` output.

package com.flagshipserver.app.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// ---------- Shared shapes ----------------------------------------------

@Serializable
data class AppSummary(
    val serviceId: String,
    val creator: String,
    val slug: String,
    val urlLabel: String,
    val summary: String? = null,
    val url: String,
    val status: String,            // "running" | "stopped" | "unknown"
    val version: String? = null,
    val installedAt: Long,
)

@Serializable
data class RecentInstallEvent(
    val at: Long,
    val kind: String,              // "installed" | "uninstalled" | "deploy" | "update-pulled"
    val serviceId: String,
    val detail: String? = null,
)

// ---------- P1.1 server-detail -----------------------------------------

@Serializable
data class ServerDetailResponse(
    val serverFqdn: String,
    val username: String,
    val daemonVersion: String,
    val startedAt: Long,
    val uptimeMs: Long,
    val certNotAfter: Long? = null,
    val certNotBefore: Long? = null,
    val certSans: List<String>? = null,
    val serviceCount: Int,
    val pairedSessionCount: Int,
    val recentInstallEvents: List<RecentInstallEvent>,
)

// ---------- P1.2 apps-list ---------------------------------------------

@Serializable
data class AppsListResponse(val apps: List<AppSummary>)

// ---------- P1.3 app-detail --------------------------------------------

@Serializable
data class AppDetailResponse(
    val app: AppSummary,
    val manifest: Map<String, JsonElement>,
    val dataLayerInstances: List<DataLayerInstance>,
    val members: List<AppMember>,
    val browserTabs: List<BrowserTabRef>,
    val lastBackup: BackupSummary? = null,
    val recentLogs: List<String>,
) {
    @Serializable
    data class DataLayerInstance(val store: String, val instanceName: String)

    @Serializable
    data class AppMember(
        val stableIdPrefix: String,
        val role: String,
        val addedAt: Long,
    )

    @Serializable
    data class BrowserTabRef(val tabId: String)

    @Serializable
    data class BackupSummary(
        val backupId: String,
        val createdAt: Long,
        val bytes: Long,
    )
}

// ---------- P1.5 vibe-code/start ---------------------------------------

@Serializable
data class VibeCodeStartRequest(val prompt: String, val model: String? = null)

@Serializable
data class VibeCodeStartResponse(val sessionId: String)

// ---------- P1.6 vibe-code stream frames -------------------------------

@Serializable
sealed class VibeCodeFrame {
    @Serializable @SerialName("token") data class Token(val text: String) : VibeCodeFrame()
    @Serializable @SerialName("manifest-emit") data class ManifestEmit(val manifestJson: String) : VibeCodeFrame()
    @Serializable @SerialName("repo-create") data class RepoCreate(val repoFullName: String) : VibeCodeFrame()
    @Serializable @SerialName("build-start") object BuildStart : VibeCodeFrame()
    @Serializable @SerialName("build-log") data class BuildLog(val line: String) : VibeCodeFrame()
    @Serializable @SerialName("deploy") data class Deploy(val serviceId: String, val url: String) : VibeCodeFrame()
    @Serializable @SerialName("done") object Done : VibeCodeFrame()
    @Serializable @SerialName("error") data class Err(val message: String) : VibeCodeFrame()
}

// ---------- P1.7 vibe-code/:id status ----------------------------------

@Serializable
data class VibeCodeStatusResponse(
    val status: String,
    val transcript: List<TranscriptEntry>,
    val files: Map<String, String>,
    val deployedUrl: String? = null,
    val errorReason: String? = null,
) {
    @Serializable
    data class TranscriptEntry(val role: String, val content: String)
}

// ---------- P1.10 / P1.11 browser-tabs ---------------------------------

@Serializable
data class BrowserTab(
    val tabId: String,
    val serviceId: String,
    val currentUrl: String? = null,
    val title: String? = null,
    val screenshotKey: String? = null,
    val needsField: String? = null,    // "password" | "text" | "code"
)

@Serializable
data class BrowserTabsListResponse(val tabs: List<BrowserTab>)

// ---------- P1.12 / P1.13 paired-sessions ------------------------------

@Serializable
data class PairedSessionSummary(
    val tokenPrefix: String,
    val label: String,
    val addedAt: Long,
    val current: Boolean,
)

@Serializable
data class PairedSessionsListResponse(val sessions: List<PairedSessionSummary>)

// ---------- P1.14 orders/send ------------------------------------------

@Serializable
data class OrdersSendRequest(val envelope: String, val kind: String)

@Serializable
data class OrdersSendResponse(
    val ok: Boolean,
    val response: Map<String, JsonElement>? = null,
)

// ---------- P1.15 install-events (SSE) — DEMOTED to debug-only ---------
//
// `install-events` is no longer a provisioning-progress UI channel. The
// ONE canonical channel is `order-status` (ProvisionStatus below). This
// sealed class + the `ScreensClient.installEvents` SSE flow survive ONLY
// as a debug decoder for the retained `install_events` table (workspace
// artifact); no provisioning UI reads it. Do NOT add new UI consumers.

@Serializable
sealed class InstallEvent {
    @Serializable @SerialName("registered") data class Registered(val serial: String, val at: Long) : InstallEvent()
    @Serializable @SerialName("boot") data class Boot(val at: Long) : InstallEvent()
    @Serializable @SerialName("tunnel-online") data class TunnelOnline(val at: Long) : InstallEvent()
    @Serializable @SerialName("cert-issued") data class CertIssued(val at: Long) : InstallEvent()
    @Serializable @SerialName("ready") data class Ready(val serverFqdn: String, val at: Long) : InstallEvent()
    @Serializable @SerialName("failed") data class Failed(val reason: String, val at: Long) : InstallEvent()
}

// ---------- Canonical provisioning channel — order-status --------------
//
// The ONE provisioning-progress channel + vocabulary. Consumed identically
// by Swift (iOS ProvisionStatus / ProvisionStatusPhase) and JS (webapp).
//
//   GET  /api/order/<serial>/status  → ProvisionStatusRecord (404 = none yet)
//   POST /api/order/<serial>/status  body { phase, detail? }  (box writes)
//
// MIRRORS: packages/storage/src/types.ts `ProvisionStatusRecord` +
// packages/control-plane/src/provisionStatus.ts `PROVISION_STATUS_PHASES`.
// Field names + JSON keys are byte-identical with the canonical channel
// JSON so kotlinx-serialization round-trips with the Worker output.

/** The ONE ordered phase ladder (terminal `error` off-ladder). Wire
 *  strings are the canonical `ProvisionStatusPhase` values. Forward-compat:
 *  an unrecognised wire string decodes to [UNKNOWN] (never part of
 *  [ordered]) so an older binary doesn't crash on a newer Worker. */
@Serializable
enum class ProvisionStatusPhase(val wire: String) {
    @SerialName("booting")      BOOTING("booting"),
    @SerialName("downloading")  DOWNLOADING("downloading"),
    @SerialName("partitioning") PARTITIONING("partitioning"),
    @SerialName("installing")   INSTALLING("installing"),
    @SerialName("registering")  REGISTERING("registering"),
    @SerialName("sealing")      SEALING("sealing"),
    @SerialName("pairing")      PAIRING("pairing"),
    @SerialName("live")         LIVE("live"),
    @SerialName("error")        ERROR("error"),
    @SerialName("unknown")      UNKNOWN("unknown");

    /** Terminal phases stop the poller (success or failure). */
    val isTerminal: Boolean get() = this == LIVE || this == ERROR

    companion object {
        /** The happy-path ladder, in order, EXCLUDING terminal `error`
         *  (and the `unknown` sentinel). */
        val ordered: List<ProvisionStatusPhase> = listOf(
            BOOTING, DOWNLOADING, PARTITIONING, INSTALLING,
            REGISTERING, SEALING, PAIRING, LIVE,
        )

        /** Forward-compat parse from a wire string → [UNKNOWN] when
         *  unrecognised (never throws). */
        fun fromWire(wire: String?): ProvisionStatusPhase =
            entries.firstOrNull { it.wire == wire } ?: UNKNOWN
    }
}

/** One entry in a provision-status row's append-only history. Mirrors
 *  `ProvisionStatusHistoryEntry`: `{ phase, detail?, ts }`. */
@Serializable
data class ProvisionStatusEntry(
    val phase: String,
    val detail: String? = null,
    /** Wall-clock ms of the report. */
    val ts: Long,
)

/** GET /api/order/<serial>/status response. Mirrors
 *  `ProvisionStatusRecord`: `{ serial, serverDomain?, phase, detail?,
 *  updatedAt, history[] }`. A 404 ("no status") is surfaced as `null`
 *  by the client, not this type. */
@Serializable
data class ProvisionStatusRecord(
    val serial: String,
    /** The server FQDN once the box has registered it; null before. */
    val serverDomain: String? = null,
    /** The latest reported phase (raw wire string; parse via
     *  [ProvisionStatusPhase.fromWire]). */
    val phase: String,
    /** Free-form latest detail (error text, percentage, etc.). */
    val detail: String? = null,
    /** Wall-clock ms of the latest report. */
    val updatedAt: Long,
    /** Append-only history of every phase report, oldest first. */
    val history: List<ProvisionStatusEntry> = emptyList(),
)

// ---------- P1.16 tier-status ------------------------------------------

@Serializable
data class TierStatusResponse(
    val tier: String,                              // "free" | "promo" | "byok"
    val llmCreditsRemainingDay: Long? = null,
    val llmCreditsRemainingTotal: Long? = null,
    val dispatcherUsageGBmonth: Double? = null,
    val dispatcherFreeQuotaGBmonth: Double? = null,
    val customDomains: List<String>,
    val reservedNames: List<String>,
)

// ---------- P1.17 / P1.18 url-controller -------------------------------

@Serializable
data class OwnedUrl(
    val fqdn: String,
    val kind: String,           // "canonical" | "alias" | "custom"
    val claimedAt: Long,
)

@Serializable
data class UrlControllerOwnedResponse(val urls: List<OwnedUrl>)

@Serializable
data class UrlControllerClaimRequest(val fqdn: String)

@Serializable
data class UrlControllerClaimResponse(val ok: Boolean)

// ---------- P1.19 / P1.20 app-backup -----------------------------------

@Serializable
data class AppBackupStartRequest(
    val serviceId: String,
    val password: String? = null,
    val includeUserData: Boolean? = null,
)

@Serializable
data class AppBackupStartResponse(
    val backupId: String,
    val fetchPath: String,
    val expiresAt: Long,
    val bytes: Long,
    val encrypted: Boolean,
)

// ---------- P1.21 server-metrics (extension) ---------------------------
//
// CPU% / memory / disk / I/O / network with a 60-sample 1-min trailing
// window for each. Daemon side is pending — contract is iOS-driven for
// now; this Kotlin mirror keeps the two clients identical.

@Serializable
data class ServerMetricsResponse(
    val collectedAt: Long,
    val cpuPercent: Double,
    val loadAvg1: Double,
    val loadAvg5: Double,
    val loadAvg15: Double,
    val memUsedBytes: Long,
    val memTotalBytes: Long,
    val diskUsedBytes: Long,
    val diskTotalBytes: Long,
    val diskIOReadBytesPerSec: Double,
    val diskIOWriteBytesPerSec: Double,
    val netRxBytesPerSec: Double,
    val netTxBytesPerSec: Double,
    val cpuHistory: List<TimedSample>,
    val memHistory: List<TimedSample>,
    val ioHistory: List<IOSample>,
    val netHistory: List<IOSample>,
) {
    @Serializable
    data class TimedSample(val at: Long, val value: Double)

    @Serializable
    data class IOSample(val at: Long, val read: Double, val write: Double)
}

// ---------- P1.22 custom-domain verify (extension) ---------------------

@Serializable
data class VerifyCustomDomainRequest(val fqdn: String)

@Serializable
data class VerifyCustomDomainResponse(
    val fqdn: String,
    val status: Status,
    val expectedTxtRecord: String,
    val observedTxtRecord: String? = null,
    val reason: String? = null,
) {
    @Serializable
    enum class Status {
        @SerialName("pending")  PENDING,
        @SerialName("verified") VERIFIED,
        @SerialName("failed")   FAILED,
    }
}

// ---------- P1.23 post-recovery status --------------------------------
//
// After the user recovers on a new device and a J.3 IRK swap completes,
// the daemon rewrites membership rows from the old IRK to the new one.
// This endpoint surfaces that walk so the post-recovery confirmation
// screen can show a per-app readout + a single Undo CTA for the 7-day
// window.

@Serializable
data class PostRecoveryStatusResponse(val report: PostRecoverySnapshot? = null)

@Serializable
data class PostRecoverySnapshot(
    val currentIrkPubHex: String,
    val state: WatcherState,
    val lastReissue: ReissuanceReportPayload? = null,
)

@Serializable
data class WatcherState(
    val lastSeen: PendingRePair? = null,
    val lastSwapTo: String? = null,
    val lastSwapAt: Long? = null,
    val lastPolledAt: Long,
    val lastError: String? = null,
)

@Serializable
data class PendingRePair(
    val newIrkPub: String,
    val oldIrkPub: String,
    val initiatedAt: Long,
    val completesAt: Long,
    val objectedAt: Long? = null,
)

@Serializable
data class ReissuanceReportPayload(
    val startedAt: Long,
    val completedAt: Long? = null,
    /** "pending" | "running" | "complete" | "failed" — raw string for
     *  forward-compat with daemon-side enum additions. */
    val status: String,
    val oldIrkPrefix: String,
    val newIrkPrefix: String,
    val apps: List<AppReissuanceSummary>,
    val totalRewritten: Int,
    val reattachedCount: Int,
    val unchangedCount: Int,
    val undoWindowExpiresAt: Long,
)

@Serializable
data class AppReissuanceSummary(
    val serviceId: String,
    val slug: String,
    val rewrittenCount: Int,
    val unchangedCount: Int,
    val error: String? = null,
    val completedAt: Long,
)

// ---------- W10 — per-app env-var KV editor -----------------------------

/** Daemon NEVER returns values; this DTO has no `values` field by design. */
@Serializable
data class ServiceEnvListResponse(val names: List<String>)

/** Mirror of @flagship/protocol SetServiceEnvRequest. */
@Serializable
data class ServiceEnvSetEnvelope(
    val serverId: String,
    val creator: String,
    val slug: String,
    val env: Map<String, String>,
    val issuedAt: Long,
)

@Serializable
data class ServiceEnvSetRequest(
    val name: String,
    val value: String,
    val request: ServiceEnvSetEnvelope,
    /** Hex Ed25519 signature over canonicalSetServiceEnv(request). */
    val signature: String,
)

@Serializable
data class ServiceEnvUnsetRequest(
    val name: String,
    val request: ServiceEnvSetEnvelope,
    val signature: String,
)

@Serializable
data class ServiceEnvOpResponse(val ok: Boolean)

// ---------- W10 — vibe-code session public state + reply ----------------

@Serializable
data class VibeCodeSessionMessage(
    val role: String,           // "user" | "assistant"
    val text: String,
    val timestamp: Long,
)

@Serializable
data class TalkToUserPayload(val message: String)

@Serializable
data class RequestEnvVarPayload(
    val name: String,
    val description: String,
    val why: String,
    val example: String? = null,
    val secret: Boolean? = null,
)

@Serializable
sealed class VibeCodePendingRequest {
    abstract val toolUseId: String
    @Serializable @SerialName("talkToUser")
    data class TalkToUser(
        override val toolUseId: String,
        val payload: TalkToUserPayload,
    ) : VibeCodePendingRequest()
    @Serializable @SerialName("requestEnvVar")
    data class RequestEnvVar(
        override val toolUseId: String,
        val payload: RequestEnvVarPayload,
    ) : VibeCodePendingRequest()
}

@Serializable
data class VibeCodeSessionPublicState(
    val id: String,
    val appId: String? = null,
    val status: String,
    val messages: List<VibeCodeSessionMessage>,
    val pendingRequest: VibeCodePendingRequest? = null,
)

@Serializable
data class VibeCodeReplyRequest(
    val text: String? = null,
    /** "set" | "declined" | "deferred" — only meaningful when the
     *  pending tool is `requestEnvVar`. */
    val envVarStatus: String? = null,
)

@Serializable
data class VibeCodeReplyResponse(val ok: Boolean)

// ---------- P9 — peer-backup status + toggle ----------------------------

@Serializable
data class PeerBackupPeerHostingYou(
    val peerFqdn: String,
    val shardsHosted: Int,
    val lastSeenMs: Long,
    val online: Boolean,
)

@Serializable
data class PeerBackupPeerYouHost(
    val peerFqdn: String,
    val shardsHosted: Int,
    val bytesHosted: Long,
    val lastFetchedMs: Long,
)

@Serializable
data class PeerBackupShardSummary(
    val shardId: String,
    val replicas: Int,
    val minReplicas: Int,
    val bytes: Long,
)

@Serializable
data class PeerBackupRepairStatus(
    val state: String,                       // "idle" | "running" | "error"
    val lastTickMs: Long? = null,
    val queued: Int,
    val completed24h: Int,
    val lastError: String? = null,
)

@Serializable
data class PeerBackupStats(
    val total: Int,
    val durable: Int,
    val atRisk: Int,
    val yourBytesStored: Long,
    val peerBytesHosted: Long,
)

@Serializable
data class PeerBackupStatusResponse(
    val participating: Boolean,
    val peersBackingYouUp: List<PeerBackupPeerHostingYou>,
    val peersYouBackUp: List<PeerBackupPeerYouHost>,
    val shards: List<PeerBackupShardSummary>,
    val repair: PeerBackupRepairStatus,
    val stats: PeerBackupStats,
)

@Serializable
data class PeerBackupToggleRequest(val participate: Boolean)

// ---------- P6 — app-invite (collaborator invites) -----------------------
//
// Wire-shape parity with `packages/server-daemon/src/screens/types.ts`
// (AppInvite*) — the daemon never sees the local label-book
// (displayName / channel / sentTo / notes). The only client-supplied
// strings that ride the wire are `opaqueTag` (16-byte hex anonymization
// handle) and the optional `contextNote` rendered to the redeemer.

@Serializable
data class AppInviteIssueRequest(
    val serviceId: String,
    val role: String,
    val opaqueTag: String,
    val contextNote: String? = null,
)

@Serializable
data class AppInviteIssueResponse(
    val secret: String,
    val expiresAt: Long,
)

@Serializable
data class AppInvitePendingSummary(
    val opaqueTag: String,
    val inviteId: String,
    val role: String,
    val expiresAt: Long,
)

@Serializable
data class AppInviteListResponse(
    val pending: List<AppInvitePendingSummary>,
)

@Serializable
data class AppInviteAccessSummary(
    val opaqueTag: String,
    val irkPubHex: String,
    val role: String,
    val grantedAt: Long,
)

@Serializable
data class AppInviteAccessResponse(
    val access: List<AppInviteAccessSummary>,
)

/** Discriminated revoke request. The daemon expects either:
 *    { serviceId, inviteId, scope: "invite" }
 *    { serviceId, irkPubKey, scope: "access" }
 *  We model both branches as one data class with optional fields + a
 *  scope discriminator; the JSON encoder skips null optionals
 *  (`explicitNulls = false`), matching the union shape on the wire. */
@Serializable
data class AppInviteRevokeRequest(
    val serviceId: String,
    val scope: String,
    val inviteId: String? = null,
    val irkPubKey: String? = null,
) {
    companion object {
        fun invite(serviceId: String, inviteId: String): AppInviteRevokeRequest =
            AppInviteRevokeRequest(serviceId = serviceId, scope = "invite", inviteId = inviteId)
        fun access(serviceId: String, irkPubKey: String): AppInviteRevokeRequest =
            AppInviteRevokeRequest(serviceId = serviceId, scope = "access", irkPubKey = irkPubKey)
    }
}

@Serializable
data class AppInviteRevokeResponse(
    val ok: Boolean,
    val alreadyRevoked: Boolean? = null,
)

// ---------- P14 — companion-dock (browser pairing tickets) -------------
//
// A 60-second single-use pairing ticket minted on the phone; a desktop
// browser scans the QR + redeems against the pod, becoming a 4-hour
// read-only "companion" session. List + revoke surface the active
// companions per pod.

@Serializable
data class CompanionMintTicketRequest(val label: String?)

@Serializable
data class CompanionMintTicketResponse(
    val ticketId: String,
    val ticketSecret: String,
    val expiresAt: Long,
)

@Serializable
data class CompanionSummary(
    val tokenPrefix: String,
    val label: String?,
    val redeemedAt: Long,
    val lastSeenMs: Long,
    val expiresAt: Long,
    val userAgent: String?,
)

@Serializable
data class CompanionListResponse(val companions: List<CompanionSummary>)

@Serializable
data class CompanionRevokeRequest(val tokenPrefix: String)

@Serializable
data class CompanionRevokeResponse(val ok: Boolean)

// ---------- P14 Phase 2 — companion write-relay (owner queue) ---------
//
// A companion may POST `/api/companion/request-write` with an unsigned
// intent; the owner's app polls `/api/screens/companion/pending-writes`,
// signs + dispatches the destination call (releaseServerName /
// revokeServer), then POSTs `/api/screens/companion/resolve-pending` to
// mark the row approved/denied.
//
// `intent` is dynamic JSON keyed off `kind`. v1 kinds:
//   - "release-server":  { username, serverDomain, issuedAt }
//   - "revoke-server":   { userId, revokedServerId, reason, issuedAt }
// Other kinds render as "Unsupported request kind" without auto-action.

@Serializable
data class CompanionPendingWrite(
    val requestId: String,
    val companionTokenPrefix: String,
    val companionLabel: String? = null,
    val kind: String,
    val intent: JsonObject,
    val queuedAt: Long,
    val expiresAt: Long,
)

@Serializable
data class CompanionPendingWritesResponse(val pending: List<CompanionPendingWrite>)

@Serializable
data class CompanionResolvePendingRequest(
    val requestId: String,
    /** "approved" | "denied" */
    val outcome: String,
)

@Serializable
data class CompanionResolvePendingResponse(
    val ok: Boolean,
    val alreadyResolved: Boolean? = null,
)
