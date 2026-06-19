// Kotlin mirror of @flagship/protocol's serviceInvite.ts + the AID/household-key
// derivations in keys.ts — the `flagship/service-invite/v1` tag family for the
// UMK-anchored, first-bind, bearer-link service-access gating model
// (docs/service-access-gating.md).
//
// Identity is the STABLE AID (ServerKeys.deriveAccountId), NOT the versioned
// IRK. The author's IRK SIGNS create + revoke (active orders by the current
// device key); the friend is IDENTIFIED by — and signs redeem + visits with —
// their AID. The webapp (lib/serviceInvite.js) + iOS (ServiceInvite.swift)
// mirror the SAME canonical bytes; the cross-platform pinned vectors in
// packages/protocol/tests/fixtures/serviceAccessGating.vectors.json (asserted by
// ServiceInviteVectorTest) lock every byte in.
//
// Crypto MUST stay byte-identical to the TS implementation:
//   AID seed     = HKDF-SHA256(ikm = UMK seed, salt = empty,
//                              info = "flagship/account-id/v1", 32) -> Ed25519
//   householdKey = HKDF-SHA256(ikm = UMK seed, salt = empty,
//                              info = "flagship/household-key/v1", 32)
//   bundle       = AES-256-GCM(householdKey, 12-B nonce,
//                              aad = "flagship/service-invite/bundle/v1|<inviteId>")
//                  wire = nonce || ciphertext || tag (hex)

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object ServiceInvite {
    // Canonical-bytes tags — MUST match @flagship/protocol.
    const val TAG_CREATE = "flagship/service-invite/create/v1"
    const val TAG_REDEEM = "flagship/service-invite/redeem/v1"
    const val TAG_REVOKE = "flagship/service-invite/revoke/v1"
    const val TAG_ACCEPT = "flagship/service-invite/accept/v1"
    const val TAG_INVITE_ID = "flagship/service-invite/id/v1"
    const val TAG_BUNDLE = "flagship/service-invite/bundle/v1"
    const val TAG_ACCESS_MODE = "flagship/service-access-mode/v1"
    const val TAG_ALLOW_REMOVE = "flagship/service-allow-remove/v1"
    const val TAG_VISIT = "flagship/service-visit/v1"
    const val TAG_KNOCK = "flagship/service-knock/v1"
    const val TAG_LIST_QUERY = "flagship/service-invite-list/v1"

    private val rng = SecureRandom()

    // ── inviteId + secretHash ─────────────────────────────────────────────

    /** inviteId = sha256( TAG_INVITE_ID | sha256(authorAID) | sha256(devicePub)
     *  | counter ) — deterministic 64-hex; mirrors serviceInviteId. */
    fun inviteId(authorAidPub: ByteArray, authorDevicePub: ByteArray, counter: Int): String {
        require(counter >= 0) { "counter must be non-negative" }
        val pre = listOf(
            TAG_INVITE_ID,
            HexUtil.encode(sha256(authorAidPub)),
            HexUtil.encode(sha256(authorDevicePub)),
            counter.toString(),
        ).joinToString("|")
        return HexUtil.encode(sha256(pre.toByteArray(Charsets.UTF_8)))
    }

    /** A random 128-bit invite id (64-char lowercase hex), the v2 replacement for
     *  the structured [inviteId] (which baked sha256(devicePub) into the id — a
     *  device-fingerprint leak via the listing, v2 §M2). Same uniqueness, zero
     *  metadata; attribution stays in the stored authorAID. Mirrors protocol
     *  `randomServiceInviteId`. */
    fun randomInviteId(): String = HexUtil.encode(ByteArray(32).also(rng::nextBytes))

    /** SHA-256 hex of a 32-byte capability secret — the form .com stores/indexes. */
    fun secretHash(secret: ByteArray): String = HexUtil.encode(sha256(secret))

    /** A fresh 32-byte capability secret. */
    fun randomSecret(): ByteArray = ByteArray(32).also(rng::nextBytes)

    // ── The value-blind bundle ({ name, photo? }) ─────────────────────────

    data class Bundle(val name: String, val photo: String? = null)

    private fun bundleAad(inviteId: String): ByteArray =
        listOf(TAG_BUNDLE, inviteId).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Serialize the bundle EXACTLY as @flagship/protocol does (name first,
     *  photo only when present) so the sealed JSON is byte-identical for a
     *  given nonce: {"name":…} or {"name":…,"photo":…}, with JSON-stringify
     *  escaping. */
    private fun bundleJson(b: Bundle): ByteArray {
        val sb = StringBuilder("{\"name\":")
        sb.append(jsonString(b.name))
        if (b.photo != null) {
            sb.append(",\"photo\":").append(jsonString(b.photo))
        }
        sb.append("}")
        return sb.toString().toByteArray(Charsets.UTF_8)
    }

    /** Escape a string EXACTLY as JSON.stringify would (\\, \", control chars
     *  via \u00XX; \b \t \n \f \r short forms). Pins the sealed plaintext to
     *  the JS/TS twin. */
    private fun jsonString(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') {
                    sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
                } else {
                    sb.append(ch)
                }
            }
        }
        sb.append("\"")
        return sb.toString()
    }

    /** Seal { name, photo? } under the household key, bound to inviteId.
     *  Returns lowercase hex of nonce || ciphertext || tag. */
    fun sealBundle(bundle: Bundle, householdKey: ByteArray, inviteId: String): String {
        require(householdKey.size == 32) { "household key must be 32 bytes" }
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(householdKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(bundleAad(inviteId))
        val ct = cipher.doFinal(bundleJson(bundle)) // ciphertext || 16-byte tag
        return HexUtil.encode(nonce + ct)
    }

    /** Open a bundle sealed by sealBundle (or its protocol/webapp/iOS twin).
     *  Throws on a bad key / tampered ciphertext / wrong inviteId. */
    fun openBundle(sealedHex: String, householdKey: ByteArray, inviteId: String): Bundle {
        require(householdKey.size == 32) { "household key must be 32 bytes" }
        val buf = HexUtil.decode(sealedHex) ?: error("invalid hex")
        require(buf.size >= 12 + 16) { "sealed bundle too short" }
        val nonce = buf.copyOfRange(0, 12)
        val ct = buf.copyOfRange(12, buf.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(householdKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(bundleAad(inviteId))
        val plain = cipher.doFinal(ct)
        return parseBundle(String(plain, Charsets.UTF_8))
    }

    private val json = Json { ignoreUnknownKeys = true }

    private fun parseBundle(jsonStr: String): Bundle {
        val obj = json.parseToJsonElement(jsonStr).jsonObject
        val name = obj["name"]?.jsonPrimitive?.contentOrNull ?: error("malformed bundle: name")
        val photo = obj["photo"]?.jsonPrimitive?.contentOrNull
        return Bundle(name = name, photo = photo)
    }

    // ── Canonical bytes (mirror @flagship/protocol exactly) ───────────────

    /** Canonical create bytes. v2: [maxRedemptions] + [expiresAt] are appended
     *  (in that fixed order) ONLY when non-null — a v1 (both null) create signs
     *  byte-identically. Mirrors @flagship/protocol `canonicalCreate`. */
    fun canonicalCreate(
        inviteId: String,
        authorAID: ByteArray,
        serviceRef: String,
        secretHash: String,
        encryptedBundle: String,
        issuedAt: Long,
        maxRedemptions: Int? = null,
        expiresAt: Long? = null,
    ): ByteArray {
        validateNoSepCtrl("inviteId", inviteId)
        validateNoSepCtrl("serviceRef", serviceRef)
        validateNoSepCtrl("secretHash", secretHash)
        validateNoSepCtrl("encryptedBundle", encryptedBundle)
        val parts = mutableListOf(
            TAG_CREATE, inviteId, HexUtil.encode(authorAID), serviceRef, secretHash,
            encryptedBundle, issuedAt.toString(),
        )
        if (maxRedemptions != null) {
            require(maxRedemptions >= 0) { "maxRedemptions must be a non-negative integer" }
            parts.add("maxN=$maxRedemptions")
        }
        if (expiresAt != null) {
            require(expiresAt >= 0) { "expiresAt must be a non-negative integer" }
            parts.add("exp=$expiresAt")
        }
        return parts.joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun canonicalRedeem(secretHash: String, visitorAID: ByteArray, redeemedAt: Long): ByteArray {
        validateNoSepCtrl("secretHash", secretHash)
        return listOf(TAG_REDEEM, secretHash, HexUtil.encode(visitorAID), redeemedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun canonicalRevoke(inviteId: String, issuedAt: Long): ByteArray {
        validateNoSepCtrl("inviteId", inviteId)
        return listOf(TAG_REVOKE, inviteId, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Canonical bytes for an AcceptServiceInvite — the MANUAL-approve out-of-band
     *  acceptance the friend's app emits (signed by the friend's PER-AUTHOR contact
     *  AID), replied back to the author who finalizes the bind on their own box
     *  (v2 Phase 3 tier 2). Mirrors @flagship/protocol `canonicalAccept`. */
    fun canonicalAccept(inviteId: String, serviceRef: String, contactAID: ByteArray, acceptedAt: Long): ByteArray {
        validateNoSepCtrl("inviteId", inviteId)
        validateNoSepCtrl("serviceRef", serviceRef)
        return listOf(TAG_ACCEPT, inviteId, serviceRef, HexUtil.encode(contactAID), acceptedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Contact-AID-sign an AcceptServiceInvite (Ed25519 over [canonicalAccept]).
     *  RFC-8032 deterministic ⇒ byte-equals the TS/webapp/iOS twin. */
    fun signAcceptServiceInvite(
        inviteId: String,
        serviceRef: String,
        contactAID: ByteArray,
        acceptedAt: Long,
        contactAid: Ed25519Sign,
    ): ByteArray = contactAid.sign(canonicalAccept(inviteId, serviceRef, contactAID, acceptedAt))

    fun canonicalSetAccessMode(serverId: String, serviceRef: String, mode: String, issuedAt: Long): ByteArray {
        validateNoSepCtrl("serverId", serverId)
        validateNoSepCtrl("serviceRef", serviceRef)
        require(mode == "open" || mode == "restricted") { "mode must be open or restricted" }
        return listOf(TAG_ACCESS_MODE, serverId, serviceRef, mode, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Canonical bytes for an owner-IRK remove-from-allow-list order — the box's
     *  `flagship/service-allow-remove/v1` shape. Prunes ONE bound AID (lowercase
     *  hex) from a service's allow-list so a revoked friend is denied on their
     *  next request. Mirrors @flagship/protocol `canonicalRemoveServiceAllow`. */
    fun canonicalRemoveServiceAllow(serverId: String, serviceRef: String, aid: String, issuedAt: Long): ByteArray {
        validateNoSepCtrl("serverId", serverId)
        validateNoSepCtrl("serviceRef", serviceRef)
        validateNoSepCtrl("aid", aid)
        return listOf(TAG_ALLOW_REMOVE, serverId, serviceRef, aid, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Owner-IRK-sign a remove-from-allow-list order (Ed25519 over
     *  [canonicalRemoveServiceAllow]). RFC-8032 deterministic ⇒ byte-equals the
     *  TS/webapp/iOS twin. */
    fun signRemoveServiceAllow(
        serverId: String,
        serviceRef: String,
        aid: String,
        issuedAt: Long,
        irk: Ed25519Sign,
    ): ByteArray = irk.sign(canonicalRemoveServiceAllow(serverId, serviceRef, aid, issuedAt))

    fun canonicalVisit(serverId: String, serviceRef: String, visitorAID: ByteArray, issuedAt: Long): ByteArray {
        validateNoSepCtrl("serverId", serverId)
        validateNoSepCtrl("serviceRef", serviceRef)
        return listOf(TAG_VISIT, serverId, serviceRef, HexUtil.encode(visitorAID), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Canonical bytes for a KnockAuthorization — the visitor's PHONE AID-signs
     *  THIS to authorize a SEPARATE browser's QR-login session
     *  (docs/service-access-gating.md, "Web-experience gating"). The `pageId` is
     *  IN the signature, so a visit proof can never be replayed to authorize a
     *  different page. Mirrors @flagship/protocol `canonicalKnock` exactly. */
    fun canonicalKnock(serverId: String, serviceRef: String, pageId: String, visitorAID: ByteArray, issuedAt: Long): ByteArray {
        validateNoSepCtrl("serverId", serverId)
        validateNoSepCtrl("serviceRef", serviceRef)
        validateNoSepCtrl("pageId", pageId)
        return listOf(TAG_KNOCK, serverId, serviceRef, pageId, HexUtil.encode(visitorAID), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** AID-sign a KnockAuthorization (Ed25519 over [canonicalKnock]). The byte
     *  output is RFC-8032 deterministic, so it equals the TS/webapp/iOS twin. */
    fun signKnockAuthorization(
        serverId: String,
        serviceRef: String,
        pageId: String,
        visitorAID: ByteArray,
        issuedAt: Long,
        aid: Ed25519Sign,
    ): ByteArray = aid.sign(canonicalKnock(serverId, serviceRef, pageId, visitorAID, issuedAt))

    /** Canonical bytes for a ServiceInviteListQuery — the OWNER-SIGNED list / poll
     *  query (v2 §C2; the v1 list was an open graph dump). `scope` is "list" (the
     *  full author listing) or "revoked-since" (the box poller). Mirrors
     *  @flagship/protocol `canonicalListQuery`. */
    fun canonicalListQuery(username: String, authorAID: String, scope: String, cursor: Long, issuedAt: Long): ByteArray {
        validateNoSepCtrl("username", username)
        validateNoSepCtrl("authorAID", authorAID)
        require(scope == "list" || scope == "revoked-since") { "scope must be list or revoked-since" }
        return listOf(TAG_LIST_QUERY, username, authorAID, scope, cursor.toString(), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Owner-sign (AID or IRK) a ServiceInviteListQuery (Ed25519 over
     *  [canonicalListQuery]). `.com` dual-accepts AID|IRK during the transition. */
    fun signServiceInviteListQuery(
        username: String,
        authorAID: String,
        scope: String,
        cursor: Long,
        issuedAt: Long,
        signer: Ed25519Sign,
    ): ByteArray = signer.sign(canonicalListQuery(username, authorAID, scope, cursor, issuedAt))

    // ── sign / verify ──────────────────────────────────────────────────────

    fun sign(bytes: ByteArray, signer: Ed25519Sign): ByteArray = signer.sign(bytes)

    fun verify(sig: ByteArray, bytes: ByteArray, pub: ByteArray): Boolean =
        try {
            Ed25519Verify(pub).verify(sig, bytes)
            true
        } catch (_: Throwable) {
            false
        }

    /** Build the `x-flagship-visit` header value: base64(JSON({ proof, sig })),
     *  AID-signed. */
    fun visitHeaderValue(
        serverId: String,
        serviceRef: String,
        visitorAID: ByteArray,
        issuedAt: Long,
        aid: Ed25519Sign,
    ): String {
        val bytes = canonicalVisit(serverId, serviceRef, visitorAID, issuedAt)
        val sig = aid.sign(bytes)
        val proof = buildJsonObject {
            put("serverId", JsonPrimitive(serverId))
            put("serviceRef", JsonPrimitive(serviceRef))
            put("visitorAID", JsonPrimitive(HexUtil.encode(visitorAID)))
            put("issuedAt", JsonPrimitive(issuedAt))
        }
        val payload: JsonObject = buildJsonObject {
            put("proof", proof)
            put("sig", JsonPrimitive(HexUtil.encode(sig)))
        }
        return Base64.getEncoder().encodeToString(payload.toString().toByteArray(Charsets.UTF_8))
    }

    // ── internals ─────────────────────────────────────────────────────────

    /** Reject '|' + control chars (0x00-0x1F, 0x7F) — mirrors validateNoSepCtrl. */
    private fun validateNoSepCtrl(name: String, value: String) {
        for ((i, ch) in value.withIndex()) {
            val c = ch.code
            require(c != 0x7c) { "field $name contains separator '|' at index $i" }
            require(c > 0x1f && c != 0x7f) { "field $name contains control char at index $i" }
        }
    }

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)
}
