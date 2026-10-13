// In-memory fixture data mirroring iOS's MockScreensClient. Used by
// previews and unit tests — every method returns plausible data so the
// full UI can be exercised without a paired pod.

package com.flagshipserver.app.api

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

class MockScreensClient(
    var simulatedLatencyMs: Long = 180,
    var shouldFail: Boolean = false,
) : ScreensClient {

    /// Set by the container view to pivot fixture output on the active
    /// pod context. LiveScreensClient achieves the same by swapping its
    /// session-store pod base URL.
    var podContext: String = "home"

    private suspend fun tick() {
        if (simulatedLatencyMs > 0) delay(simulatedLatencyMs)
        if (shouldFail) throw ScreensError.Http(503, "simulated failure")
    }

    private fun now(): Long = System.currentTimeMillis()

    override suspend fun serverUpdates(refresh: Boolean): ReleaseCatalogResponse {
        tick()
        val running = "9f2c1ab3de4567890abcdef1234567890abcdef1"
        val latest = ReleaseEntry(
            commit = "4b1e0c9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c",
            releaseId = "mock-new",
            tag = "v0.0.0-2026-10-11-4b1e0c9d",
            endorsedAt = "2026-10-11T12:00:00.000Z",
            relation = "newer",
        )
        return ReleaseCatalogResponse(
            checkedAt = now(),
            currentCommit = running,
            latest = latest,
            releases = listOf(
                latest,
                ReleaseEntry(running, "mock-cur", "v0.0.0-2026-10-10-9f2c1ab3", "2026-10-10T12:00:00.000Z", "current"),
                ReleaseEntry(
                    "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
                    "mock-old",
                    "v0.0.0-2026-10-09-1a2b3c4d",
                    "2026-10-09T12:00:00.000Z",
                    "older",
                ),
            ),
        )
    }

    override suspend fun serverDetail(): ServerDetailResponse {
        tick()
        val day = 24L * 3600 * 1000
        val pod = podContext
        val serviceCount = (abs(pod.hashCode()) % 5) + 1
        return ServerDetailResponse(
            serverFqdn = "$pod.bright-maple.flagship.services",
            username = "bright-maple",
            daemonVersion = "0.18.4",
            currentCommit = "9f2c1ab3de4567890abcdef1234567890abcdef1",
            startedAt = now() - 11L * day,
            uptimeMs = 11L * day,
            certNotAfter = now() + 67L * day,
            certNotBefore = now() - 23L * day,
            certSans = listOf("$pod.bright-maple.flagship.services", "*.$pod.bright-maple.flagship.services"),
            serviceCount = serviceCount,
            pairedSessionCount = 2,
            recentInstallEvents = listOf(
                RecentInstallEvent(now() - 60_000L * 30, "installed", "bright-maple--plants", "via vibe-code"),
                RecentInstallEvent(now() - 60_000L * 60 * 6, "deploy", "bright-maple--wiki", "v1.4.0"),
                RecentInstallEvent(now() - 60_000L * 60 * 26, "installed", "bright-maple--wiki", "via vibe-code"),
            ),
        )
    }

    override suspend fun appsList(): AppsListResponse {
        tick()
        // url mirrors the live daemon's tier-1 form
        // `https://<urlLabel>.<serverFqdn>` (screensHttp builds it off the
        // box's per-box wildcard name — cert model A′).
        val fqdn = "$podContext.bright-maple.flagship.services"
        return AppsListResponse(
            apps = listOf(
                AppSummary("bright-maple--plants", "bright-maple", "plants", "plants",
                    "Houseplant watering tracker", "https://plants.$fqdn/", "running", "0.0.3", now() - 60_000 * 30,
                    egress = egressFixture["bright-maple--plants"], access = accessSummary("bright-maple--plants")),
                AppSummary("bright-maple--wiki", "bright-maple", "wiki", "wiki",
                    "Personal notes + recipes", "https://wiki.$fqdn/", "running", "1.4.0", now() - 60_000 * 60 * 26,
                    egress = egressFixture["bright-maple--wiki"], access = accessSummary("bright-maple--wiki")),
                AppSummary("trent--scratchpad", "trent", "scratchpad", "scratchpad--trent",
                    "Markdown scratchpad", "https://scratchpad--trent.$fqdn/", "stopped", "0.7.1", now() - 60_000L * 60 * 24 * 12,
                    egress = egressFixture["trent--scratchpad"], access = accessSummary("trent--scratchpad")),
            )
        )
    }

    /** Each app's internet hosts: plants wants a weather API, wiki needs none. */
    val egressFixture: MutableMap<String, AppEgress> = mutableMapOf(
        "bright-maple--plants" to AppEgress(declared = listOf("api.open-meteo.com")),
        "bright-maple--wiki" to AppEgress(),
    )
    val egressCalls: MutableList<Pair<String, AppEgressRequest>> = mutableListOf()
    /** Thrown by `serviceEgressSet` instead of applying. */
    var egressError: Throwable? = null

    override suspend fun serviceEgressSet(serviceId: String, req: AppEgressRequest): AppEgressResponse {
        tick()
        egressCalls.add(serviceId to req)
        egressError?.let { throw it }
        val current = egressFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"no such service"}""")
        val next = current.copy(approved = req.grant.hosts.filter { it in current.declared })
        egressFixture[serviceId] = next
        return AppEgressResponse(ok = true, egress = next)
    }

    /** Each app's access list (§3a): plants was denied a weather API, wiki
     *  allows one host. An app missing here is on a box from before access
     *  lists (its summary carries no `access`). */
    val accessFixture: MutableMap<String, AppAccessState> = mutableMapOf(
        "bright-maple--plants" to AppAccessState(
            list = com.flagshipserver.app.core.AppAccessList.DEFAULT_LIST,
            listSha256 = com.flagshipserver.app.core.AppAccessList.sha256Hex(com.flagshipserver.app.core.AppAccessList.DEFAULT_LIST),
            pending = listOf(
                AppAccessPending("api.open-meteo.com", AppAccessPending.SOURCE_APP, 0, now() - 60_000L * 30, now() - 60_000L * 30),
            ),
        ),
        "bright-maple--wiki" to AppAccessState(
            list = "allow en.wikipedia.org\n",
            listSha256 = com.flagshipserver.app.core.AppAccessList.sha256Hex("allow en.wikipedia.org\n"),
        ),
    )
    val accessCalls: MutableList<Pair<String, AppAccessSetRequest>> = mutableListOf()
    val accessDismissals: MutableList<Pair<String, String>> = mutableListOf()
    /** Thrown by `serviceAccessSet` instead of applying. */
    var accessError: Throwable? = null

    private fun accessSummary(serviceId: String): AppAccessSummary? = accessFixture[serviceId]?.let {
        AppAccessSummary(com.flagshipserver.app.core.AppAccessList.parse(it.list).rules.size, it.pending.size, it.draft != null)
    }

    /** Drafts discarded with `serviceAccessDraftDismiss`. */
    val accessDraftDismissals: MutableList<String> = mutableListOf()

    override suspend fun serviceAccess(serviceId: String): AppAccessState {
        tick()
        return accessFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"no such service"}""")
    }

    override suspend fun serviceAccessSet(serviceId: String, req: AppAccessSetRequest): AppAccessSetResponse {
        tick()
        accessCalls.add(serviceId to req)
        accessError?.let { throw it }
        val current = accessFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"no such service"}""")
        val parsed = com.flagshipserver.app.core.AppAccessList.parse(req.list)
        if (!parsed.ok) {
            val errors = parsed.errors.joinToString(",") { """{"line":${it.line},"message":${JsonPrimitive(it.message)}}""" }
            throw ScreensError.Http(400, """{"error":"the list has errors","errors":[$errors]}""")
        }
        // A request is answered once a rule names its host.
        val named = parsed.rules.map { it.target }.toSet()
        // Applying a list drops the draft.
        val next = AppAccessState(req.list, req.grant.listSha256, current.pending.filter { it.host !in named }, draft = null)
        accessFixture[serviceId] = next
        return AppAccessSetResponse(ok = true, access = kotlinx.serialization.json.Json.encodeToJsonElement(AppAccessState.serializer(), next))
    }

    override suspend fun serviceAccessDismiss(serviceId: String, host: String) {
        tick()
        accessDismissals.add(serviceId to host)
        val current = accessFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"no such service"}""")
        accessFixture[serviceId] = current.copy(pending = current.pending.filter { it.host != host })
    }

    override suspend fun serviceAccessDraftDismiss(serviceId: String) {
        tick()
        accessDraftDismissals.add(serviceId)
        val current = accessFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"no such service"}""")
        accessFixture[serviceId] = current.copy(draft = null)
    }

    /** Each app's API keys (docs/app-apis.md §3): plants has a read key, wiki
     *  none. An app missing here is on a box from before API keys (404). */
    val apiKeysFixture: MutableMap<String, MutableList<AppApiKeyInfo>> = mutableMapOf(
        "bright-maple--plants" to mutableListOf(
            AppApiKeyInfo(
                keyId = "5d2c8e0f9a7b1346",
                label = "Garden sensor",
                scope = com.flagshipserver.app.core.AppApiKey.SCOPE_READ,
                createdAt = now() - 60_000L * 60 * 24 * 9,
                lastUsedAt = now() - 60_000L * 12,
                expiresAt = 0,
            ),
        ),
        "bright-maple--wiki" to mutableListOf(),
    )
    val apiKeyCreates: MutableList<Pair<String, AppApiKeyCreateRequest>> = mutableListOf()
    val apiKeyRevokes: MutableList<Pair<String, String>> = mutableListOf()
    /** Thrown by `serviceApiKeyCreate` / `serviceApiKeyRevoke` instead of applying. */
    var apiKeysError: Throwable? = null

    override suspend fun serviceApiKeys(serviceId: String): AppApiKeysResponse {
        tick()
        val keys = apiKeysFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        return AppApiKeysResponse(keys.toList())
    }

    override suspend fun serviceApiKeyCreate(serviceId: String, req: AppApiKeyCreateRequest): AppApiKeyCreateResponse {
        tick()
        apiKeyCreates.add(serviceId to req)
        apiKeysError?.let { throw it }
        val keys = apiKeysFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        val g = req.grant
        if (g.serviceId != serviceId || !com.flagshipserver.app.core.AppApiKey.isValidKeyId(g.keyId) ||
            g.scope !in setOf(com.flagshipserver.app.core.AppApiKey.SCOPE_READ, com.flagshipserver.app.core.AppApiKey.SCOPE_WRITE) ||
            req.signature.length != 128
        ) {
            throw ScreensError.Http(400, """{"error":"malformed grant"}""")
        }
        if (g.serverDomain != boxFqdn()) throw ScreensError.Http(403, """{"error":"grant names another server"}""")
        if (keys.any { it.keyId == g.keyId }) throw ScreensError.Http(409, """{"error":"key id exists"}""")
        keys.add(
            AppApiKeyInfo(
                keyId = g.keyId,
                label = req.label,
                scope = g.scope,
                createdAt = now(),
                lastUsedAt = null,
                expiresAt = g.expiresAt,
            ),
        )
        val secret = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })
        return AppApiKeyCreateResponse(ok = true, key = "fsk_${g.keyId}_$secret")
    }

    override suspend fun serviceApiKeyRevoke(serviceId: String, keyId: String) {
        tick()
        apiKeyRevokes.add(serviceId to keyId)
        apiKeysError?.let { throw it }
        val keys = apiKeysFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        if (!keys.removeAll { it.keyId == keyId }) throw ScreensError.Http(404, """{"error":"no such key"}""")
    }

    override suspend fun accessRequests(): AccessRequestsResponse {
        tick()
        val name = { id: String -> id.substringAfter("--").replaceFirstChar { it.uppercase() } }
        // Drafts first, as the box lists them.
        val drafts = accessFixture.mapNotNull { (id, state) ->
            state.draft?.let { d ->
                AccessRequest(id, name(id), kind = AccessRequest.KIND_DRAFT, hosts = d.hosts, createdAt = d.createdAt)
            }
        }
        return AccessRequestsResponse(
            drafts + accessFixture.flatMap { (id, state) ->
                state.pending.map { p ->
                    AccessRequest(id, name(id), p.host, p.source, p.attempts, p.firstSeen, p.lastSeen)
                }
            },
        )
    }

    /** The box's push setting for access requests, and every write to it. */
    var accessAlertsEnabled: Boolean = true
    val accessAlertsWrites: MutableList<Boolean> = mutableListOf()

    override suspend fun accessAlerts(): AccessAlertsSetting {
        tick()
        return AccessAlertsSetting(accessAlertsEnabled)
    }

    override suspend fun accessAlertsSet(enabled: Boolean): AccessAlertsSetting {
        tick()
        accessAlertsWrites += enabled
        accessAlertsEnabled = enabled
        return AccessAlertsSetting(enabled, ok = true)
    }

    override suspend fun boxFqdn(): String = "$podContext.bright-maple.flagship.services"

    // ---- Copies (docs/app-placement.md §5) ----

    /** Every copy request this box received, in order. */
    val copyRequests: MutableList<AppCopyRequest> = mutableListOf()
    /** The copies this box reports. A test can seed or advance them. */
    val copies: MutableList<AppCopyRecord> = mutableListOf()
    /** Thrown by [serviceCopy] when set (e.g. a 409 or an older box's 404). */
    var copyError: Throwable? = null
    /** Every signed uninstall this box received. */
    val uninstalls: MutableList<Pair<String, UninstallServiceBody>> = mutableListOf()
    var uninstallError: Throwable? = null

    override suspend fun serviceCopy(req: AppCopyRequest): AppCopyResponse {
        tick()
        copyError?.let { throw it }
        copyRequests.add(req)
        val id = "copy-${copyRequests.size}"
        copies.add(
            AppCopyRecord(
                copyId = id,
                serviceId = req.grant.serviceId,
                appName = req.grant.serviceId.substringAfter("--"),
                sourceServer = req.grant.sourceServer,
                state = "copying",
                progress = 0.0,
                startedAt = now(),
            ),
        )
        return AppCopyResponse(copyId = id)
    }

    override suspend fun serviceCopies(): AppCopiesResponse {
        tick()
        return AppCopiesResponse(copies.toList())
    }

    override suspend fun uninstallService(serviceId: String, body: UninstallServiceBody) {
        tick()
        uninstallError?.let { throw it }
        uninstalls.add(serviceId to body)
    }

    // ---- The owner's Database section (docs/app-apis.md §6) ----

    /** One table: its columns and every row (values as the box sends them). */
    data class MockTable(val columns: List<AppDbColumn>, val rows: List<List<kotlinx.serialization.json.JsonElement>>, val kind: String = "table")

    /** Each app's stores and their tables. An app missing here is on a box
     *  without the Database section (404). */
    val dbFixture: MutableMap<String, MutableMap<String, MutableMap<String, MockTable>>> = mutableMapOf(
        "bright-maple--plants" to mutableMapOf(
            "default" to mutableMapOf(
                "plants" to MockTable(
                    listOf(AppDbColumn("id", "integer"), AppDbColumn("name", "text"), AppDbColumn("watered", "boolean")),
                    (1..230).map { i ->
                        listOf(JsonPrimitive(i), JsonPrimitive("Plant $i"), JsonPrimitive(i % 3 == 0))
                    },
                ),
                "waterings" to MockTable(
                    listOf(AppDbColumn("id", "bigint"), AppDbColumn("plant_id", "integer"), AppDbColumn("at", "timestamp with time zone")),
                    listOf(listOf(JsonPrimitive("1"), JsonPrimitive(3), JsonPrimitive("2026-10-11 08:00:00+00"))),
                ),
            ),
        ),
    )
    val dbTableCalls: MutableList<Triple<String, String, Pair<Int, Int>>> = mutableListOf()
    val dbQueries: MutableList<Pair<String, AppDbQueryRequest>> = mutableListOf()
    /** Thrown by every database call instead of answering (e.g. a 403 for a companion). */
    var dbError: Throwable? = null
    /** Signed orders already run: a repeat gets 409. */
    private val dbUsedOrders = HashSet<String>()

    private fun dbStore(serviceId: String, store: String): MutableMap<String, MockTable> {
        val stores = dbFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        return stores[store] ?: throw ScreensError.Http(404, """{"error":"no such store"}""")
    }

    override suspend fun serviceDb(serviceId: String): AppDbOverview {
        tick()
        dbError?.let { throw it }
        val stores = dbFixture[serviceId] ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        return AppDbOverview(
            stores.map { (store, tables) ->
                AppDbStore(
                    store,
                    tables.map { (name, t) ->
                        AppDbTable(name, t.kind, if (t.kind == "view") null else t.rows.size.toDouble(), 8192.0 + t.rows.size * 64.0)
                    },
                )
            },
        )
    }

    override suspend fun serviceDbTable(serviceId: String, store: String, table: String, offset: Int, limit: Int): AppDbRows {
        tick()
        dbError?.let { throw it }
        dbTableCalls.add(Triple(serviceId, table, offset to limit))
        val t = dbStore(serviceId, store)[table] ?: throw ScreensError.Http(404, """{"error":"no such table"}""")
        return AppDbRows(t.columns, t.rows.drop(offset).take(limit.coerceAtMost(1000)), t.rows.size.toLong())
    }

    override suspend fun serviceDbExportCsv(serviceId: String, store: String, table: String): ByteArray {
        tick()
        dbError?.let { throw it }
        val t = dbStore(serviceId, store)[table] ?: throw ScreensError.Http(404, """{"error":"no such table"}""")
        val cell = { e: kotlinx.serialization.json.JsonElement ->
            val v = (e as? JsonPrimitive)?.content ?: e.toString()
            if (v.any { it == ',' || it == '"' || it == '\n' }) "\"" + v.replace("\"", "\"\"") + "\"" else v
        }
        val lines = listOf(t.columns.joinToString(",") { it.name }) + t.rows.map { r -> r.joinToString(",") { cell(it) } }
        return (lines.joinToString("\n") + "\n").toByteArray()
    }

    override suspend fun serviceDbQuery(serviceId: String, store: String, req: AppDbQueryRequest): AppDbQueryResult {
        tick()
        dbQueries.add(serviceId to req)
        dbError?.let { throw it }
        val tables = dbStore(serviceId, store)
        val sql = req.sql.trim()
        val verb = sql.split(Regex("\\s+"), 2).first().trimEnd(';').uppercase()
        val reads = verb == "SELECT" || verb == "WITH" || verb == "SHOW" || verb == "EXPLAIN"
        val g = req.grant
        if (g != null || req.signature != null) {
            if (g == null || req.signature?.length != 128) throw ScreensError.Http(400, """{"error":"malformed grant"}""")
            if (g.serviceId != serviceId) throw ScreensError.Http(400, """{"error":"the order is for a different app"}""")
            if (g.store != store) throw ScreensError.Http(400, """{"error":"the order is for a different store"}""")
            if (g.serverDomain != boxFqdn()) throw ScreensError.Http(403, """{"error":"the order is for a different server"}""")
            if (g.sqlSha256 != com.flagshipserver.app.core.AppDbWrite.sqlSha256(req.sql)) {
                throw ScreensError.Http(403, """{"error":"the statement is not the one that was signed"}""")
            }
            if (!dbUsedOrders.add("$serviceId|$store|${g.sqlSha256}|${g.issuedAt}")) {
                throw ScreensError.Http(409, """{"error":"this signed order was already used: sign it again"}""")
            }
        } else if (!reads) {
            throw ScreensError.Http(
                400,
                """{"error":"cannot execute $verb in a read-only transaction","sqlState":"25006","needsGrant":true}""",
            )
        }
        if (!reads) return AppDbQueryResult(command = verb, rowCount = 1)
        val from = Regex("(?i)\\bfrom\\s+([A-Za-z_][A-Za-z0-9_.]*)").find(sql)?.groupValues?.get(1)
        val t = from?.let { tables[it] }
            ?: if (from == null) null else throw ScreensError.Http(
                400, """{"error":"relation \"$from\" does not exist","sqlState":"42P01","position":15}""",
            )
        if (t == null) return AppDbQueryResult("SELECT", listOf(AppDbColumn("?column?", "integer")), listOf(listOf(JsonPrimitive(1))), 1)
        val max = 1000
        return AppDbQueryResult("SELECT", t.columns, t.rows.take(max), minOf(t.rows.size, max).toLong(), t.rows.size > max)
    }

    /** Services the box says can be edited from the phone (built there). */
    var editableServiceIds: Set<String> = setOf("bright-maple--plants")

    override suspend fun appDetail(serviceId: String): AppDetailResponse {
        tick()
        val app = appsList().apps.firstOrNull { it.serviceId == serviceId }
            ?: throw ScreensError.Http(404, "no such app")
        return AppDetailResponse(
            app = app,
            manifest = mapOf(
                "name" to JsonPrimitive(app.slug),
                "datastore" to JsonPrimitive("postgres"),
                "siblings" to JsonPrimitive(false),
            ),
            dataLayerInstances = listOf(
                AppDetailResponse.DataLayerInstance("postgres", "${app.slug}_db")
            ),
            members = listOf(
                AppDetailResponse.AppMember("ab12cd", "owner", app.installedAt)
            ),
            browserTabs = emptyList(),
            lastBackup = AppDetailResponse.BackupSummary(
                backupId = "bk-${app.slug}-001",
                createdAt = now() - 60_000L * 60 * 2,
                bytes = 4_812_000,
            ),
            recentLogs = listOf("listening on :8080", "GET / → 200", "migration check ok"),
            editable = serviceId in editableServiceIds,
            adaptedFrom = adaptedFromFixture[serviceId]?.let { AppDetailResponse.AdaptedFrom(it) },
        )
    }


    val vibeCodeStartCalls: MutableList<VibeCodeStartRequest> = mutableListOf()

    /** When set, start refuses with it (e.g. an edit's 409 or 413). */
    var vibeCodeStartError: Throwable? = null

    override suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse {
        tick()
        vibeCodeStartCalls.add(req)
        vibeCodeStartError?.let { throw it }
        // Wire-match the live contract: no credential + no promo budget ⇒ the
        // box asks the client for a key. The mock has no promo budget, so a
        // credential-less start signals needsCredential.
        if (req.credential == null) {
            return VibeCodeStartResponse(sessionId = "", needsCredential = true)
        }
        return VibeCodeStartResponse(sessionId = "vc-${UUID.randomUUID().toString().take(8).lowercase()}")
    }

    /** Background deploys started on the mock: each poll walks one phase on. */
    private val deployPolls = mutableMapOf<String, Int>()

    /** The credential each deploy carried, in order. */
    val deployCredentials: MutableList<BuildCredential?> = mutableListOf()

    override suspend fun vibeCodeDeployStart(sessionId: String, credential: BuildCredential?): VibeCodeDeployReply {
        tick()
        deployCredentials.add(credential)
        deployPolls[sessionId] = 0
        return VibeCodeDeployReply(ok = true, started = true)
    }

    override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse {
        tick()
        deployPolls[sessionId]?.let { n ->
            deployPolls[sessionId] = n + 1
            val stage = listOf("staging", "going-live").getOrNull(n)
            return VibeCodeStatusResponse(
                status = if (stage != null) "deploying" else "deployed",
                deployPhase = stage,
                transcript = emptyList(),
                files = emptyMap(),
                deployedUrl = if (stage == null) "https://habits.$podContext.bright-maple.flagship.services/" else null,
            )
        }
        return VibeCodeStatusResponse(
            status = "streaming",
            transcript = listOf(
                VibeCodeStatusResponse.TranscriptEntry("user", "Build a habit tracker."),
                VibeCodeStatusResponse.TranscriptEntry("assistant", "Sketching schema for habits + check-ins…"),
            ),
            files = emptyMap(),
            deployedUrl = null,
            errorReason = null,
        )
    }

    override suspend fun browserTabsList(serviceId: String): BrowserTabsListResponse {
        tick(); return BrowserTabsListResponse(tabs = emptyList())
    }

    override suspend fun pairedSessionsList(): PairedSessionsListResponse {
        tick()
        return PairedSessionsListResponse(
            sessions = listOf(
                PairedSessionSummary("a1b2c3d4", now() - 60_000L * 60 * 24 * 14, true),
                PairedSessionSummary("f9e8d7c6", now() - 60_000L * 60 * 24 * 3, false),
            )
        )
    }

    override suspend fun revokePairedSession(tokenPrefix: String) { tick() }

    override suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse {
        tick(); return OrdersSendResponse(ok = true, response = null)
    }

    override suspend fun urlControllerOwned(): UrlControllerOwnedResponse {
        tick()
        return UrlControllerOwnedResponse(
            urls = listOf(
                OwnedUrl("home.bright-maple.flagship.services", "canonical", now() - 60_000L * 60 * 24 * 30),
                OwnedUrl("plants.bright-maple.flagship.services", "alias", now() - 60_000L * 30),
                OwnedUrl("wiki.bright-maple.flagship.services", "alias", now() - 60_000L * 60 * 26),
            )
        )
    }

    override suspend fun urlControllerClaim(req: UrlControllerClaimRequest): UrlControllerClaimResponse {
        tick(); return UrlControllerClaimResponse(ok = true)
    }

    override suspend fun appBackupStart(req: AppBackupStartRequest): AppBackupStartResponse {
        tick()
        return AppBackupStartResponse(
            backupId = "bk-${UUID.randomUUID().toString().take(8).lowercase()}",
            fetchPath = "/api/screens/app-backup/${req.serviceId}/fetch",
            expiresAt = now() + 3600L * 1000,
            bytes = 4_812_000,
            encrypted = req.password != null,
        )
    }

    override suspend fun serverMetrics(podId: String): ServerMetricsResponse {
        tick()
        val interval = 60_000L
        val memTotal = 8L * 1024 * 1024 * 1024
        val diskTotal = 256L * 1024 * 1024 * 1024
        val seed = abs(podId.hashCode())

        val cpu = mutableListOf<ServerMetricsResponse.TimedSample>()
        val mem = mutableListOf<ServerMetricsResponse.TimedSample>()
        val io = mutableListOf<ServerMetricsResponse.IOSample>()
        val net = mutableListOf<ServerMetricsResponse.IOSample>()
        for (i in 0 until 60) {
            val t = now() - (59 - i) * interval
            val phase = i / 60.0 * Math.PI * 2
            val s = (seed % 7) / 7.0
            cpu.add(ServerMetricsResponse.TimedSample(t, (18 + 14 * sin(phase + s) + 6 * cos(2 * phase + s)).coerceIn(2.0, 95.0)))
            mem.add(ServerMetricsResponse.TimedSample(t, memTotal * (0.42 + 0.06 * sin(phase + s))))
            io.add(ServerMetricsResponse.IOSample(t,
                read = (220_000 + 180_000 * sin(phase * 1.3 + s)).coerceAtLeast(0.0),
                write = (140_000 + 110_000 * cos(phase * 1.1 + s)).coerceAtLeast(0.0)))
            net.add(ServerMetricsResponse.IOSample(t,
                read = (90_000 + 70_000 * sin(phase * 0.7 + s)).coerceAtLeast(0.0),
                write = (55_000 + 50_000 * cos(phase * 0.9 + s)).coerceAtLeast(0.0)))
        }
        val memUsed = mem.last().value.toLong()
        return ServerMetricsResponse(
            collectedAt = now(),
            cpuPercent = cpu.last().value,
            loadAvg1 = 0.62, loadAvg5 = 0.71, loadAvg15 = 0.55,
            memUsedBytes = memUsed,
            memTotalBytes = memTotal,
            diskUsedBytes = (diskTotal * 0.34).toLong(),
            diskTotalBytes = diskTotal,
            diskIOReadBytesPerSec = io.last().read,
            diskIOWriteBytesPerSec = io.last().write,
            netRxBytesPerSec = net.last().read,
            netTxBytesPerSec = net.last().write,
            cpuHistory = cpu, memHistory = mem, ioHistory = io, netHistory = net,
        )
    }

    // W10 — per-app env vars + vibe-code session mock state.
    //
    // Values are SECRET — held only in this in-memory map and never
    // echoed by any response (mirrors the daemon's "values never leave"
    // invariant). The test surface exposes only the NAMES.
    private val mockEnvNames: MutableMap<String, MutableSet<String>> =
        mutableMapOf(
            "bright-maple--plants" to mutableSetOf("WEATHER_API_KEY"),
            "bright-maple--wiki" to mutableSetOf(),
        )

    override suspend fun serviceEnvList(appId: String): ServiceEnvListResponse {
        tick()
        return ServiceEnvListResponse(
            names = (mockEnvNames[appId] ?: emptySet()).toList().sorted()
        )
    }

    override suspend fun serviceEnvSet(appId: String, req: ServiceEnvSetRequest): ServiceEnvOpResponse {
        tick()
        val set = mockEnvNames.getOrPut(appId) { mutableSetOf() }
        set.add(req.name)
        return ServiceEnvOpResponse(ok = true)
    }

    override suspend fun serviceEnvUnset(appId: String, req: ServiceEnvUnsetRequest): ServiceEnvOpResponse {
        tick()
        mockEnvNames[appId]?.remove(req.name)
        return ServiceEnvOpResponse(ok = true)
    }

    override suspend fun vibeCodeSessionState(sessionId: String): VibeCodeSessionPublicState {
        tick()
        val n = now()
        return VibeCodeSessionPublicState(
            id = sessionId,
            appId = "bright-maple--plants",
            status = "awaiting-tool-response",
            messages = listOf(
                VibeCodeSessionMessage(role = "user", text = "Build me a plants tracker", timestamp = n - 30_000),
                VibeCodeSessionMessage(role = "assistant", text = "Sure — I need a weather API key for the dehydration warning.", timestamp = n - 5_000),
            ),
            pendingRequest = VibeCodePendingRequest.RequestEnvVar(
                toolUseId = "tu_mock_42",
                payload = RequestEnvVarPayload(
                    name = "WEATHER_API_KEY",
                    description = "OpenWeather API key",
                    why = "to look up today's high temperature",
                    example = "abc123…",
                    secret = true,
                ),
            ),
        )
    }

    override suspend fun vibeCodeSessionReply(sessionId: String, req: VibeCodeReplyRequest): VibeCodeReplyResponse {
        tick()
        return VibeCodeReplyResponse(ok = true)
    }

    override suspend fun vibeCodeDiscard(sessionId: String) {
        tick()
    }

    /** Services built from a shared adaptation, and the repo each adapts. */
    var adaptedFromFixture: Map<String, String> = emptyMap()
    val adapterReports: MutableList<Pair<String, String>> = mutableListOf()
    /** Thrown by `adapterReport` instead of sending. */
    var adapterReportError: Throwable? = null

    override suspend fun adapterReport(serviceId: String, detail: String) {
        tick()
        adapterReportError?.let { throw it }
        adapterReports.add(serviceId to detail)
    }

    override suspend fun vibeCodeDeploy(sessionId: String): BuildDeployResponse {
        tick()
        return BuildDeployResponse(
            ok = true,
            serviceId = "bright-maple-habits",
            url = "https://habits.$podContext.bright-maple.flagship.services/",
        )
    }

    override suspend fun postRecoveryStatus(): PostRecoveryStatusResponse {
        tick()
        val day = 24L * 3600 * 1000
        return PostRecoveryStatusResponse(
            report = PostRecoverySnapshot(
                currentIrkPubHex = "abcdef0123456789".repeat(4),
                state = WatcherState(
                    lastSeen = null,
                    lastSwapTo = "feedbeef".repeat(8),
                    lastSwapAt = now() - 2 * day,
                    lastPolledAt = now() - 30_000,
                    lastError = null,
                ),
                lastReissue = ReissuanceReportPayload(
                    startedAt = now() - 2 * day,
                    completedAt = now() - 2 * day + 4_500,
                    status = "complete",
                    oldIrkPrefix = "0123456789ab",
                    newIrkPrefix = "feedbeef0123",
                    apps = listOf(
                        AppReissuanceSummary(
                            serviceId = "bright-maple--plants", slug = "plants",
                            rewrittenCount = 1, unchangedCount = 0,
                            error = null, completedAt = now() - 2 * day + 1_500,
                        ),
                        AppReissuanceSummary(
                            serviceId = "bright-maple--wiki", slug = "wiki",
                            rewrittenCount = 3, unchangedCount = 1,
                            error = null, completedAt = now() - 2 * day + 3_500,
                        ),
                    ),
                    totalRewritten = 4,
                    reattachedCount = 2,
                    unchangedCount = 1,
                    undoWindowExpiresAt = now() + 5 * day,
                ),
            ),
        )
    }

    /** Overridable fixture for tests + dev. Null → the honest-empty
     *  "not participating, zero peers, zeroed stats" default below
     *  (matches the daemon's behaviour when the registry is not wired). */
    var peerBackupStatusFixture: PeerBackupStatusResponse? = null

    /** Records each `peerBackupToggle` call's `participate` argument so
     *  tests can assert the right value flowed through. */
    val togglePeerBackupCalls: MutableList<Boolean> = mutableListOf()

    override suspend fun peerBackupStatus(): PeerBackupStatusResponse {
        tick()
        peerBackupStatusFixture?.let { return it }
        return PeerBackupStatusResponse(
            participating = false,
            peersBackingYouUp = emptyList(),
            peersYouBackUp = emptyList(),
            shards = emptyList(),
            repair = PeerBackupRepairStatus(
                state = "idle",
                lastTickMs = null,
                queued = 0,
                completed24h = 0,
                lastError = null,
            ),
            stats = PeerBackupStats(
                total = 0,
                durable = 0,
                atRisk = 0,
                yourBytesStored = 0,
                peerBytesHosted = 0,
            ),
        )
    }

    override suspend fun peerBackupToggle(participate: Boolean): PeerBackupStatusResponse {
        tick()
        togglePeerBackupCalls.add(participate)
        val current = peerBackupStatusFixture
        val next = if (current != null) {
            current.copy(participating = participate)
        } else {
            PeerBackupStatusResponse(
                participating = participate,
                peersBackingYouUp = emptyList(),
                peersYouBackUp = emptyList(),
                shards = emptyList(),
                repair = PeerBackupRepairStatus(
                    state = "idle",
                    lastTickMs = null,
                    queued = 0,
                    completed24h = 0,
                    lastError = null,
                ),
                stats = PeerBackupStats(
                    total = 0, durable = 0, atRisk = 0,
                    yourBytesStored = 0, peerBytesHosted = 0,
                ),
            )
        }
        peerBackupStatusFixture = next
        return next
    }

    override fun installEvents(serial: String): Flow<InstallEvent> = flow {
        val timeline = listOf<Pair<Long, InstallEvent>>(
            0L  to InstallEvent.Registered(serial, now()),
            1500L to InstallEvent.Boot(now()),
            4000L to InstallEvent.TunnelOnline(now()),
            9500L to InstallEvent.CertIssued(now()),
            11000L to InstallEvent.Ready("newbox.bright-maple.flagship.services", now()),
        )
        var elapsed = 0L
        for ((at, event) in timeline) {
            val wait = at - elapsed
            if (wait > 0) delay(wait)
            emit(event)
            elapsed = at
        }
    }

    override fun vibeCodeStream(sessionId: String): Flow<VibeCodeFrame> = flow {
        val tokens = listOf(
            "Sketching ", "schema. ", "Two tables: ", "habits, ", "check_ins.\n",
            "Building manifest…\n",
            "Creating Docker image…\n",
            "Deploying to ", "home pod…\n",
            "Live. 🎉",
        )
        for (t in tokens) {
            emit(VibeCodeFrame.Token(t))
            delay(600)
        }
        emit(VibeCodeFrame.ManifestEmit("{\"name\":\"habits\",\"datastore\":\"postgres\"}"))
        delay(500)
        emit(VibeCodeFrame.BuildStart)
        for (log in listOf("FROM node:20-alpine", "RUN apk add postgresql-client", "COPY . /app", "Build ok in 8.4s")) {
            emit(VibeCodeFrame.BuildLog(log))
            delay(300)
        }
        emit(VibeCodeFrame.Deploy("habits", "https://habits.$podContext.bright-maple.flagship.services/"))
        emit(VibeCodeFrame.Done)
    }

    val browserStreamsOpened = mutableListOf<String>()
    var browserStreamFramesToEmit: List<BrowserFrame> = emptyList()

    override fun browserTabStream(tabId: String): BrowserStream {
        browserStreamsOpened.add(tabId)
        val s = MockBrowserStream()
        for (f in browserStreamFramesToEmit) s.emit(f)
        return s
    }

    // ---------- P6 app-invite -----------------------------------------

    /** Overridable fixture for `appInviteList(serviceId)`. Null → honest-
     *  empty default (matches the daemon's "no pending invites" steady
     *  state). Mirrors iOS's `appInviteListFixture`. */
    var appInviteListFixture: AppInviteListResponse? = null

    /** Overridable fixture for `appInviteAccess(serviceId)`. Null →
     *  honest-empty default. Mirrors iOS's `appInviteAccessFixture`. */
    var appInviteAccessFixture: AppInviteAccessResponse? = null

    /** Optional issuance result override. When null the mock mints a
     *  deterministic 32-byte hex secret + 24h TTL — matching the
     *  daemon's `DEFAULT_TTL_MS`. */
    var appInviteIssueFixture: AppInviteIssueResponse? = null

    /** Records each `appInviteIssue` call so tests can assert the wire
     *  shape (incl. that no label/displayName/sentTo flowed through —
     *  privacy invariant). Mirrors iOS's `appInviteIssueCalls`. */
    val appInviteIssueCalls: MutableList<AppInviteIssueRequest> = mutableListOf()

    /** Records each `appInviteRevoke` call's request. */
    val appInviteRevokeCalls: MutableList<AppInviteRevokeRequest> = mutableListOf()

    override suspend fun appInviteIssue(req: AppInviteIssueRequest): AppInviteIssueResponse {
        tick()
        appInviteIssueCalls.add(req)
        appInviteIssueFixture?.let { return it }
        val secret = (1..32).joinToString("") {
            "%02x".format(kotlin.random.Random.nextInt(0, 256))
        }
        return AppInviteIssueResponse(secret = secret, expiresAt = now() + 24L * 3600 * 1000)
    }

    override suspend fun appInviteList(serviceId: String): AppInviteListResponse {
        tick()
        return appInviteListFixture ?: AppInviteListResponse(pending = emptyList())
    }

    override suspend fun appInviteAccess(serviceId: String): AppInviteAccessResponse {
        tick()
        return appInviteAccessFixture ?: AppInviteAccessResponse(access = emptyList())
    }

    override suspend fun appInviteRevoke(req: AppInviteRevokeRequest): AppInviteRevokeResponse {
        tick()
        appInviteRevokeCalls.add(req)
        val key = when (req.scope) {
            "invite" -> "invite:${req.serviceId}:${req.inviteId ?: ""}"
            "access" -> "access:${req.serviceId}:${req.irkPubKey ?: ""}"
            else -> "${req.scope}:${req.serviceId}"
        }
        val priorMatches = appInviteRevokeCalls.dropLast(1).any { prior ->
            val pk = when (prior.scope) {
                "invite" -> "invite:${prior.serviceId}:${prior.inviteId ?: ""}"
                "access" -> "access:${prior.serviceId}:${prior.irkPubKey ?: ""}"
                else -> "${prior.scope}:${prior.serviceId}"
            }
            pk == key
        }
        return AppInviteRevokeResponse(ok = true, alreadyRevoked = priorMatches)
    }

    // ---------- P14 companion-dock -----------------------------------

    /** Overridable fixture for `companionList()`. Null → honest-empty
     *  default (matches the daemon's behaviour when no companion has
     *  redeemed a ticket yet). Mirrors iOS's `companionListFixture`. */
    var companionListFixture: CompanionListResponse? = null

    /** Records each `companionMintTicket` call so tests can assert the
     *  wire shape (label round-tripped, no other fields snuck in). */
    val companionMintCalls: MutableList<CompanionMintTicketRequest> = mutableListOf()

    val companionApproveCalls: MutableList<CompanionDockApproveRequest> = mutableListOf()

    /** Records each `companionRevoke` call's tokenPrefix. */
    val companionRevokeCalls: MutableList<String> = mutableListOf()

    override suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse {
        tick()
        companionMintCalls.add(req)
        val id = "tk-${UUID.randomUUID().toString().take(8).lowercase()}"
        val secret = (1..32).joinToString("") {
            "%02x".format(kotlin.random.Random.nextInt(0, 256))
        }
        return CompanionMintTicketResponse(
            ticketId = id,
            ticketSecret = secret,
            expiresAt = now() + 60_000L,
        )
    }

    override suspend fun companionApproveDock(req: CompanionDockApproveRequest): CompanionDockApproveResponse {
        tick()
        companionApproveCalls.add(req)
        return CompanionDockApproveResponse(ok = true, expiresAt = now() + 4 * 60 * 60 * 1_000L)
    }

    override suspend fun companionList(): CompanionListResponse {
        tick()
        return companionListFixture ?: CompanionListResponse(companions = emptyList())
    }

    override suspend fun companionRevoke(req: CompanionRevokeRequest): CompanionRevokeResponse {
        tick()
        companionRevokeCalls.add(req.tokenPrefix)
        return CompanionRevokeResponse(ok = true)
    }

    // ---------- P14 Phase 2 companion write-relay (owner queue) -------

    /** Overridable fixture for `companionPendingWrites()`. Null →
     *  honest-empty default. Mirrors iOS `companionPendingWritesFixture`. */
    var companionPendingWritesFixture: CompanionPendingWritesResponse? = null

    /** Records each `companionResolvePending` call so tests can assert
     *  which request was resolved + with what outcome. */
    val companionResolveCalls: MutableList<CompanionResolvePendingRequest> = mutableListOf()

    override suspend fun companionPendingWrites(): CompanionPendingWritesResponse {
        tick()
        return companionPendingWritesFixture ?: CompanionPendingWritesResponse(pending = emptyList())
    }

    override suspend fun companionResolvePending(req: CompanionResolvePendingRequest): CompanionResolvePendingResponse {
        tick()
        companionResolveCalls.add(req)
        companionPendingWritesFixture?.let { fixture ->
            companionPendingWritesFixture = fixture.copy(
                pending = fixture.pending.filterNot { it.requestId == req.requestId },
            )
        }
        return CompanionResolvePendingResponse(ok = true, alreadyResolved = false)
    }
}
