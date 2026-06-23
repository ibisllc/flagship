// In-memory fixture BuildClient mirroring the live `/api/build/*` wire
// format. Used by previews + unit tests so the full chooser → git / mcp /
// journal UI can be exercised without a paired pod.
//
// Every shape here MUST round-trip with LiveBuildClient against the daemon
// (packages/server-daemon/src/buildmodes/buildModesHttp.ts) — same keys,
// same nesting. Mirrors iOS MockBuildClient.

package com.flagshipserver.app.api

import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID

class MockBuildClient(
    var simulatedLatencyMs: Long = 120,
    /** When true, `adapt` throws a 503 so previews/tests can exercise the
     *  "AI adapt not configured → fall back to scratch" branch. */
    var adaptNotConfigured: Boolean = false,
    /** When set, the build ENTRY calls (gitImport / mcpCreate / sessions) throw
     *  an `ScreensError.Http` with this status — used to exercise the 404
     *  build-platform-absent mapping. */
    var entryFailStatus: Int? = null,
) : BuildClient {

    private suspend fun tick() { if (simulatedLatencyMs > 0) delay(simulatedLatencyMs) }
    private fun failEntryIfRequested() {
        entryFailStatus?.let { throw ScreensError.Http(it, """{"error":"not found"}""") }
    }
    private fun now(): Long = System.currentTimeMillis()
    private fun mintBuildId(): String = "bld-${UUID.randomUUID().toString().take(8).lowercase()}"
    private fun mintKey(): String = (1..32).joinToString("") {
        "%02x".format(kotlin.random.Random.nextInt(0, 256))
    }

    /** Records each gitImport call so tests can assert the wire shape. */
    val gitImportCalls: MutableList<BuildGitRequest> = mutableListOf()

    /** Overridable verdict. Null → "fit" by default (deterministic install). */
    var gitFitFixture: Boolean? = null

    override suspend fun gitImport(req: BuildGitRequest): BuildGitResponse {
        tick()
        failEntryIfRequested()
        gitImportCalls.add(req)
        val fit = gitFitFixture ?: true
        return if (fit) {
            BuildGitResponse(
                buildId = mintBuildId(),
                fit = true,
                reason = "Found flagship.app.json at the repo root",
                manifestName = "demo-app",
                fileCount = 14,
            )
        } else {
            BuildGitResponse(
                buildId = mintBuildId(),
                fit = false,
                reason = "No flagship.app.json — this repo isn't a Flagship app yet",
                manifestName = null,
                fileCount = 9,
            )
        }
    }

    val adaptCalls: MutableList<Pair<String, BuildAdaptRequest>> = mutableListOf()

    override suspend fun adapt(buildId: String, req: BuildAdaptRequest): BuildAdaptResponse {
        tick()
        adaptCalls.add(buildId to req)
        if (adaptNotConfigured) throw ScreensError.Http(503, """{"error":"AI adapt not configured"}""")
        return BuildAdaptResponse(ok = true, fileCount = 12)
    }

    val mcpCreateCalls: MutableList<BuildMcpRequest> = mutableListOf()
    val mcpRotateCalls: MutableList<Pair<String, BuildMcpRequest>> = mutableListOf()

    private fun connectionFor(buildId: String): BuildMcpConnection {
        val url = "https://home.harry.flagship.services/mcp/build/$buildId"
        val key = mintKey()
        return BuildMcpConnection(url = url, key = key, ideConfig = ideConfig(url, key))
    }

    /** Cursor/Cline MCP-servers config snippet, matching the daemon's shape. */
    private fun ideConfig(url: String, key: String): JsonObject = buildJsonObject {
        put("mcpServers", buildJsonObject {
            put("flagship-build", buildJsonObject {
                put("url", JsonPrimitive(url))
                put("headers", buildJsonObject {
                    put("Authorization", JsonPrimitive("Bearer $key"))
                })
            })
        })
    }

    override suspend fun mcpCreate(req: BuildMcpRequest): BuildMcpResponse {
        tick()
        failEntryIfRequested()
        mcpCreateCalls.add(req)
        val id = mintBuildId()
        return BuildMcpResponse(buildId = id, connection = connectionFor(id))
    }

    override suspend fun mcpGet(buildId: String): BuildMcpResponse {
        tick()
        return BuildMcpResponse(buildId = buildId, connection = connectionFor(buildId))
    }

    override suspend fun mcpRotate(buildId: String, req: BuildMcpRequest): BuildMcpResponse {
        tick()
        mcpRotateCalls.add(buildId to req)
        return BuildMcpResponse(buildId = buildId, connection = connectionFor(buildId))
    }

    /** Overridable fixture for env-requests. Null → a single demo request. */
    var envRequestsFixture: BuildEnvRequestsResponse? = null

    override suspend fun envRequests(buildId: String): BuildEnvRequestsResponse {
        tick()
        return envRequestsFixture ?: BuildEnvRequestsResponse(
            requests = listOf(
                BuildEnvRequest(
                    name = "WEATHER_API_KEY",
                    why = "to look up today's high temperature",
                    secret = true,
                    requestedAt = now() - 30_000,
                    requestedBy = "ide",
                    currentlySet = false,
                ),
            ),
        )
    }

    /** Overridable fixture for the sessions list. Null → two demo builds. */
    var sessionsFixture: BuildSessionsResponse? = null

    override suspend fun sessions(): BuildSessionsResponse {
        tick()
        failEntryIfRequested()
        return sessionsFixture ?: BuildSessionsResponse(
            builds = listOf(
                BuildSummary(
                    buildId = "bld-plants01",
                    mode = "scratch",
                    serviceId = "harry-plants",
                    startedAt = now() - 60_000L * 60 * 26,
                    lastAt = now() - 60_000L * 60 * 25,
                    entryCount = 7,
                    lastKind = "deployed",
                ),
                BuildSummary(
                    buildId = "bld-wiki0002",
                    mode = "git",
                    serviceId = "harry-wiki",
                    startedAt = now() - 60_000L * 60 * 3,
                    lastAt = now() - 60_000L * 60 * 2,
                    entryCount = 4,
                    lastKind = "installed",
                ),
            ),
        )
    }

    /** Overridable fixture for the per-build journal. Null → a demo timeline. */
    var journalFixture: BuildJournalResponse? = null

    override suspend fun journal(buildId: String): BuildJournalResponse {
        tick()
        return journalFixture ?: BuildJournalResponse(
            entries = listOf(
                BuildJournalEntry(seq = 1, ts = now() - 300_000, buildId = buildId, mode = "git", kind = "git-import", actor = "owner", summary = "Cloned repo"),
                BuildJournalEntry(seq = 2, ts = now() - 240_000, buildId = buildId, mode = "git", kind = "fitness", actor = "box", summary = "Flagship-ready ✓"),
                BuildJournalEntry(seq = 3, ts = now() - 60_000, buildId = buildId, mode = "git", kind = "deployed", actor = "box", summary = "Installed", serviceId = "harry-wiki"),
            ),
        )
    }

    val deployCalls: MutableList<String> = mutableListOf()

    override suspend fun deploy(buildId: String): BuildDeployResponse {
        tick()
        deployCalls.add(buildId)
        return BuildDeployResponse(
            ok = true,
            serviceId = "harry-newapp",
            url = "https://newapp.home.harry.flagship.services/",
        )
    }
}
