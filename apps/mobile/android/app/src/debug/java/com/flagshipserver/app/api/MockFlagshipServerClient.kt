package com.flagshipserver.app.api

import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.RateLimitedException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString

class MockFlagshipServerClient(
    var simulatedLatencyMs: Long = 200,
    var shouldFail: Boolean = false,
    var reservedUsernames: Set<String> = setOf("root", "admin", "flagship", "system", "support"),
    /** Mirror of the Worker's env.TEST_ACCOUNTS map. Mock tests can
     *  populate this to drive the test-account branch of the
     *  availability check; production uses the real Worker which reads
     *  its own off-git secret. */
    var testAccounts: Map<String, TestAccountMeta> = emptyMap(),
    /** Plan A — mirror of the Worker's `demo_users` D1 table. When a
     *  typed username is present here, `usernameAvailable` embeds the
     *  corresponding `demoServer` block. Independent of
     *  [testAccounts] — a username may carry both (legacy reviewer
     *  compat) or just the new block (live demo only). */
    var demoServers: MutableMap<String, DemoServerBlock> = mutableMapOf(),
    /** v2 device-addressing — mirror of the Worker's
     *  `device_capability_grants` D1 table. Keyed by the full
     *  `<u>.<label>` string the user types. When `usernameAvailable`
     *  is called with a key here AND the user-part has a [demoServers]
     *  row, the response carries the `deviceCapability` block + the
     *  `demoServer` block from the user-part row. See
     *  docs/v2-device-addressing-and-real-ticket.md §5.1. */
    /** Canonical provisioning channel — mirror of the Worker's
     *  `provision_status` table, keyed by auth-code SERIAL. When a serial
     *  is present here, [fetchProvisionStatus] returns the record; absent ⇒
     *  null (the Worker's 404 "no record yet"). Tests / previews script a
     *  progression by mutating this map. */
    var provisionStatuses: MutableMap<String, ProvisionStatusRecord> = mutableMapOf(),
) : FlagshipServerClient {
    private val recoveryStore = mutableMapOf<String, RecoveryEnvelope>()

    /** Mirror of the Worker's webauthn_recovery row, keyed by lowercased
     *  username — the unit the gated /fetch endpoint reads. Holds the
     *  passphrase-gate hashes so [fetchWrappedUmkWithToken] can enforce the
     *  same SHA-256(fetchToken) check the Worker does. */
    private data class MockRecoveryRecord(
        val credentialId: String,
        val wrappedUmk: String,
        val wrappedAcmeAccountKey: String?,
        val wrappedAdminRoot: String?,
        val fetchTokenHashHex: String?,
        val prfSaltHashHex: String?,
        val updatedAt: Long,
    )
    private val recoveryByUsername = mutableMapOf<String, MockRecoveryRecord>()

    private val _claimedUsernames = mutableMapOf<String, String>()       // username → irkPub
    private val _bootstrappedAccounts = mutableMapOf<String, AccountBootstrapRequest>()
    private val _bootstrapDeviceIds = mutableMapOf<String, MutableList<String>>()
    private val _issuedAuthCodes = mutableMapOf<String, AuthCodeWire>()  // serial → wire
    private val _revokedAuthCodes = mutableSetOf<String>()
    private val _releasedServerNames = mutableListOf<ReleaseServerNameRequest>()
    private val _revokedServers = mutableListOf<ServerRevocationRequest>()
    private val _activeRevocations = mutableMapOf<String, String>()   // fqdn → reason
    private val _unrevokedServers = mutableListOf<UnrevokeServerRequest>()
    private val _registeredRcks = mutableMapOf<String, String>()         // subdomain → rckPubKey
    private val _registeredPushTokens = mutableMapOf<String, PushTokenRegisterRequest.Inner>()
    private var nextPushTokenId = 1
    /** Settable clock so tests can drive TTL/expiry math deterministically. */
    var nowMs: () -> Long = { System.currentTimeMillis() }
    /** Active watch delegates per user (un-revoked only; the list endpoint
     *  shows active-only, one-active-per-user — a mint replaces the prior). */
    val watchDelegatesByUser = mutableMapOf<String, MutableList<WatchDelegateInfo>>()

    val claimedUsernames: Map<String, String> get() = _claimedUsernames
    /** Every device id each username was bootstrapped with, in order — lets a
     *  test see whether a retry re-used the device or minted a second one. */
    val bootstrapDeviceIds: Map<String, List<String>> get() = _bootstrapDeviceIds
    val issuedAuthCodes: Map<String, AuthCodeWire> get() = _issuedAuthCodes
    private val _issuedAdminSignatures = mutableMapOf<String, String>()  // serial → admin approval hex
    val issuedAdminSignatures: Map<String, String> get() = _issuedAdminSignatures
    val revokedAuthCodes: Set<String> get() = _revokedAuthCodes
    val releasedServerNames: List<ReleaseServerNameRequest> get() = _releasedServerNames
    val revokedServers: List<ServerRevocationRequest> get() = _revokedServers
    val unrevokedServers: List<UnrevokeServerRequest> get() = _unrevokedServers
    val registeredRcks: Map<String, String> get() = _registeredRcks
    val registeredPushTokens: Map<String, PushTokenRegisterRequest.Inner> get() = _registeredPushTokens

    private suspend fun tick() {
        if (simulatedLatencyMs > 0) kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { kotlinx.coroutines.delay(simulatedLatencyMs) }
        if (shouldFail) throw HttpException(503, "simulated failure")
    }

    override suspend fun claimUsername(req: UsernameClaimRequest) {
        tick()
        val u = req.request.username.lowercase()
        val prior = _claimedUsernames[u]
        if (prior != null && prior != req.request.irkPub) throw HttpException(409, "username taken")
        _claimedUsernames[u] = req.request.irkPub
    }

    override suspend fun bootstrapAccount(req: AccountBootstrapRequest): AccountBootstrapResponse {
        tick()
        val username = req.claim.request.username.lowercase()
        // Mirrors the Worker (`D1AccountProvisioningStorage.initialize`): the
        // same IRK + admin root is the proof of ownership, so a retried
        // bootstrap is accepted as "already created"; anyone else gets 409.
        val prior = _bootstrappedAccounts[username]
        if (prior != null) {
            if (!prior.claim.request.irkPub.equals(req.claim.request.irkPub, ignoreCase = true) ||
                !prior.adminRootPub.equals(req.adminRootPub, ignoreCase = true)
            ) throw HttpException(409, "username unavailable")
            _bootstrapDeviceIds.getOrPut(username) { mutableListOf() } += req.device.deviceId
            return AccountBootstrapResponse(true, username, username, req.device.deviceId, false)
        }
        _bootstrappedAccounts[username] = req
        _bootstrapDeviceIds[username] = mutableListOf(req.device.deviceId)
        _claimedUsernames[username] = req.claim.request.irkPub
        return AccountBootstrapResponse(true, username, username, req.device.deviceId, true)
    }

    override suspend fun selfDeleteAccount(req: AccountSelfDeleteBundleRequest) {
        tick()
        // Mock: hard-delete frees the name (mirrors .com dropping the row).
        _claimedUsernames.remove(req.accountSelfDelete.request.username.lowercase())
    }

    override suspend fun issueAuthCode(req: AuthCodeIssueRequest) {
        tick()
        _issuedAuthCodes[req.code.serial] = req.code
        req.adminSignature?.let { _issuedAdminSignatures[req.code.serial] = it }
    }

    override suspend fun registerRck(req: RckRegisterRequest) {
        tick()
        _registeredRcks[req.request.subdomain] = req.request.rckPubKey
    }

    override suspend fun revokeAuthCode(req: AuthCodeRevokeRequest) {
        tick()
        _revokedAuthCodes += req.request.serial
    }

    /** The gym's rate limiter (GymSeams.rateLimited): `.com`'s 429 body. */
    private fun rateLimit(endpoint: String) {
        if (endpoint !in com.flagshipserver.app.core.GymSeams.rateLimited) return
        val body = """{"error":"rate-limited","endpoint":"$endpoint","limit":"ip","retryAfterSec":720,"message":"Too many tries from your network. Try again in about 12 minutes."}"""
        throw com.flagshipserver.app.core.RateLimitedException.parse(429, body)!!
    }

    /** The gym's admin-pinned `.com`: a sensitive order the IRK signed is a 403. */
    private fun requireAdmin(what: String, bytes: ByteArray, sig: String) {
        try {
            MockSignatures.requireAdmin(what, bytes, sig)
        } catch (e: ScreensError.Http) {
            throw HttpException(403, e.body)
        }
    }

    override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
        tick()
        requireAdmin(
            "release-name",
            com.flagshipserver.app.core.ReleaseServerName.canonicalBytes(req.request.username, req.request.serverDomain, req.request.issuedAt),
            req.signature,
        )
        _releasedServerNames += req
    }

    override suspend fun revokeServer(req: ServerRevocationRequest) {
        tick()
        val r = req.request
        requireAdmin(
            "revoke",
            com.flagshipserver.app.core.ServerRevocationClaim.canonicalBytes(r.userId, r.revokedServerId, r.reason, r.issuedAt),
            req.signature,
        )
        _revokedServers += req
        _activeRevocations[req.request.revokedServerId.lowercase()] = req.request.reason
    }

    /** Mirrors the Worker's handleUnrevokeServer: a live server is a 200
     *  noop, a released (deleted) one can't be restored. */
    override suspend fun unrevokeServer(req: UnrevokeServerRequest): UnrevokeServerResponse {
        tick()
        val domain = req.request.serverDomain.lowercase()
        if (_releasedServerNames.any { it.request.serverDomain.lowercase() == domain }) {
            throw HttpException(409, """{"error":"this server was deleted, transferred or retired and can't be restored"}""")
        }
        requireAdmin(
            "unrevoke",
            com.flagshipserver.app.core.ServerUnrevocation.canonicalBytes(req.request.username, req.request.serverDomain, req.request.issuedAt),
            req.signature,
        )
        _activeRevocations.remove(domain) ?: return UnrevokeServerResponse(ok = true, alreadyActive = true)
        _unrevokedServers += req
        return UnrevokeServerResponse(ok = true, unrevokedAt = nowMs(), dnsRepublished = 0)
    }

    /** Mock suggestion — a fresh random `<adjective>-<noun>` each call, fixed
     *  2 s cooldown, never throttled (offline/dev convenience; no DNS). */
    override suspend fun suggestUsername(deviceKey: String): UsernameSuggestion {
        tick()
        val adj = listOf("happy", "brave", "calm", "clever", "lucky", "swift", "sunny", "witty", "golden", "jolly").random()
        val noun = listOf("otter", "panda", "fox", "heron", "robin", "finch", "badger", "beaver", "gecko", "comet").random()
        return UsernameSuggestion(name = "$adj-$noun", retryAfterMs = 2000, throttled = false)
    }

    override suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse {
        tick()
        val lower = username.lowercase()
        // Plan A — every return branch folds in the demoServer block
        // when present. Independent of testAccount / claim branches;
        // the Worker behaves the same way.
        val demoBlock = demoServers[lower]
        // Test-account match precedes every other rule so a typed
        // value that looks "invalid" by length / regex (e.g. has
        // hyphens) still surfaces the testAccount block when the
        // Worker has it on the secret list.
        testAccounts[lower]?.let {
            return UsernameAvailabilityResponse(
                username = lower,
                available = false,
                reason = "test account",
                testAccount = it,
                demoServer = demoBlock,
            )
        }
        // Mirrors the Worker's USERNAME_RE in labels.ts: 3–30 lowercase chars,
        // interior single dashes OK, no leading/trailing dash, and no `--` (the
        // `<slug>--<creator>` delimiter — docs/service-addressing-double-dash.md).
        if (lower.length < 3 || lower.length > 30) {
            return UsernameAvailabilityResponse(lower, false, "Must be 3–30 chars.", demoServer = demoBlock)
        }
        if (lower in reservedUsernames) {
            return UsernameAvailabilityResponse(lower, false, "Reserved.", demoServer = demoBlock)
        }
        if (!lower.matches(Regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$")) || lower.contains("--")) {
            return UsernameAvailabilityResponse(lower, false, "Letters, digits, and interior dashes only (no double dash).", demoServer = demoBlock)
        }
        val prior = _claimedUsernames[lower]
        if (prior != null && prior != "_self") {
            return UsernameAvailabilityResponse(lower, false, "Already claimed.", demoServer = demoBlock)
        }
        return UsernameAvailabilityResponse(lower, true, null, demoServer = demoBlock)
    }

    override suspend fun fetchProvisionStatus(serial: String): ProvisionStatusRecord? {
        tick()
        // Absent serial mirrors the Worker's 404 "no record yet" → null.
        return provisionStatuses[serial]
    }

    override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse {
        tick()
        val r = req.request
        // Preserve a previously-escrowed account key when a re-upload
        // omits it, mirroring the control-plane upsert (#28).
        val priorAcme = recoveryStore[r.credentialId]?.wrappedAcmeAccountKey
        val resolvedAcme = r.wrappedAcmeAccountKey ?: priorAcme
        val priorAdminRoot = recoveryStore[r.credentialId]?.wrappedAdminRoot
        val resolvedAdminRoot = r.wrappedAdminRoot ?: priorAdminRoot
        recoveryStore[r.credentialId] = RecoveryEnvelope(
            credentialId = r.credentialId,
            wrappedUmk = r.wrappedUmk,
            wrappedAcmeAccountKey = resolvedAcme,
            wrappedAdminRoot = resolvedAdminRoot,
        )
        // Also mirror the by-username row the gated /fetch endpoint reads,
        // carrying the passphrase-gate hashes (Task #74). Preserve a prior
        // ACME / admin-root escrow / hashes the same way the Worker's upsert does.
        val key = r.username.lowercase()
        val prior = recoveryByUsername[key]
        recoveryByUsername[key] = MockRecoveryRecord(
            credentialId = r.credentialId,
            wrappedUmk = r.wrappedUmk,
            wrappedAcmeAccountKey = resolvedAcme ?: prior?.wrappedAcmeAccountKey,
            wrappedAdminRoot = resolvedAdminRoot ?: prior?.wrappedAdminRoot,
            fetchTokenHashHex = r.fetchTokenHash?.lowercase() ?: prior?.fetchTokenHashHex,
            prfSaltHashHex = r.prfSaltHash?.lowercase() ?: prior?.prfSaltHashHex,
            updatedAt = nowMs(),
        )
        return RecoveryEnvelopeResponse(ok = true)
    }

    override suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope {
        tick()
        return recoveryStore[credentialId] ?: throw HttpException(404, "no envelope")
    }

    override suspend fun fetchWrappedUmkWithToken(
        username: String,
        fetchTokenHex: String,
        issuedAt: Long,
    ): GatedRecoveryEnvelope {
        tick()
        val rec = recoveryByUsername[username.lowercase()]
            ?: throw HttpException(404, "no recovery record")
        // Legacy row with no gate → the Worker refuses with 409.
        val storedHash = rec.fetchTokenHashHex
            ?: throw HttpException(409, "record predates passphrase gate — re-enrol cloud recovery")
        // Enforce the SHA-256(fetchToken) gate exactly like the Worker.
        val presented = com.flagshipserver.app.keystore.RecoveryDerivation.sha256Hex(
            HexUtil.decode(fetchTokenHex.lowercase()) ?: throw HttpException(400, "fetchToken must be hex"),
        )
        if (presented != storedHash) throw HttpException(403, "invalid fetch token")
        // The gate was just cleared, so attest it — the Worker does the
        // same, and the follow-on re-pair initiate requires it.
        val proofToken = "rp1.mock.${username.lowercase()}.$storedHash"
        gatedProofsMinted += username.lowercase()
        return GatedRecoveryEnvelope(
            username = username.lowercase(),
            credentialId = rec.credentialId,
            wrappedUmk = rec.wrappedUmk,
            wrappedAcmeAccountKey = rec.wrappedAcmeAccountKey,
            wrappedAdminRoot = rec.wrappedAdminRoot,
            prfSaltHash = rec.prfSaltHashHex,
            updatedAt = rec.updatedAt,
            recoveryProof = RecoveryProofToken(token = proofToken),
        )
    }

    /** Usernames the Mock has minted a recovery proof for. The re-pair
     *  gate accepts a token only for one of these, mirroring that the
     *  Worker's proof is MAC-bound to the account it was minted for. */
    val gatedProofsMinted = mutableSetOf<String>()

    override suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse {
        tick()
        val id = "tok_%06d".format(nextPushTokenId++)
        _registeredPushTokens[id] = req.request
        return PushTokenRegisterResponse(ok = true, tokenId = id)
    }

    override suspend fun revokePushToken(req: PushTokenRevokeRequest) {
        tick()
        _registeredPushTokens.remove(req.request.tokenId)
    }

    /** Scripted devices listing per username for tests + dev mode. */
    var accountDirectories: Map<String, AccountDirectoryResponse> = emptyMap()

    /** Scripted audit log per username — tests configure to drive
     *  Activity feed renders without hitting the Worker. The default
     *  seed gives the demo username "bright-maple" a handful of plausible
     *  recent events so the P5 audit-log screen + the Activity feed
     *  both have something to render in dev/preview without any setup.
     *  Tests that need a clean state simply reassign the whole map. */
    var auditEventsByUser: Map<String, List<AuditEvent>> = run {
        val now = System.currentTimeMillis()
        val hour = 3_600_000L
        mapOf(
            "bright-maple" to listOf(
                AuditEvent(
                    seq = 4, eventKind = "device-added",
                    detail = "A device joined the account",
                    devicePrefix = "f9e8d7c6",
                    postedAt = now - 2 * hour,
                ),
                AuditEvent(
                    seq = 3, eventKind = "device-replaced",
                    detail = "Rotated identity key from a new device",
                    devicePrefix = "a1b2c3d4",
                    postedAt = now - 26 * hour,
                ),
                AuditEvent(
                    seq = 2, eventKind = "recovery-set-up",
                    detail = "Enrolled cloud recovery passkey",
                    devicePrefix = "a1b2c3d4",
                    postedAt = now - 5 * 24 * hour,
                ),
                AuditEvent(
                    seq = 1, eventKind = "device-disconnected",
                    detail = "A device left the account",
                    devicePrefix = "deadbeef",
                    postedAt = now - 30 * 24 * hour,
                ),
            ),
        )
    }

    /** Scripted recovery enrollment per username. Drives the C9 Home
     *  nudge in tests. Unconfigured users default to `false` — the
     *  "fresh install, no envelope yet" baseline. */
    var cloudRecoveryByUser: Map<String, Boolean> = emptyMap()

    override suspend fun hasCloudRecovery(username: String): Boolean {
        tick()
        return cloudRecoveryByUser[username.lowercase()] ?: false
    }

    /** Drives initiate outcomes in tests. */
    sealed interface RePairBehavior {
        data object Ok : RePairBehavior
        data class StaleEtag(val currentEtag: String) : RePairBehavior
        data object AlreadyPending : RePairBehavior
    }
    var rePairBehavior: RePairBehavior = RePairBehavior.Ok
    var lastRePairInitiate: Triple<String, RePairInitiateRequest, String?>? = null
        private set

    override suspend fun initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?,
    ): RePairInitiateResponse {
        tick()
        lastRePairInitiate = Triple(username, body, ifMatch)
        // Mirror the Worker's credential gate (byte-matching error
        // strings). Recovery is credential-only: the envelope's own
        // signature is by the key being installed and `oldIrkPub` is
        // public, so one of three proofs is required —
        //   - `oldIrkSignature` (the account's registered key): always
        //     acceptable, the key-file / signed-in-device route;
        //   - `totpProof`: MANDATORY on multi, also accepted on single
        //     when a code credential is enrolled;
        //   - `recoveryProof`: single accounts with cloud recovery.
        // Nothing presented and nothing enrolled ⇒ 409 no-credential.
        val u = username.lowercase()
        val isMulti = accountTypeByUser[u] == "multi"
        val registeredKeyProven = !body.oldIrkSignature.isNullOrEmpty()
        val codeEnrolled =
            totpEnrolledAtByUser[u] != null || !recoveryCodesByUser[u].isNullOrEmpty()
        // A recovery record WITH the passphrase gate is the single-device
        // credential (a legacy ungated row can authorize nothing — the
        // Worker refuses its fetch too). `cloudRecoveryByUser` is the
        // older scripted flag; honour both.
        val cloudEnrolled = !isMulti &&
            ((cloudRecoveryByUser[u] ?: false) || recoveryByUsername[u]?.fetchTokenHashHex != null)
        val proof = body.totpProof
        // The Mock can't verify a code (it holds no secret), so a
        // structurally-valid one counts — the real verification lives in
        // the control-plane tests. What the Mock DOES mirror faithfully
        // is the gate itself: something must be presented.
        val codeOk = proof != null &&
            proof.code.isNotEmpty() &&
            (proof.method == "totp" || proof.method == "recovery")
        val cloudOk = cloudEnrolled &&
            !body.recoveryProof?.token.isNullOrEmpty() &&
            (u in gatedProofsMinted || (cloudRecoveryByUser[u] ?: false))
        if (!registeredKeyProven && !codeOk && !(!isMulti && cloudOk)) {
            when {
                isMulti -> throw HttpException(
                    401, "totpProof required for multi-device recovery",
                )
                codeEnrolled -> throw HttpException(
                    401,
                    "totpProof required for single-device recovery (a second factor is enrolled)",
                )
                cloudEnrolled -> throw HttpException(
                    401,
                    "recoveryProof required: complete the cloud-recovery passphrase step, then retry",
                )
                else -> throw HttpException(
                    409,
                    "this account has no recovery credential enrolled; recovery is credential-only",
                )
            }
        }
        return when (val b = rePairBehavior) {
            is RePairBehavior.StaleEtag ->
                throw IllegalStateException("412 currentEtag=${b.currentEtag}")
            RePairBehavior.AlreadyPending ->
                throw IllegalStateException("409 already-pending")
            RePairBehavior.Ok -> RePairInitiateResponse(
                ok = true,
                completesAt = System.currentTimeMillis() + 24L * 3600 * 1000,
                graceMs = 24L * 3600 * 1000,
            )
        }
    }

    /** Records the last finalization body so tests can assert the
     *  envelope was signed (the Worker 401s an unsigned call). */
    var lastRePairComplete: Pair<String, RePairCompleteRequest>? = null
        private set

    override suspend fun completeRePair(
        username: String,
        body: RePairCompleteRequest,
    ): RePairCompleteResponse {
        tick()
        lastRePairComplete = username to body
        if (body.signature.isEmpty() || body.request.newIrkPub.isEmpty()) {
            throw HttpException(
                401,
                "a RePairComplete envelope signed by the new IRK is required",
            )
        }
        return RePairCompleteResponse(
            ok = true,
            newIrkPub = body.request.newIrkPub,
            swappedAt = System.currentTimeMillis(),
        )
    }

    /** M4 — scripted pending re-pair snapshot per username. Tests set
     *  this to drive the Trusted-devices banner. Unconfigured users
     *  default to `{ pending = null }`. Flip `pendingRePairUnavailable`
     *  to model an older Worker (404). */
    var pendingRePairByUser: Map<String, PendingRePair> = emptyMap()
    var pendingRePairUnavailable: Boolean = false

    override suspend fun fetchPendingRePair(username: String): PendingRePairSnapshot {
        tick()
        if (pendingRePairUnavailable) {
            return PendingRePairSnapshot(pending = null, unavailable = true)
        }
        return PendingRePairSnapshot(pending = pendingRePairByUser[username.lowercase()])
    }

    sealed interface WipeRestartBehavior {
        data object Ok : WipeRestartBehavior
        data object RateLimited : WipeRestartBehavior
        data class StaleEtag(val currentEtag: String) : WipeRestartBehavior
        data object ConcurrentRotation : WipeRestartBehavior
    }
    var wipeRestartBehavior: WipeRestartBehavior = WipeRestartBehavior.Ok
    var lastWipeRestart: Triple<String, WipeRestartRequest, String?>? = null
        private set

    /** V3 — scripted Replace outcomes for tests. */
    sealed interface AppRenameBehavior {
        data object Ok : AppRenameBehavior
        data object Collision : AppRenameBehavior
        data object StaleSignature : AppRenameBehavior
    }
    var appRenameBehavior: AppRenameBehavior = AppRenameBehavior.Ok
    var lastAppRename: Triple<String, String, AppRenameRequest>? = null
        private set
    /** Mock-side alias cache; getAppLinks reads it, renameApp writes
     *  to it so test fixtures stay self-consistent across calls. */
    var appAliasByUser: MutableMap<String, MutableMap<String, Pair<String, String>>> = mutableMapOf()
    override suspend fun renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest,
    ): AppRenameResponse {
        tick()
        lastAppRename = Triple(username, serviceId, body)
        return when (appRenameBehavior) {
            AppRenameBehavior.Collision -> throw IllegalStateException("409 label collision")
            AppRenameBehavior.StaleSignature -> throw IllegalStateException("403 bad signature")
            AppRenameBehavior.Ok -> {
                val newLabel = body.request.newDisplayLabel
                val canonical = "https://${Endpoints.serverFqdn(newLabel, username.lowercase())}"
                appAliasByUser.getOrPut(username.lowercase()) { mutableMapOf() }[serviceId] = newLabel to canonical
                AppRenameResponse(
                    ok = true,
                    displayLabel = newLabel,
                    canonicalUrl = canonical,
                    shortUrl = "https://voi.ci/${newLabel.take(2)}mock1",
                    shortCode = "${newLabel.take(2)}mock1",
                    unchanged = false,
                )
            }
        }
    }

    override suspend fun getAppLinks(
        username: String,
        serviceId: String,
    ): AppLinksResponse {
        tick()
        val alias = appAliasByUser[username.lowercase()]?.get(serviceId)
        // Mirrors @flagship/protocol deriveUrlFragment: serviceId is
        // `<creator>--<slug>` (the `--` delimiter splits — both halves may
        // carry single dashes; docs/service-addressing-double-dash.md).
        // Fragment is CONDITIONAL: `<slug>` when the running user authored
        // it, else `<slug>--<creator>`.
        val defaultLabel = run {
            val i = serviceId.indexOf("--")
            if (i > 0 && i < serviceId.length - 2) {
                val creator = serviceId.substring(0, i).lowercase()
                val slug = serviceId.substring(i + 2).lowercase()
                if (creator == username.lowercase()) slug else "$slug--$creator"
            } else {
                serviceId.lowercase()
            }
        }
        val label = alias?.first ?: defaultLabel
        val host = Endpoints.userZoneHost(username.lowercase())
        val canonical = alias?.second ?: "https://$label.$host"
        return AppLinksResponse(
            serviceId = serviceId,
            displayLabel = label,
            canonicalUrl = canonical,
            instances = listOf(
                AppLinkInstance(serverDomain = host, url = canonical),
            ),
            shortUrl = null,
        )
    }

    override suspend fun wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?,
    ): WipeRestartResponse {
        tick()
        lastWipeRestart = Triple(username, body, ifMatch)
        return when (wipeRestartBehavior) {
            WipeRestartBehavior.Ok -> WipeRestartResponse(
                ok = true,
                auditSeq = 42,
                newIrkPub = body.request.newIrkPub,
                etag = "W/\"post-wipe\"",
            )
            WipeRestartBehavior.RateLimited ->
                throw IllegalStateException("429 wipe-restart rate-limited")
            is WipeRestartBehavior.StaleEtag ->
                throw IllegalStateException("412 stale-etag")
            WipeRestartBehavior.ConcurrentRotation ->
                throw IllegalStateException("409 concurrent rotation")
        }
    }

    override suspend fun listAuditEvents(username: String, sinceSeq: Int, limit: Int): AuditEventListResponse {
        tick()
        val all = auditEventsByUser[username.lowercase()] ?: emptyList()
        val filtered = all.filter { it.seq > sinceSeq }.sortedByDescending { it.seq }
        val cappedLimit = limit.coerceIn(1, 50)
        return AuditEventListResponse(events = filtered.take(cappedLimit))
    }

    override suspend fun accountDirectory(
        accountId: String,
        authorization: AccountDirectoryAuthorization,
    ): AccountDirectoryResponse {
        tick()
        return accountDirectories[accountId.lowercase()] ?: AccountDirectoryResponse(accountId.lowercase())
    }

    // ── v1.2 Phase 4 — account-type + TOTP scripted state ─────────

    /** Per-username `account_type`. "single" (default) or "multi". */
    var accountTypeByUser: MutableMap<String, String> = mutableMapOf()

    /** Per-username `totp_enrolled_at` ms. Null while single-device. */
    var totpEnrolledAtByUser: MutableMap<String, Long> = mutableMapOf()

    /** Per-username staged TOTP secret (base32). Set on enroll-begin
     *  + cleared on disable; mirrors `usernames.totp_secret_encrypted`
     *  on the Worker. */
    var totpSecretByUser: MutableMap<String, String> = mutableMapOf()

    /** Per-username plaintext recovery codes (Mock-only; the Worker
     *  stores argon2id hashes). */
    var recoveryCodesByUser: MutableMap<String, List<String>> = mutableMapOf()

    /** Code the Mock accepts on enroll-confirm / disable. Tests drive
     *  the mismatch branch by changing this. */
    var totpExpectedConfirmCode: String = "123456"

    /** Recovery codes to hand back on enroll-confirm. Default is
     *  deterministic so tests don't need to mock the RNG. */
    var totpRecoveryCodesToIssue: List<String> = listOf(
        "AAAA-BBBB", "CCCC-DDDD", "EEEE-FFFF", "GGGG-HHHH", "IIII-JJJJ",
        "KKKK-LLLL", "MMMM-NNNN", "OOOO-PPPP", "QQQQ-RRRR", "SSSS-TTTT",
    )

    override suspend fun getUsernameRecord(username: String): UsernameLookupResponse {
        tick()
        val u = username.lowercase()
        val irk = _claimedUsernames[u] ?: throw HttpException(404, "not found")
        return UsernameLookupResponse(
            username = u,
            irkPub = irk,
            claimedAt = 0L,
            accountType = accountTypeByUser[u] ?: "single",
            totpEnrolledAt = totpEnrolledAtByUser[u],
        )
    }

    override suspend fun totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest,
    ): TotpEnrollBeginResponse {
        tick()
        val u = username.lowercase()
        val secret = "JBSWY3DPEHPK3PXP" + u.take(4).uppercase().padEnd(4, 'X')
        totpSecretByUser[u] = secret
        val issuer = "Flagship"
        val otpauthUrl =
            "otpauth://totp/$issuer:$u?secret=$secret&issuer=$issuer&algorithm=SHA1&digits=6&period=30"
        // 1×1 PNG transparent placeholder — same shape as the iOS Mock.
        // The real Worker returns a 4×-scaled QR; tests don't pixel-compare.
        val qrPngBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        return TotpEnrollBeginResponse(
            secret = secret,
            otpauthUrl = otpauthUrl,
            qrPngBase64 = qrPngBase64,
            issuer = issuer,
        )
    }

    override suspend fun totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest,
    ): TotpEnrollConfirmResponse {
        tick()
        rateLimit("totp-verify")
        val u = username.lowercase()
        if (totpSecretByUser[u] == null) {
            throw HttpException(409, "no staged TOTP secret; call enroll-begin first")
        }
        if (body.code != totpExpectedConfirmCode) {
            throw HttpException(401, "invalid TOTP code")
        }
        val now = System.currentTimeMillis()
        accountTypeByUser[u] = "multi"
        totpEnrolledAtByUser[u] = now
        recoveryCodesByUser[u] = totpRecoveryCodesToIssue
        return TotpEnrollConfirmResponse(
            ok = true,
            accountType = "multi",
            totpEnrolledAt = now,
            recoveryCodes = totpRecoveryCodesToIssue,
        )
    }

    override suspend fun totpDisable(
        username: String,
        body: TotpDisableRequest,
    ): TotpDisableResponse {
        tick()
        val u = username.lowercase()
        if (body.code != totpExpectedConfirmCode) {
            throw HttpException(401, "invalid TOTP code")
        }
        accountTypeByUser[u] = "single"
        totpEnrolledAtByUser.remove(u)
        totpSecretByUser.remove(u)
        recoveryCodesByUser.remove(u)
        return TotpDisableResponse(ok = true, accountType = "single")
    }

    override suspend fun resolveAccount(username: String): AccountResolution {
        tick()
        val u = username.lowercase()
        // Demo first (mirror of the Worker's demo_users-before-users
        // ordering). A seeded demo username = entry; crypto is a no-op,
        // so we report it with `kind="demo"` + its demoServer and the
        // client skips every credential gate. The `demoServers` map is
        // the Mock's mirror of the Worker's `demo_users` table.
        demoServers[u]?.let { block ->
            return AccountResolution(
                username = u,
                exists = true,
                kind = "demo",
                recovery = AccountResolution.RecoveryState(present = false, hasFetchGate = false),
                totpEnrolled = false,
                demoServer = block,
                graceModel = "instant",
            )
        }
        // A claimed real username projects its account-type / TOTP /
        // recovery / device-count scripted state (used by later phases).
        // Everything else is a clean `unknown` STATE with zeroed factors
        // — never a 404. Non-existent names return the same shape as a
        // miss so timing/shape don't distinguish them.
        val irk = _claimedUsernames[u]
        if (irk == null) {
            return AccountResolution(
                username = u,
                exists = false,
                kind = "unknown",
                recovery = AccountResolution.RecoveryState(present = false, hasFetchGate = false),
                totpEnrolled = false,
                graceModel = "none",
            )
        }
        val kind = if ((accountTypeByUser[u] ?: "single") == "multi") "multi" else "single"
        // A real enrolled record (recoveryByUsername, written by
        // registerRecoveryEnvelope) is authoritative for presence + the
        // passphrase gate; the scripted cloudRecoveryByUser map is an
        // explicit override for tests that don't run a full enroll.
        val record = recoveryByUsername[u]
        val hasRecovery = (cloudRecoveryByUser[u] ?: false) || record != null
        val hasFetchGate = record?.fetchTokenHashHex != null
        val credentialId = record?.credentialId
        return AccountResolution(
            username = u,
            exists = true,
            kind = kind,
            recovery = AccountResolution.RecoveryState(
                present = hasRecovery,
                hasFetchGate = hasFetchGate,
                credentialId = credentialId,
            ),
            totpEnrolled = totpEnrolledAtByUser[u] != null,
            graceModel = if (kind == "multi") "24h-totp" else "3d",
            // Recovery Phase A vs B — surface the account's currently
            // registered IRK so the single-device takeover can tell a
            // wiped-but-valid device (same key ⇒ instant pair) from a
            // rotated one (re-pair behind grace).
            registeredIrkPubHex = irk,
        )
    }

    override suspend fun pairDemoSession(username: String, token: String): DemoPairSessionResponse {
        tick()
        require(Regex("^[0-9a-fA-F]{64}$").matches(token)) { "invalid paired-session token" }
        val demo = demoServers[username.lowercase()] ?: throw HttpException(404, "demo user not found")
        if (demo.lifecycle != DemoServerBlock.Lifecycle.Up) {
            throw HttpException(409, "demo server is not ready")
        }
        return DemoPairSessionResponse(ok = true, fqdn = demo.fqdn)
    }

    /** Phase 3b — last vouched-admit the Mock received, for test
     *  assertions (the admin's admit + the incoming device's register). */
    var lastDeviceAdmit: Pair<String, DeviceAdmitRequest>? = null
        private set

    /** Phase 3b — wall-clock the Mock stamps as `quarantineUntil` on a
     *  successful admit. 14 days, matching the Worker QUARANTINE_MS. */
    var admitQuarantineMs: Long = 14L * 86_400_000

    /** When true, [admitDevice] simulates the Worker rejecting a bad /
     *  stale admit proof (401). Tests flip this to drive the failure
     *  branch. */
    var admitShouldRejectProof: Boolean = false

    override suspend fun admitDevice(account: String, req: DeviceAdmitRequest): DeviceAdmitResponse {
        tick()
        lastDeviceAdmit = account to req
        if (admitShouldRejectProof) throw HttpException(401, "invalid admit proof")
        val id = "tok_%06d".format(nextPushTokenId++)
        _registeredPushTokens[id] = req.request
        return DeviceAdmitResponse(
            ok = true,
            tokenId = id,
            quarantineUntil = System.currentTimeMillis() + admitQuarantineMs,
        )
    }

    override suspend fun mintWatchDelegate(username: String, body: WatchDelegateMintRequest): WatchDelegateMintResponse {
        tick()
        rateLimit("watch-delegate")
        val u = username.lowercase()
        // The Worker rejects any scope set other than ["boot-approval"]
        // (core.WatchDelegateKey.BOOT_APPROVAL_SCOPE; inlined so the api
        // package needn't depend on core).
        if (body.grant.scopes != listOf("boot-approval")) {
            throw HttpException(400, "invalid scopes")
        }
        if (body.grant.expiresAt <= nowMs()) throw HttpException(400, "delegate already expired")
        val prior = watchDelegatesByUser[u]?.firstOrNull()
        watchDelegatesByUser[u] = mutableListOf(
            WatchDelegateInfo(
                grantId = body.grant.grantId,
                delegatePubKey = body.grant.delegatePubKey.lowercase(),
                scopes = body.grant.scopes,
                issuedAt = body.grant.issuedAt,
                expiresAt = body.grant.expiresAt,
            )
        )
        return WatchDelegateMintResponse(
            ok = true,
            grantId = body.grant.grantId,
            expiresAt = body.grant.expiresAt,
            replacedGrantId = prior?.grantId,
        )
    }

    override suspend fun listWatchDelegates(username: String): WatchDelegatesListResponse {
        tick()
        val u = username.lowercase()
        val active = (watchDelegatesByUser[u] ?: emptyList()).filter { it.expiresAt > nowMs() }
        return WatchDelegatesListResponse(username = u, delegates = active)
    }

    override suspend fun revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) {
        tick()
        val u = username.lowercase()
        watchDelegatesByUser[u]?.removeAll { it.grantId == body.request.grantId }
    }

    /** Slice D (§5) — record the rotated admin root against the mock account so
     *  a subsequent getUsernameRecord could reflect it. Verifies the carried
     *  proof against the old root byte-for-byte so a test can't pass a bogus
     *  signature. */
    val rotatedAdminRootByUser = mutableMapOf<String, String>()
    override suspend fun rotateAdminRoot(username: String, req: AdminRootRotationRequest) {
        tick()
        val r = com.flagshipserver.app.core.AdminRootRotation(
            username = req.rotation.username,
            oldAdminRootPub = req.rotation.oldAdminRootPub,
            newAdminRootPub = req.rotation.newAdminRootPub,
            issuedAt = req.rotation.issuedAt,
        )
        val sig = com.flagshipserver.app.core.HexUtil.decode(req.signatureHex)
            ?: throw IllegalArgumentException("bad signature hex")
        val oldPub = com.flagshipserver.app.core.HexUtil.decode(req.rotation.oldAdminRootPub)
            ?: throw IllegalArgumentException("bad old admin root pub hex")
        if (!com.flagshipserver.app.core.AdminRootRotationClaim.verify(r, sig, oldPub)) {
            throw IllegalArgumentException("admin-root-rotation proof does not verify")
        }
        rotatedAdminRootByUser[username.lowercase()] = req.rotation.newAdminRootPub.lowercase()
    }

}
