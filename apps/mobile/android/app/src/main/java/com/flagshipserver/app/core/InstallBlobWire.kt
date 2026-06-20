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
    // Create-time pairing: the pairing key's private seed (hex) the booting box
    // uses to open the sealed `add-paired-session` deposit. An UNSIGNED recipe
    // sibling (top-level, NOT inside `blob` / never in the signed canonical
    // bytes); null when create-time pairing didn't run. Omitted from JSON when
    // null (encodeDefaults=false), so a non-pairing recipe is byte-identical.
    val pairingKeyPrivHex: String? = null,
)

@Serializable
data class WireBlob(
    val version: Int = 2,
    val serverDomain: String,
    val username: String,
    val serverName: String,
    val phoneDelegatedPubKey: String,    // hex
    val registrationUrl: String = Endpoints.registrationUrl,
    val authCode: WireAuthCode,
    val authCodeUserSignature: String,   // hex
    val installerGitRef: String = "main",
    val rckPubKey: String,               // hex
    // Only present for "approve" servers — null (omitted, since the default
    // Json has encodeDefaults=false) for the "auto" default, mirroring the
    // webapp's onWireBlob. The box reads blob.bootUnlockMode; absent ⇒ "auto".
    val bootUnlockMode: String? = null,
    // Disk-encryption policy: "luks" | "none". Only present when the user
    // opted out of encryption ("none") — null (omitted, encodeDefaults=false)
    // for the "luks" default, mirroring the webapp's onWireBlob. The box reads
    // blob.diskEncryption; absent ⇒ "luks". trailer.ts reconstructs it so the
    // daemon's canonical bytes match the signature.
    val diskEncryption: String? = null,
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
