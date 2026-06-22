import Foundation
import CryptoKit
import Security
import FlagshipAPI

/// Pure (testable) builders for the transfer-a-box flow
/// (docs/account-deletion-and-name-reclaim.md §4). The SwiftUI VMs derive the
/// IRK behind the biometric, then call these to produce the exact wire bodies
/// the broker accepts — byte-identical to the webapp `lib/serverTransfer.js`.
///
/// Split this way so the crypto/canonical-bytes is `swift test`-able without the
/// UIKit-bound VM layer.
public enum ServerTransferFlow {

    /// The QR payload the giver shows + the acquirer scans. JSON, byte-stable
    /// field set matching the webapp `createTransferOffer().qr`.
    public struct OfferQR: Codable, Equatable, Sendable {
        public let v: Int
        public let kind: String
        public let serverDomain: String
        public let transferNonce: String
        public let giverIrkPub: String
        public let issuedAt: Int64
        public let expiresAt: Int64
        public let offerSignature: String

        public init(serverDomain: String, transferNonce: String, giverIrkPub: String, issuedAt: Int64, expiresAt: Int64, offerSignature: String) {
            self.v = 1
            self.kind = "flagship-transfer-offer"
            self.serverDomain = serverDomain
            self.transferNonce = transferNonce
            self.giverIrkPub = giverIrkPub
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
            self.offerSignature = offerSignature
        }
    }

    public enum TransferError: Error, Equatable, Sendable {
        case notATransferQR
        case malformedQR
        case expired
    }

    // MARK: - GIVER: build the offer body + the QR

    /// Sign a `ServerTransferOffer` + an IRK mailbox-auth, returning the deposit
    /// body AND the QR to render. `ttlMs` defaults to 15 min (the broker clamps).
    public static func buildOffer(
        serverDomain: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        issuedAt: Int64,
        ttlMs: Int64 = 15 * 60_000,
        nonce: Data,
        authNonce: Data
    ) throws -> (body: TransferOfferBody, qr: OfferQR) {
        let nonceHex = HexUtil.encode(nonce)
        let expiresAt = issuedAt + ttlMs
        let order = ServerTransferOfferOrder(
            serverDomain: serverDomain, transferNonce: nonceHex, issuedAt: issuedAt, expiresAt: expiresAt
        )
        let offerSig = try order.sign(with: irk)
        let offerSigHex = HexUtil.encode(offerSig)
        let auth = try buildMailboxAuth(username: username, irk: irk, issuedAt: issuedAt, nonce: authNonce)
        let body = TransferOfferBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            offer: TransferOfferWire(serverDomain: serverDomain, transferNonce: nonceHex, issuedAt: issuedAt, expiresAt: expiresAt),
            offerSignature: offerSigHex
        )
        let qr = OfferQR(
            serverDomain: serverDomain,
            transferNonce: nonceHex,
            giverIrkPub: HexUtil.encode(irk.publicKey.rawRepresentation),
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            offerSignature: offerSigHex
        )
        return (body, qr)
    }

    /// Cheap shape check for the camera validator (full parse happens on scan).
    public static func looksLikeTransferQR(_ text: String) -> Bool {
        text.contains("flagship-transfer-offer")
    }

    public static func encodeQR(_ qr: OfferQR) throws -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return String(data: try enc.encode(qr), encoding: .utf8) ?? ""
    }

    // MARK: - ACQUIRER: parse + build the claim body

    /// Parse a scanned/pasted QR string. Throws on a malformed / wrong-kind payload.
    public static func parseQR(_ text: String) throws -> OfferQR {
        guard let data = text.data(using: .utf8) else { throw TransferError.notATransferQR }
        guard let qr = try? JSONDecoder().decode(OfferQR.self, from: data) else {
            throw TransferError.notATransferQR
        }
        guard qr.kind == "flagship-transfer-offer" else { throw TransferError.notATransferQR }
        guard !qr.serverDomain.isEmpty, !qr.transferNonce.isEmpty, !qr.giverIrkPub.isEmpty else {
            throw TransferError.malformedQR
        }
        return qr
    }

    /// Sign a `ServerTransferClaim` for a parsed offer, returning the claim body.
    public static func buildClaim(
        offer: OfferQR,
        acquirerUsername: String,
        acquirerIrk: Curve25519.Signing.PrivateKey,
        issuedAt: Int64
    ) throws -> TransferClaimBody {
        if offer.expiresAt <= issuedAt { throw TransferError.expired }
        let acquirerIrkHex = HexUtil.encode(acquirerIrk.publicKey.rawRepresentation)
        let lowered = acquirerUsername.lowercased()
        let order = ServerTransferClaimOrder(
            serverDomain: offer.serverDomain,
            transferNonce: offer.transferNonce,
            acquirerUsername: lowered,
            acquirerIrkPubHex: acquirerIrkHex,
            issuedAt: issuedAt
        )
        let sig = try order.sign(with: acquirerIrk)
        return TransferClaimBody(
            claim: TransferClaimWire(
                serverDomain: offer.serverDomain,
                transferNonce: offer.transferNonce,
                acquirerUsername: lowered,
                acquirerIrkPub: acquirerIrkHex,
                issuedAt: issuedAt
            ),
            claimSignature: HexUtil.encode(sig)
        )
    }

    // MARK: - GIVER: disk-key re-seal

    /// Re-seal the box's LUKS disk key (already unsealed by the giver IRK) to the
    /// ACQUIRER IRK pub, returning the deposit body. `.com` stays content-blind.
    public static func buildDiskKeyDeposit(
        serverDomain: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        diskKey: Data,
        acquirerIrkPubHex: String,
        issuedAt: Int64,
        authNonce: Data
    ) throws -> TransferDiskKeyBody {
        guard let acquirerPub = HexUtil.decode(acquirerIrkPubHex), acquirerPub.count == 32 else {
            throw TransferError.malformedQR
        }
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: diskKey, recipientEd25519Pub: acquirerPub)
        let auth = try buildMailboxAuth(username: username, irk: irk, issuedAt: issuedAt, nonce: authNonce)
        return TransferDiskKeyBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            sealedDiskKey: HexUtil.encode(sealed)
        )
    }

    /// ACQUIRER: open the giver's re-sealed disk key with the acquirer IRK seed.
    public static func openDiskKey(sealedHex: String, acquirerIrk: Curve25519.Signing.PrivateKey) throws -> Data {
        guard let blob = HexUtil.decode(sealedHex) else { throw TransferError.malformedQR }
        return try SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: acquirerIrk.rawRepresentation)
    }

    /// GIVER: open the box's install-time disk key (sealed FOR the giver IRK)
    /// with the giver IRK seed — the first half of the re-seal step.
    public static func openGiverDiskKey(sealedHex: String, giverIrk: Curve25519.Signing.PrivateKey) throws -> Data {
        guard let blob = HexUtil.decode(sealedHex) else { throw TransferError.malformedQR }
        return try SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: giverIrk.rawRepresentation)
    }

    /// A fresh 32-byte random nonce.
    public static func random32() -> Data {
        var b = Data(count: 32)
        b.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return b
    }

    // MARK: - mailbox auth (IRK-signed DeviceEndpointClaim)

    public static func buildMailboxAuth(
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        issuedAt: Int64,
        nonce: Data,
        endpointLabel: String = "device"
    ) throws -> MailboxAuthEnvelope {
        let claim = DeviceEndpointClaim(
            username: username,
            endpointLabel: endpointLabel,
            phoneIrkPub: irk.publicKey.rawRepresentation,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 120_000,
            nonce: nonce
        )
        let sig = try claim.sign(with: irk)
        return MailboxAuthEnvelope(
            auth: .init(
                username: claim.username,
                endpointLabel: claim.endpointLabel,
                phoneIrkPub: HexUtil.encode(claim.phoneIrkPub),
                issuedAt: claim.issuedAt,
                expiresAt: claim.expiresAt,
                nonce: HexUtil.encode(claim.nonce)
            ),
            authSignature: HexUtil.encode(sig)
        )
    }
}
