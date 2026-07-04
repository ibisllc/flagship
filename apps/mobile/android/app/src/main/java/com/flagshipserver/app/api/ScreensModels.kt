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

/** sha256 hex of a UTF-8 string. Used to verify a carried marketplace manifest
 *  hashes to the listing's committed `manifest_hash` before install (mirror of
 *  the webapp `sha256Hex` + iOS `manifestSha256Hex`). */
fun manifestSha256Hex(s: String): String =
    com.flagshipserver.app.core.HexUtil.encode(
        java.security.MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)),
    )

@Serializable
data class AppSummary(
    val serviceId: String,
    val creator: String,
    val slug: String,
    val urlLabel: String,
    val summary: String? = null,
    val url: String,
    /** "running" | "starting" | "stopped" | "unknown" (docs/app-placement.md §6);
     *  older boxes always send "unknown". */
    val status: String,
    val version: String? = null,
    val installedAt: Long,
    /** Internet hosts the manifest declares and the ones the owner approved.
     *  Absent on boxes without the egress gateway. */
    val egress: AppEgress? = null,
    /** The app's access list at a glance (§3a). Absent on boxes from before
     *  access lists; those may still send [egress]. */
    val access: AppAccessSummary? = null,
    /** Set while a copy of this app is arriving on this box
     *  (docs/app-placement.md §5); absent once it is installed. */
    val copying: AppCopying? = null,
    /** Something working on the app on this box (§6). Absent when idle, and
     *  on boxes from before app activity. */
    val activity: AppActivity? = null,
    /** "open" | "members-only" (docs/service-access-gating.md); absent on
     *  older boxes. A co-manager of the server still needs an invite to a
     *  members-only app. */
    val accessMode: String? = null,
    /** The app's name on a row for a copy still underway (no manifest yet). */
    val name: String? = null,
)

/** `activity: {kind}`: "deploying" | "copying" | "editing". */
@Serializable
data class AppActivity(val kind: String)

/** `copying: {state, progress}` on an app summary while a copy arrives. */
@Serializable
data class AppCopying(
    /** "copying" | "installing" (a box may also report a final state briefly). */
    val state: String,
    /** How far along, 0..1 over the whole copy. */
    val progress: Double? = null,
)

// ---------- Copying an app to another server (docs/app-placement.md §5) ----

/** The owner's grant to copy [serviceId] from [sourceServer] to [targetServer]. */
@Serializable
data class AppCopyGrantBody(
    val sourceServer: String,
    val targetServer: String,
    val serviceId: String,
    val issuedAt: Long,
)

/** `POST /api/screens/services/copy`, sent to the TARGET box. */
@Serializable
data class AppCopyRequest(
    val grant: AppCopyGrantBody,
    /** Ed25519 over the canonical bytes, 128 hex. */
    val signature: String,
)

/** The box's answer to a delivered server order: [heldIssuedAt] is the
 *  `issuedAt` of the order it holds now (0 when none). */
@Serializable
data class ServerOrderDeliveryResponse(
    val ok: Boolean = false,
    val adopted: Boolean = false,
    val heldIssuedAt: Long = 0,
)

/** 202 from the copy endpoint. */
@Serializable
data class AppCopyResponse(val copyId: String = "")

/** One copy the box is receiving (or received). */
@Serializable
data class AppCopyRecord(
    val copyId: String,
    val serviceId: String,
    val appName: String = "",
    val sourceServer: String = "",
    /** "copying" | "installing" | "done" | "failed". */
    val state: String,
    val progress: Double? = null,
    val reason: String? = null,
    val startedAt: Long = 0,
    /** Env names whose values couldn't come along: the owner sets them on
     *  this server. */
    val pendingEnv: List<String> = emptyList(),
) {
    val underway: Boolean get() = state == "copying" || state == "installing"
}

/** `GET /api/screens/services/copies`. */
@Serializable
data class AppCopiesResponse(val copies: List<AppCopyRecord> = emptyList())

/** The owner-signed uninstall (`DELETE /api/services/:serviceId`). */
@Serializable
data class UninstallServiceRequestBody(
    val serverId: String,
    val creator: String,
    val slug: String,
    val issuedAt: Long,
)

@Serializable
data class UninstallServiceBody(
    val request: UninstallServiceRequestBody,
    val signature: String,
)

/** `access: {rules, pending, draft?}` on an app summary. */
@Serializable
data class AppAccessSummary(
    val rules: Int = 0,
    val pending: Int = 0,
    /** A suggested list waits for the owner's review. */
    val draft: Boolean = false,
)

/** A live app's internet access: it may reach only [approved] hosts, each of
 *  which it [declared] in its manifest. */
@Serializable
data class AppEgress(
    val declared: List<String> = emptyList(),
    val approved: List<String> = emptyList(),
) {
    /** Declared hosts still waiting for the owner's approval. */
    val pending: List<String> get() = declared.filter { it !in approved }
}

/** The signed body of `POST /api/screens/services/:serviceId/egress`. */
@Serializable
data class AppEgressGrantBody(
    val serverDomain: String,
    val serviceId: String,
    val hosts: List<String>,
    val issuedAt: Long,
)

@Serializable
data class AppEgressRequest(
    val grant: AppEgressGrantBody,
    /** Ed25519 over the canonical bytes, 128 hex. */
    val signature: String,
)

@Serializable
data class AppEgressResponse(
    val ok: Boolean = false,
    val egress: AppEgress? = null,
)

/** A host an app was denied because no rule matched (`attempt`), or one its
 *  manifest declares (`app`, recorded at install). */
@Serializable
data class AppAccessPending(
    val host: String,
    val source: String = SOURCE_ATTEMPT,
    val attempts: Int = 0,
    val firstSeen: Long = 0,
    val lastSeen: Long = 0,
) {
    companion object {
        const val SOURCE_ATTEMPT = "attempt"
        const val SOURCE_APP = "app"
    }
}

/** A host the app's manifest suggests, with its short reason. */
@Serializable
data class AppAccessSuggestion(val host: String, val why: String? = null)

/** A suggested list (§3a "Suggested lists"): the signed list with an `allow`
 *  line on top for each new host. It opens nothing until the owner signs it. */
@Serializable
data class AppAccessDraft(
    val list: String,
    val listSha256: String? = null,
    val hosts: List<AppAccessSuggestion> = emptyList(),
    val createdAt: Long = 0,
)

/** `GET /api/screens/services/:id/access`. */
@Serializable
data class AppAccessState(
    val list: String = com.flagshipserver.app.core.AppAccessList.DEFAULT_LIST,
    val listSha256: String? = null,
    val pending: List<AppAccessPending> = emptyList(),
    /** Null when no draft waits, and on boxes from before drafts. */
    val draft: AppAccessDraft? = null,
)

@Serializable
data class AppAccessGrantBody(
    val serverDomain: String,
    val serviceId: String,
    val listSha256: String,
    val issuedAt: Long,
)

/** `POST /api/screens/services/:id/access`. */
@Serializable
data class AppAccessSetRequest(
    val list: String,
    val grant: AppAccessGrantBody,
    /** Ed25519 over the canonical bytes, 128 hex. */
    val signature: String,
)

@Serializable
data class AppAccessSetResponse(
    val ok: Boolean = false,
    /** The applied state; read leniently because only the GET shape is useful. */
    val access: JsonElement? = null,
) {
    fun state(json: kotlinx.serialization.json.Json): AppAccessState? {
        val obj = access as? JsonObject ?: return null
        if (!obj.containsKey("list")) return null
        return runCatching { json.decodeFromJsonElement(AppAccessState.serializer(), obj) }.getOrNull()
    }
}

/** The body of a refused access-list order: per-line errors on a 400. */
@Serializable
data class AppAccessRefusal(
    val error: String? = null,
    val errors: List<AppAccessLineError> = emptyList(),
)

@Serializable
data class AppAccessLineError(val line: Int, val message: String)

@Serializable
data class AppAccessDismissRequest(val host: String)

// ---------- The owner's Database section (docs/app-apis.md §6) ------------

/** `GET /api/screens/services/:id/db`. */
@Serializable
data class AppDbOverview(val stores: List<AppDbStore> = emptyList())

@Serializable
data class AppDbStore(val store: String, val tables: List<AppDbTable> = emptyList())

/** `name` is `table` in the public schema, else `schema.table`. `rows` is the
 *  planner's estimate, null when unknown. */
@Serializable
data class AppDbTable(
    val name: String,
    val kind: String = "table",
    val rows: Double? = null,
    val bytes: Double = 0.0,
)

@Serializable
data class AppDbColumn(val name: String, val type: String = "")

/** `GET …/db/:store/tables/:table?offset&limit`. Values come as Postgres
 *  prints them (strings), except booleans and small numbers. */
@Serializable
data class AppDbRows(
    val columns: List<AppDbColumn> = emptyList(),
    val rows: List<List<JsonElement>> = emptyList(),
    val total: Long = 0,
)

@Serializable
data class AppDbWriteGrantBody(
    val serverDomain: String,
    val serviceId: String,
    val store: String,
    val sqlSha256: String,
    val issuedAt: Long,
)

/** `POST …/db/:store/query`: unsigned runs READ ONLY; a write carries the
 *  owner's signed grant. Nulls are left out on the wire. */
@Serializable
data class AppDbQueryRequest(
    val sql: String,
    val grant: AppDbWriteGrantBody? = null,
    /** Ed25519 over the canonical bytes, 128 hex. */
    val signature: String? = null,
)

@Serializable
data class AppDbQueryResult(
    /** The first word of the statement's tag (`SELECT`, `UPDATE` …). */
    val command: String = "",
    val columns: List<AppDbColumn> = emptyList(),
    val rows: List<List<JsonElement>> = emptyList(),
    val rowCount: Long? = null,
    /** More rows existed than came back. */
    val truncated: Boolean = false,
)

/** A refused query: `{error, sqlState, position?, needsGrant?}`. */
@Serializable
data class AppDbRefusal(
    val error: String? = null,
    val sqlState: String? = null,
    val position: Int? = null,
    val needsGrant: Boolean = false,
)

// ---------- App API keys (docs/app-apis.md §3) --------------------------

/** One key on `GET /api/screens/services/:id/api-keys`. The secret never
 *  comes back after the create. */
@Serializable
data class AppApiKeyInfo(
    val keyId: String,
    val label: String = "",
    /** "read" | "write". */
    val scope: String = com.flagshipserver.app.core.AppApiKey.SCOPE_READ,
    val createdAt: Long = 0,
    val lastUsedAt: Long? = null,
    /** ms, or 0 / absent for a key that never expires. */
    val expiresAt: Long? = null,
)

@Serializable
data class AppApiKeysResponse(val keys: List<AppApiKeyInfo> = emptyList())

@Serializable
data class AppApiKeyGrantBody(
    val serverDomain: String,
    val serviceId: String,
    val keyId: String,
    val scope: String,
    val expiresAt: Long,
    val issuedAt: Long,
)

/** `POST /api/screens/services/:id/api-keys`. */
@Serializable
data class AppApiKeyCreateRequest(
    val grant: AppApiKeyGrantBody,
    /** Ed25519 over the canonical bytes, 128 hex. */
    val signature: String,
    val label: String,
)

/** The full key (`fsk_<keyId>_<secret>`), returned once. */
@Serializable
data class AppApiKeyCreateResponse(val ok: Boolean = false, val key: String? = null)

/** One entry on `GET /api/screens/access-requests`: a host an app was
 *  denied, or (`kind: "draft"`, listed first) a suggested list to review. */
@Serializable
data class AccessRequest(
    val serviceId: String,
    val appName: String? = null,
    /** Empty on a draft. */
    val host: String = "",
    val source: String = AppAccessPending.SOURCE_ATTEMPT,
    val attempts: Int = 0,
    val firstSeen: Long = 0,
    val lastSeen: Long = 0,
    /** `"draft"` for a suggested list; absent for a single-host request. */
    val kind: String? = null,
    /** A draft's suggested hosts. */
    val hosts: List<AppAccessSuggestion> = emptyList(),
    val createdAt: Long = 0,
) {
    val isDraft: Boolean get() = kind == KIND_DRAFT

    companion object {
        const val KIND_DRAFT = "draft"
    }
}

@Serializable
data class AccessRequestsResponse(val requests: List<AccessRequest> = emptyList())

/** `GET`/`POST /api/screens/settings/access-alerts`: whether the box pushes
 *  access requests at all (the POST answers with `ok` too). */
@Serializable
data class AccessAlertsSetting(val enabled: Boolean, val ok: Boolean? = null)

/** A frame on the screens event socket. */
@Serializable
data class ScreensEvent(val type: String, val serviceId: String? = null) {
    companion object {
        const val ACCESS_REQUEST = "access-request"
    }
}

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
    /** The box's code-checkout HEAD (full git SHA, lowercase) — the
     *  applied-commit truth the self-update consumer enforces `fromCommit`
     *  against. Defaults null so an old box's daemon (pre-field) still
     *  parses; the update action is disabled without it. */
    val currentCommit: String? = null,
    val startedAt: Long,
    val uptimeMs: Long,
    val certNotAfter: Long? = null,
    val certNotBefore: Long? = null,
    val certSans: List<String>? = null,
    val serviceCount: Int,
    val pairedSessionCount: Int,
    val recentInstallEvents: List<RecentInstallEvent>,
    /** Verdict of the most recent update order. Absent from older daemons. */
    val lastUpdate: LastUpdate? = null,
    /** The sandbox every app runs in (gVisor). Absent from older daemons. */
    val appSandbox: AppSandbox? = null,
)

/** The box's app sandbox (docs/app-runtimes.md §5.1): `off`, `starting`,
 *  `ready` (with `version`) or `unavailable` (with `reason`: no app can start). */
@Serializable
data class AppSandbox(
    val state: String,
    val version: String? = null,
    val reason: String? = null,
) {
    data class Notice(val danger: Boolean, val text: String)

    /** What the server page says, or null. Matches the webapp's appSandboxNotice. */
    val notice: Notice?
        get() = when (state) {
            "unavailable" -> Notice(
                danger = true,
                text = "Apps can't start on this server: the sandbox they run in isn't working (${reason ?: "unknown reason"}). The server tries again every 10 minutes.",
            )
            "starting" -> Notice(danger = false, text = "Setting up the sandbox apps run in. They start once it's ready.")
            else -> null
        }
}

/** The box's record of the last update order: applied, rolled back after the
 *  new code failed its boot health gate, or refused with a reason. */
@Serializable
data class LastUpdate(
    val outcome: String,
    val at: Long,
    val targetCommit: String? = null,
    val previousCommit: String? = null,
    val bootAttempts: Int? = null,
    val reason: String? = null,
) {
    /** One sentence for the update card, or null for an outcome this build
     *  doesn't know. Matches the webapp's describeLastUpdate. */
    val summary: String?
        get() {
            fun short(sha: String?): String? =
                sha?.takeIf { it.length == 40 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } }?.take(8)
            return when (outcome) {
                "applied" -> short(targetCommit)?.let { "Last update: $it installed and running." }
                    ?: "Last update installed and running."
                "rolled-back" -> {
                    val to = short(targetCommit)?.let { " to $it" } ?: ""
                    val back = short(previousCommit)?.let { " to $it" } ?: ""
                    "The last update$to didn't start cleanly, so the server went back$back on its own."
                }
                "refused" -> REFUSAL_COPY[reason]?.let { "The server refused the last update: $it" }
                    ?: "The server refused the last update."
                else -> null
            }
        }

    private companion object {
        val REFUSAL_COPY = mapOf(
            "unendorsed" to "Flagship's maintainers haven't endorsed that release.",
            "from-commit-mismatch" to "the server was no longer on the version the update was made for. Send it again.",
            "apply-failed" to "it couldn't download or build the new version. Nothing changed.",
            "rejected" to "the request wasn't signed by this account's admin key.",
            "stale" to "the request was too old. Send it again.",
            "wrong-domain" to "the request was for a different server.",
        )
    }
}

/** One maintainer-endorsed release, placed relative to the box's running commit. */
@Serializable
data class ReleaseEntry(
    val commit: String,
    val releaseId: String,
    val tag: String,
    /** ISO 8601. */
    val endorsedAt: String,
    /** "current" | "newer" | "older" | "unrelated". */
    val relation: String,
)

/** GET /api/screens/updates: the releases the box verified for itself. */
@Serializable
data class ReleaseCatalogResponse(
    val checkedAt: Long,
    val currentCommit: String? = null,
    /** Newest endorsed release after the running one, or null when up to date. */
    val latest: ReleaseEntry? = null,
    /** Newest first. */
    val releases: List<ReleaseEntry> = emptyList(),
    /** True when the box couldn't fetch and listed from its local copy. */
    val stale: Boolean? = null,
) {
    val currentTag: String?
        get() = releases.firstOrNull { it.relation == "current" }?.tag

    val otherNewer: List<ReleaseEntry>
        get() = releases.filter { it.relation == "newer" && it.commit != latest?.commit }

    val older: List<ReleaseEntry>
        get() = releases.filter { it.relation == "older" }
}

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
    /** The owner can change its code from the phone (built on this box, with
     *  its source there). Absent on older boxes. */
    val editable: Boolean? = null,
    /** Built from a shared repo adaptation: the repo it adapts, so the page
     *  can offer to report a problem with it. */
    val adaptedFrom: AdaptedFrom? = null,
) {
    @Serializable
    data class AdaptedFrom(val repo: String)

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
    /** Env-var NAME a `requiresLlmKey` app reads its key from (e.g.
     *  `OPENAI_API_KEY`); relayed by the BFF so the client can prefill
     *  "Configure environment" after install. Null ⇒ fall back to
     *  [MarketplaceLlmKey.DEFAULT_ENV_VAR]. */
    val llmKeyEnvVar: String? = null,
    /** Marketplace scanner verdict ("A".."F"), or null when not yet scanned
     *  (the pill renders "ungraded"). MIRRORS the BFF's `scanGrade`. */
    val scanGrade: String? = null,
    val alreadyInstalled: Boolean,
)

/**
 * Marketplace install LLM-key UX helpers, byte-identical with the daemon BFF
 * (`LLM_KEY_ENV_DEFAULT`), the webapp (`lib/marketplaceLlmKey.js`), and iOS
 * (`MarketplaceLlmKey`) so the prefilled-name flow is the same everywhere.
 */
object MarketplaceLlmKey {
    /** Fallback env-var name when a listing doesn't declare one. */
    const val DEFAULT_ENV_VAR = "OPENAI_API_KEY"

    /** The env-var name to prefill for [listing] — its declared name, else the
     *  default. */
    fun envVar(listing: MarketplaceListing): String =
        listing.llmKeyEnvVar?.takeIf { it.isNotEmpty() } ?: DEFAULT_ENV_VAR
}

/**
 * Marketplace scanner-grade → display bucket, mapped identically on every
 * surface (mirrors the webapp `scanGradePill`): A/B → OK, C/D → WARN, F → ERR,
 * and anything else (incl. null — `scan_grade` is NULL until the scanner runs)
 * → UNGRADED.
 */
enum class ScanGradeBucket {
    OK, WARN, ERR, UNGRADED;

    companion object {
        fun from(grade: String?): ScanGradeBucket = when (grade?.uppercase()) {
            "A", "B" -> OK
            "C", "D" -> WARN
            "F" -> ERR
            else -> UNGRADED
        }

        /** Pill label: "scan A".."scan F" for a known grade, else "ungraded". */
        fun pillLabel(grade: String?): String = when (grade?.uppercase()) {
            "A", "B", "C", "D", "F" -> "scan ${grade!!.uppercase()}"
            else -> "ungraded"
        }

        /** Conservative install-confirm gate: a failing grade (F → ERR) BLOCKS
         *  the normal Install tap; the client must demand an explicit,
         *  visually-distinct "Install anyway" override before posting to the
         *  box. A/B/C/D and ungraded do NOT block. */
        fun blocksInstall(grade: String?): Boolean = from(grade) == ERR

        /** True when the listing has no usable grade yet (null / empty /
         *  unrecognised → UNGRADED) — the confirm cautions "not yet
         *  security-scanned" but still allows the install. */
        fun isUngraded(grade: String?): Boolean = from(grade) == UNGRADED
    }
}

@Serializable
data class MarketplaceBrowseResponse(val listings: List<MarketplaceListing>)

/**
 * Single-listing fetch (`GET https://flagshipserver.com/api/marketplace/<creator>/<slug>`).
 * MIRRORS the iOS `MarketplaceListingDetail` + the webapp's `fetchListing`
 * in `apps/web/public/webapp/lib/installService.js` — `manifestJson` is the
 * opaque JSON the daemon verifies on install. Extra fields the .com worker
 * returns are tolerated (`ignoreUnknownKeys`).
 */
@Serializable
data class MarketplaceListingDetail(
    val creator: String,
    val slug: String,
    val title: String,
    val summary: String,
    val manifestJson: String,
    /** The listing's committed `manifest_hash` (sha256 hex of manifestJson).
     *  The VM re-checks it before install so a swapped manifest is rejected.
     *  Empty on legacy listings that predate the carried manifest. */
    val manifestHash: String = "",
)

/**
 * Wire shape of the `.com` single-listing GET
 * (`GET https://flagshipserver.com/api/marketplace/<creator>/<slug>`): the
 * listing object is wrapped under `listing` and uses snake_case keys. Mapped
 * into [MarketplaceListingDetail] by the Live client. Unknown fields tolerated.
 */
@Serializable
internal data class ComListingEnvelope(val listing: ComListingObject)

@Serializable
internal data class ComListingObject(
    val creator: String,
    val slug: String,
    val name: String = "",
    val tagline: String = "",
    @SerialName("manifest_json") val manifestJson: String = "",
    @SerialName("manifest_hash") val manifestHash: String = "",
)

/**
 * Install-marketplace-app request. Wire-identical to the iOS
 * `InstallServiceRequest` + the webapp body in
 * `apps/web/public/webapp/lib/installService.js`: same field names, same
 * canonical tag (`flagship/install-service/v1`), same envelope
 * (`{ request, signature }`). The daemon endpoint is `POST <pod>/api/services`
 * (NOT a screens-BFF route — the install pipeline lives on the
 * service-platform handler in `packages/server-daemon/src/servicePlatform.ts`).
 */
@Serializable
data class InstallServiceRequest(
    val serverId: String,
    val creator: String,
    val slug: String,
    val manifestJson: String,
    val addOwnerToMembership: Boolean,
    val issuedAt: Long,
)

/**
 * `{request, signature}` envelope expected by `POST <pod>/api/services`.
 * `signature` is the hex-encoded Ed25519 signature of
 * [installServiceCanonicalBytes] produced with the user's IRK.
 */
@Serializable
data class InstallServiceEnvelope(
    val request: InstallServiceRequest,
    val signature: String,
)

/** Daemon's success body for `POST /api/services`. Mirrors `installService`
 *  in `servicePlatform.ts` (+ the iOS `InstallServiceResponse`). */
@Serializable
data class InstallServiceResponse(
    val ok: Boolean,
    val serviceId: String,
    val urlLabel: String,
    val port: Int? = null,
)

/**
 * Canonical-bytes for [InstallServiceRequest], byte-identical with the iOS
 * `installServiceCanonicalBytes`, the webapp's `canonicalInstallService`,
 * and the TS protocol `canonicalInstallService` in
 * `packages/protocol/src/auth.ts`. Format:
 *
 *     flagship/install-service/v1 | serverId | creator | slug | manifestJson | (1|0) | issuedAt
 *
 * `addOwnerToMembership` is encoded as `"1"` (true) / `"0"` (false);
 * `issuedAt` is a base-10 integer (no padding, no inner separator).
 */
fun installServiceCanonicalBytes(r: InstallServiceRequest): ByteArray = listOf(
    "flagship/install-service/v1",
    r.serverId,
    r.creator,
    r.slug,
    r.manifestJson,
    if (r.addOwnerToMembership) "1" else "0",
    r.issuedAt.toString(),
).joinToString("|").toByteArray(Charsets.UTF_8)

// ---------- P1.5 vibe-code/start ---------------------------------------

/**
 * BYOK credential handed to a build. Wire-identical to the webapp's
 * providers.js entry shape (`{ provider, apiKey, baseUrl? }`) and the daemon
 * BYOK contract. Lives in memory only — the device-local AiKeyStore decides
 * whether the underlying key is persisted. NEVER logged.
 */
@Serializable
data class LlmProviderCredential(
    val provider: String,
    val apiKey: String,
    val baseUrl: String? = null,
    /** Route the provider call through the Flagship relay. Sent explicitly on
     *  every send; a box treats an absent value as on. */
    val relay: Boolean? = null,
    /** "promo" for free AI credits (the box pins it to its host); omitted for
     *  the owner's own key. */
    val source: String? = null,
) {
    companion object {
        fun from(c: com.flagshipserver.app.core.AiCredential): LlmProviderCredential =
            LlmProviderCredential(c.provider, c.apiKey, c.baseUrl, relay = c.relay, source = c.source)
    }
}

/** The type's earlier Android name, still used by the screens client. */
typealias BuildCredential = LlmProviderCredential

@Serializable
data class VibeCodeStartRequest(
    val prompt: String,
    /** A Flagship Inference catalog id ("low", …) or the provider's own model
     *  id. Omitted ⇒ the box picks its default. */
    val model: String? = null,
    /** Reasoning effort in the provider's own words; omitted ⇒ its default. */
    val effort: String? = null,
    /** Files and images on the opening turn (≤ 6). */
    val attachments: List<VibeCodeAttachment>? = null,
    /** Optional BYOK credential. Omitted ⇒ box uses promo/credits. */
    val credential: LlmProviderCredential? = null,
    /** Owner-chosen service name/slug (the web-address label) from the
     *  Describe form. A hint the daemon uses for the deployed slug. */
    val name: String? = null,
    /** Owner-chosen reach: "just-me" or "link". Applied at install. */
    val visibility: String? = null,
    /** Change this installed service (`<creator>--<slug>`) instead of building
     *  a new one. The box ignores [name] and [visibility] when it's set. */
    val editServiceId: String? = null,
)

@Serializable
data class VibeCodeStartResponse(
    val sessionId: String,
    /** True when the box needs a credential before it can build (none was
     *  supplied and no promo budget is available). The client routes back
     *  into the AI-key step. */
    val needsCredential: Boolean = false,
)

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
    /** While "deploying": "staging" | "fixing" | "going-live". */
    val deployPhase: String? = null,
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
    @SerialName("partitioning") PARTITIONING("partitioning"),
    @SerialName("installing")   INSTALLING("installing"),
    @SerialName("downloading")  DOWNLOADING("downloading"),
    @SerialName("registering")  REGISTERING("registering"),
    @SerialName("sealing")      SEALING("sealing"),
    @SerialName("installed")    INSTALLED("installed"),
    @SerialName("pairing")      PAIRING("pairing"),
    @SerialName("live")         LIVE("live"),
    @SerialName("error")        ERROR("error"),
    @SerialName("unknown")      UNKNOWN("unknown");

    /** Terminal phases stop the poller (success or failure). */
    val isTerminal: Boolean get() = this == LIVE || this == ERROR

    companion object {
        /** The happy-path ladder, in order, EXCLUDING terminal `error`
         *  (and the `unknown` sentinel). `installed` is the final pre-poweroff
         *  action-needed rung, after `sealing`. */
        val ordered: List<ProvisionStatusPhase> = listOf(
            BOOTING, PARTITIONING, INSTALLING, DOWNLOADING,
            REGISTERING, SEALING, INSTALLED, PAIRING, LIVE,
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
) {
    val hasActiveReattach: Boolean
        get() = state.lastSeen?.objectedAt == null &&
            state.lastSeen != null &&
            state.lastSwapTo == null
}

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
    /** What the owner attached on this turn (user messages only). */
    val attachments: List<VibeCodeAttachment>? = null,
    /** Flagship Inference: credits this reply cost (assistant messages only). */
    val credits: Double? = null,
)

/**
 * A file or image on a chat turn. Polymorphic on `kind` (the screens JSON's
 * class discriminator). Mirror of the daemon's `VibeCodeAttachment`.
 */
@Serializable
sealed class VibeCodeAttachment {
    abstract val name: String?

    @Serializable @SerialName("image")
    data class Image(val mediaType: String, val dataBase64: String, override val name: String? = null) : VibeCodeAttachment()

    @Serializable @SerialName("text")
    data class Text(val text: String, override val name: String? = null) : VibeCodeAttachment()

    /** CSV or JSON sample data (`text/csv` | `application/json`). */
    @Serializable @SerialName("data")
    data class Data(override val name: String? = null, val mediaType: String, val text: String) : VibeCodeAttachment()

    /** A PDF (`application/pdf`). */
    @Serializable @SerialName("document")
    data class Document(override val name: String? = null, val mediaType: String = "application/pdf", val dataBase64: String) : VibeCodeAttachment()
}

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

/**
 * One entry of the daemon's in-memory vibe-code registry
 * (`GET /api/llm/sessions`). A session listed here can be reopened; one
 * missing from it ended with a daemon restart and survives only as its
 * build-journal timeline. Mirror of iOS VibeCodeSessionMeta.
 */
@Serializable
data class VibeCodeSessionMeta(
    val sessionId: String,
    val startedAt: Long = 0,
    /** streaming | awaiting-tool-response | ready-to-deploy | deploying | deployed | failed | cancelled */
    val status: String,
    val serviceId: String? = null,
    val url: String? = null,
    /** The owner's chosen name, which the session holds until it is deployed
     *  or discarded. Absent on sessions from before names were kept. */
    val name: String? = null,
    val visibility: String? = null,
) {
    /** Discarding frees the name; a deployed session's name is its app's. */
    val canDiscard: Boolean
        get() = status != "deployed"

    /** Still working or waiting on the owner: worth resuming. */
    val isActive: Boolean
        get() = status in ACTIVE_STATUSES

    private companion object {
        val ACTIVE_STATUSES = setOf("streaming", "awaiting-tool-response", "ready-to-deploy", "deploying")
    }
}

/**
 * `GET /api/screens/vibe-code/name-check`, and the body of a 409 from
 * `vibeCodeStart`. `kind` is "invalid", "app" (an installed service) or
 * "session" (an open build session, stopped from the build-sessions list).
 * Mirror of iOS VibeCodeNameCheck.
 */
@Serializable
data class VibeCodeNameCheck(
    val ok: Boolean,
    val name: String? = null,
    val kind: String? = null,
    val serviceId: String? = null,
    val sessionId: String? = null,
    val message: String? = null,
) {
    companion object {
        /** What a box too old to answer is taken to say: free. */
        val Unknown = VibeCodeNameCheck(ok = true)

        private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

        /** A refused start, if [error] is the box's 409 for a taken name. */
        fun conflict(error: Throwable): VibeCodeNameCheck? {
            if (error !is ScreensError.Http || error.status != 409) return null
            val check = runCatching { json.decodeFromString(serializer(), error.body) }.getOrNull()
            return check?.takeIf { !it.ok }
        }
    }
}

@Serializable
data class VibeCodeSessionsResponse(
    val sessions: List<VibeCodeSessionMeta> = emptyList(),
)

@Serializable
data class VibeCodeSessionPublicState(
    val id: String,
    val appId: String? = null,
    val status: String,
    val messages: List<VibeCodeSessionMessage>,
    val pendingRequest: VibeCodePendingRequest? = null,
    /** While "deploying": "staging" | "fixing" | "going-live". */
    val deployPhase: String? = null,
    /** Why the session failed, when status is "failed". */
    val failureReason: String? = null,
    /** The AI is waiting but the box has no key for this session: the reply
     *  must carry one. */
    val needsCredential: Boolean? = null,
    /** The model and effort the conversation uses now. */
    val model: String? = null,
    val effort: String? = null,
    /** Older turns were summarised to fit the model's context. */
    val summarised: Boolean = false,
)

/** `POST /api/llm/sessions/:id/deploy {background:true}`: `started` from a
 *  current box (202), or the finished result from an older one that ignores
 *  `background`. */
@Serializable
data class VibeCodeDeployReply(
    val ok: Boolean = false,
    val started: Boolean? = null,
    val serviceId: String? = null,
    val url: String? = null,
    val inviteOnly: Boolean? = null,
)

@Serializable
data class VibeCodeReplyRequest(
    /** Switch the model for this and later turns (same values as on start). */
    val model: String? = null,
    /** Switch the effort; "" goes back to the provider's default (null is
     *  left off the wire and keeps the current one). */
    val effort: String? = null,
    val text: String? = null,
    /** Files and images on this reply (≤ 6). */
    val attachments: List<VibeCodeAttachment>? = null,
    /** "set" | "declined" | "deferred" — only meaningful when the
     *  pending tool is `requestEnvVar`. */
    val envVarStatus: String? = null,
    /** Optional BYOK credential carried on a reply (e.g. the box asked for a
     *  key mid-session, or an adapt step needs the box's model). */
    val credential: LlmProviderCredential? = null,
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

// ---------- P14 — companion-dock (browser pairing tickets) -------------
//
// A 60-second single-use pairing ticket minted on the phone; a desktop
// browser scans the QR + redeems against the pod, becoming a 4-hour
// read-only "companion" session. List + revoke surface the active
// companions per pod.

@Serializable
class CompanionMintTicketRequest

@Serializable
data class CompanionMintTicketResponse(
    val ticketId: String,
    val ticketSecret: String,
    val expiresAt: Long,
)

@Serializable
data class CompanionSummary(
    val tokenPrefix: String,
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

// ---------- Access control — members' ranks ----------------------------
//
// Wire parity with packages/server-daemon/src/memberRoles.ts. Every
// redemption of an invite is its own grant; a person holding several has the
// highest rank.

@Serializable
data class AppMemberGrant(val inviteId: String, val role: String)

@Serializable
data class AppMember(
    val aid: String,
    val role: String,
    val grants: List<AppMemberGrant> = emptyList(),
    val direct: String? = null,
)

@Serializable
data class AppMemberInviteRole(val inviteId: String, val role: String, val set: Boolean = false)

/** `GET /api/screens/services/:id/members`. */
@Serializable
data class AppMembersResponse(
    val serviceId: String,
    val mode: String,
    val roles: List<String> = listOf("member", "manager", "master"),
    val defaultRole: String,
    /** The app's one line per rank (its manifest's `role_descriptions`). */
    val descriptions: Map<String, String> = emptyMap(),
    val members: List<AppMember> = emptyList(),
    val invites: List<AppMemberInviteRole> = emptyList(),
) {
    fun description(role: String): String? = descriptions[role]?.takeIf { it.isNotEmpty() }

    fun member(aid: String?): AppMember? = aid?.lowercase()?.let { a -> members.firstOrNull { it.aid == a } }

    /** Where a rank change for one row goes: a person's personal invite is their
     *  grant; a member who joined before grants were tracked, by their AID. */
    fun roleTarget(inviteId: String, boundAID: String?): String {
        val m = member(boundAID)
        if (m != null && m.grants.none { it.inviteId == inviteId }) return "aid:${m.aid}"
        return "invite:$inviteId"
    }

    fun rowRole(inviteId: String, boundAID: String?): String {
        val m = member(boundAID)
        if (m != null && m.grants.none { it.inviteId == inviteId }) return m.role
        return invites.firstOrNull { it.inviteId == inviteId }?.role ?: defaultRole
    }

    /** The person's other grants, for "also in Family: Viewer". */
    fun otherGrants(inviteId: String, boundAID: String?, label: (String) -> String?): List<Pair<String, String>> {
        val m = member(boundAID) ?: return emptyList()
        return m.grants.filter { it.inviteId != inviteId }.mapNotNull { g ->
            label(g.inviteId)?.takeIf { it.isNotEmpty() }?.let { it to g.role }
        }
    }

    /** Only the AIDs for whom this grant was the last one are pruned on the box. */
    fun aidsToPrune(inviteId: String, aids: List<String>): List<String> = aids.filter { aid ->
        val m = member(aid) ?: return@filter true
        m.grants.all { it.inviteId == inviteId }
    }

    companion object {
        fun alsoInText(others: List<Pair<String, String>>, label: (String) -> String): String =
            if (others.isEmpty()) "" else "also in " + others.joinToString(", ") { (l, r) -> "$l: ${label(r)}" }
    }
}

@Serializable
data class AppMemberRoleOrderBody(
    val serverDomain: String,
    val serviceId: String,
    val target: String,
    val role: String,
    val issuedAt: Long,
)

/** `POST /api/screens/services/:id/members/role` body. */
@Serializable
data class AppMemberRoleRequest(val order: AppMemberRoleOrderBody, val signature: String)

@Serializable
data class AppMemberRoleResponse(val ok: Boolean, val target: String, val role: String)

// ---------- AI model menus (packages/protocol/src/aiModels.ts) ----------

/** One Flagship Inference model, as `.com` serves it. */
@Serializable
data class InferenceModel(
    val id: String,
    val tier: String = "",
    val model: String = "",
    val multiplier: Double = 1.0,
    val label: String = "",
    val descriptor: String = "",
    val contextTokens: Long = 0,
    val modalities: List<String> = emptyList(),
    val reasoning: Boolean = false,
    val default: Boolean? = null,
    val visionAlternative: String? = null,
    val upstream: Map<String, String>? = null,
)

/** `GET https://flagshipserver.com/api/inference/models`. */
@Serializable
data class InferenceCatalogResponse(
    val models: List<InferenceModel> = emptyList(),
    val defaultModel: String = "",
    val creditTokens: Long = 1000,
    val inputWeight: Double = 1.0,
    val outputWeight: Double = 4.0,
)

/** A row of an own-key model menu, as the box answers it. */
@Serializable
data class ModelOption(
    val id: String,
    val label: String = id,
    val contextTokens: Long? = null,
    /** Takes images. Null: unknown. */
    val vision: Boolean? = null,
    /** Takes tool calls. Null: unknown. */
    val tools: Boolean? = null,
    /** Effort levels in the provider's own words; null: no control. */
    val efforts: List<String>? = null,
    val defaultEffort: String? = null,
    /** False: not in the capability table ("capabilities unknown"). */
    val known: Boolean = false,
    val visionAlternative: String? = null,
)

/**
 * `POST /api/screens/ai/models {credential}`. `kind` "flagship" carries
 * [catalog]; "own" carries [listed], [models], [defaultModel] and, with no
 * list, [reason] ("no-list" | "rejected" | "failed").
 */
@Serializable
data class AiModelsResponse(
    val provider: String,
    val kind: String,
    val catalog: InferenceCatalogResponse? = null,
    val listed: Boolean = false,
    val models: List<ModelOption> = emptyList(),
    val defaultModel: String? = null,
    val reason: String? = null,
)

@Serializable
data class AiModelsRequest(val credential: LlmProviderCredential? = null)
