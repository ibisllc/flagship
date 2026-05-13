// On-wire shape of the install-blob bundle the phone seals into the
// QR-relay deliver frame. Browser unwraps this and hands it to /build/
// for ISO personalization.
//
// Field-for-field match with apps/web/public/webapp/views/create-server.js
// `onWireBlob` so the browser's existing handoff works without change.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable

@Serializable
data class InstallBlobBundle(
    val blob: WireBlob,
    val blobSignature: String,    // hex, IRK over canonical bytes
)

@Serializable
data class WireBlob(
    val version: Int = 1,
    val serverDomain: String,
    val username: String,
    val serverName: String,
    val phoneDelegatedPubKey: String,    // hex
    val registrationUrl: String = "https://flagship.services/api/server/register",
    val authCode: WireAuthCode,
    val authCodeUserSignature: String,   // hex
    val issuedAt: Long,
    val expiresAt: Long,
    val installerGitRef: String = "main",
    val rckPubKey: String,               // hex
)

@Serializable
data class WireAuthCode(
    val version: Int = 1,
    val serial: String,
    val username: String,
    val serverName: String,
    val serverDomain: String,
    val delegatedPubKey: String,         // hex
    val userPubKey: String,              // hex (IRK pub)
    val issuedAt: Long,
    val expiresAt: Long,
)
