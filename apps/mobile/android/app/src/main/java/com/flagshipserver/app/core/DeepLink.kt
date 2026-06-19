// Kotlin mirror of FlagshipCore/DeepLink.swift.
//
// Out-of-band navigation events triggered by push-notification taps,
// `flagship://` intents, or app-link openings. Shell observes
// DeepLinker.pending and dispatches the right destination on the right
// tab; consumers must call consume() to clear it.

package com.flagshipserver.app.core

import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface DeepLink {
    /** Phone-as-unlock-endpoint RELAY approval list (the sealed-key flow).
     *  Fired by the `secret-request` push when a box is finishing setup /
     *  rebooting in "approve" mode and needs the phone to release its boot
     *  secret. (The legacy plaintext unlock-approval flow has been removed.) */
    data object SecretRequests : DeepLink
    data class ServerDetail(val podId: String) : DeepLink
    data class AppDetail(val appId: String) : DeepLink
    data object CreateServer : DeepLink
    /** Open the recovery-setup flow on the Settings tab. Triggered
     *  in-app from the Home nudge (C9). Internal-only — not parsed
     *  from a URI. */
    data object RecoverySetup : DeepLink
    /** W10 — vibe-code chat surface for the given session id. Fired
     *  by the `vibecode-needs-you` push when the AI is awaiting an
     *  env-var or talkToUser response. */
    data class VibeCodeChat(val sessionId: String) : DeepLink

    /** A git/mcp build's own surface — its journal timeline. Used as the
     *  global-operations-sliver tap target for a non-scratch build (which,
     *  unlike scratch, has no vibe-code session/chat). Internal-only — not
     *  parsed from a URI (like [RecoverySetup]). */
    data class BuildJournal(val buildId: String) : DeepLink

    /** Phase 3b — cross-device pairing. Opened when the collaborator's
     *  NATIVE camera (or the in-app scanner) follows the admin's pairing
     *  QR / App-Links URL (https://flagshipserver.com/join?sid=…&pk=…).
     *  Routes into the incoming add-profile join flow. Carries the raw
     *  join params; the host re-parses them into a [JoinLink]. */
    data class JoinDevice(val sid: String, val pk: String) : DeepLink

    /** #92 — friend redeem of a service-access capability invite
     *  (docs/service-access-gating.md). Carries the BOX host the `/invite` link
     *  was served from + the 32-byte capability secret (64-hex). The secret is
     *  POSTed to that box's OWN redeem endpoint, never to `.com`. Reachable two
     *  ways: the `flagship://invite?server=<host>&k=<secret>` "open in app"
     *  hand-off the box's /invite page offers (Android drops the URL fragment
     *  from App-Links, so the secret rides a query), and — when the fragment
     *  IS carried — the universal link
     *  `https://<server>.<user>.flagship.services/invite#<secret>`.
     *  v2: [authorAidHex] (optional, from `a=<64hex>` in the fragment/query) lets
     *  the friend derive a PER-AUTHOR contact AID for the redeem; absent ⇒ the
     *  friend falls back to the global AID (legacy links are grandfathered).
     *  [inviteIdHex] (optional, from `i=<64hex>`) is required for a manual-approve
     *  invite — the friend's acceptance is signed over it; harmless for auto/group.
     *  The canonical fragment is the BARE secret then `&a=`/`&i=` (identical across
     *  webapp/iOS/Android). */
    data class RedeemInvite(
        val serverDomain: String,
        val secretHex: String,
        val authorAidHex: String? = null,
        val inviteIdHex: String? = null,
    ) : DeepLink

    /** Web-experience gating (docs/service-access-gating.md, "Web-experience
     *  gating") — the visitor's phone authorizes a SEPARATE browser's QR-login
     *  for a restricted service's website. Carried by the knock page's
     *  `flagship://access?server=<serverFqdn>&svc=<urlLabel>&ref=<serviceRef>&page=<pageId>`
     *  deeplink (also a QR for cross-device, and a copyable "Get link" string).
     *  All four params are required; a malformed link is NOT routed. */
    data class AuthorizeKnock(
        val serverId: String,
        val svc: String,
        val serviceRef: String,
        val pageId: String,
    ) : DeepLink

    companion object {
        /// Parse a `flagship://...` URI OR a box `/invite#<secret>` universal
        /// link. Keep in sync with iOS DeepLink.parse and the webapp router.
        /// Returns null when the host/scheme is not one we route.
        fun parse(uri: Uri): DeepLink? {
            // Universal link: a service-access invite served from a BOX —
            // `https://<server>.<user>.flagship.services/invite#<secret>`.
            if (uri.scheme == "https") {
                val host = uri.host
                if (host != null && host.endsWith(".${Endpoints.dataApex}") &&
                    (uri.path == "/invite" || uri.path == "/invite/")
                ) {
                    val secret = secretFromFragment(uri.fragment)
                    val author = InviteLink.authorAidFromFragment(uri.fragment)
                    val invite = InviteLink.inviteIdFromFragment(uri.fragment)
                    return if (secret != null) RedeemInvite(host, secret, author, invite) else null
                }
                return null
            }
            if (uri.scheme != "flagship") return null
            val host = uri.host ?: return null
            val params = uri.queryParameterNames.associateWith { uri.getQueryParameter(it) ?: "" }
            return when (host) {
                // Back-compat: legacy `unlock-approve(s)` links (old pushes /
                // cached shortcuts) now land on the relay approval list.
                "secret-requests", "secret-request", "unlock-approve", "unlock-approvals" -> SecretRequests
                "server" -> params["podId"]?.let { ServerDetail(it) }
                "app" -> params["appId"]?.let { AppDetail(it) }
                "create-server" -> CreateServer
                "invite" -> {
                    // flagship://invite?server=<host>&k=<64hex>&a=<authorAID>&i=<inviteId>
                    // — the "open in app" hand-off from the box's /invite page (a
                    // custom scheme can't carry the fragment, so the secret is a
                    // `k` query).
                    val server = params["server"] ?: params["host"] ?: ""
                    val pathSecret = uri.path?.trim('/').orEmpty()
                    val candidate = params["k"] ?: params["secret"] ?: pathSecret
                    val secret = secretFromFragment(candidate)
                    val hex64 = Regex("^[0-9a-fA-F]{64}$")
                    val author = params["a"]?.takeIf { hex64.matches(it) }?.lowercase()
                    val invite = params["i"]?.takeIf { hex64.matches(it) }?.lowercase()
                    if (secret != null && server.isNotEmpty()) RedeemInvite(server, secret, author, invite) else null
                }
                "join" -> {
                    // flagship://join?sid=<sid>&pk=<pkB64u>. Both params
                    // required; a malformed link is NOT routed (returns
                    // null so the OS falls back to the browser).
                    val sid = params["sid"].orEmpty()
                    val pk = params["pk"].orEmpty()
                    if (sid.isEmpty() || pk.isEmpty()) null else JoinDevice(sid, pk)
                }
                "access" -> {
                    // flagship://access?server=<serverFqdn>&svc=<urlLabel>
                    //   &ref=<serviceRef>&page=<pageId> — the knock page's
                    // "Access site" hand-off (same-device deeplink + QR + "Get
                    // link"). server/ref/page are load-bearing (page is IN the
                    // signature); svc is display-only and may be empty.
                    val server = params["server"].orEmpty()
                    val svc = params["svc"].orEmpty()
                    val ref = params["ref"].orEmpty()
                    val page = params["page"].orEmpty()
                    if (server.isEmpty() || ref.isEmpty() || page.isEmpty()) null
                    else AuthorizeKnock(serverId = server, svc = svc, serviceRef = ref, pageId = page)
                }
                "vibecode" -> {
                    // Accept either path form `flagship://vibecode/<id>`
                    // or query form `flagship://vibecode?sessionId=<id>`.
                    val pathId = uri.path?.trim('/').orEmpty()
                    val queryId = params["sessionId"].orEmpty()
                    val id = if (pathId.isNotEmpty()) pathId else queryId
                    if (id.isEmpty()) null else VibeCodeChat(id)
                }
                else -> null
            }
        }

        /** Pull a 64-hex capability secret from a fragment / candidate string.
         *  Accepts a bare `<64hex>`, the `k=<64hex>` form, or a LEADING bare
         *  `<64hex>` followed by other params (v2: `#<secret>&a=<authorAID>`).
         *  Mirrors the webapp's inviteSecretFromLocation + iOS secretFromFragment. */
        fun secretFromFragment(raw: String?): String? {
            var s = raw?.takeIf { it.isNotEmpty() } ?: return null
            if (s.startsWith("#")) s = s.substring(1)
            Regex("(?:^|[?&])k=([0-9a-fA-F]{64})").find(s)?.let { return it.groupValues[1].lowercase() }
            if (Regex("^[0-9a-fA-F]{64}$").matches(s)) return s.lowercase()
            // Leading bare secret with trailing params (e.g. `<secret>&a=<author>`).
            Regex("^([0-9a-fA-F]{64})(?:[&?]|$)").find(s)?.let { return it.groupValues[1].lowercase() }
            return null
        }
    }
}

class DeepLinker {
    private val _pending = MutableStateFlow<DeepLink?>(null)
    val pending: StateFlow<DeepLink?> = _pending.asStateFlow()

    fun enqueue(link: DeepLink) { _pending.value = link }

    fun consume(): DeepLink? {
        val v = _pending.value
        _pending.value = null
        return v
    }
}
