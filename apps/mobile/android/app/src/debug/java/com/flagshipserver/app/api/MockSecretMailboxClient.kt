package com.flagshipserver.app.api

import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** In-memory mailbox for previews / tests / the unconfigured default. */
class MockSecretMailboxClient : SecretMailboxClient {
    var pending: List<PendingSecretRequest> = emptyList()
    var directory: List<PodDirectoryEntry> = emptyList()
    /** #56 — outstanding install orders surfaced by [fetchPods] alongside
     *  the registered [directory]. */
    var pendingOrders: List<PendingPodEntry> = emptyList()
    var sealedLuksKeyHex: String? = null
    var lastPostedAuth: MailboxAuthEnvelope? = null
    var lastPostedResponse: SecretResponseBody? = null
    var usernameForResponses: String = "demo"
    val deposited: MutableList<Triple<BoxSealedLeaseWire, String, String>> = mutableListOf()
    val revoked: MutableList<Pair<LeaseRevokeWire, String>> = mutableListOf()
    val postedResponses: MutableList<Pair<SecretResponseBody, String>> = mutableListOf()

    override suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse {
        lastPostedAuth = auth
        return SecretRequestsResponse(auth.auth.username, pending)
    }

    /** Like the worker: a request answers once; a second answer is a 409 "already answered". */
    override suspend fun postResponse(response: SecretResponseBody, bootAuth: String) {
        val open = pending.any { it.serverDomain == response.serverDomain && it.requestNonceHex == response.requestNonceHex }
        if (!open && answeredNonces.contains(response.requestNonceHex)) {
            throw HttpException(409, """{"error":"already answered"}""")
        }
        answeredNonces.add(response.requestNonceHex)
        pending = pending.filterNot { it.serverDomain == response.serverDomain && it.requestNonceHex == response.requestNonceHex }
        lastPostedResponse = response
        postedResponses.add(response to bootAuth)
    }
    private val answeredNonces = mutableSetOf<String>()

    override suspend fun fetchSealedLuksKey(serverDomain: String): SealedLuksKeyResponse {
        val hex = sealedLuksKeyHex ?: throw HttpException(404, "no sealed key on file")
        return SealedLuksKeyResponse(serverDomain, hex, 1L)
    }

    /** Make every [fetchPods] throw (tests of a service that is down). */
    var podsError: Throwable? = null
    /** How many times [fetchPods] was called. */
    var podsFetchCount = 0
        private set

    override suspend fun fetchPods(username: String): PodsDirectoryResponse {
        podsFetchCount++
        podsError?.let { throw it }
        return PodsDirectoryResponse(username, directory, pendingOrders, directoryServerOrder)
    }

    /** Scripted live-sync responses for tests: each [fetchLiveSync] call pops the
     *  next entry; once exhausted it returns a DETERMINISTIC snapshot built from
     *  [directory]/[pendingOrders] with a content-stable cursor (so a loop keeps
     *  a stable cursor and never hangs). Set [liveSyncError] to make the next
     *  call throw (exercising the /pods fallback). */
    var liveSyncScript: MutableList<LiveSyncResponse> = mutableListOf()
    var liveSyncError: Throwable? = null
    /** Cursors observed across calls — lets a test assert the cursor is echoed. */
    val liveSyncCursors: MutableList<String?> = mutableListOf()

    override suspend fun fetchLiveSync(username: String, cursor: String?): LiveSyncResponse {
        liveSyncCursors.add(cursor)
        liveSyncError?.let { err ->
            liveSyncError = null
            throw err
        }
        if (liveSyncScript.isNotEmpty()) return liveSyncScript.removeAt(0)
        val stableCursor = "mock-${directory.size}-${pendingOrders.size}"
        return LiveSyncResponse(stableCursor, username, directory, pendingOrders)
    }

    /** The leases the worker took, by server: a restart finds one and unlocks without the phone. */
    val leases: MutableMap<String, BoxSealedLeaseWire> = mutableMapOf()
    /** When set, the next lease deposit throws this, then clears it (a passing failure). */
    var leaseDepositError: Throwable? = null

    /** The worker's rules for `PUT /api/boot/lease` (boot-core handleDepositLease),
     *  faithfully: the lease body is verified against the IRK that signed the
     *  Authorization header, so a lease signed by the admin root, or by any other
     *  key, is a 403 "invalid lease signature" and nothing is stored. */
    override suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) {
        leaseDepositError?.let { leaseDepositError = null; throw it }
        val ownerPub = ownerPubFromHeader(bootAuth)
            ?: throw HttpException(401, """{"error":"unauthorized"}""")
        val stk = com.flagshipserver.app.core.HexUtil.decode(lease.stkPub)
        val sealed = com.flagshipserver.app.core.HexUtil.decode(lease.sealedKey)
        val sig = com.flagshipserver.app.core.HexUtil.decode(signatureHex)
        val canonical = if (stk != null && sealed != null) {
            com.flagshipserver.app.core.AutoUnlockLeaseV2(
                lease.serverDomain, stk, lease.leaseId, sealed, lease.issuedAt, lease.expiresAt, lease.maxUses,
            ).canonicalBytes()
        } else null
        val ok = canonical != null && sig != null && runCatching {
            com.google.crypto.tink.subtle.Ed25519Verify(ownerPub).verify(sig, canonical)
        }.isSuccess
        if (!ok) throw HttpException(403, """{"error":"invalid lease signature"}""")
        leases[lease.serverDomain] = lease
        deposited.add(Triple(lease, signatureHex, bootAuth))
    }

    /** The owner key an `Authorization: Flagship-Boot-v1 <b64url json>` header names. */
    private fun ownerPubFromHeader(header: String): ByteArray? = runCatching {
        val json = String(java.util.Base64.getUrlDecoder().decode(header.removePrefix("Flagship-Boot-v1 ")))
        val hex = Json.parseToJsonElement(json).jsonObject["pubKeyHex"]!!.jsonPrimitive.content
        com.flagshipserver.app.core.HexUtil.decode(hex)
    }.getOrNull()

    /** The box reboots: with a lease on file it unlocks itself (true); without
     *  one it asks the phone again (false). */
    fun secondBoot(serverDomain: String): Boolean = leases.containsKey(serverDomain)

    override suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) {
        revoked.add(request to bootAuth)
    }

    val pairingDeposits: MutableList<Pair<String, PairingDepositBody>> = mutableListOf()
    override suspend fun depositPairing(serverDomain: String, body: PairingDepositBody) {
        pairingDeposits.add(serverDomain to body)
    }

    val entitlementDeposits: MutableList<Pair<String, PairingDepositBody>> = mutableListOf()
    override suspend fun depositEntitlement(serverDomain: String, body: PairingDepositBody) {
        entitlementDeposits.add(serverDomain to body)
    }

    val swkDeposits: MutableList<Pair<String, PairingDepositBody>> = mutableListOf()
    /** When set, the next [depositSwk] throws this, then clears it. */
    var swkDepositError: Throwable? = null
    override suspend fun depositSwk(serverDomain: String, body: PairingDepositBody) {
        swkDepositError?.let { swkDepositError = null; throw it }
        swkDeposits.add(serverDomain to body)
    }

    val cgkDeposits: MutableList<Pair<String, PairingDepositBody>> = mutableListOf()
    /** When set, the next [depositCgk] throws this, then clears it (best-effort
     *  retry path). */
    var cgkDepositError: Throwable? = null
    override suspend fun depositCgk(serverDomain: String, body: PairingDepositBody) {
        cgkDepositError?.let { cgkDepositError = null; throw it }
        cgkDeposits.add(serverDomain to body)
    }

    val serverOrders: MutableList<Pair<String, com.flagshipserver.app.core.ServerOrderWire>> = mutableListOf()
    /** When set, the next [postServerOrder] throws this, then clears it. */
    var serverOrderError: Throwable? = null
    /** What [fetchPods] returns as `serverOrder`. */
    var directoryServerOrder: com.flagshipserver.app.core.ServerOrderWire? = null
    override suspend fun postServerOrder(username: String, wire: com.flagshipserver.app.core.ServerOrderWire) {
        serverOrderError?.let { serverOrderError = null; throw it }
        adminOnly("server-order", com.flagshipserver.app.core.ServerOrderProtocol.canonicalBytes(wire.order), wire.signature)
        serverOrders.add(username to wire)
    }

    /** The gym's admin-pinned `.com`: an admin order the IRK signed is a 403. */
    private fun adminOnly(what: String, bytes: ByteArray, sig: String) {
        try {
            MockSignatures.requireAdmin(what, bytes, sig)
        } catch (e: ScreensError.Http) {
            throw com.flagshipserver.app.core.HttpException(403, e.body)
        }
    }

    /** When set, the next [depositDecommission] throws this, then clears it. */
    var nextDecommissionError: Throwable? = null
    val decommissionDeposits: MutableList<Pair<String, DecommissionDepositBody>> = mutableListOf()
    override suspend fun depositDecommission(serverDomain: String, body: DecommissionDepositBody) {
        nextDecommissionError?.let { nextDecommissionError = null; throw it }
        decommissionDeposits.add(serverDomain to body)
    }

    /** When set, the next [depositUpdate] throws this, then clears it. */
    var nextUpdateError: Throwable? = null
    val updateDeposits: MutableList<Pair<String, UpdateDepositBody>> = mutableListOf()
    override suspend fun depositUpdate(serverDomain: String, body: UpdateDepositBody) {
        nextUpdateError?.let { nextUpdateError = null; throw it }
        val o = body.order
        adminOnly(
            "server-update",
            com.flagshipserver.app.core.ServerUpdateOrder.canonicalBytes(o.serverDomain, o.targetCommit, o.fromCommit, o.nonce, o.issuedAt),
            body.signature,
        )
        updateDeposits.add(serverDomain to body)
    }

    /** Scripted GET result for [fetchMigration] (null ⇒ 404 / no session). */
    var migrationSession: MigrationSession? = null
    /** When set, the next call of that kind throws it once. */
    var nextMigrationStartError: Throwable? = null
    var nextMigrationFetchError: Throwable? = null
    var nextMigrationConfirmError: Throwable? = null
    var nextMigrationFreezeError: Throwable? = null
    var nextMigrationAbortError: Throwable? = null
    val migrationStarts: MutableList<Pair<String, MigrationStartBody>> = mutableListOf()
    val migrationConfirms: MutableList<Pair<String, MigrationControlBody>> = mutableListOf()
    val migrationFreezes: MutableList<Pair<String, DecommissionDepositBody>> = mutableListOf()
    val migrationAborts: MutableList<Pair<String, MigrationControlBody>> = mutableListOf()
    val migrationFetches: MutableList<String> = mutableListOf()

    override suspend fun depositMigrationStart(serverDomain: String, body: MigrationStartBody) {
        nextMigrationStartError?.let { nextMigrationStartError = null; throw it }
        migrationStarts.add(serverDomain to body)
    }

    override suspend fun fetchMigration(serverDomain: String): MigrationSession? {
        migrationFetches.add(serverDomain)
        nextMigrationFetchError?.let { nextMigrationFetchError = null; throw it }
        return migrationSession
    }

    override suspend fun depositMigrationConfirmReady(serverDomain: String, body: MigrationControlBody) {
        nextMigrationConfirmError?.let { nextMigrationConfirmError = null; throw it }
        migrationConfirms.add(serverDomain to body)
    }

    override suspend fun depositMigrationFreeze(serverDomain: String, body: DecommissionDepositBody) {
        nextMigrationFreezeError?.let { nextMigrationFreezeError = null; throw it }
        migrationFreezes.add(serverDomain to body)
    }

    override suspend fun depositMigrationAbort(serverDomain: String, body: MigrationControlBody) {
        nextMigrationAbortError?.let { nextMigrationAbortError = null; throw it }
        migrationAborts.add(serverDomain to body)
    }

    /** Scripted [fetchReleases] result; null ⇒ up to date (no releases). */
    var releaseCatalog: ReleaseCatalogResponse? = null
    var nextReleasesError: Throwable? = null
    val releaseFetches: MutableList<Pair<String, Boolean>> = mutableListOf()
    override suspend fun fetchReleases(currentCommit: String, refresh: Boolean): ReleaseCatalogResponse {
        releaseFetches.add(currentCommit to refresh)
        nextReleasesError?.let { nextReleasesError = null; throw it }
        return releaseCatalog ?: ReleaseCatalogResponse(checkedAt = System.currentTimeMillis(), currentCommit = currentCommit)
    }
}
