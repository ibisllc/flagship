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

    override suspend fun serverDetail(): ServerDetailResponse {
        tick()
        val day = 24L * 3600 * 1000
        val pod = podContext
        val serviceCount = (abs(pod.hashCode()) % 5) + 1
        return ServerDetailResponse(
            serverFqdn = "$pod.harry.flagship.services",
            username = "harry",
            daemonVersion = "0.18.4",
            startedAt = now() - 11L * day,
            uptimeMs = 11L * day,
            certNotAfter = now() + 67L * day,
            certNotBefore = now() - 23L * day,
            certSans = listOf("$pod.harry.flagship.services", "*.$pod.harry.flagship.services"),
            serviceCount = serviceCount,
            pairedSessionCount = 2,
            recentInstallEvents = listOf(
                RecentInstallEvent(now() - 60_000L * 30, "installed", "harry-plants", "via vibe-code"),
                RecentInstallEvent(now() - 60_000L * 60 * 6, "deploy", "harry-wiki", "v1.4.0"),
                RecentInstallEvent(now() - 60_000L * 60 * 26, "installed", "harry-wiki", "marketplace"),
            ),
        )
    }

    override suspend fun appsList(): AppsListResponse {
        tick()
        // url mirrors the live daemon's tier-1 form
        // `https://<urlLabel>.<serverFqdn>` (screensHttp builds it off the
        // box's per-box wildcard name — cert model A′).
        val fqdn = "$podContext.harry.flagship.services"
        return AppsListResponse(
            apps = listOf(
                AppSummary("harry-plants", "harry", "plants", "plants",
                    "Houseplant watering tracker", "https://plants.$fqdn/", "running", "0.0.3", now() - 60_000 * 30),
                AppSummary("harry-wiki", "harry", "wiki", "wiki",
                    "Personal notes + recipes", "https://wiki.$fqdn/", "running", "1.4.0", now() - 60_000 * 60 * 26),
                AppSummary("trent-scratchpad", "trent", "scratchpad", "scratchpad-trent",
                    "Markdown scratchpad", "https://scratchpad-trent.$fqdn/", "stopped", "0.7.1", now() - 60_000L * 60 * 24 * 12),
            )
        )
    }

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
        )
    }

    override suspend fun marketplaceBrowse(): MarketplaceBrowseResponse {
        tick()
        return MarketplaceBrowseResponse(
            listings = listOf(
                MarketplaceListing(
                    creator = "trent", slug = "scratchpad", title = "Scratchpad",
                    summary = "A markdown notes app with offline-first sync.",
                    screenshots = emptyList(), installCount = 412,
                    requiresLlmKey = false, scanGrade = "A", alreadyInstalled = true,
                ),
                MarketplaceListing(
                    creator = "wendy", slug = "wishlist", title = "Family Wishlist",
                    summary = "Shared birthday + holiday lists for the household.",
                    screenshots = emptyList(), installCount = 188,
                    requiresLlmKey = false, scanGrade = null, alreadyInstalled = false,
                ),
                MarketplaceListing(
                    creator = "peggy", slug = "feed-reader", title = "Tiny Feed Reader",
                    summary = "Atom + RSS in a clean reader. Optional AI summaries.",
                    screenshots = emptyList(), installCount = 974,
                    requiresLlmKey = true, llmKeyEnvVar = "OPENAI_API_KEY",
                    scanGrade = "C", alreadyInstalled = false,
                ),
            )
        )
    }

    // P1.4 marketplace install plumbing.
    //
    // Tests inspect these recorders to assert the install call shape (request
    // body + signature presence). The Live client posts the same payload to
    // `<pod>/api/services`. Mirrors iOS MockScreensClient.

    /** Records each `installFromMarketplace` envelope so tests can assert
     *  the wire shape. Mirrors iOS `installCalls`. */
    val installCalls: MutableList<InstallServiceEnvelope> = mutableListOf()

    /** Records each `marketplaceFetchListing` call. Mirrors iOS `listingFetches`. */
    data class ListingFetch(val creator: String, val slug: String)
    val listingFetches: MutableList<ListingFetch> = mutableListOf()

    /** When true the next `installFromMarketplace` call throws so tests can
     *  exercise the error path. Mirrors iOS `installShouldFail`. */
    var installShouldFail: Boolean = false
    var installFailureMessage: String = "simulated daemon error"

    /** Deterministic listing detail. The `manifestJson` is opaque (a real
     *  daemon validates the inner JSON); the mock returns a small recognizable
     *  stub so tests can assert it round-trips into the install request. */
    override suspend fun marketplaceFetchListing(creator: String, slug: String): MarketplaceListingDetail {
        tick()
        listingFetches.add(ListingFetch(creator, slug))
        return MarketplaceListingDetail(
            creator = creator,
            slug = slug,
            title = slug.replaceFirstChar { it.uppercase() },
            summary = "Marketplace stub for $creator/$slug",
            manifestJson = """{"name":"$slug","version":"1.0.0","creator":"$creator"}""",
        )
    }

    /** Records the install envelope, then returns a deterministic success
     *  body. Set `installShouldFail = true` to exercise the error path. */
    override suspend fun installFromMarketplace(envelope: InstallServiceEnvelope): InstallServiceResponse {
        tick()
        installCalls.add(envelope)
        if (installShouldFail) throw ScreensError.Http(400, installFailureMessage)
        return InstallServiceResponse(
            ok = true,
            serviceId = "${envelope.request.creator}--${envelope.request.slug}",
            urlLabel = envelope.request.slug,
            port = 8080,
        )
    }

    override suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse {
        tick()
        // Wire-match the live contract: no credential + no promo budget ⇒ the
        // box asks the client for a key. The mock has no promo budget, so a
        // credential-less start signals needsCredential.
        if (req.credential == null) {
            return VibeCodeStartResponse(sessionId = "", needsCredential = true)
        }
        return VibeCodeStartResponse(sessionId = "vc-${UUID.randomUUID().toString().take(8).lowercase()}")
    }

    override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse {
        tick()
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
                PairedSessionSummary("a1b2c3d4", "Phone — Harry", now() - 60_000L * 60 * 24 * 14, true),
                PairedSessionSummary("f9e8d7c6", "Pixel 8", now() - 60_000L * 60 * 24 * 3, false),
            )
        )
    }

    override suspend fun revokePairedSession(tokenPrefix: String) { tick() }

    override suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse {
        tick(); return OrdersSendResponse(ok = true, response = null)
    }

    /** Overridable fixture so tests (and dev mode) can pin an exact tier
     *  wire shape — BYOK, custom-domains-present, free-tier, etc. — without
     *  editing the default. Null = the default promo fixture below. */
    var tierStatusFixture: TierStatusResponse? = null

    override suspend fun tierStatus(): TierStatusResponse {
        tick()
        tierStatusFixture?.let { return it }
        return TierStatusResponse(
            tier = "promo",
            llmCreditsRemainingDay = 38,
            llmCreditsRemainingTotal = 162,
            dispatcherUsageGBmonth = 1.2,
            dispatcherFreeQuotaGBmonth = 50.0,
            customDomains = emptyList(),
            reservedNames = listOf("harry"),
        )
    }

    override suspend fun urlControllerOwned(): UrlControllerOwnedResponse {
        tick()
        return UrlControllerOwnedResponse(
            urls = listOf(
                OwnedUrl("home.harry.flagship.services", "canonical", now() - 60_000L * 60 * 24 * 30),
                OwnedUrl("plants.harry.flagship.services", "alias", now() - 60_000L * 30),
                OwnedUrl("wiki.harry.flagship.services", "alias", now() - 60_000L * 60 * 26),
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

    private val verifyCallCount = mutableMapOf<String, Int>()

    override suspend fun verifyCustomDomain(req: VerifyCustomDomainRequest): VerifyCustomDomainResponse {
        tick()
        val count = (verifyCallCount[req.fqdn] ?: 0) + 1
        verifyCallCount[req.fqdn] = count
        val expected = "flagship-verify=${abs(req.fqdn.hashCode())}"
        return if (count == 1) {
            VerifyCustomDomainResponse(
                fqdn = req.fqdn,
                status = VerifyCustomDomainResponse.Status.PENDING,
                expectedTxtRecord = expected,
                observedTxtRecord = null,
                reason = "Waiting for DNS propagation (typical: 1–5 minutes).",
            )
        } else {
            VerifyCustomDomainResponse(
                fqdn = req.fqdn,
                status = VerifyCustomDomainResponse.Status.VERIFIED,
                expectedTxtRecord = expected,
                observedTxtRecord = expected,
                reason = null,
            )
        }
    }

    // W10 — per-app env vars + vibe-code session mock state.
    //
    // Values are SECRET — held only in this in-memory map and never
    // echoed by any response (mirrors the daemon's "values never leave"
    // invariant). The test surface exposes only the NAMES.
    private val mockEnvNames: MutableMap<String, MutableSet<String>> =
        mutableMapOf(
            "harry-plants" to mutableSetOf("WEATHER_API_KEY"),
            "harry-wiki" to mutableSetOf(),
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
            appId = "harry-plants",
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
                            serviceId = "harry-plants", slug = "plants",
                            rewrittenCount = 1, unchangedCount = 0,
                            error = null, completedAt = now() - 2 * day + 1_500,
                        ),
                        AppReissuanceSummary(
                            serviceId = "harry-wiki", slug = "wiki",
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
            11000L to InstallEvent.Ready("newbox.harry.flagship.services", now()),
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
        emit(VibeCodeFrame.Deploy("habits", "https://habits.$podContext.harry.flagship.services/"))
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
