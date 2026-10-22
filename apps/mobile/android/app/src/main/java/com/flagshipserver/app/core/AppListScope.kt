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

import com.flagshipserver.app.R
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

    val TITLE get() = FSStrings.get(R.string.separate_list_on_each_server)
    val NOTE get() = FSStrings.get(R.string.each_server_keeps_its_own_members)
    val PRO_LINE get() = FSStrings.get(R.string.comes_with_pro)
    val PENDING_LINE get() = FSStrings.get(R.string.waiting_for_this_server_to_confirm)
    val READ_ONLY_ON get() = FSStrings.get(R.string.each_server_has_its_own_list)
    val ON_TITLE get() = FSStrings.get(R.string.a_separate_list_on_each_server)
    val ON_CONFIRM get() = FSStrings.get(R.string.each_server_keeps_its_current_list)
    val OFF_TITLE get() = FSStrings.get(R.string.one_list_on_every_server)

    /** A server's name when the phone doesn't know it: its first DNS label. */
    fun firstLabel(fqdn: String): String {
        val s = fqdn.trim().lowercase()
        return s.substringBefore('.').ifEmpty { s }
    }

    fun offConfirm(leaderName: String): String =
        FSStrings.get(R.string.every_server_will_use_s_list, leaderName)

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
                FSStrings.get(R.string.apps_have_a_separate_access_list, separateApps, nameOf(one))
            else ->
                FSStrings.get(R.string.apps_have_a_separate_access_list_2, separateApps)
        }
    }
}
