// The remote page's QR (remote.<apex>) and the ticket the phone seals back
// to the browser.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable

/** The remote page's QR (remote.<apex>): `https://flagshipserver.com/remote?s=<sid>&k=<pk>`
 *  (older pages: `flagship://remote?s=…&k=…`), a QR-relay session and the
 *  browser's ephemeral X25519 key. Nothing in it names an account or a server;
 *  the phone picks the server. */
object RemoteApprovalLink {
    private val sidPattern = Regex("^[A-Za-z0-9_-]{16,64}$")

    fun parse(raw: String): QrRelay.QrSession? {
        val uri = runCatching { java.net.URI(raw.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme == "flagship" && uri.host == "remote"
        val appLink = uri.scheme == "https" && Endpoints.isControlHost(uri.host) &&
            uri.path?.trimEnd('/') == "/remote"
        if (!scheme && !appLink) return null
        val session = runCatching { QrRelay.parseQrUrl(raw) }.getOrNull() ?: return null
        return session.takeIf { sidPattern.matches(it.sid) }
    }
}

/** The Flagship Firefox extension's pairing code:
 *  `https://flagshipserver.com/pair-extension?s=<sid>&k=<pk>` (or
 *  `flagship://pair-extension?…`), a QR-relay session (16-byte sid) and the
 *  extension's ephemeral X25519 key. A `/remote` code is never read as this,
 *  nor this as a `/remote` code: the path (or scheme host) must match exactly. */
object ExtensionPairLink {
    const val PATH = "pair-extension"

    fun parse(raw: String): QrRelay.QrSession? {
        val uri = runCatching { java.net.URI(raw.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme == "flagship" && uri.host == PATH
        val appLink = uri.scheme == "https" && Endpoints.isControlHost(uri.host) &&
            uri.path?.trimEnd('/') == "/$PATH"
        if (!scheme && !appLink) return null
        val session = runCatching { QrRelay.parseQrUrl(raw) }.getOrNull() ?: return null
        return session.takeIf { Base64URL.decode(it.sid)?.size == 16 }
    }
}

/** What the phone seals to the extension: a single-use extension ticket for the
 *  server the owner picked, and the server key THIS phone pinned for it, so the
 *  extension can check the server's certificate. Fields are declared in sorted
 *  order, so the JSON's keys are sorted. */
@Serializable
data class ExtensionPairPayload(
    val kind: String = KIND,
    val podBaseUrl: String,
    val serverDomain: String,
    val stkPubHex: String,
    val ticketId: String,
    val ticketSecret: String,
    val username: String,
) {
    companion object {
        const val KIND = "flagship/extension-pair/v1"
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
