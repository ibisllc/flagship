// #28 — the admin-device PRODUCER of an AcmeAccountKeyGrant (SEAL-TO-BOX).
//
// Given a box's STK pubkey (Ed25519, 32 bytes) and the account-key scalar this
// admin device holds (Keystore.acmeAccountKeyScalar — the #28 keygen), this:
//   1. reconstructs the P-256 private key from the 32-byte big-endian scalar,
//   2. exports it as a standard PKCS#8 `PRIVATE KEY` PEM (what an ACME client
//      parses to authenticate to Let's Encrypt under the user's account),
//   3. SEALS the PEM bytes FOR the box STK (SecretSeal.sealForEd25519Recipient
//      — crypto_box_seal; the box opens it with its own STK seed),
//   4. IRK-signs an AcmeAccountKeyGrant binding the sealed blob to the recipient
//      STK + the public accountKeyId.
//
// The plaintext PEM never leaves this function; only the sealed ciphertext is
// carried by the grant. accountKeyId is the cross-platform sha256-hex of the
// account key's uncompressed SEC1 pubkey (AcmeAccountKey.accountKeyId) so every
// surface references the same key identity.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.math.BigInteger
import java.security.KeyFactory
import java.security.PrivateKey
import org.bouncycastle.crypto.params.ECDomainParameters
import org.bouncycastle.crypto.params.ECPrivateKeyParameters
import org.bouncycastle.crypto.util.PrivateKeyInfoFactory
import org.bouncycastle.jce.ECNamedCurveTable
import org.bouncycastle.jce.spec.ECNamedCurveParameterSpec

/** A produced grant: the IRK signature plus every field needed for the wire
 *  body. recipientPubKey + sealedAccountKey are raw bytes; the API layer
 *  hex-encodes them (lowercase) to match the Worker. */
data class ProducedAcmeAccountKeyGrant(
    val grantId: String,
    val username: String,
    val accountKeyId: String,
    val recipientPubKey: ByteArray,
    val sealedAccountKey: ByteArray,
    val issuedAt: Long,
    val expiresAt: Long,
    val signatureHex: String,
)

object AcmeAccountKeyGrantProducer {
    private const val CURVE = "secp256r1"
    private val spec: ECNamedCurveParameterSpec = ECNamedCurveTable.getParameterSpec(CURVE)

    /** Default grant lifetime — 90 days, matching the per-user-cert design's
     *  re-seal-before-expiry cadence. */
    const val DEFAULT_TTL_MS: Long = 90L * 24 * 3600 * 1000

    /**
     * Reconstruct the P-256 private key from a 32-byte big-endian [scalar] and
     * export it as a PKCS#8 `-----BEGIN PRIVATE KEY-----` PEM. The DER is a
     * standard RFC 5208 PrivateKeyInfo with id-ecPublicKey + the secp256r1
     * namedCurve — exactly what an ACME client expects for an ES256 account
     * key. Built from the scalar so ANY scalar (incl. the scalar=2 KAT vector)
     * round-trips independent of how the key was minted.
     */
    fun scalarToPkcs8Pem(scalar: ByteArray): String {
        require(scalar.size == 32) { "ACME account key scalar must be 32 bytes" }
        val s = BigInteger(1, scalar)
        val domain = ECDomainParameters(spec.curve, spec.g, spec.n, spec.h, spec.seed)
        val params = ECPrivateKeyParameters(s, domain)
        val der = PrivateKeyInfoFactory.createPrivateKeyInfo(params).encoded
        return derToPem(der, "PRIVATE KEY")
    }

    /** Reverse of [scalarToPkcs8Pem] for tests / re-parse: parse a PKCS#8 PEM
     *  back into a JCE PrivateKey via the secp256r1 spec, so a round-trip can
     *  assert the same scalar. */
    fun pkcs8PemToPrivateKey(pem: String): PrivateKey {
        val der = pemToDer(pem, "PRIVATE KEY")
        val kf = KeyFactory.getInstance("EC", org.bouncycastle.jce.provider.BouncyCastleProvider())
        return kf.generatePrivate(java.security.spec.PKCS8EncodedKeySpec(der))
    }

    /**
     * Seal the account key (derived from [scalar]) FOR [boxStkPub] and IRK-sign
     * an AcmeAccountKeyGrant. [grantId] is a fresh v4 UUID supplied by the
     * caller (so the producer stays pure / testable); [issuedAt] defaults to
     * now and [expiresAt] to issuedAt + 90d.
     */
    fun produce(
        irk: Ed25519Sign,
        username: String,
        scalar: ByteArray,
        boxStkPub: ByteArray,
        grantId: String,
        issuedAt: Long = System.currentTimeMillis(),
        expiresAt: Long = issuedAt + DEFAULT_TTL_MS,
    ): ProducedAcmeAccountKeyGrant {
        require(boxStkPub.size == 32) { "box STK pubkey must be 32 bytes" }
        val accountKeyId = AcmeAccountKey.accountKeyId(scalar)
        val pemBytes = scalarToPkcs8Pem(scalar).toByteArray(Charsets.UTF_8)
        val sealed = SecretSeal.sealForEd25519Recipient(pemBytes, boxStkPub)
        val sig = AcmeAccountKeyGrant.sign(
            irk = irk,
            grantId = grantId,
            username = username,
            accountKeyId = accountKeyId,
            recipientPubKey = boxStkPub,
            sealedAccountKey = sealed,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
        )
        return ProducedAcmeAccountKeyGrant(
            grantId = grantId,
            username = username,
            accountKeyId = accountKeyId,
            recipientPubKey = boxStkPub,
            sealedAccountKey = sealed,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            signatureHex = HexUtil.encode(sig),
        )
    }

    private fun derToPem(der: ByteArray, label: String): String {
        val b64 = java.util.Base64.getEncoder().encodeToString(der)
        val sb = StringBuilder()
        sb.append("-----BEGIN ").append(label).append("-----\n")
        var i = 0
        while (i < b64.length) {
            val end = minOf(i + 64, b64.length)
            sb.append(b64, i, end).append('\n')
            i = end
        }
        sb.append("-----END ").append(label).append("-----\n")
        return sb.toString()
    }

    private fun pemToDer(pem: String, label: String): ByteArray {
        val body = pem
            .replace("-----BEGIN $label-----", "")
            .replace("-----END $label-----", "")
            .replace("\\s".toRegex(), "")
        return java.util.Base64.getDecoder().decode(body)
    }
}
