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
    /** An app's page. [podId] (internal-only) opens it on that server,
     *  e.g. from a server's list of apps; null is the current server. */
    data class AppDetail(val appId: String, val podId: String? = null) : DeepLink
    /** An app's access list editor, from an internet-access alert's "View
     *  access list", or with its suggested list ([draft]) from a draft
     *  alert's Review, on the box that raised it ([podId]). Internal-only —
     *  not parsed from a URI. */
    data class AccessList(val serviceId: String, val draft: Boolean = false, val podId: String? = null) : DeepLink
    /** "Create app here" on a server's page: the creation flow pinned to
     *  that server (docs/app-placement.md §3). Internal-only. */
    data class CreateApp(val podId: String) : DeepLink
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
     *  POSTed to that box's OWN redeem endpoint, never to `.com`. Reachable via
     *  the box /invite page's "Open in the Flagship app" App Link
     *  `https://flagshipserver.com/invite#server=<host>&k=<secret>&a=&i=&s=`
     *  (older pages: `flagship://invite?…` with the same params as a query), and
     *  the box's own universal link
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
        /** The app the invite is for (`s=`); null for a link made before per-app ids. */
        val serviceRef: String? = null,
    ) : DeepLink

    /** Web-experience gating (docs/service-access-gating.md, "Web-experience
     *  gating") — the visitor's phone authorizes a SEPARATE browser's QR-login
     *  for a restricted service's website. Carried by the knock page's
     *  `https://flagshipserver.com/access#server=<serverFqdn>&svc=<urlLabel>&ref=<serviceRef>&page=<pageId>`
     *  App Link (in the fragment so a browser without the app never sends them;
     *  links minted earlier carry a `?query`, older pages `flagship://access?…`; also a QR for cross-device,
     *  and a copyable "Get link" string).
     *  All four params are required; a malformed link is NOT routed. */
    data class AuthorizeKnock(
        val serverId: String,
        val svc: String,
        val serviceRef: String,
        val pageId: String,
    ) : DeepLink

    /** A backup's browser download page (`https://<apex>/app/backup-download#s=&a=&r=`):
     *  approve downloading that server's backup in that browser (biometric + signature). */
    data class ApproveBackupDownload(val serverFqdn: String, val archiveId: String, val requestId: String) : DeepLink

    /** A browser asking to become a remote: the QR on remote.<apex>, naming
     *  only a relay session and the browser's key (see [RemoteApprovalLink]). */
    data class CompanionDockApproval(val rawLink: String) : DeepLink

    /** Flagship Studio's pairing QR, `https://flagshipserver.com/builder?c=<code>&k=<pk>`
     *  (older Studio: `flagship://builder?…`), scanned with the phone's camera.
     *  Opens Create server, which pairs with that Studio once the server is designed. */
    data class BuilderPair(val rawLink: String) : DeepLink

    /** A friend's acceptance of a manual-approve invite (see [InviteLink.buildAcceptReply]),
     *  `https://flagshipserver.com/invite-accept#server=&iid=&ref=&aid=&sig=&at=`
     *  (earlier: the same as a `?query`; older apps: `flagship://invite-accept?…`). Opens the owner's approve screen,
     *  which submits it to the box named by `server`. */
    data class AcceptInvite(val rawLink: String) : DeepLink

    /** Transfer-a-box take-over (docs/device-admin-entitlements.md Slice C). The
     *  giver's box-detail page renders the IRK-signed transfer offer as a QR /
     *  universal link: `https://flagshipserver.com/transfer?o=<b64url>` (or the
     *  `flagship://transfer?o=…` twin) where `<b64url>` = base64url(UTF8(offerJSON)).
     *  The offer is a SIGNED non-secret, so it rides a QUERY param (Android/webapp
     *  strip the `#fragment`). [offerJson] is the decoded offer JSON; the acquirer
     *  VM re-parses it and MUST Ed25519-verify the signature + expiry BEFORE the
     *  claim biometric (it's attacker-supplied). Keep in sync with iOS + webapp. */
    data class TransferOffer(val offerJson: String) : DeepLink

    /** Share this server (docs/share-a-server.md): `https://flagshipserver.com/share#s=<shareId>&k=<secret>`
     *  or `flagship://share?s=…&k=…`. The secret opens the offer and must stay out of logs. */
    data class ShareOffer(val shareId: String, val secretHex: String) : DeepLink {
        override fun toString(): String = "ShareOffer(shareId=$shareId)"
    }

    /** A server's install progress (`…/app/install-progress[?serial=]`), from a
     *  `provision-status` push. Without a serial (or an order this phone doesn't
     *  know) it lands on Home, whose pending server cards show the progress. */
    data class InstallProgress(val serial: String? = null) : DeepLink

    /** A dead-man reminder's tap (`…/app/deadman/<serverDomain>`): that server's
     *  page, where its lock section has Affirm. */
    data class Deadman(val serverDomain: String) : DeepLink

    /** Account pushes (`…/app/account/<page>?u=`, `…/app/settings/<page>`).
     *  The `u=` is not carried: the screens show the active account. */
    data object AccountSecurity : DeepLink
    /** Trusted devices, which also shows a pending re-pair (account recovery). */
    data object TrustedDevices : DeepLink
    /** An account/settings page this app has no screen for: the Settings tab. */
    data object Settings : DeepLink

    companion object {
        /// Parse a `flagship://...` URI, its `https://<control host>/app/...`
        /// twin, a control-host App Link (/join, /remote, …) OR a box
        /// `/invite#<secret>` universal link. Keep in sync with iOS
        /// DeepLink.parse and the webapp router.
        /// Returns null when the host/scheme is not one we route.
        fun parse(uri: Uri): DeepLink? {
            appRouteTwin(uri)?.let { return parse(it) }
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
                    val ref = InviteLink.serviceRefFromLink(uri.fragment)
                    return if (secret != null) RedeemInvite(host, secret, author, invite, ref) else null
                }
                // Transfer take-over universal link served from the control apex:
                // `https://flagshipserver.com/transfer?o=<b64url>`.
                if (host == Endpoints.controlHost &&
                    (uri.path == "/transfer" || uri.path == "/transfer/")
                ) {
                    val json = uri.getQueryParameter("o")?.let { ServerTransferFlow.decodeOfferParam(it) }
                    return if (json != null) TransferOffer(json) else null
                }
                if (host == Endpoints.controlHost && (uri.path == "/share" || uri.path == "/share/")) {
                    // The App Link also claims `/share/`; the link format itself is `/share`.
                    val link = uri.toString().replaceFirst("/share/#", "/share#")
                    return ServerShare.parseShareLink(link)?.let { ShareOffer(it.shareId, it.secretHex) }
                }
                // The App Link twins of flagship://join, remote, builder, access,
                // invite and invite-accept: same params, same validation.
                if (Endpoints.isControlHost(host)) {
                    val path = uri.path?.trimEnd('/')
                    val twin = APP_LINK_PATHS.firstOrNull { "/$it" == path }
                    if (twin != null) return parseHost(twin, uri)
                }
                return null
            }
            if (uri.scheme != "flagship") return null
            val host = uri.host ?: return null
            return parseHost(host, uri)
        }

        private val APP_LINK_PATHS = listOf("join", "remote", "builder", "access", "invite", "invite-accept")

        /** `http(s)://<control host>/app/<route>[/<more>][?q]` ≡ `flagship://<route>[/<more>][?q]`. */
        private fun appRouteTwin(uri: Uri): Uri? {
            if (uri.scheme != "https" && uri.scheme != "http") return null
            if (!Endpoints.isControlHost(uri.host)) return null
            val segments = uri.pathSegments
            if (segments.size < 2 || segments[0] != "app") return null
            return Uri.Builder()
                .scheme("flagship")
                .authority(segments[1])
                .apply { segments.drop(2).forEach { appendPath(it) } }
                .encodedQuery(uri.encodedQuery)
                .encodedFragment(uri.encodedFragment)
                .build()
        }

        /** [uri] with its fragment params moved into the query, or null when the
         *  fragment carries none (a link in the older `?query` form). */
        private fun fragmentAsQuery(uri: Uri): Uri? {
            val fragment = uri.encodedFragment?.takeIf { '=' in it } ?: return null
            return uri.buildUpon().encodedQuery(fragment).encodedFragment(null).build()
        }

        private fun parseHost(host: String, uri: Uri): DeepLink? {
            if (host == "access" || host == "invite" || host == "backup-download") fragmentAsQuery(uri)?.let { return parseHost(host, it) }
            val params = uri.queryParameterNames.associateWith { uri.getQueryParameter(it) ?: "" }
            return when (host) {
                // Back-compat: legacy `unlock-approve(s)` links (old pushes /
                // cached shortcuts) now land on the relay approval list.
                "secret-requests", "secret-request", "unlock-approve", "unlock-approvals" -> SecretRequests
                "server" -> params["podId"]?.let { ServerDetail(it) }
                "app" -> params["appId"]?.let { AppDetail(it) }
                "create-server" -> CreateServer
                "share" -> ServerShare.parseShareLink(uri.toString())?.let { ShareOffer(it.shareId, it.secretHex) }
                "backup-download" -> {
                    val s = (params["s"] ?: "").lowercase()
                    val a = params["a"] ?: ""
                    val r = params["r"] ?: ""
                    if (s.endsWith(".${Endpoints.dataApex}") &&
                        com.flagshipserver.app.api.ArchiveDownloadApproval.isId(a) &&
                        com.flagshipserver.app.api.ArchiveDownloadApproval.isId(r)
                    ) ApproveBackupDownload(s, a, r) else null
                }
                "transfer" -> {
                    // flagship://transfer?o=<b64url> — the custom-scheme twin of
                    // the /transfer universal link (Slice C take-over).
                    val json = params["o"]?.let { ServerTransferFlow.decodeOfferParam(it) }
                    if (json != null) TransferOffer(json) else null
                }
                "invite" -> {
                    // The box /invite page's "open in app" hand-off:
                    // https://<control host>/invite#server=<host>&k=<64hex>&a=&i=&s=
                    // (older pages: flagship://invite?… with the same params as a query).
                    // The secret is POSTed to `server`, so it must be a box on the data apex.
                    val server = (params["server"] ?: params["host"] ?: "").lowercase()
                    if (!server.endsWith(".${Endpoints.dataApex}")) return null
                    val pathSecret = if (uri.scheme == "flagship") uri.path?.trim('/').orEmpty() else ""
                    val candidate = params["k"] ?: params["secret"] ?: pathSecret
                    val secret = secretFromFragment(candidate)
                    val hex64 = Regex("^[0-9a-fA-F]{64}$")
                    val author = params["a"]?.takeIf { hex64.matches(it) }?.lowercase()
                    val invite = params["i"]?.takeIf { hex64.matches(it) }?.lowercase()
                    val ref = params["s"]?.takeIf { ServerKeys.isAppRef(it) }
                    if (secret != null) RedeemInvite(server, secret, author, invite, ref) else null
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
                // flagship://remote?s=<sid>&k=<pk> — the QR on remote.<apex>.
                "remote" -> {
                    if (RemoteApprovalLink.parse(uri.toString()) != null) CompanionDockApproval(uri.toString()) else null
                }
                "builder" -> {
                    if (params["c"].isNullOrEmpty() || BuilderPairing.parse(uri.toString()) == null) null
                    else BuilderPair(uri.toString())
                }
                "invite-accept" -> {
                    val acceptance = InviteLink.decodeAcceptance(uri.toString())
                    if (acceptance?.serverDomain == null) null else AcceptInvite(uri.toString())
                }
                "vibecode" -> {
                    // Accept either path form `flagship://vibecode/<id>`
                    // or query form `flagship://vibecode?sessionId=<id>`.
                    val pathId = uri.path?.trim('/').orEmpty()
                    val queryId = params["sessionId"].orEmpty()
                    val id = if (pathId.isNotEmpty()) pathId else queryId
                    if (id.isEmpty()) null else VibeCodeChat(id)
                }
                "install-progress" -> InstallProgress(params["serial"]?.takeIf { it.isNotEmpty() })
                "deadman" -> uri.path?.trim('/')?.takeIf { it.isNotEmpty() }?.let { Deadman(it) }
                "account" -> when (uri.pathSegments.firstOrNull()) {
                    "security" -> AccountSecurity
                    "devices", "re-pair" -> TrustedDevices
                    else -> Settings
                }
                "settings" -> when (uri.pathSegments.firstOrNull()) {
                    "two-factor" -> AccountSecurity
                    else -> Settings
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
