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

// ---------- P1.4 marketplace-browse ------------------------------------

@Serializable
data class MarketplaceListing(
    val creator: String,
    val slug: String,
    val title: String,
    val summary: String,
    val screenshots: List<String>,
    val installCount: Int,
    val requiresLlmKey: Boolean,
    val alreadyInstalled: Boolean,
)

@Serializable
data class MarketplaceBrowseResponse(val listings: List<MarketplaceListing>)

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

// ---------- P1.8 / P1.9 unlock-approvals -------------------------------

@Serializable
data class PendingUnlockApproval(
    val serverFqdn: String,
    val requestId: String,
    val requestedAt: Long,
    val ip: String? = null,
    val userAgent: String? = null,
)

@Serializable
data class UnlockApprovalsPendingResponse(val pending: List<PendingUnlockApproval>)

@Serializable
data class UnlockApprovalApproveRequest(
    val signature: String,    // hex
    val envelope: String,     // base64
)

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

// ---------- P1.15 install-events (SSE) ---------------------------------

@Serializable
sealed class InstallEvent {
    @Serializable @SerialName("registered") data class Registered(val serial: String, val at: Long) : InstallEvent()
    @Serializable @SerialName("boot") data class Boot(val at: Long) : InstallEvent()
    @Serializable @SerialName("tunnel-online") data class TunnelOnline(val at: Long) : InstallEvent()
    @Serializable @SerialName("cert-issued") data class CertIssued(val at: Long) : InstallEvent()
    @Serializable @SerialName("ready") data class Ready(val serverFqdn: String, val at: Long) : InstallEvent()
    @Serializable @SerialName("failed") data class Failed(val reason: String, val at: Long) : InstallEvent()
}

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
