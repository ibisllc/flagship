// P14 — pure helper that packs a freshly-minted companion-pairing ticket
// into the canonical URL the desktop browser scans:
//
//   https://webapp.flagshipserver.com/?companion=<base64url(JSON {ticketId,
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

/** The remote page's QR (remote.<apex>): `flagship://remote?s=<sid>&k=<pk>`,
 *  a QR-relay session and the browser's ephemeral X25519 key. Nothing in it
 *  names an account or a server; the phone picks the server. */
object RemoteApprovalLink {
    private val sidPattern = Regex("^[A-Za-z0-9_-]{16,64}$")

    fun parse(raw: String): QrRelay.QrSession? {
        val uri = runCatching { java.net.URI(raw.trim()) }.getOrNull() ?: return null
        if (uri.scheme != "flagship" || uri.host != "remote") return null
        val session = runCatching { QrRelay.parseQrUrl(raw) }.getOrNull() ?: return null
        return session.takeIf { sidPattern.matches(it.sid) }
    }
}

/** What the phone seals to the browser: a single-use companion ticket for the
 *  server the owner picked. The browser redeems it on that server.
 *  MIRRORS apps/web/public/webapp/lib/companionDockStart.js parseRemoteTicket. */
@Serializable
data class RemoteTicketPayload(
    val kind: String = KIND,
    val ticketId: String,
    val ticketSecret: String,
    val podBaseUrl: String,
    val username: String,
) {
    companion object {
        const val KIND = "flagship/remote-ticket/v1"
    }
}
