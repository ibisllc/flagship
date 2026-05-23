// Kotlin mirror of FlagshipCore/PhoneEndpoint.swift + @flagship/protocol
// phoneEndpoint.ts / encryption.ts — the phone's half of the boot-secret
// RELAY model (docs/security-phone-as-unlock-endpoint.md).
//
// `.com` is a blind store-and-forward mailbox. The booting box posts an
// STK-signed SecretRequest; the phone fetches pending requests (IRK-signed
// DeviceEndpointClaim mailbox-auth), re-verifies each against the
// directory-resolved STK + the user's visual confirm, then posts a reply:
// a SealedSecretResponse sealed FOR the box STK (unlock-key) or an
// IRK-signed RootEntitlement carrier (entitlement). `.com` sees only
// ciphertext + public-signed blobs.
//
// Every canonical-bytes layout + the seal layout MUST match the TS +
// Swift byte-for-byte (the iOS-Mock-matches-Worker-wire invariant).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import com.google.crypto.tink.subtle.X25519
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** "unlock-key" | "entitlement" — the two boot-secret purposes. */
enum class SecretPurpose(val wire: String) {
    UNLOCK_KEY("unlock-key"),
    ENTITLEMENT("entitlement");

    companion object {
        fun fromWire(s: String): SecretPurpose? = entries.firstOrNull { it.wire == s }
    }
}

/** Reject '|' + control chars in caller-controlled fields. Mirrors the
 *  fieldGuard in phoneEndpoint.ts / PhoneEndpointFieldGuard.swift. */
object PhoneEndpointFieldGuard {
    fun check(name: String, value: String) {
        for (ch in value) {
            val c = ch.code
            require(c != 0x7c) { "canonical-bytes field \"$name\" contains separator '|'" }
            require(c > 0x1f && c != 0x7f) { "canonical-bytes field \"$name\" contains a control char" }
        }
    }
}

// MARK: - 1. DeviceEndpointClaim (IRK-signed mailbox-auth)

object DeviceEndpointClaim {
    const val CANONICAL_TAG = "flagship/device-endpoint-claim/v1"

    fun canonicalBytes(
        username: String,
        endpointLabel: String,
        phoneIrkPubHex: String,
        issuedAt: Long,
        expiresAt: Long,
        nonceHex: String,
    ): ByteArray {
        PhoneEndpointFieldGuard.check("username", username)
        PhoneEndpointFieldGuard.check("endpointLabel", endpointLabel)
        return listOf(
            CANONICAL_TAG, username, endpointLabel, phoneIrkPubHex,
            issuedAt.toString(), expiresAt.toString(), nonceHex,
        ).joinToString("|").toByteArray()
    }

    fun sign(
        irk: Ed25519Sign,
        username: String,
        endpointLabel: String,
        phoneIrkPubHex: String,
        issuedAt: Long,
        expiresAt: Long,
        nonceHex: String,
    ): ByteArray = irk.sign(
        canonicalBytes(username, endpointLabel, phoneIrkPubHex, issuedAt, expiresAt, nonceHex)
    )

    fun verify(
        signature: ByteArray,
        irkPub: ByteArray,
        username: String,
        endpointLabel: String,
        phoneIrkPubHex: String,
        issuedAt: Long,
        expiresAt: Long,
        nonceHex: String,
    ): Boolean = try {
        Ed25519Verify(irkPub).verify(
            signature,
            canonicalBytes(username, endpointLabel, phoneIrkPubHex, issuedAt, expiresAt, nonceHex),
        )
        true
    } catch (_: Throwable) { false }
}

// MARK: - 2. SecretRequest (STK-signed — re-verified vs directory)

object SecretRequest {
    const val CANONICAL_TAG = "flagship/secret-request/v1"

    fun canonicalBytes(
        serverDomain: String,
        stkPubHex: String,
        purpose: SecretPurpose,
        nonceHex: String,
        issuedAt: Long,
    ): ByteArray {
        PhoneEndpointFieldGuard.check("serverDomain", serverDomain)
        return listOf(
            CANONICAL_TAG, serverDomain, stkPubHex, purpose.wire, nonceHex, issuedAt.toString(),
        ).joinToString("|").toByteArray()
    }

    /** Re-verify the box's request against the DIRECTORY-resolved STK
     *  (NOT the mailbox echo) — `.com` is not a trust anchor. */
    fun verify(
        signature: ByteArray,
        stkPub: ByteArray,
        serverDomain: String,
        stkPubHex: String,
        purpose: SecretPurpose,
        nonceHex: String,
        issuedAt: Long,
    ): Boolean = try {
        Ed25519Verify(stkPub).verify(
            signature,
            canonicalBytes(serverDomain, stkPubHex, purpose, nonceHex, issuedAt),
        )
        true
    } catch (_: Throwable) { false }
}

// MARK: - 3. SealedSecretResponse (sealed FOR the box STK)

object SealedSecretResponse {
    const val CONTEXT_TAG = "flagship/secret-response/v1"

    /** The (nonce, purpose)-binding context prepended before sealing.
     *  Mirrors secretResponseContext in phoneEndpoint.ts. */
    fun context(nonceHex: String, purpose: SecretPurpose): ByteArray =
        listOf(CONTEXT_TAG, nonceHex, purpose.wire).joinToString("|").toByteArray()

    /** Seal `secret` for the box STK, bound to (nonce, purpose). Returns
     *  the sealed bytes ([ephPub:32][nonce:12][ct+tag]). The framed
     *  payload is [ctxLen:4 BE][ctx][secret]. */
    fun build(secret: ByteArray, stkPub: ByteArray, nonceHex: String, purpose: SecretPurpose): ByteArray {
        val ctx = context(nonceHex, purpose)
        val header = ByteArray(4)
        val len = ctx.size
        header[0] = ((len ushr 24) and 0xff).toByte()
        header[1] = ((len ushr 16) and 0xff).toByte()
        header[2] = ((len ushr 8) and 0xff).toByte()
        header[3] = (len and 0xff).toByte()
        val payload = header + ctx + secret
        return SecretSeal.sealForEd25519Recipient(payload, stkPub)
    }
}

// MARK: - 4. RootEntitlement (IRK-signed entitlement carrier)

object RootEntitlement {
    const val CANONICAL_TAG = "flagship/root-entitlement/v1"

    /** Canonical bytes — MUST match canonicalRootEntitlement in auth.ts. */
    fun canonicalBytes(username: String, podPubKeyHex: String, podCanonical: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username, podPubKeyHex, podCanonical, issuedAt.toString())
            .joinToString("|").toByteArray()

    fun sign(irk: Ed25519Sign, username: String, podPubKeyHex: String, podCanonical: String, issuedAt: Long): ByteArray =
        irk.sign(canonicalBytes(username, podPubKeyHex, podCanonical, issuedAt))

    fun verify(
        signature: ByteArray,
        irkPub: ByteArray,
        username: String,
        podPubKeyHex: String,
        podCanonical: String,
        issuedAt: Long,
    ): Boolean = try {
        Ed25519Verify(irkPub).verify(signature, canonicalBytes(username, podPubKeyHex, podCanonical, issuedAt))
        true
    } catch (_: Throwable) { false }
}

/** Serializes a root-only EntitlementBundle as the daemon's on-disk JSON
 *  carrier (entitlementBundleStore.ts `EntitlementBundleFile`). The
 *  `entitlement` secret-response carries the hex of these bytes. JSON
 *  keys are emitted in the daemon's order; the daemon parses by key. */
object EntitlementBundleCarrier {
    fun serialize(
        username: String,
        podPubKeyHex: String,
        podCanonical: String,
        issuedAt: Long,
        rootEntitlementSigHex: String,
    ): ByteArray {
        // Hand-built JSON so we don't depend on a serializer's key order /
        // null handling. The daemon's HEX32/HEX64 + field checks pass on
        // this exact shape (root-only; serviceEntitlement = null).
        val json = buildString {
            append('{')
            append("\"rootEntitlement\":{")
            append("\"username\":").append(jsonString(username)).append(',')
            append("\"podPubKey\":").append(jsonString(podPubKeyHex)).append(',')
            append("\"podCanonical\":").append(jsonString(podCanonical)).append(',')
            append("\"issuedAt\":").append(issuedAt)
            append("},")
            append("\"rootEntitlementSig\":").append(jsonString(rootEntitlementSigHex)).append(',')
            append("\"serviceEntitlement\":null,")
            append("\"serviceEntitlementSig\":null")
            append('}')
        }
        return json.toByteArray(Charsets.UTF_8)
    }

    private fun jsonString(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append("\"")
        return sb.toString()
    }
}

// MARK: - Sealing crypto (Ed25519 recipient → crypto_box_seal)

/** `crypto_box_seal`-equivalent matching sealForEd25519Recipient /
 *  sealForRecipient in encryption.ts:
 *    [ephX25519Pub:32][nonce:12][AES-256-GCM ct+tag]
 *  key = HKDF-SHA256(ECDH(ephPriv, recipientX25519Pub), salt=ephPub,
 *                    info="flagship.seal.v1"). */
object SecretSeal {
    const val TAG = "flagship.seal.v1"
    private val rng = SecureRandom()

    fun sealForEd25519Recipient(plaintext: ByteArray, recipientEd25519Pub: ByteArray): ByteArray {
        require(recipientEd25519Pub.size == 32) { "recipient Ed25519 pubkey must be 32 bytes" }
        val x25519Pub = Curve25519Map.edwardsPubToMontgomery(recipientEd25519Pub)
        return sealForRecipient(plaintext, x25519Pub)
    }

    fun sealForRecipient(plaintext: ByteArray, recipientX25519Pub: ByteArray): ByteArray {
        require(recipientX25519Pub.size == 32) { "recipient X25519 pubkey must be 32 bytes" }
        val ephPriv = X25519.generatePrivateKey()
        val ephPub = X25519.publicFromPrivate(ephPriv)
        val shared = X25519.computeSharedSecret(ephPriv, recipientX25519Pub)
        val key = hkdfSha256(shared, ephPub, TAG.toByteArray(), 32)
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ct = cipher.doFinal(plaintext)
        return ephPub + nonce + ct
    }

    /** Phone-side OPEN of a blob sealed against an Ed25519 recipient pub
     *  (e.g. the LUKS key sealed at install time against a phone key).
     *  Maps the Ed25519 SEED → X25519 scalar
     *  (crypto_sign_ed25519_sk_to_curve25519) before opening — exactly the
     *  move openSealedFromEd25519Recipient makes box-side. */
    fun openWithEd25519Seed(blob: ByteArray, recipientEd25519Seed: ByteArray): ByteArray {
        require(recipientEd25519Seed.size == 32) { "recipient Ed25519 seed must be 32 bytes" }
        val x25519Priv = Curve25519Map.edwardsSeedToMontgomery(recipientEd25519Seed)
        return openWithX25519(blob, x25519Priv)
    }

    /** Box-side open (used by tests vs a known X25519 priv). */
    fun openWithX25519(blob: ByteArray, recipientX25519Priv: ByteArray): ByteArray {
        require(blob.size >= 44) { "sealed blob too short" }
        val ephPub = blob.copyOfRange(0, 32)
        val nonce = blob.copyOfRange(32, 44)
        val ct = blob.copyOfRange(44, blob.size)
        val shared = X25519.computeSharedSecret(recipientX25519Priv, ephPub)
        val key = hkdfSha256(shared, ephPub, TAG.toByteArray(), 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ct)
    }

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }
}

// MARK: - Ed25519 → X25519 (Montgomery) maps

/** Standard Curve25519 birational map. For PUBLIC keys:
 *  `u = (1 + y) / (1 - y) mod p`, p = 2^255 - 19, y = low 255 bits LE of
 *  the Ed25519 compressed point. Matches noble's toMontgomery. For SEEDS:
 *  `clamp(SHA512(seed)[0..32])` (crypto_sign_ed25519_sk_to_curve25519). */
object Curve25519Map {
    private val P = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19))
    private val ONE = BigInteger.ONE

    fun edwardsPubToMontgomery(edPub: ByteArray): ByteArray {
        require(edPub.size == 32) { "Ed25519 pubkey must be 32 bytes" }
        // y = the 32-byte LE value with the top (sign) bit cleared.
        val yBytes = edPub.copyOf()
        yBytes[31] = (yBytes[31].toInt() and 0x7f).toByte()
        val y = leToBigInteger(yBytes)
        val num = y.add(ONE).mod(P)               // 1 + y
        val den = ONE.subtract(y).mod(P)          // 1 - y
        val u = num.multiply(den.modInverse(P)).mod(P)
        return bigIntegerToLe(u, 32)
    }

    fun edwardsSeedToMontgomery(seed: ByteArray): ByteArray {
        val hashed = MessageDigest.getInstance("SHA-512").digest(seed).copyOf(32)
        hashed[0] = (hashed[0].toInt() and 248).toByte()
        hashed[31] = (hashed[31].toInt() and 127).toByte()
        hashed[31] = (hashed[31].toInt() or 64).toByte()
        return hashed
    }

    private fun leToBigInteger(le: ByteArray): BigInteger {
        // BigInteger expects big-endian; reverse a copy.
        val be = ByteArray(le.size) { le[le.size - 1 - it] }
        return BigInteger(1, be)
    }

    private fun bigIntegerToLe(v: BigInteger, size: Int): ByteArray {
        var be = v.toByteArray()
        // Strip a possible leading sign byte; pad/truncate to `size`.
        if (be.size > size) be = be.copyOfRange(be.size - size, be.size)
        val padded = ByteArray(size)
        System.arraycopy(be, 0, padded, size - be.size, be.size)
        // Reverse to little-endian.
        return ByteArray(size) { padded[size - 1 - it] }
    }
}
