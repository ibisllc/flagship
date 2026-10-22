// A separate access list on each server, a Pro option
// (docs/service-access-gating.md, "Separate lists per server (Pro)";
// feat/marketplace only). An app's access list is one list across the
// account's servers; an admin signs this order to give it a separate list on
// each server (`server`) or to go back to one (`account`, every server then
// takes the app's lead server's list). It names the app, never a server, and
// is signed with the same sensitive-order key as the mode and rank orders:
//
//   flagship/app-list-scope/v1|<serviceRef>|<account|server>|<issuedAt>
//
// packages/protocol/test-vectors/app-list-scope/vectors.json is the reference;
// AppListScopeVectorsTest runs every case and every refusal.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

object AppListScope {
    const val TAG = "flagship/app-list-scope/v1"
    const val ACCOUNT = "account"
    const val SERVER = "server"

    data class Order(val serviceRef: String, val scope: String, val issuedAt: Long)

    private val SERVICE_REF = Regex("^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$")

    /** Throws for an order the box would refuse (never sign one). */
    fun canonicalBytes(o: Order): ByteArray {
        require(SERVICE_REF.matches(o.serviceRef)) { "bad serviceRef" }
        require(o.scope == ACCOUNT || o.scope == SERVER) { "bad scope" }
        require(o.issuedAt >= 0) { "bad issuedAt" }
        return listOf(TAG, o.serviceRef, o.scope, o.issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun signHex(key: Ed25519Sign, o: Order): String = HexUtil.encode(key.sign(canonicalBytes(o)))

    const val TITLE = "Separate list on each server"
    const val NOTE = "Each server keeps its own members and invites."
    const val PRO_LINE = "Comes with Pro."
    const val PENDING_LINE = "Waiting for this server to confirm Pro."
    const val READ_ONLY_ON = "Each server has its own list."
    const val ON_TITLE = "A separate list on each server?"
    const val ON_CONFIRM = "Each server keeps its current list. Changes you make on one server stay on it."
    const val OFF_TITLE = "One list on every server?"

    /** A server's name when the phone doesn't know it: its first DNS label. */
    fun firstLabel(fqdn: String): String {
        val s = fqdn.trim().lowercase()
        return s.substringBefore('.').ifEmpty { s }
    }

    fun offConfirm(leaderName: String): String =
        "Every server will use $leaderName's list. People who joined on other servers since lose access."

    /** The plan screen's warning before Pro ends; null when there is nothing to warn about. */
    fun separateListsWarning(plan: String, separateApps: Int, leaders: List<String>, nameOf: (String) -> String): String? {
        if (plan != "pro" || separateApps <= 0) return null
        val distinct = leaders.map { it.lowercase() }.distinct()
        val one = distinct.singleOrNull()
        return when {
            separateApps == 1 && one != null ->
                "1 app has a separate access list on each server. When Pro ends it will use ${nameOf(one)}'s list."
            separateApps == 1 ->
                "1 app has a separate access list on each server. When Pro ends it will use its lead server's list."
            one != null ->
                "$separateApps apps have a separate access list on each server. When Pro ends they'll all use ${nameOf(one)}'s list."
            else ->
                "$separateApps apps have a separate access list on each server. When Pro ends each will use its lead server's list."
        }
    }
}
