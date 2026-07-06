// Invite-link + acceptance-reply codecs for service-access gating v2
// (docs/service-access-gating.md §v2 hardening). Two artifacts:
//
//  1. The INVITE link the author shares. v2 embeds the author's stable AID so
//     the redeeming friend can derive their PER-AUTHOR contact AID up front
//     (pairwise AIDs — the redemption identity is deriveContactAccountId(UMK,
//     authorAID), not the global AID; "the author's AID comes from the invite").
//     The capability secret stays in the URL FRAGMENT (never sent to a server);
//     the author AID rides alongside it (`#<secret>&a=<authorAID>`). The app
//     hand-off is `flagship://invite?server=<host>&k=<secret>&a=<authorAID>`
//     (a custom scheme can't carry a fragment, so both are queries there).
//
//  2. The ACCEPTANCE reply (MANUAL-approve, tier 2). The friend's app emits the
//     canonical cross-client deep-link
//       flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at=
//     carrying ONLY { accept, acceptSig } — the friend's contact-AID-signed
//     AcceptServiceInvite + the box host. It carries NO create: the AUTHOR's box
//     FETCHES the owner's signed create from .com by inviteId at finalize, so the
//     author can finalize from ANY device. The friend sends this back through the
//     same private channel; the author opens it and submits {accept, acceptSig}
//     to their own box's /api/service-access/accept. Identical form on
//     webapp/iOS/Android (a real deeplink the camera / share / QR opens).
//
// Pure-JVM by design (java.util.Base64 + string parsing, NO android.net.Uri /
// android.util.Base64) so the viewmodels stay unit-testable without Robolectric.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Base64

object InviteLink {
    private val json = Json { ignoreUnknownKeys = true }
    private val RE_HEX64 = Regex("^[0-9a-fA-F]{64}$")
    private val RE_A_PARAM = Regex("(?:^|[?&#])a=([0-9a-fA-F]{64})")
    private val RE_I_PARAM = Regex("(?:^|[?&#])i=([0-9a-fA-F]{64})")

    /** Build the friend share-link. The capability [secretHex] is the BARE leading
     *  fragment token (canonical cross-client format — never leaves the browser);
     *  [authorAidHex] rides next to it so the friend derives their per-author
     *  contact AID before redeeming (v2). [inviteIdHex], when present, is appended
     *  as `&i=` so a manual-approve invite's friend can sign the acceptance over
     *  the same id the author created it under. */
    fun shareLink(serverDomain: String, secretHex: String, authorAidHex: String, inviteIdHex: String? = null): String {
        var frag = "${secretHex.lowercase()}&a=${authorAidHex.lowercase()}"
        if (inviteIdHex != null) frag += "&i=${inviteIdHex.lowercase()}"
        return "https://$serverDomain/invite#$frag"
    }

    /** The same hand-off as a `flagship://invite` app-scheme link (a custom
     *  scheme can't carry a fragment → secret + author [+ inviteId] ride as
     *  queries). Useful for the QR / "open in app" affordance. */
    fun appLink(serverDomain: String, secretHex: String, authorAidHex: String, inviteIdHex: String? = null): String {
        var s = "flagship://invite?server=$serverDomain&k=${secretHex.lowercase()}&a=${authorAidHex.lowercase()}"
        if (inviteIdHex != null) s += "&i=${inviteIdHex.lowercase()}"
        return s
    }

    /** Pull the optional author AID (64-hex) from anywhere in an invite link (the
     *  fragment `#<secret>&a=<authorAID>` or an `a=<authorAID>` query). Returns
     *  null if absent — the caller then falls back to the global AID (legacy links
     *  are grandfathered). Pure string scan (no Uri parse). */
    fun authorAidFromLink(raw: String): String? =
        RE_A_PARAM.find(raw)?.groupValues?.get(1)?.lowercase()

    /** Pull `a=<64hex>` from a fragment string (with or without a leading '#'). */
    fun authorAidFromFragment(fragment: String?): String? {
        val f = fragment?.takeIf { it.isNotEmpty() } ?: return null
        return RE_A_PARAM.find(f)?.groupValues?.get(1)?.lowercase()
    }

    /** Pull the optional inviteId (64-hex) from anywhere in an invite link (the
     *  fragment `#<secret>&a=…&i=<inviteId>` or an `i=<inviteId>` query). Required
     *  for a manual-approve invite (the friend's acceptance is signed over it);
     *  null/ignored for auto + group. Pure string scan (no Uri parse). */
    fun inviteIdFromLink(raw: String): String? =
        RE_I_PARAM.find(raw)?.groupValues?.get(1)?.lowercase()

    /** Pull `i=<64hex>` from a fragment string (with or without a leading '#'). */
    fun inviteIdFromFragment(fragment: String?): String? {
        val f = fragment?.takeIf { it.isNotEmpty() } ?: return null
        return RE_I_PARAM.find(f)?.groupValues?.get(1)?.lowercase()
    }

    // ── acceptance reply (manual-approve loop) ────────────────────────────────

    private val RE_HEX128 = Regex("^[0-9a-fA-F]{128}$")

    /** The friend's parsed acceptance: the box host + the {accept, acceptSig}
     *  pair (the friend's contact-AID-signed AcceptServiceInvite). NO create —
     *  the author's box fetches the owner's create from .com at finalize. */
    data class Acceptance(
        val serverDomain: String?,
        val accept: JsonObject,
        val acceptSigHex: String,
    )

    /** FRIEND: build the canonical acceptance reply deep-link
     *  `flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at=` (cross-client;
     *  identical on webapp/iOS). Carries ONLY {accept, acceptSig}. [accept] is the
     *  `{inviteId, serviceRef, contactAID, acceptedAt}` object. */
    fun buildAcceptReply(serverDomain: String, accept: JsonObject, acceptSigHex: String): String {
        val iid = accept["inviteId"]?.jsonPrimitive?.contentOrNull ?: ""
        val ref = accept["serviceRef"]?.jsonPrimitive?.contentOrNull ?: ""
        val aid = accept["contactAID"]?.jsonPrimitive?.contentOrNull ?: ""
        val at = accept["acceptedAt"]?.jsonPrimitive?.contentOrNull ?: ""
        return "flagship://invite-accept?server=$serverDomain" +
            "&iid=${iid.lowercase()}&ref=$ref&aid=${aid.lowercase()}&sig=${acceptSigHex.lowercase()}&at=$at"
    }

    /** Decode a pasted/scanned acceptance reply. Parses the canonical
     *  `flagship://invite-accept?…` deep-link, OR (back-compat) the legacy
     *  `flagship://accept?b=<base64url({v,accept,acceptSig,create,createSig})>`
     *  bundle (the create is ignored — the box fetches it). Returns null on
     *  anything malformed. */
    fun decodeAcceptance(raw: String): Acceptance? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.startsWith("flagship://invite-accept")) return decodeCanonical(trimmed)
        if (trimmed.startsWith("flagship://accept")) return decodeLegacy(trimmed)
        // A bare base64url body (legacy share without the scheme wrapper).
        return decodeLegacyBody(trimmed)
    }

    private fun decodeCanonical(raw: String): Acceptance? {
        fun param(k: String): String? = Regex("[?&]$k=([^&]*)").find(raw)?.groupValues?.get(1)
        val iid = param("iid")?.lowercase() ?: return null
        val ref = param("ref") ?: return null
        val aid = param("aid")?.lowercase() ?: return null
        val sig = param("sig")?.lowercase() ?: return null
        val at = param("at")?.toLongOrNull() ?: return null
        val server = param("server")?.removePrefix("https://")?.removePrefix("http://")?.trimEnd('/')
        if (!RE_HEX64.matches(iid) || ref.isEmpty() || !RE_HEX64.matches(aid) || !RE_HEX128.matches(sig)) return null
        val accept = buildJsonObject {
            put("inviteId", JsonPrimitive(iid))
            put("serviceRef", JsonPrimitive(ref))
            put("contactAID", JsonPrimitive(aid))
            put("acceptedAt", JsonPrimitive(at))
        }
        return Acceptance(server?.takeIf { it.isNotEmpty() }, accept, sig)
    }

    private fun decodeLegacy(raw: String): Acceptance? {
        val body = Regex("[?&]b=([^&]+)").find(raw)?.groupValues?.get(1) ?: return null
        return decodeLegacyBody(body)
    }

    private fun decodeLegacyBody(body: String): Acceptance? = try {
        val bytes = Base64.getUrlDecoder().decode(body)
        val obj = json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject
        val accept = obj["accept"] as? JsonObject ?: return null
        val acceptSig = obj["acceptSig"]?.jsonPrimitive?.contentOrNull ?: return null
        Acceptance(null, accept, acceptSig)
    } catch (_: Throwable) {
        null
    }
}
