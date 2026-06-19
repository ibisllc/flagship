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
//  2. The ACCEPTANCE reply (MANUAL-approve, tier 2). The friend's app emits a
//     self-contained, base64url'd JSON bundle { accept, acceptSig, create,
//     createSig } that the friend sends BACK through the same private channel;
//     the author opens it and submits it verbatim to their own box's
//     /api/service-access/accept. Symmetric to the invite (also a link/QR).

package com.flagshipserver.app.core

import android.net.Uri
import android.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object InviteLink {
    private val json = Json { ignoreUnknownKeys = true }

    /** Build the friend share-link. The capability [secretHex] is in the fragment
     *  (never leaves the browser); [authorAidHex] rides next to it so the friend
     *  derives their per-author contact AID before redeeming (v2). */
    fun shareLink(serverDomain: String, secretHex: String, authorAidHex: String): String =
        "https://$serverDomain/invite#${secretHex.lowercase()}&a=${authorAidHex.lowercase()}"

    /** The same hand-off as a `flagship://invite` app-scheme link (a custom
     *  scheme can't carry a fragment → secret + author ride as queries). Useful
     *  for the QR / "open in app" affordance. */
    fun appLink(serverDomain: String, secretHex: String, authorAidHex: String): String =
        "flagship://invite?server=$serverDomain&k=${secretHex.lowercase()}&a=${authorAidHex.lowercase()}"

    /** Pull the optional author AID (64-hex) from an invite link's fragment
     *  (`...#<secret>&a=<authorAID>`) or an `a=` query. Returns null if absent —
     *  the caller then falls back to the global AID (legacy links are grandfathered). */
    fun authorAidFromLink(raw: String): String? {
        val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return null
        uri.getQueryParameter("a")?.let { if (RE_HEX64.matches(it)) return it.lowercase() }
        return authorAidFromFragment(uri.fragment)
    }

    /** Pull `a=<64hex>` from a fragment string (with or without a leading '#'). */
    fun authorAidFromFragment(fragment: String?): String? {
        val f = fragment?.takeIf { it.isNotEmpty() } ?: return null
        val s = if (f.startsWith("#")) f.substring(1) else f
        RE_A_PARAM.find(s)?.let { return it.groupValues[1].lowercase() }
        return null
    }

    private val RE_HEX64 = Regex("^[0-9a-fA-F]{64}$")
    private val RE_A_PARAM = Regex("(?:^|[?&])a=([0-9a-fA-F]{64})")

    // ── acceptance reply (manual-approve loop) ────────────────────────────────

    /** Encode the friend's acceptance bundle into a base64url string the friend
     *  sends back to the author (who pastes/scans it). NO padding, URL-safe. */
    fun encodeAcceptance(
        accept: JsonObject,
        acceptSigHex: String,
        create: JsonObject,
        createSigHex: String,
    ): String {
        val obj = buildJsonObject {
            put("v", JsonPrimitive(2))
            put("accept", accept)
            put("acceptSig", JsonPrimitive(acceptSigHex.lowercase()))
            put("create", create)
            put("createSig", JsonPrimitive(createSigHex.lowercase()))
        }
        return Base64.encodeToString(
            obj.toString().toByteArray(Charsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
    }

    data class Acceptance(
        val accept: JsonObject,
        val acceptSigHex: String,
        val create: JsonObject,
        val createSigHex: String,
    )

    /** Decode a pasted/scanned acceptance bundle. Tolerates a `flagship://accept?b=<...>`
     *  wrapper or a bare base64url body. Returns null on anything malformed. */
    fun decodeAcceptance(raw: String): Acceptance? {
        val body = extractAcceptanceBody(raw) ?: return null
        return try {
            val bytes = Base64.decode(body, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            val obj = json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject
            val accept = obj["accept"] as? JsonObject ?: return null
            val create = obj["create"] as? JsonObject ?: return null
            val acceptSig = obj["acceptSig"]?.jsonPrimitive?.contentOrNull ?: return null
            val createSig = obj["createSig"]?.jsonPrimitive?.contentOrNull ?: return null
            Acceptance(accept, acceptSig, create, createSig)
        } catch (_: Throwable) {
            null
        }
    }

    private fun extractAcceptanceBody(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.startsWith("flagship://accept")) {
            return runCatching { Uri.parse(trimmed).getQueryParameter("b") }.getOrNull()
        }
        return trimmed
    }

    /** Wrap an acceptance body in a `flagship://accept?b=<...>` scheme link (for
     *  the friend's "send back" QR / share). */
    fun acceptanceLink(body: String): String = "flagship://accept?b=$body"
}
