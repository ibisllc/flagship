// Wire shapes for browser grants beyond an app's manifest (SEC-BROWSER-002) and for syncing an
// imported app with its upstream repo (N12). Mirrors
// packages/server-daemon/src/browser/grantRequests.ts and buildmodes/buildOrchestrator.ts.

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

/** `localNetwork`: null, `{kind:"exact", hosts}` or `{kind:"whole-lan"}`. */
@Serializable
data class BrowserLocalNetwork(val kind: String, val hosts: List<String> = emptyList())

@Serializable
data class BrowserGrantRequestWire(
    val requestId: String,
    val serviceId: String,
    val capabilities: List<String> = emptyList(),
    val origins: List<String> = emptyList(),
    val localNetwork: BrowserLocalNetwork? = null,
    val duration: String,
    val explanation: String = "",
    val at: Long = 0,
)

/** `GET /api/browser/owner/grant-requests`. */
@Serializable
data class BrowserGrantRequestsResponse(val requests: List<BrowserGrantRequestWire> = emptyList())

/** `POST /api/browser/owner/grant-requests/answer`. A denial carries no signature. Allow names the
 *  duration the owner chose (the ask's or shorter); the signature covers it. */
@Serializable
data class BrowserGrantAnswerBody(
    val requestId: String,
    val decision: String,
    val issuedAt: Long,
    val signature: String? = null,
    val duration: String? = null,
)

/** One grant the owner gave beyond the manifest, in `GET /api/browser/owner/grants`. */
@Serializable
data class OwnerBrowserGrantWire(
    val grantId: String,
    val serviceId: String,
    val capabilities: List<String> = emptyList(),
    val origins: List<String> = emptyList(),
    val localNetwork: BrowserLocalNetwork? = null,
    val duration: String,
    val explanation: String = "",
    val issuedAt: Long = 0,
)

@Serializable
data class OwnerBrowserGrantsResponse(val grants: List<OwnerBrowserGrantWire> = emptyList())

/** `POST /api/browser/owner/grants/revoke`: the owner's signed flagship/browser-grant-revoke/v1. */
@Serializable
data class BrowserGrantRevokeBody(
    val serviceId: String,
    val grantId: String,
    val issuedAt: Long,
    val signature: String,
)

@Serializable
data class SyncCapabilityChange(
    val section: String,
    val added: List<String> = emptyList(),
    val removed: List<String> = emptyList(),
)

@Serializable
data class SyncProposal(
    val upstreamChanged: List<String> = emptyList(),
    val localChanged: List<String> = emptyList(),
    val takeUpstream: List<String> = emptyList(),
    val conflicts: List<String> = emptyList(),
    val alreadyApplied: List<String> = emptyList(),
    val capabilityChanges: List<SyncCapabilityChange> = emptyList(),
    val clean: Boolean = false,
)

@Serializable
data class BuildSyncRequest(val ref: String? = null)

/** `POST /api/build/apps/:serviceId/sync`: the proposal and the build that holds the merge. Up to
 *  date: no build is opened, so there is no [buildId] and no proposal. */
@Serializable
data class BuildSyncResponse(
    val ok: Boolean = true,
    val buildId: String? = null,
    val proposal: SyncProposal = SyncProposal(),
    val candidateCommit: String? = null,
    val upToDate: Boolean = false,
)
