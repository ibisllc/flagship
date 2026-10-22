// A separate access list on each server, a Pro option (feat/marketplace only;
// packages/server-daemon/src/accessScopeHttp.ts):
//   GET  /api/screens/services/:id/list-scope   → AppListScopeState
//   POST /api/screens/services/:id/list-scope   AppListScopeRequest → AppListScopeState
//        (402 code "pro-required"; 403 not admin-signed; 409 stale, sign again)
//   GET  /api/screens/access-lists/summary      → AccessListsSummary

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

@Serializable
data class AppListScopeState(
    val serviceRef: String = "",
    /** "account" (one list on every server) or "server" (a separate list on each). */
    val scope: String = "account",
    /** A "server" order this box holds but hasn't honoured yet (it hasn't seen Pro). */
    val pending: Boolean = false,
    /** "pro" | "free" | "unknown". */
    val plan: String = "unknown",
    /** The server that answered. */
    val self: String = "",
    /** The app's lead server, whose list every server takes on "account". */
    val leader: String = "",
    /** The app's servers in the owner's server order, this one included. */
    val servers: List<String> = emptyList(),
) {
    val separate: Boolean get() = scope == "server"
    val isPro: Boolean get() = plan == "pro"
}

@Serializable
data class AppListScopeOrderBody(val serviceRef: String, val scope: String, val issuedAt: Long)

@Serializable
data class AppListScopeRequest(val order: AppListScopeOrderBody, val signature: String)

@Serializable
data class AccessListsSummary(
    val plan: String = "unknown",
    val separateApps: Int = 0,
    val leaders: List<String> = emptyList(),
)
