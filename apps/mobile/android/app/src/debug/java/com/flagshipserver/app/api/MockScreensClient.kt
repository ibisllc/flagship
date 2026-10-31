// In-memory fixture data mirroring iOS's MockScreensClient. Used by
// previews and unit tests — every method returns plausible data so the
// full UI can be exercised without a paired pod.

package com.flagshipserver.app.api

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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

    /** Boxes (by podContext label) that don't answer, like a real offline,
     *  revoked or never-online box: their server detail fails. */
    val unreachablePodContexts: MutableSet<String> = mutableSetOf()

    /** The gym: a failure every call throws while set (any transport or HTTP error). */
    @Volatile var failure: Throwable? = null

    private suspend fun tick() {
        if (simulatedLatencyMs > 0) delay(simulatedLatencyMs)
        failure?.let { throw it }
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

    /** Replaces the applied `lastUpdate` (a rollback, a refusal, one kept in recovery). */
    var lastUpdateFixture: LastUpdate? = null

    /** The box's dead-man setting (server-detail `serving`): a 7-day policy renewed an hour ago. */
    var servingFixture: ServingView? = ServingView(
        grace = "7d", onLapse = "stop-apps", until = System.currentTimeMillis() + 7L * 86_400_000 - 3_600_000,
        policyGen = 1, regGen = 1, scopeSha256 = "1b".repeat(32), boxPub = "6e".repeat(32),
    )
    /** What the apps handed this box (`POST /api/screens/serving`). */
    val servingPosts: MutableList<BoxServingPost> = mutableListOf()

    override suspend fun postServing(body: BoxServingPost): BoxServingAck {
        tick()
        body.policy?.let { p ->
            MockSignatures.requireAdmin("serving-policy", com.flagshipserver.app.core.ServingAuthority.canonical(p.record), p.signature)
            val r = p.record
            servingFixture = ServingView(r.grace, r.onLapse, if (r.grace == "indefinite") null else servingFixture?.until,
                r.policyGen, r.regGen, r.scopeSha256, r.box)
        }
        val best = body.leases?.maxByOrNull { it.record.notAfter }?.record
        val f = servingFixture
        if (best != null && f != null && f.grace != "indefinite" && best.policyGen == f.policyGen) {
            servingFixture = f.copy(until = maxOf(f.until ?: 0L, best.notAfter))
        }
        servingPosts.add(body)
        return BoxServingAck(ok = true, policyAdopted = body.policy != null, leasesAccepted = body.leases?.size ?: 0, serving = servingFixture)
    }

    override suspend fun serverDetail(): ServerDetailResponse {
        tick()
        if (podContext in unreachablePodContexts) throw java.io.IOException("$podContext isn't answering")
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
            lastUpdate = lastUpdateFixture ?: LastUpdate(
                outcome = "applied",
                at = now() - 2L * day,
                targetCommit = "9f2c1ab3de4567890abcdef1234567890abcdef1",
                previousCommit = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
            ),
            debugAccess = debugAccessState,
            serving = servingFixture,
            storage = ServerStorage(
                brake = "off",
                capped = true,
                apps = appStorageFixture.map { (id, s) -> AppStorageEntry(id, s.files, s.postgres) },
            ),
        )
    }

    /** Each app's disk use against its limits, as the box sends it (Wiki's files folder is full). */
    val appStorageFixture: MutableMap<String, AppStorage> = mutableMapOf(
        "bright-maple--plants" to AppStorage(
            files = StoreUsage(usedBytes = 2L * 1024 * 1024 * 1024, limitBytes = 5L * 1024 * 1024 * 1024, enforced = true),
            postgres = StoreUsage(usedBytes = 300L * 1024 * 1024, limitBytes = 1024L * 1024 * 1024),
        ),
        "bright-maple--wiki" to AppStorage(
            files = StoreUsage(usedBytes = 5L * 1024 * 1024 * 1024, limitBytes = 5L * 1024 * 1024 * 1024, full = true, enforced = true),
        ),
    )

    /** Gym: a failure for the apps list (e.g. a name the phone's resolver can't find). */
    var appsListFailure: Throwable? = null

    override suspend fun appsList(): AppsListResponse {
        tick()
        appsListFailure?.let { throw it }
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
        MockSignatures.requireAdmin(
            "app-egress",
            com.flagshipserver.app.core.AppEgressGrant.canonicalBytes(req.grant.serverDomain, req.grant.serviceId, req.grant.hosts, req.grant.issuedAt),
            req.signature,
        )
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
        MockSignatures.requireAdmin(
            "app-access",
            com.flagshipserver.app.core.AppAccessList.canonicalBytes(req.grant.serverDomain, req.grant.serviceId, req.grant.listSha256, req.grant.issuedAt),
            req.signature,
        )
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
        MockSignatures.requireAdmin(
            "app-api-key",
            com.flagshipserver.app.core.AppApiKey.canonicalBytes(g.serverDomain, g.serviceId, g.keyId, g.scope, g.expiresAt, g.issuedAt),
            req.signature,
        )
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

    /** The box's "Share update results" choice (null: the box refuses this session, 403), and every write. */
    var updateReportsShare: Boolean? = false
    val updateReportsWrites: MutableList<Boolean> = mutableListOf()

    override suspend fun updateReports(): UpdateReportsSetting {
        tick()
        val share = updateReportsShare ?: throw ScreensError.Http(403, """{"error":"owner sessions only"}""")
        return UpdateReportsSetting(share, if (updateReportsWrites.isEmpty()) "default" else "owner")
    }

    override suspend fun updateReportsSet(share: Boolean): UpdateReportsSetting {
        tick()
        updateReportsWrites += share
        if (updateReportsShare == null) throw ScreensError.Http(403, """{"error":"owner sessions only"}""")
        updateReportsShare = share
        return UpdateReportsSetting(share, "owner")
    }

    override suspend fun boxFqdn(): String = "$podContext.bright-maple.flagship.services"

    // ---- App-name certificate grant (serverWildcardGrant.ts) ------------

    /** The grant the box keeps once one verifies; null until then. */
    var wildcardGrant: Pair<Long, String>? = null
    /** Every grant posted, as (issuedAt, signature). */
    val wildcardGrantPosts: MutableList<Pair<Long, String>> = mutableListOf()
    /** The key the box signs with, which the grant must name (the gym sets it to the pinned one). */
    var wildcardGrantStkHex: String? = null
    var wildcardGrantUser: String = "bright-maple"

    override suspend fun serverWildcardGrantGranted(): Boolean {
        tick()
        return wildcardGrant != null
    }

    override suspend fun postServerWildcardGrant(issuedAt: Long, signatureHex: String) {
        tick()
        wildcardGrantPosts += issuedAt to signatureHex
        val stk = wildcardGrantStkHex
        if (stk != null) {
            val bytes = com.flagshipserver.app.core.ServerWildcardGrant.canonicalBytes(wildcardGrantUser, boxFqdn(), stk, issuedAt)
            MockSignatures.requireAdmin("server-wildcard-grant", bytes, signatureHex)
        }
        wildcardGrant = issuedAt to signatureHex
    }

    // ---- App chat (chat/approvals.ts) -----------------------------------

    /** Held chat requests; empty unless a scenario seeds them ([seedChat]). */
    val chatFixture: MutableList<ChatRequestWire> = mutableListOf()
    val chatAlwaysFixture: MutableList<ChatAlwaysWire> = mutableListOf()
    val chatAnswers: MutableList<ChatAnswerBody> = mutableListOf()
    val chatRevokes: MutableList<ChatAlwaysRevokeBody> = mutableListOf()

    /** One incoming request (a stranger's app asking to chat with Plants) and one outgoing. */
    fun seedChat() {
        chatFixture.clear()
        chatFixture += ChatRequestWire(
            requestId = "c0ffee01", kind = "incoming",
            claimedSender = ChatAppIdentity("riverside", "garden-club"), receiverApp = ChatAppIdentity("bright-maple", "plants"),
            phrase = "blue heron", count = 2, at = now() - 60_000L,
        )
        chatFixture += ChatRequestWire(
            requestId = "c0ffee02", kind = "outgoing",
            claimedSender = ChatAppIdentity("bright-maple", "wiki"), receiverApp = ChatAppIdentity("northwind", "atlas"),
            count = 1, at = now() - 30_000L,
        )
    }

    override suspend fun chatRequests(): ChatRequestsResponse {
        tick()
        return ChatRequestsResponse(chatFixture.toList(), chatAlwaysFixture.toList())
    }

    override suspend fun chatAnswer(body: ChatAnswerBody) {
        tick()
        val kind = com.flagshipserver.app.core.ChatApproval.Kind.entries.first { it.wire == body.kind }
        val decision = com.flagshipserver.app.core.ChatApproval.Decision.entries.first { it.wire == body.decision }
        MockSignatures.requireAdmin(
            "chat-approval",
            com.flagshipserver.app.core.ChatApproval.canonicalBytes(boxFqdn(), body.requestId, kind, decision, body.issuedAt),
            body.signature,
        )
        val held = chatFixture.firstOrNull { it.requestId == body.requestId && it.kind == body.kind }
            ?: throw ScreensError.Http(404, """{"error":"that request is no longer waiting"}""")
        chatAnswers += body
        chatFixture.remove(held)
        if (decision == com.flagshipserver.app.core.ChatApproval.Decision.ALWAYS) {
            val rule = ChatAlwaysWire(held.receiverApp, held.claimedSender)
            if (rule !in chatAlwaysFixture) chatAlwaysFixture += rule
        }
    }

    override suspend fun chatAlwaysRevoke(app: ChatAppIdentity, sender: ChatAppIdentity?): ChatAlwaysRevokeResponse {
        tick()
        chatRevokes += ChatAlwaysRevokeBody(app.author, app.slug, sender)
        val before = chatAlwaysFixture.size
        chatAlwaysFixture.removeAll { it.receiverApp == app && (sender == null || it.claimedSender == sender) }
        return ChatAlwaysRevokeResponse(before - chatAlwaysFixture.size)
    }

    // ---- Browser grants beyond the manifest (browser/grantRequests.ts) ---

    /** Held asks; empty unless a scenario seeds them ([seedBrowserGrants]). */
    val browserGrantFixture: MutableList<BrowserGrantRequestWire> = mutableListOf()
    val browserGrantAnswers: MutableList<BrowserGrantAnswerBody> = mutableListOf()
    /** The box's cooldown after a denial: the same ask from the same app waits. */
    val browserGrantCooling: MutableSet<String> = mutableSetOf()
    /** Gym: the app browser is off on this box (the owner routes answer 404). */
    var browserOff = false
    /** The grants the owner gave (an Allow records one with the duration it signed; Withdraw removes it). */
    val ownerBrowserGrants: MutableList<OwnerBrowserGrantWire> = mutableListOf()
    val browserGrantRevokes: MutableList<BrowserGrantRevokeBody> = mutableListOf()

    /** Plants was allowed to keep a docs site open for the session. */
    fun seedOwnerBrowserGrant() {
        ownerBrowserGrants += OwnerBrowserGrantWire(
            grantId = "bg-0f4c9a1e-2d3b-4c5d-8e6f-7a8b9c0d1e2f", serviceId = "bright-maple--plants",
            capabilities = listOf("navigate", "read-dom"), origins = listOf("docs.plants.example"),
            duration = "session", explanation = "Read the care guide", issuedAt = now() - 120_000L,
        )
    }

    /** Plants asks for one visit to a weather map; Wiki asks to keep reading a docs site and a printer on the LAN. */
    fun seedBrowserGrants() {
        browserGrantFixture.clear()
        browserGrantFixture += BrowserGrantRequestWire(
            requestId = "6b7c0f1e-1111-4a2b-9c3d-000000000001", serviceId = "bright-maple--plants",
            capabilities = listOf("navigate", "screenshot"), origins = listOf("radar.weather.example"),
            duration = "once", explanation = "Show today's rain radar next to your plants", at = now() - 60_000L,
        )
        browserGrantFixture += BrowserGrantRequestWire(
            requestId = "6b7c0f1e-2222-4a2b-9c3d-000000000002", serviceId = "bright-maple--wiki",
            capabilities = listOf("navigate", "read-dom"), origins = listOf("*.docs.example.org"),
            localNetwork = BrowserLocalNetwork("exact", listOf("192.168.1.40")),
            duration = "service", at = now() - 30_000L,
        )
    }

    override suspend fun browserGrantRequests(): BrowserGrantRequestsResponse {
        tick()
        if (browserOff) throw ScreensError.Http(404, """{"error":"not found"}""")
        return BrowserGrantRequestsResponse(browserGrantFixture.toList())
    }

    override suspend fun browserGrantAnswer(body: BrowserGrantAnswerBody) {
        tick()
        val held = browserGrantFixture.firstOrNull { it.requestId == body.requestId }
            ?: throw ScreensError.Http(404, """{"error":"that request is no longer waiting"}""")
        if (body.decision == "allow") {
            val lan = held.localNetwork
            // The box's rule: the owner may grant the ask or less, never more (browserGrantWithin).
            val duration = body.duration ?: held.duration
            if (duration !in com.flagshipserver.app.core.BrowserGrant.durationChoices(held.duration)) {
                throw ScreensError.Http(400, """{"error":"an answer can grant the request or less, never more"}""")
            }
            MockSignatures.requireAdmin(
                "browser-grant",
                com.flagshipserver.app.core.BrowserGrant.canonicalBytes(
                    boxFqdn(), held.requestId, held.serviceId, "allow", duration, held.capabilities, held.origins,
                    lan?.takeIf { it.kind == "exact" }?.hosts, lan?.kind == "whole-lan", body.issuedAt,
                ),
                body.signature,
            )
            ownerBrowserGrants += OwnerBrowserGrantWire(
                grantId = "bg-mock-${held.requestId.takeLast(4)}", serviceId = held.serviceId, capabilities = held.capabilities,
                origins = held.origins, localNetwork = held.localNetwork, duration = duration, explanation = held.explanation, issuedAt = now(),
            )
        } else {
            if (body.signature != null) throw ScreensError.Http(400, """{"error":"a denial carries no signature"}""")
            browserGrantCooling += held.serviceId
        }
        browserGrantAnswers += body
        browserGrantFixture.remove(held)
    }

    override suspend fun browserGrants(serviceId: String?): OwnerBrowserGrantsResponse {
        tick()
        if (browserOff) throw ScreensError.Http(404, """{"error":"not found"}""")
        return OwnerBrowserGrantsResponse(ownerBrowserGrants.filter { serviceId == null || it.serviceId == serviceId })
    }

    override suspend fun browserGrantRevoke(body: BrowserGrantRevokeBody) {
        tick()
        val g = ownerBrowserGrants.firstOrNull { it.grantId == body.grantId && it.serviceId == body.serviceId }
            ?: throw ScreensError.Http(404, """{"error":"that grant is no longer in force"}""")
        MockSignatures.requireAdmin(
            "browser-grant-revoke",
            com.flagshipserver.app.core.BrowserGrant.revokeCanonicalBytes(boxFqdn(), body.serviceId, body.grantId, body.issuedAt),
            body.signature,
        )
        browserGrantRevokes += body
        ownerBrowserGrants.remove(g)
    }

    var sliver: com.flagshipserver.app.core.SecuritySliverResponse = com.flagshipserver.app.core.SecuritySliverResponse()
    val publisherStates: MutableMap<String, com.flagshipserver.app.core.WaitingPublisherResponse> = mutableMapOf()
    val trustCalls: MutableList<Triple<String, com.flagshipserver.app.core.PublisherTrust, String>> = mutableListOf()
    val rejectCalls: MutableList<String> = mutableListOf()

    val permissions: MutableMap<String, com.flagshipserver.app.core.ServicePermissions> = mutableMapOf()
    val permissionRevokes: MutableList<Pair<String, String?>> = mutableListOf()

    override suspend fun servicePermissions(serviceId: String): com.flagshipserver.app.core.ServicePermissions {
        tick()
        return permissions[serviceId] ?: com.flagshipserver.app.core.ServicePermissions()
    }

    override suspend fun revokeServicePermission(serviceId: String, grantId: String?): com.flagshipserver.app.core.PermissionRevokeResult {
        tick()
        permissionRevokes += serviceId to grantId
        val cur = permissions[serviceId] ?: com.flagshipserver.app.core.ServicePermissions()
        val left = cur.grants.filter { grantId != null && it.id != grantId }
        permissions[serviceId] = cur.copy(grants = left)
        return com.flagshipserver.app.core.PermissionRevokeResult(revoked = cur.grants.size - left.size)
    }

    var restoredDrafts: MutableList<com.flagshipserver.app.core.RestoredAccessDraft> = mutableListOf()
    val restoredApprovals: MutableList<com.flagshipserver.app.core.RestoredAccessApproveBody> = mutableListOf()
    val restoredDiscards: MutableList<String> = mutableListOf()
    val updateModes: MutableMap<String, com.flagshipserver.app.core.UpdateModeState> = mutableMapOf()
    val updateModeSets: MutableList<Pair<String, String>> = mutableListOf()
    val delegations: MutableMap<String, MutableList<com.flagshipserver.app.core.CompanionDelegationRow>> = mutableMapOf()
    val delegationGrants: MutableList<com.flagshipserver.app.core.CompanionDelegationBody> = mutableListOf()
    val delegationEnds: MutableList<Pair<String, String>> = mutableListOf()

    override suspend fun restoredAccessDrafts(): com.flagshipserver.app.core.RestoredAccessList { tick(); return com.flagshipserver.app.core.RestoredAccessList(restoredDrafts.toList()) }
    override suspend fun approveRestoredAccess(body: com.flagshipserver.app.core.RestoredAccessApproveBody) {
        tick()
        restoredApprovals += body
        restoredDrafts.removeAll { it.serviceRef == body.request.serviceRef }
    }
    override suspend fun discardRestoredAccess(serviceRef: String) { tick(); restoredDiscards += serviceRef; restoredDrafts.removeAll { it.serviceRef == serviceRef } }
    override suspend fun updateMode(serviceId: String): com.flagshipserver.app.core.UpdateModeState {
        tick()
        return updateModes[serviceId] ?: throw ScreensError.Http(404, "no publisher")
    }
    override suspend fun setUpdateMode(serviceId: String, mode: String) {
        tick()
        updateModeSets += serviceId to mode
        updateModes[serviceId]?.let { updateModes[serviceId] = it.copy(mode = mode) }
    }
    override suspend fun companionDelegations(sessionId: String): com.flagshipserver.app.core.CompanionDelegationList {
        tick()
        return com.flagshipserver.app.core.CompanionDelegationList(delegations[sessionId]?.toList() ?: emptyList())
    }
    override suspend fun allowCompanionBuild(body: com.flagshipserver.app.core.CompanionDelegationBody) {
        tick()
        delegationGrants += body
        delegations.getOrPut(body.delegation.sessionId) { mutableListOf() } += com.flagshipserver.app.core.CompanionDelegationRow(body.delegation.serviceRef, body.delegation.ops, body.delegation.expiresAt)
    }
    override suspend fun endCompanionDelegation(sessionId: String, serviceRef: String) {
        tick()
        delegationEnds += sessionId to serviceRef
        delegations[sessionId]?.removeAll { it.serviceRef == serviceRef }
    }

    override suspend fun securitySliver(): com.flagshipserver.app.core.SecuritySliverResponse { tick(); return sliver }
    override suspend fun publisherState(serviceId: String): com.flagshipserver.app.core.WaitingPublisherResponse {
        tick()
        return publisherStates[serviceId] ?: com.flagshipserver.app.core.WaitingPublisherResponse()
    }
    override suspend fun trustPublisher(serviceId: String, trust: com.flagshipserver.app.core.PublisherTrust, signatureHex: String) {
        tick()
        trustCalls += Triple(serviceId, trust, signatureHex)
    }
    override suspend fun rejectPublisher(serviceId: String) { tick(); rejectCalls += serviceId }

    /** Debug access as a box would hold it: a grant turns it on until its end, a revoke turns it off. */
    var debugAccessState: DebugAccessView = DebugAccessView(on = false)
    val debugAccessBodies: MutableList<String> = mutableListOf()

    override suspend fun debugAccessGrant(bodyJson: String): DebugAccessChangeResponse {
        tick()
        debugAccessBodies += bodyJson
        val g = Json.parseToJsonElement(bodyJson).jsonObject["grant"]?.jsonObject
            ?: throw ScreensError.Http(400, """{"error":"That debug access grant can't be read."}""")
        if (g["serverDomain"]?.jsonPrimitive?.content != boxFqdn()) {
            throw ScreensError.Http(422, """{"error":"That debug access grant is for another server."}""")
        }
        val wasOn = debugAccessState.on
        debugAccessState = DebugAccessView(
            on = true,
            expiresAt = g["expiresAt"]?.jsonPrimitive?.long,
            keyFingerprint = com.flagshipserver.app.core.DebugAccess.fingerprint(g["sshPublicKey"]?.jsonPrimitive?.content.orEmpty()),
            grantedBy = "admin",
        )
        return DebugAccessChangeResponse(ok = true, change = if (wasOn) "renewed" else "granted", debugAccess = debugAccessState)
    }

    override suspend fun debugAccessRevoke(bodyJson: String): DebugAccessChangeResponse {
        tick()
        debugAccessBodies += bodyJson
        val wasOn = debugAccessState.on
        debugAccessState = DebugAccessView(
            on = false,
            lastEnded = if (wasOn) DebugAccessEnded(now(), "revoked") else debugAccessState.lastEnded,
        )
        return DebugAccessChangeResponse(ok = true, change = if (wasOn) "revoked" else "unchanged", debugAccess = debugAccessState)
    }

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
        MockSignatures.requireAdmin(
            "app-copy",
            com.flagshipserver.app.core.AppCopy.canonicalBytes(
                com.flagshipserver.app.core.AppCopy.Grant(req.grant.sourceServer, req.grant.targetServer, req.grant.serviceId, req.grant.issuedAt),
            ),
            req.signature,
        )
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
        val r = body.request
        MockSignatures.requireAdmin(
            "uninstall",
            com.flagshipserver.app.core.UninstallServiceOrder.canonicalBytes(r.serverId, r.creator, r.slug, r.issuedAt),
            body.signature,
        )
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

    // ---------- Access control — members' ranks ------------------------

    /** Per-service members the box would list (absent: no people, the default
     *  account members). */
    val membersFixture: MutableMap<String, AppMembersResponse> = mutableMapOf()
    val setAppRankCalls: MutableList<Pair<String, AppRankRequest>> = mutableListOf()
    /** Status to refuse the next rank change with (e.g. 403), once. */
    var memberRoleStatus: Int? = null

    /** The mock box's device book and co-managers: this device (an admin with
     *  the gym's admin seed, else at the gym's chosen rank, Manager by
     *  default), the account's other phone and one co-managing family. */
    fun defaultAccountMembers(): List<AppAccountMember> {
        val admin = com.flagshipserver.app.core.GymSeams.forceAdminRoot
        val seeded = com.flagshipserver.app.core.GymSeams.deviceRank
        val refused = !admin && seeded == "refused"
        return listOf(
            AppAccountMember(
                kind = "device", deviceId = SELF_DEVICE_ID, devicePub = SELF_DEVICE_PUB,
                tier = if (admin) "admin" else "member",
                rank = when { admin -> "master"; refused -> null; else -> seeded ?: "manager" },
                set = !admin && seeded != null, refused = refused,
            ),
            AppAccountMember(kind = "device", deviceId = OTHER_DEVICE_ID, devicePub = OTHER_DEVICE_PUB, tier = "admin", rank = "master"),
            AppAccountMember(kind = "co-manager", shareId = CO_MANAGER_SHARE_ID, label = "Sam's family", rank = "manager"),
        )
    }

    override suspend fun appMembers(serviceId: String): AppMembersResponse {
        tick()
        return membersFixture[serviceId]
            ?: AppMembersResponse(serviceId = serviceId, mode = "open", defaultRole = "member", accountMembers = defaultAccountMembers())
    }

    /** Mirrors the box: records the order and updates the listed rank. */
    override suspend fun setAppRank(serviceId: String, req: AppRankRequest): AppRankResponse {
        tick()
        setAppRankCalls.add(serviceId to req)
        memberRoleStatus?.let { memberRoleStatus = null; throw ScreensError.Http(it, """{"error":"refused"}""") }
        MockSignatures.requireAdmin(
            "app-rank",
            com.flagshipserver.app.core.AppAccessOrders.canonicalBytes(
                com.flagshipserver.app.core.AppAccessOrders.Rank(req.order.serviceRef, req.order.target, req.order.rank, req.order.issuedAt),
            ),
            req.signature,
        )
        val cur = appMembers(serviceId)
        val t = req.order.target
        val role = req.order.rank
        val next = when {
            t.startsWith("device:") || t.startsWith("share:") -> {
                val key = t.substringAfter(':')
                val refused = role == com.flagshipserver.app.core.AppAccessOrders.REFUSED
                cur.copy(
                    accountMembers = cur.accountMembers.map { m ->
                        val hit = if (t.startsWith("device:")) m.devicePub == key else m.shareId == key
                        if (hit) m.copy(rank = if (refused) null else role, set = true, refused = refused) else m
                    },
                )
            }
            t.startsWith("invite:") -> {
                val id = t.removePrefix("invite:")
                cur.copy(
                    invites = cur.invites.filter { it.inviteId != id } + AppMemberInviteRole(id, role, true),
                    members = cur.members.map { m ->
                        m.copy(grants = m.grants.map { if (it.inviteId == id) it.copy(role = role) else it })
                    },
                )
            }
            t.startsWith("aid:") -> {
                val aid = t.removePrefix("aid:")
                cur.copy(members = cur.members.map { if (it.aid == aid) it.copy(role = role, direct = role) else it })
            }
            else -> cur
        }
        membersFixture[serviceId] = next
        return AppRankResponse(ok = true, target = t, rank = role)
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
            MockSignatures.requireAdmin(
                "app-db-write",
                com.flagshipserver.app.core.AppDbWrite.canonicalBytes(
                    com.flagshipserver.app.core.AppDbWrite.Grant(g.serverDomain, g.serviceId, g.store, g.sqlSha256, g.issuedAt),
                ),
                req.signature,
            )
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
                AppDetailResponse.AppMember("ab12cd", "master", app.installedAt)
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
            importedFrom = importedFromFixture[serviceId]?.let { AppDetailResponse.ImportedFrom(it) },
            storage = appStorageFixture[serviceId],
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
    val deployCredentials: MutableList<LlmProviderCredential?> = mutableListOf()

    override suspend fun vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?): VibeCodeDeployReply {
        tick()
        deployCredentials.add(credential)
        chatDeploys += sessionId
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
                // This phone's own session: a Trusted device, not a browser.
                PairedSessionSummary("a1b2c3d4", now() - 60_000L * 60 * 24 * 14, true, kind = "device"),
                PairedSessionSummary(
                    "f9e8d7c6", now() - 60_000L * 60, false,
                    kind = "remote", expiresAt = now() + 60_000L * 60 * 3,
                ),
            ).filter { it.tokenPrefix !in revokedPairedSessions }
        )
    }

    /** The box's activity log (docs/server-backup-and-clone.md "Activity"):
     *  an update, an app, a backup, a co-manager's sign-in, and an owner write
     *  the feed leaves out. */
    var boxActivityFixture: List<BoxActivityEntry> = listOf(
        BoxActivityEntry(seq = 6, ts = now() - 60_000L * 5, action = "server.update.applied", kind = "server.update.applied", detail = "4b1e0c9d"),
        BoxActivityEntry(seq = 5, ts = now() - 60_000L * 30, action = "post /api/screens/services/plants/env"),
        BoxActivityEntry(seq = 4, ts = now() - 60_000L * 60, action = "server.backup.created", kind = "server.backup.created", detail = "2 files"),
        BoxActivityEntry(
            seq = 3, ts = now() - 60_000L * 120, action = "share.signed-in", kind = "share.signed-in",
            actor = BoxActivityActor(kind = "share", label = "Sam"),
        ),
        BoxActivityEntry(seq = 2, ts = now() - 60_000L * 60 * 24, action = "app.installed", kind = "app.installed", target = "bright-maple--plants"),
    )

    override suspend fun boxActivity(limit: Int, before: Int?): List<BoxActivityEntry> {
        tick()
        return boxActivityFixture.filter { before == null || (it.seq ?: 0) < before }.take(limit)
    }

    /** Paired sessions revoked here; the list leaves them out after. */
    val revokedPairedSessions: MutableList<String> = mutableListOf()

    override suspend fun revokePairedSession(tokenPrefix: String) {
        tick()
        revokedPairedSessions += tokenPrefix
    }

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
            fetchPath = "/api/backups/" + UUID.randomUUID().toString().replace("-", "").take(16),
            expiresAt = now() + 3600L * 1000,
            bytes = 4_812_000,
            encrypted = req.password != null,
        )
    }

    val appBackupFetches = mutableListOf<String>()
    override suspend fun appBackupFetch(fetchPath: String): ByteArray {
        tick()
        appBackupFetches.add(fetchPath)
        return "mock app backup".toByteArray()
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

    /** Nonces the mock box has spent: a replayed change is refused, as on a box. */
    private val spentEnvNonces = mutableSetOf<String>()

    /** Every env change the mock box took, in order (gym and test assertions). */
    val envChanges = mutableListOf<ServiceEnvChange>()

    /** The box's checks on one signed change (signatures aside: the mock holds
     *  no IRK pub): the route's app and op, a well-formed change, the value's
     *  hash, and a nonce not spent before. Same refusal words as the box. */
    private fun acceptEnvChange(appId: String, op: String, c: ServiceEnvChange, value: String?) {
        fun refuse(reason: String): Nothing = throw ScreensError.Http(400, """{"error":"$reason"}""")
        if (c.serviceId != appId) refuse("the change names another app")
        if (c.op != op) refuse("the change is not an $op")
        runCatching { c.canonicalBytes() }.getOrElse { refuse("malformed env change") }
        if (op == "set" && ServiceEnvChange.valueSha256(value ?: "") != c.valueSha256) {
            refuse("the value doesn't match the signed change")
        }
        if (!spentEnvNonces.add(c.nonce)) refuse("this change was already applied")
        envChanges.add(c)
    }

    override suspend fun serviceEnvSet(appId: String, req: ServiceEnvSetRequest): ServiceEnvOpResponse {
        tick()
        acceptEnvChange(appId, "set", req.change, req.value)
        mockEnvNames.getOrPut(appId) { mutableSetOf() }.add(req.change.name)
        return ServiceEnvOpResponse(ok = true)
    }

    override suspend fun serviceEnvUnset(appId: String, req: ServiceEnvUnsetRequest): ServiceEnvOpResponse {
        tick()
        acceptEnvChange(appId, "unset", req.change, null)
        mockEnvNames[appId]?.remove(req.change.name)
        return ServiceEnvOpResponse(ok = true)
    }

    /** Which build chat this box serves: "env" (the AI asks for an env var),
     *  "ready" (ready to deploy, takes a new message) or "failed" (takes one). */
    var chatVariant: String = "env"
    /** Every reply sent to a chat, in order. */
    val chatReplies: MutableList<Pair<String, VibeCodeReplyRequest>> = mutableListOf()
    /** Chats the owner deployed from the chat. */
    val chatDeploys: MutableList<String> = mutableListOf()

    override suspend fun vibeCodeSessionState(sessionId: String): VibeCodeSessionPublicState {
        tick()
        val n = now()
        val continued = chatReplies.any { it.first == sessionId && it.second.envVarStatus == null }
        if (chatVariant != "env" || continued) {
            val provider = chatReplies.lastOrNull { it.first == sessionId }?.second?.credential?.provider ?: "flagship"
            return VibeCodeSessionPublicState(
                id = sessionId,
                appId = "bright-maple--plants",
                status = when {
                    continued -> "ready-to-deploy"
                    chatVariant == "failed" -> "failed"
                    else -> "ready-to-deploy"
                },
                messages = listOf(
                    VibeCodeSessionMessage(role = "user", text = "Build me a plants tracker", timestamp = n - 30_000),
                    VibeCodeSessionMessage(role = "assistant", text = "The plants tracker is ready to deploy.", timestamp = n - 5_000),
                ) + chatReplies.filter { it.first == sessionId }.mapNotNull { (_, r) ->
                    r.text?.let { VibeCodeSessionMessage(role = "user", text = it, timestamp = n - 1_000) }
                },
                failureReason = if (chatVariant == "failed" && !continued) "The app didn't start: port 8080 never answered." else null,
                canContinue = true,
                provider = provider,
                model = chatReplies.lastOrNull { it.first == sessionId }?.second?.model,
                conversationTokens = 1_200,
            )
        }
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
            canContinue = false,
            provider = "flagship",
            conversationTokens = 1_200,
        )
    }

    override suspend fun aiModels(credential: LlmProviderCredential?): AiModelsResponse {
        tick()
        val provider = credential?.provider ?: "flagship"
        if (provider == "flagship") return AiModelsResponse(provider = provider, kind = "flagship")
        if (provider == "flagship-local") {
            // The box's "On this server" menu: only what is downloaded there.
            val installed = localAiFixture.models.filter { it.state == "installed" }
            return AiModelsResponse(
                provider = provider, kind = "own", listed = true,
                defaultModel = installed.firstOrNull { it.tools }?.id ?: installed.firstOrNull()?.id,
                models = installed.map { ModelOption(it.id, it.name, it.contextTokens, vision = false, tools = it.tools, known = true) },
            )
        }
        return AiModelsResponse(
            provider = provider, kind = "own", listed = true, defaultModel = "gpt-5.4-mini",
            models = listOf(
                ModelOption("gpt-5.4-mini", "GPT-5.4 Mini", 400_000, vision = true, tools = true,
                    efforts = listOf("none", "low", "medium", "high", "xhigh"), defaultEffort = "medium", known = true),
                ModelOption("brand-new", "brand-new", known = false),
            ),
        )
    }

    override suspend fun vibeCodeSessionReply(sessionId: String, req: VibeCodeReplyRequest): VibeCodeReplyResponse {
        tick()
        chatReplies += sessionId to req
        return VibeCodeReplyResponse(ok = true)
    }

    override suspend fun vibeCodeDiscard(sessionId: String) {
        tick()
    }

    /** Services built from a shared adaptation, and the repo each adapts. */
    var adaptedFromFixture: Map<String, String> = emptyMap()

    /** Apps imported from a repo on this box (N12 provenance), by service id. */
    var importedFromFixture: Map<String, String> = emptyMap()
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
        chatDeploys += sessionId
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
            v = 2,
            state = "protected",
            policy = "peer",
            healthyBricks = 8,
            totalBricks = 9,
            lastPlacedAt = now() - 3_600_000L * 5,
            archiveCreatedAt = now() - 3_600_000L * 6,
            keepUntil = now() + 3_600_000L * 24 * 60,
            holderList = listOf(
                PeerBackupHolder("Server 1", "ok", now() - 3_600_000L * 2, 3),
                PeerBackupHolder("Server 2", "ok", now() - 3_600_000L * 3, 3),
                PeerBackupHolder("Server 3", "failing", now() - 3_600_000L * 30, 3),
            ),
            hosting = PeerBackupHosting(
                poolBytes = 40L * 1024 * 1024 * 1024, realBytes = 6L * 1024 * 1024 * 1024,
                fillerBytes = 34L * 1024 * 1024 * 1024, provenBytes = 40L * 1024 * 1024 * 1024,
                leases = 4, bricks = 24, reliability = 97, leaving = false,
            ),
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

    // ---------- P14 companion-dock -----------------------------------

    /** Overridable fixture for `companionList()`. Null → honest-empty
     *  default (matches the daemon's behaviour when no companion has
     *  redeemed a ticket yet). Mirrors iOS's `companionListFixture`. */
    var companionListFixture: CompanionListResponse? = null

    /** Records each `companionMintTicket` call so tests can assert the
     *  wire shape (label round-tripped, no other fields snuck in). */
    val companionMintCalls: MutableList<CompanionMintTicketRequest> = mutableListOf()

    /** Records each `companionRevoke` call's tokenPrefix. */
    val companionRevokeCalls: MutableList<String> = mutableListOf()

    override suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse {
        tick()
        companionMintCalls.add(req)
        val id = (1..16).joinToString("") {
            "%02x".format(kotlin.random.Random.nextInt(0, 256))
        }
        val secret = (1..32).joinToString("") {
            "%02x".format(kotlin.random.Random.nextInt(0, 256))
        }
        return CompanionMintTicketResponse(
            ticketId = id,
            ticketSecret = secret,
            expiresAt = now() + 60_000L,
        )
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

    // Backup/clone server (in-memory: the data file is a fixed blob).

    var archiveBytes: ByteArray = ByteArray(5_000) { 7 }
    val archiveStarts: MutableList<ServerArchiveStartRequest> = mutableListOf()
    var archiveForgotten = false
        private set
    /** A small backup file the mock hands out (a real one comes from the box). */
    var archiveBackupFile: ByteArray = "{\"magic\":\"flagship-backup\",\"v\":2}\n".toByteArray()
    val archiveApprovals: MutableList<ServerArchiveApproveRequest> = mutableListOf()
    val restoreStarts: MutableList<ServerRestoreStartRequest> = mutableListOf()
    /** Each chunk's offset and size. */
    val restoreChunks: MutableList<Pair<Long, Int>> = mutableListOf()
    val restoreCommits: MutableList<ServerRestoreCommitRequest> = mutableListOf()
    var restoreApps: List<ServerRestoreApp> = listOf(ServerRestoreApp(serviceId = "alice--wiki", name = "Wiki", state = "done"))
    var restoreFinalState = "done"
    var restoreFailure: String? = null
    /** The backup this (mock) server waits for; null ⇒ it isn't waiting. */
    var restoreWaiting: ServerRestoreWaiting? = null
    /** How much of the data file the server already holds when an upload starts. */
    var restoreAlreadyReceived: Long = 0

    override suspend fun serverArchiveStart(req: ServerArchiveStartRequest) {
        tick()
        if (req.slots.none { it.kind == "passcode" }) throw boxRefusal(400, "a backup made with Back up now needs a passcode", "passcode-required")
        archiveStarts += req
        archiveForgotten = false
    }

    override suspend fun serverArchiveStatus(): ServerArchiveStatus? {
        tick()
        val id = archiveStarts.lastOrNull()?.archiveId ?: return null
        if (archiveForgotten) return null
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(archiveBytes).joinToString("") { "%02x".format(it) }
        return ServerArchiveStatus(
            archiveId = id,
            state = "ready",
            startedAt = 1,
            bytes = archiveBytes.size.toLong(),
            sha256 = sha,
            backupFileName = "home-1970-01-01.flagship-backup",
            dataFileName = "home-1970-01-01.flagship-data",
            bundleFileName = "home-1970-01-01.flagship",
            bundleBytes = archiveBundle.size.toLong(),
            bundleSha256 = sha256Hex(archiveBundle),
            apps = listOf(ServerArchiveApp("alice--wiki", "Wiki")),
        )
    }

    /** The one `.flagship` file the box serves: header, the backup file, the data file. */
    val archiveBundle: ByteArray
        get() = com.flagshipserver.app.core.ServerBackupFormat.bundleHeader(archiveBackupFile.size) + archiveBackupFile + archiveBytes

    private fun sha256Hex(b: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun bundleChunk(offset: Long): ByteArray {
        val bundle = archiveBundle
        if (offset < 0 || offset > bundle.size) throw boxRefusal(400, "bad offset")
        val start = offset.toInt()
        return bundle.copyOfRange(start, minOf(start + 4 * 1024 * 1024, bundle.size))
    }

    override suspend fun serverArchiveBundleChunk(offset: Long): ByteArray {
        tick()
        if (archiveStarts.isEmpty() || archiveForgotten) throw boxRefusal(404, "no backup is ready")
        return bundleChunk(offset)
    }

    override suspend fun serverArchiveForget() {
        tick()
        archiveForgotten = true
    }

    override suspend fun serverArchiveApprove(req: ServerArchiveApproveRequest) {
        tick()
        MockSignatures.requireAdmin("backup-download", req.approval.canonicalBytes(), req.signature)
        archiveApprovals += req
    }

    override suspend fun serverRestoreStart(req: ServerRestoreStartRequest): ServerRestoreStartResponse {
        tick()
        restoreStarts += req
        return ServerRestoreStartResponse(received = restoreAlreadyReceived)
    }

    override suspend fun serverRestoreChunk(offset: Long, data: ByteArray) {
        tick()
        restoreChunks += offset to data.size
    }

    override suspend fun serverRestoreCommit(req: ServerRestoreCommitRequest) {
        tick()
        restoreCommits += req
    }

    /** The lost server's record a running box would answer (null: nothing found). */
    var peerRootFixture: PeerRootSummary? = null
    val peerRootRequests: MutableList<PeerRootRequest> = mutableListOf()
    val peerFetches: MutableList<PeerRootRequest> = mutableListOf()

    override suspend fun peerBackupRoot(req: PeerRootRequest): PeerRootSummary {
        tick()
        peerRootRequests += req
        return peerRootFixture ?: throw ScreensError.Http(404, "{\"error\":\"No peer backup of that server was found.\"}")
    }

    override suspend fun serverRestoreFromPeers(req: PeerRootRequest) {
        tick()
        peerFetches += req
        val w = restoreWaiting ?: throw ScreensError.Http(409, "{\"error\":\"this server isn't waiting for a backup\"}")
        restoreStarts += ServerRestoreStartRequest(w.archiveId, w.bytes)
    }

    override suspend fun serverRestoreStatus(): ServerRestoreStatusResponse {
        tick()
        if (peerFetches.isNotEmpty() && restoreCommits.isEmpty()) {
            val w = restoreWaiting
            if (w != null) {
                return ServerRestoreStatusResponse(
                    waiting = w,
                    restore = ServerRestoreStatus(archiveId = w.archiveId, state = "ready", bytes = w.bytes, received = w.bytes),
                )
            }
        }
        val id = restoreStarts.lastOrNull()?.archiveId
        if (id == null || restoreCommits.isEmpty()) return ServerRestoreStatusResponse(waiting = restoreWaiting, restore = null)
        val failed = restoreFailure != null
        val done = !failed && restoreFinalState == "done"
        val bytes = restoreStarts.last().bytes
        return ServerRestoreStatusResponse(
            waiting = if (done) null else restoreWaiting,
            restore = ServerRestoreStatus(
                archiveId = id,
                state = if (failed) "failed" else restoreFinalState,
                bytes = bytes,
                received = bytes,
                apps = restoreApps,
                reason = restoreFailure,
            ),
        )
    }

    // Saved backups and the backup policy, answered like the box
    // (serverArchive/service.ts, backupPolicy/http.ts): same shapes, same sentences.

    var backupSchedule = BackupSchedule()
    /** The box's key pool (archive ids it may still use). */
    val backupKeyPool: MutableList<String> = MutableList(120) { "%032x".format(it + 1) }
    private val backupUsedIds = mutableSetOf<String>()
    /** The apps a backup holds; a Back up now takes one poll per app. */
    var backupRunApps: List<ServerArchiveApp> = listOf(ServerArchiveApp("bright-maple--plants", "Plants"), ServerArchiveApp("bright-maple--wiki", "Wiki"))
    /** Newest first. */
    val savedBackupsList: MutableList<SavedBackup> = mutableListOf(
        mockSavedBackup("%032x".format(9001), now() - 3_600_000L * 9, "schedule"),
        mockSavedBackup("%032x".format(9000), now() - 3_600_000L * 33, "schedule"),
    )
    var backupLastRun: BackupLastRun? = savedBackupsList.firstOrNull()?.let { BackupLastRun(it.createdAt, true, "schedule", it.archiveId) }
    var backupRunning: BackupRunning? = null
    /** What the next run fails with (the box's sentence), or null. */
    var backupRunFailure: String? = null
    val backupSchedulePuts: MutableList<BackupSchedule> = mutableListOf()
    val backupKeyDeposits: MutableList<BackupKeysRequest> = mutableListOf()
    val backupDeletes: MutableList<String> = mutableListOf()
    var backupRuns = 0
        private set

    var backupPolicyState = BackupPolicyState("phone", 32L * GB, now() - 86_400_000L)
    val backupPolicyPosts: MutableList<BackupPolicyRequest> = mutableListOf()
    /** The app data a backup would hold (null: not measured yet). */
    var backupUsedBytes: Long? = (3.2 * GB).toLong()
    var backupDiskBytes: Long = 360L * GB
    /** The peer engine's status while the policy is "peer". */
    var backupPeerStatus: kotlinx.serialization.json.JsonObject? = kotlinx.serialization.json.buildJsonObject {
        put("state", JsonPrimitive("protected"))
        put("lastPlacedAt", JsonPrimitive(now() - 3_600_000L * 8))
        put("healthyBricks", JsonPrimitive(12))
        put("totalBricks", JsonPrimitive(12))
        put("hostingBytes", JsonPrimitive(5L * GB))
        put("provenBytes", JsonPrimitive(5L * GB))
        put("poolBytes", JsonPrimitive(240L * GB))
        put("holders", JsonPrimitive(4))
    }

    private fun mockSavedBackup(id: String, at: Long, trigger: String): SavedBackup {
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(archiveBytes).joinToString("") { "%02x".format(it) }
        val stem = "home-" + java.text.SimpleDateFormat("yyyy-MM-dd-HHmm", java.util.Locale.US)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(at))
        return SavedBackup(
            archiveId = id,
            createdAt = at,
            trigger = trigger,
            bytes = archiveBytes.size.toLong(),
            sha256 = sha,
            backupBytes = archiveBackupFile.size.toLong(),
            backupFileName = "$stem.flagship-backup",
            dataFileName = "$stem.flagship-data",
            bundleFileName = "$stem.flagship",
            bundleBytes = archiveBundle.size.toLong(),
            bundleSha256 = sha256Hex(archiveBundle),
            apps = backupRunApps,
        )
    }

    private fun backupNoKeys() =
        "an admin device of your account hasn't approved backups for this server yet: open this server in the Flagship app on an admin device"

    private fun boxRefusal(status: Int, error: String, code: String? = null): ScreensError.Http {
        val body = kotlinx.serialization.json.buildJsonObject {
            put("error", JsonPrimitive(error))
            if (code != null) put("code", JsonPrimitive(code))
        }
        return ScreensError.Http(status, body.toString())
    }

    /** The box's next slot (serverArchive/schedule.ts, without catch-up and retries). */
    private fun backupNextRunAt(t: Long): Long? {
        val s = backupSchedule
        if (s.frequency == "off") return null
        val day = 86_400_000L
        var slot = Math.floorDiv(t, day) * day + s.minuteOfDayUtc * 60_000L
        if (slot > t) slot -= day
        if (s.frequency == "weekly") {
            while (java.time.Instant.ofEpochMilli(slot).atZone(java.time.ZoneOffset.UTC).dayOfWeek.value % 7 != s.weekdayUtc) slot -= day
        }
        return slot + (if (s.frequency == "weekly") 7 else 1) * day
    }

    private fun savedView(): SavedBackupsView {
        val active = backupPolicyState.policy != "none"
        val pool = backupKeyPool.size
        return SavedBackupsView(
            schedule = backupSchedule,
            scheduleActive = active,
            nextRunAt = if (pool == 0 || !active) null else backupNextRunAt(now()),
            lastRun = backupLastRun,
            running = backupRunning,
            keysLeft = pool,
            keysWanted = if (pool < 30) minOf(400, 800 - pool) else 0,
            waitingReason = if (pool == 0 && backupSchedule.frequency != "off") backupNoKeys() else null,
            usedBytes = savedBackupsList.sumOf { it.totalBytes },
            backups = savedBackupsList.toList(),
        )
    }

    /** One poll of a running Back up now: the next app, then done. */
    private fun advanceBackupRun() {
        val r = backupRunning ?: return
        val done = r.progress.done + 1
        if (done < r.progress.total) {
            backupRunning = r.copy(progress = ServerArchiveProgress(done, r.progress.total, backupRunApps.getOrNull(done)?.name ?: ""))
            return
        }
        backupRunning = null
        val failure = backupRunFailure
        if (failure != null) {
            backupLastRun = BackupLastRun(r.startedAt, false, r.trigger, reason = failure)
            return
        }
        val b = mockSavedBackup(r.archiveId, r.startedAt, r.trigger)
        savedBackupsList.add(0, b)
        backupLastRun = BackupLastRun(r.startedAt, true, r.trigger, r.archiveId)
    }

    override suspend fun savedBackups(): SavedBackupsView {
        tick()
        advanceBackupRun()
        return savedView()
    }

    override suspend fun putBackupSchedule(schedule: BackupSchedule): SavedBackupsView {
        tick()
        val s = schedule
        val error = when {
            s.frequency !in setOf("daily", "weekly", "off") -> "frequency must be daily, weekly or off"
            s.minuteOfDayUtc !in 0..1439 -> "the time must be a minute of the day (0 to 1439)"
            s.weekdayUtc !in 0..6 -> "the weekday must be 0 (Sunday) to 6"
            s.keepDaily !in 0..60 -> "keep between 0 and 60 daily backups"
            s.keepWeekly !in 0..52 -> "keep between 0 and 52 weekly backups"
            s.keepDaily + s.keepWeekly == 0 -> "keep at least one backup"
            else -> null
        }
        if (error != null) throw boxRefusal(400, error)
        backupSchedulePuts += s
        backupSchedule = s
        return savedView()
    }

    override suspend fun depositBackupKeys(req: BackupKeysRequest): SavedBackupsView {
        tick()
        val d = req.deposit
        if (!d.isValid || req.keys.isEmpty() || !Regex("^[0-9a-f]{128}$").matches(req.signature)) throw boxRefusal(400, "malformed keys")
        if (d.count != req.keys.size || d.digest != com.flagshipserver.app.core.ArchiveKeys.digest(req.keys)) {
            throw boxRefusal(400, "the keys don't match their signature")
        }
        if (kotlin.math.abs(now() - d.issuedAt) > 10 * 60_000L) throw boxRefusal(403, "the approval is stale: approve again")
        backupKeyDeposits += req
        val have = backupKeyPool.toSet() + backupUsedIds
        backupKeyPool += req.keys.map { it.archiveId }.filter { it !in have }
        while (backupKeyPool.size > 800) backupKeyPool.removeAt(backupKeyPool.lastIndex)
        return savedView()
    }

    override suspend fun runBackupNow(): BackupRunResponse {
        tick()
        if (backupRunning != null) throw boxRefusal(409, "a backup or restore is already running here")
        val id = backupKeyPool.removeFirstOrNull() ?: throw boxRefusal(409, backupNoKeys(), "no-keys")
        backupUsedIds += id
        backupRuns += 1
        backupRunning = BackupRunning(
            archiveId = id,
            trigger = "now",
            startedAt = now(),
            progress = ServerArchiveProgress(0, backupRunApps.size, backupRunApps.firstOrNull()?.name ?: ""),
        )
        return BackupRunResponse(id)
    }

    private fun savedById(id: String): SavedBackup =
        savedBackupsList.firstOrNull { it.archiveId == id } ?: throw boxRefusal(404, "no backup is ready")

    override suspend fun savedBackupBundleChunk(archiveId: String, offset: Long): ByteArray {
        tick()
        savedById(archiveId)
        return bundleChunk(offset)
    }

    override suspend fun savedBackupLink(archiveId: String): SavedBackupLink {
        tick()
        val b = savedById(archiveId)
        return SavedBackupLink("/api/archive-download/" + "ab".repeat(32), b.backupFileName, b.dataFileName, b.bytes, b.sha256, b.bundleFileName, b.bundleBytes, b.bundleSha256, null)
    }

    override suspend fun deleteSavedBackup(archiveId: String): SavedBackupsView {
        tick()
        if (backupRunning?.archiveId == archiveId) throw boxRefusal(409, "the backup is still being made")
        if (savedBackupsList.none { it.archiveId == archiveId }) throw boxRefusal(404, "that backup isn't on this server")
        savedBackupsList.removeAll { it.archiveId == archiveId }
        backupDeletes += archiveId
        return savedView()
    }

    private fun gbText(n: Long) = com.flagshipserver.app.core.BackupsText.gb(n)

    private fun backupLimit(p: BackupPolicyState): Long? = when (p.policy) {
        "phone" -> p.phoneReserveBytes.takeIf { it > 0 }
        "peer" -> backupDiskBytes / 3
        else -> null
    }

    private fun policyView(): BackupPolicyView {
        val p = backupPolicyState
        val limit = backupLimit(p)
        val used = backupUsedBytes
        val over = limit != null && used != null && used >= limit
        val why = if (p.policy == "phone") "the space your device keeps for its backup" else "a third of its disk, so other servers can keep their backups on it"
        return BackupPolicyView(
            policy = p,
            cap = BackupCap(
                limitBytes = limit,
                usedBytes = used,
                measuredAt = used?.let { now() - 120_000L },
                overLimit = over,
                diskBytes = backupDiskBytes,
                reservedForPeersBytes = if (p.policy == "peer") backupDiskBytes - backupDiskBytes / 3 else null,
                apps = if (used != null) listOf(BackupCapApp("bright-maple--plants", used)) else emptyList(),
                overReason = if (over) {
                    "This server holds ${gbText(used!!)} of app data, over its backup limit of ${gbText(limit!!)} ($why). Remove apps or data, or change the backup policy on the server page."
                } else {
                    null
                },
            ),
            peerJson = if (p.policy == "peer") backupPeerStatus else null,
        )
    }

    override suspend fun backupPolicy(): BackupPolicyView {
        tick()
        return policyView()
    }

    override suspend fun setBackupPolicy(req: BackupPolicyRequest): BackupPolicyView {
        tick()
        val o = req.order
        // The box's FLAGSHIP_PEER_BACKUP gate (off at GA): a server not already on Peer can't choose it.
        if (backupPolicyState.policy != "peer" && o.policy == "peer" && !com.flagshipserver.app.core.BackupFeatures.PEER_BACKUP) {
            throw boxRefusal(409, "Backups on other servers aren't available yet. Choose another policy.", "peer-backup-not-available")
        }
        val used = backupUsedBytes
        if (o.isValid && used != null) {
            val limit = backupLimit(BackupPolicyState(o.policy, o.phoneReserveBytes, o.issuedAt))
            if (limit != null && used > limit) {
                val sentence = if (o.policy == "phone") {
                    "This server holds ${gbText(used)} of app data, more than the ${gbText(limit)} your device would keep. Reserve at least ${gbText(used)} on that device, or remove apps or data first."
                } else {
                    "This server holds ${gbText(used)} of app data, more than a third of its disk (${gbText(limit)}), which is all a server may use with peer backups. Remove apps or data first, or choose another policy."
                }
                throw boxRefusal(409, sentence, "over-backup-limit")
            }
        }
        if (!o.isValid) throw boxRefusal(400, "that backup policy is malformed")
        if (!Regex("^[0-9a-f]{128}$").matches(req.signatureHex)) throw boxRefusal(403, "only an admin device of this account can set the backup policy")
        val held = backupPolicyState.issuedAt
        if (held != null && o.issuedAt < held) throw boxRefusal(409, "a newer backup policy is already set on this server")
        backupPolicyPosts += req
        backupPolicyState = BackupPolicyState(o.policy, o.phoneReserveBytes, o.issuedAt)
        return policyView()
    }

    /** Seed the saved backups and policy for a gym scenario (SmokeModeConfig.backups). */
    fun seedBackups(kind: String?) {
        when (kind) {
            "empty" -> {
                backupKeyPool.clear()
                savedBackupsList.clear()
                backupLastRun = null
            }
            "failed" -> backupLastRun = BackupLastRun(now() - 3_600_000L, false, "schedule", reason = "needs about 12.0 GB, has 3.1 GB")
            "unset" -> backupPolicyState = BackupPolicyState()
            "over" -> backupUsedBytes = 40L * GB
            "restore-partial" -> {
                restoreWaiting = ServerRestoreWaiting("ab".repeat(16), 0, "00".repeat(32))
                restoreApps = listOf(
                    ServerRestoreApp("bright-maple--wiki", "Wiki", "done"),
                    ServerRestoreApp("bright-maple--notes", "Notes", "failed", "its image didn't build"),
                )
            }
        }
    }

    companion object {
        private const val GB = 1024L * 1024 * 1024

        /** The mock box the running app talks to in smoke mode, for the gym's
         *  assertions on what was sent. Only MainActivity's smoke seam sets it. */
        @Volatile
        var smokeInstance: MockScreensClient? = null

        /** The mock box's device book: this phone, and the account's other one. */
        const val SELF_DEVICE_ID = "0123456789abcdef0123456789abcdef"
        val SELF_DEVICE_PUB = "a1".repeat(32)
        const val OTHER_DEVICE_ID = "fedcba9876543210fedcba9876543210"
        val OTHER_DEVICE_PUB = "b2".repeat(32)
        const val CO_MANAGER_SHARE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"

        /** The names the account directory would give them (decrypted on the phone). */
        val DEVICE_NAMES = mapOf(SELF_DEVICE_ID to "Pixel 9", OTHER_DEVICE_ID to "Kitchen iPad")
    }

    // ---- Container stack (packages/server-daemon/src/archV2Switch.ts) --------------------------

    /** The box's stack screen; null is a box without it (404: no card). */
    var stackFixture: StackStatus? = null
    /** The signed bodies the mock box took, newest last. */
    val stackBodies = mutableListOf<StackSwitchBody>()
    private var stackReads = 0

    /** The classic stack with a plan that fits, or without room for the move. */
    fun classicStack(blocked: Boolean = false): StackStatus {
        val gib = 1_073_741_824L
        return StackStatus(
            stack = "classic", engine = "docker",
            plan = StackPlan(
                from = "classic", target = "arch-v2",
                steps = listOf(
                    "Install Podman and the new stack's programs from this server's release",
                    "Move 4 app image(s) and 3 volume(s) from Docker to Podman (Docker's copy is kept)",
                    "Restart on the new stack, then check every app comes back within 20 minutes",
                    "Keep Docker for a 24-hour trial: if the server isn't healthy, it goes back by itself",
                ),
                images = 4, volumes = 3, needBytes = 6 * gib, freeBytes = if (blocked) 3 * gib else 41 * gib,
                blockers = if (blocked) listOf(StackBlocker("no-podman-room", "Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB.")) else emptyList(),
            ),
        )
    }

    override suspend fun stackStatus(): StackStatus {
        tick()
        val s = stackFixture ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        val r = s.switchRecord
        if (r != null && r.state == "installing" && ++stackReads >= 2) {
            stackFixture = StackStatus(
                stack = r.target, engine = if (r.target == "arch-v2") "podman" else "docker",
                switchRecord = r.copy(state = "trial", trialUntil = now() + 24L * 3_600_000),
                plan = StackPlan(from = r.target, target = if (r.target == "arch-v2") "classic" else "arch-v2",
                    blockers = listOf(StackBlocker("in-progress", "A stack switch is already under way on this server."))),
            )
        }
        return stackFixture!!
    }

    override suspend fun stackSwitch(body: StackSwitchBody): StackSwitchReply {
        tick()
        val s = stackFixture ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        if (body.order.serverDomain.lowercase() != boxFqdn) throw ScreensError.Http(403, """{"error":"serverId mismatch"}""")
        MockSignatures.requireAdmin("arch-v2-switch", com.flagshipserver.app.core.StackSwitchOrder.canonical(body.order), body.signature)
        stackBodies += body
        val plan = if (s.plan.target == body.order.target) s.plan
        else StackPlan(s.stack, body.order.target, blockers = listOf(StackBlocker("already", "This server already runs that stack.")))
        if (body.dryRun == true) return StackSwitchReply(ok = true, dryRun = true, plan = plan)
        plan.blockers.firstOrNull()?.let { throw ScreensError.Http(409, """{"error":"${it.error}","code":"${it.code}"}""") }
        stackReads = 0
        stackFixture = s.copy(
            switchRecord = StackSwitchRecord("installing", body.order.target, now()),
            plan = plan.copy(blockers = listOf(StackBlocker("in-progress", "A stack switch is already under way on this server."))),
        )
        return StackSwitchReply(ok = true, state = "restarting", plan = plan)
    }

    // ---- Accelerators (packages/server-daemon/src/gpu/http.ts) ---------------------------------

    /** The box's GPU screen; null is a box without it (it answers 404, so the page shows no card). */
    var acceleratorsFixture: AcceleratorsView? = null
    /** The allocations the owner stopped, newest last (the gym checks them). */
    val acceleratorStops = mutableListOf<String>()

    /** Plants holds the RTX 4090, Wiki waits, the A2000 is free and the Radeon was set aside after a fault. */
    fun defaultAccelerators(): AcceleratorsView = AcceleratorsView(
        available = true,
        catalog = AcceleratorCatalog("current", 1),
        devices = listOf(
            AcceleratorDevice("0", "NVIDIA GeForce RTX 4090", "nvidia", 24_564, "in-use",
                listOf(AcceleratorHolder("alice--plants", "app-alice--plants-k1", "running"))),
            AcceleratorDevice("1", "NVIDIA RTX A2000", "nvidia", 6_138, "free"),
            AcceleratorDevice("2", "AMD Radeon PRO W7600", "amd", 8_176, "quarantined"),
        ),
        queue = listOf(AcceleratorQueueEntry("alice--wiki", 1)),
    )

    /** The signed approval and withdrawal bodies the mock box took, newest last. */
    val gpuApprovalBodies = mutableListOf<GpuApprovalBody>()
    val gpuWithdrawBodies = mutableListOf<GpuApprovalWithdrawBody>()

    /** Render, Train and Stream (sharing) ask to use a GPU; Photos may already. `server` is filled with the box's name when read. */
    fun gpuApprovalsFixture(): Pair<List<GpuApprovalRequest>, List<GpuApprovalRequest>> = Pair(
        listOf(
            GpuApprovalRequest("", "alice--render", "inst-7f3a", 3, "nvidia-cuda", 1, listOf("compute"), listOf("exclusive"), "gvisor-nvproxy", true),
            GpuApprovalRequest("", "alice--train", "inst-9", 12, "amd-rocm", 4, listOf("compute", "graphics"), listOf("exclusive"), "vm-passthrough", true),
            GpuApprovalRequest("", "alice--stream", "inst-5", 2, "nvidia-cuda", 1, listOf("video-encode"), listOf("cooperative"), "gvisor-nvproxy", false),
        ),
        listOf(
            GpuApprovalRequest("", "alice--photos", "inst-01", 1, "nvidia-cuda", 1, listOf("video-encode", "compute"), listOf("cooperative"),
                "gvisor-nvproxy", false, "family", "consent-2026-10-25", 1_800_000_000_000),
        ),
    )

    private val boxFqdn get() = "$podContext.bright-maple.flagship.services"

    override suspend fun accelerators(): AcceleratorsView {
        tick()
        val v = acceleratorsFixture ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        val named = { r: GpuApprovalRequest -> if (r.server.isEmpty()) r.copy(server = boxFqdn) else r }
        return v.copy(pendingApprovals = v.pendingApprovals.map(named), approvals = v.approvals.map(named))
    }

    /** As the box: the body's terms must be a pending request's exactly, for this box, signed by the admin root. */
    override suspend fun approveGpu(body: GpuApprovalBody) {
        tick()
        val v = acceleratorsFixture ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        if (body.server != boxFqdn) throw ScreensError.Http(403, """{"error":"That approval is for another server."}""")
        val r = com.flagshipserver.app.core.GpuApprovalOrders.request(body)
        val i = v.pendingApprovals.indexOfFirst { it.appId == r.appId }
        if (i < 0 || v.pendingApprovals[i].installationId != r.installationId || v.pendingApprovals[i].generation != r.generation) {
            throw ScreensError.Http(409, """{"error":"This approval is for another installation or version of the app.","code":"stale-installation"}""")
        }
        val want = v.pendingApprovals[i]
        if (want.backend != r.backend || want.maxCount != r.maxCount || want.isolation != r.isolation || want.caps.toSet() != r.caps.toSet() || want.policies.toSet() != r.policies.toSet()) {
            throw ScreensError.Http(409, """{"error":"This approval doesn't match what the app asks for.","code":"terms-mismatch"}""")
        }
        if ("cooperative" in r.policies && (r.trustDomain == null || r.ownerConsent == null)) {
            throw ScreensError.Http(400, """{"error":"Sharing a GPU between apps needs your consent and a trust domain.","code":"needs-trust-domain"}""")
        }
        MockSignatures.requireAdmin("gpu-approval", com.flagshipserver.app.core.GpuApprovalOrders.canonical(body.server, r, body.issuedAt), body.signature)
        gpuApprovalBodies += body
        val granted = r.copy(issuedAt = body.issuedAt)
        acceleratorsFixture = v.copy(pendingApprovals = v.pendingApprovals.filterIndexed { j, _ -> j != i }, approvals = v.approvals + granted)
    }

    /** Withdraws a granted approval (a request never approved answers 404, as the box does). */
    override suspend fun withdrawGpuApproval(body: GpuApprovalWithdrawBody) {
        tick()
        val v = acceleratorsFixture ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        MockSignatures.requireAdmin(
            "gpu-approval-withdraw",
            com.flagshipserver.app.core.GpuApprovalOrders.withdrawCanonical(boxFqdn, body.appId, body.installationId, body.generation, body.issuedAt),
            body.signature,
        )
        val match = { r: GpuApprovalRequest -> r.appId == body.appId && r.installationId == body.installationId && r.generation == body.generation }
        if (v.approvals.none(match)) throw ScreensError.Http(404, """{"error":"This app has no GPU approval to withdraw.","code":"not-approved"}""")
        gpuWithdrawBodies += body
        acceleratorsFixture = v.copy(approvals = v.approvals.filterNot(match))
    }

    /** Frees the device and, as the GPU service's fair queue does, hands it to the first app waiting. */
    override suspend fun stopAccelerator(allocationId: String) {
        tick()
        val v = acceleratorsFixture ?: throw ScreensError.Http(404, """{"error":"not found"}""")
        val i = v.devices.indexOfFirst { d -> d.holders.any { it.allocationId == allocationId } }
        if (i < 0) throw ScreensError.Http(404, """{"error":"That GPU job is not running."}""")
        acceleratorStops += allocationId
        var queue = v.queue
        var holders = v.devices[i].holders.filter { it.allocationId != allocationId }
        val next = queue.firstOrNull()
        if (holders.isEmpty() && next != null) {
            holders = listOf(AcceleratorHolder(next.appId, "app-${next.appId}-q1", "reserved"))
            queue = if (next.waiting > 1) listOf(next.copy(waiting = next.waiting - 1)) + queue.drop(1) else queue.drop(1)
        }
        val devices = v.devices.toMutableList()
        devices[i] = devices[i].copy(holders = holders, state = if (holders.isEmpty()) "free" else "in-use")
        acceleratorsFixture = v.copy(devices = devices, queue = queue)
    }

    // ---- Local AI (docs/architecture-v2/local-ai.md §4) ----------------------------------------

    /** The box's Local AI screen. The gym edits it; the actions below change it like the box would. */
    var localAiFixture: LocalAiView = defaultLocalAi()
    /** Signed bodies the app sent, newest last (the gym checks them). */
    val localAiTrainBodies = mutableListOf<LocalAiTrainBody>()
    val localAiGrantBodies = mutableListOf<LocalAiGrantBody>()
    val localAiActions = mutableListOf<String>()

    fun defaultLocalAi(): LocalAiView = LocalAiView(
        available = true,
        settings = LocalAiSettings(useGpu = true, serveModel = null),
        hardware = LocalAiHardware(
            cpus = 8, memoryMiB = 15_872, diskFreeBytes = 120_000_000_000, gpuService = true,
            gpus = listOf(
                LocalAiGpu("0", "NVIDIA GeForce RTX 4090", "nvidia", 24_564, "in-use", listOf(LocalAiGpuHolder("alice--render", "Render farm", "app-alice--render-k1", "running"))),
            ),
        ),
        budget = LocalAiBudget(usedBytes = 98_357_920, budgetBytes = 68_719_476_736),
        models = listOf(
            LocalAiModelRow("qwen2.5-coder-7b-q4", "Qwen2.5 Coder 7B", "Best for building apps; wants a GPU", "7B", "Q4_K_M", 4_683_073_536,
                LocalAiLicense("apache-2.0", "https://huggingface.co/Qwen"), 32_768, tools = true, purpose = "build", memoryNeededMiB = 5_643,
                speed = LocalAiSpeed(32.0, measured = false, on = "gpu")),
            LocalAiModelRow("qwen2.5-0.5b-q4", "Qwen2.5 0.5B", "Tiny; runs on any server", "0.5B", "Q4_K_M", 491_400_032,
                LocalAiLicense("apache-2.0", "https://huggingface.co/Qwen"), 32_768, tools = true, purpose = "chat", memoryNeededMiB = 923,
                speed = LocalAiSpeed(48.8, measured = false, on = "cpu")),
            LocalAiModelRow("stories-15m", "TinyStories 15M", "A small model to fine-tune on an app's sample text", "15M", "F32", 98_357_920,
                LocalAiLicense("mit", "https://github.com/karpathy/llama2.c"), 256, tools = false, purpose = "test", trainable = true,
                state = "installed", memoryNeededMiB = 368, speed = LocalAiSpeed(212.4, measured = true, on = "cpu")),
        ),
        service = LocalAiServiceView(state = "stopped"),
        jobs = listOf(
            LocalAiJob("0123456789abcdef", "training", "alice--notes", "Notes", "stories-15m", "running", "cpu", null, null, now() - 60_000, now() - 50_000,
                epochs = 3, epochsDone = 1, checkpoints = 1),
            LocalAiJob("fedcba9876543210", "training", "alice--notes", "Notes", "stories-15m", "queued", null, null, queuePosition = 2, createdAt = now() - 10_000,
                epochs = 2, epochsDone = 0, checkpoints = 0),
        ),
        apps = listOf(
            LocalAiAppRow("alice--notes", "Notes", grant = null),
            LocalAiAppRow("alice--helper", "Helper", LocalAiGrantView(serviceId = "alice--helper", requestsPerDay = 500, tokensPerDay = 200_000, maxTokensPerRequest = 1_024, issuedAt = now() - 3_600_000),
                LocalAiUsage("2026-10-24", 12, 3_400)),
        ),
        datasets = listOf(LocalAiDataset("alice--notes", "Notes", hasSampleData = true), LocalAiDataset("alice--helper", "Helper", hasSampleData = false)),
        trainableModels = listOf(LocalAiTrainable("stories-15m", "TinyStories 15M", installed = true, memoryNeededMiB = 934), LocalAiTrainable("stories-260k", "TinyStories 260K", installed = false, memoryNeededMiB = 518)),
    )

    private var localAiDownloadTicks = 0

    override suspend fun localAi(): LocalAiView {
        tick()
        // A download moves on each look, like the box's progress.
        if (localAiFixture.models.any { it.state == "downloading" } && ++localAiDownloadTicks >= 2) {
            localAiFixture = localAiFixture.copy(models = localAiFixture.models.map {
                if (it.state == "downloading") it.copy(state = "installed", progress = null) else it
            })
        }
        return localAiFixture
    }

    override suspend fun localAiJob(jobId: String): LocalAiJobDetail {
        tick()
        val j = localAiFixture.jobs.firstOrNull { it.id == jobId } ?: throw ScreensError.Http(404, """{"error":"No such training job."}""")
        val cps = (1..(j.checkpoints ?: 0)).map { e -> LocalAiCheckpoint(e, "a".repeat(63) + e, 98_357_920, now() - 30_000, 3.2 - e * 0.4) }
        return LocalAiJobDetail(j, "d".repeat(64), 4_096, cps)
    }

    override suspend fun localAiSettings(useGpu: Boolean?, serveModel: String?, clearServeModel: Boolean) {
        tick()
        val cur = localAiFixture.settings
        localAiFixture = localAiFixture.copy(settings = LocalAiSettings(useGpu ?: cur.useGpu, if (clearServeModel) null else serveModel ?: cur.serveModel))
    }

    override suspend fun localAiModel(action: String, modelId: String) {
        tick()
        localAiActions += "model:$action:$modelId"
        val m = localAiFixture.models.firstOrNull { it.id == modelId } ?: throw ScreensError.Http(404, """{"error":"That model isn't in this server's catalog.","code":"unknown-model"}""")
        val next = when (action) {
            "download" -> {
                if (m.state == "installed") throw ScreensError.Http(409, """{"error":"That model is already on this server.","code":"already-installed"}""")
                localAiDownloadTicks = 0
                m.copy(state = "downloading", progress = LocalAiProgress("downloading", m.sizeBytes * 2 / 5, m.sizeBytes))
            }
            "cancel", "delete" -> m.copy(state = "available", progress = null)
            else -> m
        }
        localAiFixture = localAiFixture.copy(models = localAiFixture.models.map { if (it.id == modelId) next else it })
    }

    override suspend fun localAiService(start: Boolean, modelId: String?) {
        tick()
        localAiActions += if (start) "service:start" else "service:stop"
        val installed = localAiFixture.models.filter { it.state == "installed" }
        if (start && installed.isEmpty()) throw ScreensError.Http(503, """{"error":"No model is downloaded on this server yet. Download one under Local AI.","code":"no-model"}""")
        localAiFixture = localAiFixture.copy(
            service = if (start) LocalAiServiceView("running", "1111222233334444", modelId ?: installed.first().id, "cpu", startedAt = now()) else LocalAiServiceView("stopped"),
        )
    }

    override suspend fun localAiTrain(body: LocalAiTrainBody) {
        tick()
        localAiTrainBodies += body
        val o = body.order
        val app = localAiFixture.apps.firstOrNull { it.serviceId == o.serviceId }?.name
        val waiting = localAiFixture.jobs.count { it.state == "queued" || it.state == "running" || it.state == "preparing" }
        localAiFixture = localAiFixture.copy(jobs = listOf(LocalAiJob(o.jobId, "training", o.serviceId, app, o.baseModel, "queued", queuePosition = waiting + 1,
            createdAt = now(), epochs = o.epochs, epochsDone = 0, checkpoints = 0)) + localAiFixture.jobs)
    }

    override suspend fun localAiJobAction(action: String, jobId: String) {
        tick()
        localAiActions += "job:$action:$jobId"
        localAiFixture = localAiFixture.copy(jobs = when (action) {
            "delete" -> localAiFixture.jobs.filterNot { it.id == jobId }
            "cancel" -> localAiFixture.jobs.map { if (it.id == jobId) it.copy(state = "cancelled", queuePosition = null) else it }
            "resume" -> localAiFixture.jobs.map { if (it.id == jobId) it.copy(state = "queued", queuePosition = 1) else it }
            else -> localAiFixture.jobs
        })
    }

    override suspend fun localAiGrant(body: LocalAiGrantBody) {
        tick()
        localAiGrantBodies += body
        val o = body.order
        localAiFixture = localAiFixture.copy(apps = localAiFixture.apps.map {
            if (it.serviceId != o.serviceId) it
            else it.copy(grant = if (o.requestsPerDay == 0L) null else LocalAiGrantView(o.serverDomain, o.serviceId, o.requestsPerDay, o.tokensPerDay, o.maxTokensPerRequest, o.issuedAt))
        })
    }
}
