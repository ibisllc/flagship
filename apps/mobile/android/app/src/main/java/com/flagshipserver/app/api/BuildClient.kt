// "Build a service" modes BFF contract — Kotlin mirror.
//
// The create-a-service flow asks "how do you want to build it?" and fans
// into build modes (scratch / git / mcp / marketplace) that all converge
// on the same deploy primitive + one append-only build journal per build.
//
// These endpoints are PAIRED-SESSION GATED (x-flagship-session), served by
// the user's pod at `<server>.<user>.flagship.services`. Two implementations:
//   - MockBuildClient — in-memory fixtures, used in tests + previews
//   - LiveBuildClient — OkHttp + `x-flagship-session` header
//
// MIRRORS: packages/server-daemon/src/buildmodes/buildModesHttp.ts
// + the webapp reference in apps/web/public/webapp/views/build-*.js.
// When the daemon's build-modes contract changes, update this file AND
// apps/mobile/ios/.../BuildClient.swift in the same commit. Field names +
// JSON keys must match exactly so kotlinx-serialization round-trips with
// the daemon's `JSON.stringify(...)` output.

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

// ---------- git mode ---------------------------------------------------

/** POST /api/build/git body. `ref` optional (branch / tag / sha). */
@Serializable
data class BuildGitRequest(
    val gitUrl: String,
    val ref: String? = null,
)

/** POST /api/build/git response — the fitness verdict. `fit=true` ⇒
 *  install as-is; `fit=false` ⇒ offer the AI-adapt path. */
@Serializable
data class BuildGitResponse(
    val buildId: String,
    val fit: Boolean,
    val reason: String,
    val manifestName: String? = null,
    val fileCount: Int = 0,
)

/** POST /api/build/sessions/:id/adapt body. Optional owner instructions
 *  steer the rewrite. The optional BYOK [credential] is the AI key chosen at
 *  the build-flow key step; the box stores it keyed by buildId and the
 *  adaptRunner opens it just-in-time. Omitted ⇒ the box uses what it has and
 *  may answer 503 ("AI adapt not configured" → fall back to scratch).
 *  Box-only, never logged. MIRRORS the `credential` field parsed in the
 *  daemon's buildModesHttp.ts and iOS BuildAdaptRequest. */
@Serializable
data class BuildAdaptRequest(
    val instructions: String? = null,
    val credential: BuildCredential? = null,
)

/** POST /api/build/sessions/:id/adapt response. A 503 means "AI adapt not
 *  configured" — the client falls back to from-scratch. */
@Serializable
data class BuildAdaptResponse(
    val ok: Boolean = false,
    val fileCount: Int = 0,
)

// ---------- mcp mode ---------------------------------------------------

/** POST /api/build/mcp + .../mcp/rotate body. Optional human label. */
@Serializable
data class BuildMcpRequest(
    val label: String? = null,
)

/** The connection an external IDE pastes into its MCP settings. The key
 *  binds the connection to exactly one build session. `ideConfig` is the
 *  copyable JSON snippet (Cursor/Cline MCP-servers format). */
@Serializable
data class BuildMcpConnection(
    val url: String,
    val key: String,
    /** Opaque copyable IDE config blob (re-serialized verbatim for copy). */
    val ideConfig: kotlinx.serialization.json.JsonElement,
)

/** POST /api/build/mcp response. */
@Serializable
data class BuildMcpResponse(
    val buildId: String,
    val connection: BuildMcpConnection,
)

// ---------- env-requests (value-free) ----------------------------------

/** One env var the IDE/AI asked for. VALUE-FREE by contract — only the
 *  NAME (+ optional why) travels; the owner sets the value on the box. */
@Serializable
data class BuildEnvRequest(
    val name: String,
    val why: String? = null,
    val secret: Boolean = false,
    val requestedAt: Long = 0,
    val requestedBy: String? = null,
    val currentlySet: Boolean = false,
)

@Serializable
data class BuildEnvRequestsResponse(
    val requests: List<BuildEnvRequest> = emptyList(),
)

// ---------- journal ----------------------------------------------------

/** One past build in the sessions list. */
@Serializable
data class BuildSummary(
    val buildId: String,
    val mode: String,                 // "scratch" | "git" | "mcp"
    val serviceId: String? = null,
    val startedAt: Long = 0,
    val lastAt: Long = 0,
    val entryCount: Int = 0,
    val lastKind: String = "",
)

@Serializable
data class BuildSessionsResponse(
    val builds: List<BuildSummary> = emptyList(),
)

/** One append-only journal entry for a build. Value-free by contract. */
@Serializable
data class BuildJournalEntry(
    val seq: Int = 0,
    val ts: Long = 0,
    val buildId: String = "",
    val mode: String = "",
    val kind: String = "",
    val actor: String = "",
    val summary: String = "",
    val detail: String? = null,
    val serviceId: String? = null,
)

@Serializable
data class BuildJournalResponse(
    val entries: List<BuildJournalEntry> = emptyList(),
)

// ---------- deploy -----------------------------------------------------

@Serializable
data class BuildDeployResponse(
    val ok: Boolean = false,
    val serviceId: String = "",
    val url: String = "",
)

/**
 * Client for the paired-session-gated "build a service" modes. Distinct
 * from ScreensClient: these endpoints live under the `/api/build/` prefix,
 * not the `/api/screens/` prefix. Reuses the same pod base-URL +
 * `x-flagship-session` token plumbing.
 */
interface BuildClient {
    suspend fun gitImport(req: BuildGitRequest): BuildGitResponse
    suspend fun adapt(buildId: String, req: BuildAdaptRequest = BuildAdaptRequest()): BuildAdaptResponse
    suspend fun mcpCreate(req: BuildMcpRequest = BuildMcpRequest()): BuildMcpResponse
    suspend fun mcpGet(buildId: String): BuildMcpResponse
    suspend fun mcpRotate(buildId: String, req: BuildMcpRequest = BuildMcpRequest()): BuildMcpResponse
    suspend fun envRequests(buildId: String): BuildEnvRequestsResponse
    suspend fun sessions(): BuildSessionsResponse
    suspend fun journal(buildId: String): BuildJournalResponse
    suspend fun deploy(buildId: String): BuildDeployResponse
}
