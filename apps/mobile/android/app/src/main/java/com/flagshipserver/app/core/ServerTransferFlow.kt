// Pure (JVM-testable) builders for the transfer-a-box flow
// (docs/account-deletion-and-name-reclaim.md §4). The Compose VMs derive the IRK
// behind the biometric, then call these to produce the exact wire bodies the
// broker accepts — byte-identical to the webapp lib/serverTransfer.js + iOS
// FlagshipCore/ServerTransferFlow.swift.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.TransferClaimBody
import com.flagshipserver.app.api.TransferClaimWire
import com.flagshipserver.app.api.TransferDiskKeyBody
import com.flagshipserver.app.api.TransferOfferBody
import com.flagshipserver.app.api.TransferOfferWire
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.SecureRandom

object ServerTransferFlow {
    private val rng = SecureRandom()
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }

    /** The QR payload the giver shows + the acquirer scans. Field set matches the
     *  webapp `createTransferOffer().qr`. */
    @Serializable
    data class OfferQR(
        val v: Int = 1,
        val kind: String = "flagship-transfer-offer",
        val serverDomain: String,
        val transferNonce: String,
        val giverIrkPub: String,
        val issuedAt: Long,
        val expiresAt: Long,
        val offerSignature: String,
    )

    class TransferException(message: String) : RuntimeException(message)

    fun random32(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    // ── GIVER: build the offer body + the QR ──────────────────────────────────

    data class BuiltOffer(val body: TransferOfferBody, val qr: OfferQR)

    fun buildOffer(
        serverDomain: String,
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        issuedAt: Long,
        ttlMs: Long = 15 * 60_000,
        nonce: ByteArray = random32(),
        authNonce: ByteArray = random32(),
    ): BuiltOffer {
        val nonceHex = HexUtil.encode(nonce)
        val expiresAt = issuedAt + ttlMs
        val offerSig = irk.sign(
            ServerTransferOfferOrder.canonicalBytes(serverDomain, nonceHex, issuedAt, expiresAt)
        )
        val offerSigHex = HexUtil.encode(offerSig)
        val auth = buildMailboxAuth(username, irk, irkPubHex, issuedAt, authNonce)
        val body = TransferOfferBody(
            auth = auth.auth,
            authSignature = auth.authSignature,
            offer = TransferOfferWire(serverDomain, nonceHex, issuedAt, expiresAt),
            offerSignature = offerSigHex,
        )
        val qr = OfferQR(
            serverDomain = serverDomain,
            transferNonce = nonceHex,
            giverIrkPub = irkPubHex.lowercase(),
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            offerSignature = offerSigHex,
        )
        return BuiltOffer(body, qr)
    }

    fun encodeQR(qr: OfferQR): String = json.encodeToString(OfferQR.serializer(), qr)

    // ── GIVER: the universal-link QR the acquirer scans ───────────────────────
    //
    // The offer JSON is a SIGNED non-secret, so it rides a base64url `o=` QUERY
    // param on the control-plane `/transfer` universal link (NOT a `#fragment` —
    // Android + the webapp strip fragments). Byte-identical across iOS/webapp so
    // any surface can scan any other's QR. The custom-scheme twin is the same
    // param on `flagship://transfer`.

    /** base64url(UTF8(offerJSON)), no padding — the `o=` param value. */
    fun encodeOfferParam(qr: OfferQR): String =
        Base64URL.encode(encodeQR(qr).toByteArray(Charsets.UTF_8))

    /** The https universal link the giver renders as a QR:
     *  `https://flagshipserver.com/transfer?o=<b64url>`. Uses the configured
     *  control apex (prod = flagshipserver.com; a gym build overrides it). */
    fun offerUrl(qr: OfferQR): String =
        "${Endpoints.controlBaseUrl}/transfer?o=${encodeOfferParam(qr)}"

    /** The custom-scheme twin: `flagship://transfer?o=<b64url>`. */
    fun offerCustomSchemeUrl(qr: OfferQR): String =
        "flagship://transfer?o=${encodeOfferParam(qr)}"

    /** Decode an `o=` param back to the offer JSON string, or null. */
    fun decodeOfferParam(param: String): String? =
        Base64URL.decode(param)?.let { runCatching { String(it, Charsets.UTF_8) }.getOrNull() }

    /** Pull the offer JSON out of a scanned/pasted string, accepting BOTH the
     *  URL forms (`…/transfer?o=<b64url>`, `flagship://transfer?o=…`) and a bare
     *  offer JSON. Pure string parse (no android.net.Uri) so it stays
     *  JVM-testable. Returns null when neither form is present. */
    fun offerJsonFrom(text: String): String? {
        val t = text.trim()
        Regex("[?&]o=([^&#]+)").find(t)?.let { return decodeOfferParam(it.groupValues[1]) }
        if (t.startsWith("{")) return t
        return null
    }

    /** Ed25519-verify the offer signature over the canonical bytes against
     *  `giverIrkPub`. A deep-linked / scanned offer is attacker-supplied, so the
     *  acquirer MUST verify this (+ expiry) BEFORE the claim biometric. Returns
     *  false on any malformed hex / bad signature (never throws). */
    fun verifyOfferSignature(qr: OfferQR): Boolean {
        val pub = HexUtil.decode(qr.giverIrkPub) ?: return false
        if (pub.size != 32) return false
        val sig = HexUtil.decode(qr.offerSignature) ?: return false
        return runCatching {
            Ed25519Verify(pub).verify(
                sig,
                ServerTransferOfferOrder.canonicalBytes(
                    qr.serverDomain, qr.transferNonce, qr.issuedAt, qr.expiresAt,
                ),
            )
            true
        }.getOrDefault(false)
    }

    // ── ACQUIRER: parse + build the claim body ────────────────────────────────

    fun parseQR(text: String): OfferQR {
        val qr = try {
            json.decodeFromString(OfferQR.serializer(), text)
        } catch (_: Throwable) {
            throw TransferException("not a transfer QR")
        }
        if (qr.kind != "flagship-transfer-offer") throw TransferException("not a transfer QR")
        if (qr.serverDomain.isEmpty() || qr.transferNonce.isEmpty() || qr.giverIrkPub.isEmpty()) {
            throw TransferException("malformed transfer QR")
        }
        return qr
    }

    fun looksLikeTransferQR(text: String): Boolean = text.contains("flagship-transfer-offer")

    fun buildClaim(
        offer: OfferQR,
        acquirerUsername: String,
        acquirerIrk: Ed25519Sign,
        acquirerIrkPubHex: String,
        issuedAt: Long,
    ): TransferClaimBody {
        if (offer.expiresAt <= issuedAt) throw TransferException("expired")
        val lowered = acquirerUsername.lowercase()
        val sig = acquirerIrk.sign(
            ServerTransferClaimOrder.canonicalBytes(
                offer.serverDomain, offer.transferNonce, lowered, acquirerIrkPubHex, issuedAt
            )
        )
        return TransferClaimBody(
            claim = TransferClaimWire(
                serverDomain = offer.serverDomain,
                transferNonce = offer.transferNonce,
                acquirerUsername = lowered,
                acquirerIrkPub = acquirerIrkPubHex.lowercase(),
                issuedAt = issuedAt,
            ),
            claimSignature = HexUtil.encode(sig),
        )
    }

    // ── GIVER: disk-key re-seal ───────────────────────────────────────────────

    /** Re-seal the box's LUKS disk key (already unsealed by the giver IRK) to the
     *  ACQUIRER IRK pub. `.com` stays content-blind. */
    fun buildDiskKeyDeposit(
        serverDomain: String,
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        diskKey: ByteArray,
        acquirerIrkPubHex: String,
        issuedAt: Long,
        authNonce: ByteArray = random32(),
    ): TransferDiskKeyBody {
        val acquirerPub = HexUtil.decode(acquirerIrkPubHex)
        if (acquirerPub == null || acquirerPub.size != 32) throw TransferException("bad acquirer IRK")
        val sealed = SecretSeal.sealForEd25519Recipient(diskKey, acquirerPub)
        val auth = buildMailboxAuth(username, irk, irkPubHex, issuedAt, authNonce)
        return TransferDiskKeyBody(
            auth = auth.auth,
            authSignature = auth.authSignature,
            sealedDiskKey = HexUtil.encode(sealed),
        )
    }

    /** GIVER: open the box's install-time disk key (sealed FOR the giver IRK). */
    fun openGiverDiskKey(sealedHex: String, giverIrkSeed: ByteArray): ByteArray =
        SecretSeal.openWithEd25519Seed(
            HexUtil.decode(sealedHex) ?: throw TransferException("bad sealed key"), giverIrkSeed
        )

    /** ACQUIRER: open the giver's re-sealed disk key with the acquirer IRK seed. */
    fun openDiskKey(sealedHex: String, acquirerIrkSeed: ByteArray): ByteArray =
        SecretSeal.openWithEd25519Seed(
            HexUtil.decode(sealedHex) ?: throw TransferException("bad sealed key"), acquirerIrkSeed
        )

    // ── mailbox auth (IRK-signed DeviceEndpointClaim) ─────────────────────────

    fun buildMailboxAuth(
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        issuedAt: Long,
        nonce: ByteArray = random32(),
        endpointLabel: String = "device",
    ): MailboxAuthEnvelope {
        val nonceHex = HexUtil.encode(nonce)
        val expiresAt = issuedAt + 120_000
        val sig = DeviceEndpointClaim.sign(
            irk = irk,
            username = username,
            endpointLabel = endpointLabel,
            phoneIrkPubHex = irkPubHex,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            nonceHex = nonceHex,
        )
        return MailboxAuthEnvelope(
            auth = MailboxAuthEnvelope.Auth(
                username = username,
                endpointLabel = endpointLabel,
                phoneIrkPub = irkPubHex,
                issuedAt = issuedAt,
                expiresAt = expiresAt,
                nonce = nonceHex,
            ),
            authSignature = HexUtil.encode(sig),
        )
    }
}
