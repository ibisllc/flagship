// P14 — pure helper that packs a freshly-minted companion-pairing ticket
// into the canonical URL the desktop browser scans:
//
//   https://web.flagshipserver.com/?companion=<base64url(JSON {ticketId,
//   ticketSecret, podBaseUrl, username})>
//
// base64url is RFC 4648 §5 — no padding. The webapp boot-time handler
// reverses this: split off the `companion=` param, base64url-decode,
// JSON.parse, then POST to <podBaseUrl>/api/screens/companion/redeem
// with the (ticketId, ticketSecret) tuple.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipCore/CompanionTicketUrl.swift
// + apps/web/public/webapp/lib/companion-ticket-url.js.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class CompanionTicketPayload(
    val ticketId: String,
    val ticketSecret: String,
    val podBaseUrl: String,
    val username: String,
)

object CompanionTicketUrl {
    /** Webapp receiver origin, via [Endpoints] (prod-default + test override). */
    private val HOST: String get() = Endpoints.webappOrigin

    private val json = Json {
        explicitNulls = false
        encodeDefaults = true
    }

    fun build(
        ticketId: String,
        ticketSecret: String,
        podBaseUrl: String,
        username: String,
    ): String {
        val payload = CompanionTicketPayload(
            ticketId = ticketId,
            ticketSecret = ticketSecret,
            podBaseUrl = podBaseUrl,
            username = username,
        )
        val jsonString = json.encodeToString(CompanionTicketPayload.serializer(), payload)
        val encoded = Base64URL.encode(jsonString.toByteArray(Charsets.UTF_8))
        return "$HOST?companion=$encoded"
    }
}

data class CompanionDockApprovalPayload(
    val serverDomain: String,
    val requestId: String,
    val approvalSecret: String,
)

object CompanionDockApprovalLink {
    private val hex32 = Regex("^[0-9a-fA-F]{32}$")
    private val hex64 = Regex("^[0-9a-fA-F]{64}$")

    fun parse(raw: String): CompanionDockApprovalPayload? {
        val uri = runCatching { java.net.URI(raw.trim()) }.getOrNull() ?: return null
        if (uri.scheme != "flagship" || uri.host != "dock") return null
        val params = uri.rawQuery.orEmpty().split('&').mapNotNull { pair ->
            val index = pair.indexOf('=')
            if (index < 1) null else {
                val key = java.net.URLDecoder.decode(pair.substring(0, index), "UTF-8")
                val value = java.net.URLDecoder.decode(pair.substring(index + 1), "UTF-8")
                key to value
            }
        }.toMap()
        val server = params["server"]?.lowercase().orEmpty()
        val request = params["request"].orEmpty()
        val code = params["code"].orEmpty()
        if (!server.endsWith(".${Endpoints.dataApex}") || !hex32.matches(request) || !hex64.matches(code)) return null
        return CompanionDockApprovalPayload(server, request.lowercase(), code.lowercase())
    }
}
