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
    const val TAG_INVITE_ID = "flagship/service-invite/id/v1"
    const val TAG_BUNDLE = "flagship/service-invite/bundle/v1"
    const val TAG_ACCESS_MODE = "flagship/service-access-mode/v1"
    const val TAG_VISIT = "flagship/service-visit/v1"

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

    fun canonicalCreate(
        inviteId: String,
        authorAID: ByteArray,
        serviceRef: String,
        secretHash: String,
        encryptedBundle: String,
        issuedAt: Long,
    ): ByteArray {
        validateNoSepCtrl("inviteId", inviteId)
        validateNoSepCtrl("serviceRef", serviceRef)
        validateNoSepCtrl("secretHash", secretHash)
        validateNoSepCtrl("encryptedBundle", encryptedBundle)
        return listOf(
            TAG_CREATE, inviteId, HexUtil.encode(authorAID), serviceRef, secretHash,
            encryptedBundle, issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
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

    fun canonicalSetAccessMode(serverId: String, serviceRef: String, mode: String, issuedAt: Long): ByteArray {
        validateNoSepCtrl("serverId", serverId)
        validateNoSepCtrl("serviceRef", serviceRef)
        require(mode == "open" || mode == "restricted") { "mode must be open or restricted" }
        return listOf(TAG_ACCESS_MODE, serverId, serviceRef, mode, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun canonicalVisit(serverId: String, serviceRef: String, visitorAID: ByteArray, issuedAt: Long): ByteArray {
        validateNoSepCtrl("serverId", serverId)
        validateNoSepCtrl("serviceRef", serviceRef)
        return listOf(TAG_VISIT, serverId, serviceRef, HexUtil.encode(visitorAID), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

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
