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
        /// The offer's `offerSignature` does not verify under `giverIrkPub` over
        /// the `ServerTransferOfferOrder` canonical bytes. A deep-linked/scanned
        /// offer is attacker-supplied — this is the forgery gate.
        case badSignature
    }

    // MARK: - Universal-link / custom-scheme QR encoding (Slice C)

    /// The path the transfer universal link + custom scheme both use.
    public static let transferLinkPath = "/transfer"
    /// The query param carrying the base64url(offerJSON).
    public static let transferLinkParam = "o"

    /// Encode an offer as the `o=` param: `base64url(UTF8(offerJSON))`, NO padding
    /// (`-_` alphabet, `=` stripped). `offerJSON` is `encodeQR` (sortedKeys), so
    /// the payload is byte-identical to what the in-app scanner parses.
    public static func encodeOfferParam(_ qr: OfferQR) throws -> String {
        let json = try encodeQR(qr)
        return base64URLNoPadding(Data(json.utf8))
    }

    /// Decode an `o=` param back to the offer JSON string. Returns nil on a
    /// malformed base64url / non-UTF8 payload.
    public static func decodeOfferParam(_ b64url: String) -> String? {
        guard let data = decodeBase64URLNoPadding(b64url),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    /// The UNIVERSAL LINK the giver renders as a QR so the native Camera can open
    /// it: `https://flagshipserver.com/transfer?o=<b64url>`. Uses the configured
    /// control host (prod = `flagshipserver.com`).
    public static func transferUniversalLink(_ qr: OfferQR, controlHost: String = Endpoints.controlHost) throws -> String {
        "https://\(controlHost)\(transferLinkPath)?\(transferLinkParam)=\(try encodeOfferParam(qr))"
    }

    /// The custom-scheme twin: `flagship://transfer?o=<b64url>`.
    public static func transferCustomSchemeLink(_ qr: OfferQR) throws -> String {
        "flagship://transfer?\(transferLinkParam)=\(try encodeOfferParam(qr))"
    }

    /// Base64url-no-padding encoder (RFC 4648 §5) — matches the webapp/Android
    /// encoders + the existing `CompanionTicketURL` idiom.
    static func base64URLNoPadding(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
        s = s.replacingOccurrences(of: "/", with: "_")
        while s.hasSuffix("=") { s.removeLast() }
        return s
    }

    static func decodeBase64URLNoPadding(_ s: String) -> Data? {
        var t = s
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t.append("=") }
        return Data(base64Encoded: t)
    }

    // MARK: - GIVER: build the offer body + the QR

    /// Sign a `ServerTransferOffer` + an IRK mailbox-auth, returning the deposit
    /// body AND the QR to render. `ttlMs` defaults to 15 min (the broker clamps).
    public static func buildOffer(
        serverDomain: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
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
        // Slice D — the transfer OFFER is a SENSITIVE order: sign with the giver's
        // admin master root (`orderKey`) when supplied, else the IRK. The QR's
        // `giverIrkPub` MUST be the key the offer was signed with (the acquirer's
        // local `verifyOffer` checks `offerSignature` under it), so it tracks the
        // signing key. `.com` gates the offer against the giver's admin root and
        // records the giver identity from the registered account, independent of
        // this QR field. The mailbox AUTH stays IRK-signed.
        let signKey = orderKey ?? irk
        let offerSig = try order.sign(with: signKey)
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
            giverIrkPub: HexUtil.encode(signKey.publicKey.rawRepresentation),
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            offerSignature: offerSigHex
        )
        return (body, qr)
    }

    /// Cheap shape check for the camera validator (full parse happens on scan).
    /// Accepts BOTH the raw offer JSON (carries the `flagship-transfer-offer`
    /// kind) AND the universal-link / custom-scheme QR (`…/transfer?o=`).
    public static func looksLikeTransferQR(_ text: String) -> Bool {
        text.contains("flagship-transfer-offer")
            || text.contains("\(transferLinkPath)?\(transferLinkParam)=")
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

    /// Tolerant parse for a scanned string that may be EITHER the raw offer JSON
    /// OR a `flagship://transfer?o=` / `https://<controlHost>/transfer?o=` link.
    /// The in-app scanner uses this so it keeps working whether the giver renders
    /// the JSON (older client) or the universal link (Slice C).
    public static func parseScanned(_ text: String) throws -> OfferQR {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let json = offerJSONFromLink(trimmed) {
            return try parseQR(json)
        }
        return try parseQR(trimmed)
    }

    /// Pull the offer JSON out of a transfer link (universal or custom scheme),
    /// or nil if the string isn't a `…/transfer?o=…` link.
    public static func offerJSONFromLink(_ text: String) -> String? {
        guard let url = URL(string: text),
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              comps.path == transferLinkPath || url.host == "transfer",
              let o = comps.queryItems?.first(where: { $0.name == transferLinkParam })?.value
        else { return nil }
        return decodeOfferParam(o)
    }

    /// SECURITY GATE (Slice C) — Ed25519-verify `offer.offerSignature` under
    /// `offer.giverIrkPub` over the `ServerTransferOfferOrder` canonical bytes AND
    /// require `expiresAt > now`. A deep-linked/scanned offer is attacker-supplied,
    /// so the acquirer MUST pass this before building any claim. Throws
    /// `.malformedQR` (bad pubkey), `.badSignature`, or `.expired`.
    public static func verifyOffer(_ offer: OfferQR, now: Int64) throws {
        guard let pubData = HexUtil.decode(offer.giverIrkPub), pubData.count == 32,
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: pubData)
        else { throw TransferError.malformedQR }
        guard let sig = HexUtil.decode(offer.offerSignature) else { throw TransferError.badSignature }
        let order = ServerTransferOfferOrder(
            serverDomain: offer.serverDomain,
            transferNonce: offer.transferNonce,
            issuedAt: offer.issuedAt,
            expiresAt: offer.expiresAt
        )
        guard pub.isValidSignature(sig, for: order.canonicalBytes()) else {
            throw TransferError.badSignature
        }
        guard offer.expiresAt > now else { throw TransferError.expired }
    }

    /// Sign a `ServerTransferClaim` for a parsed offer, returning the claim body.
    public static func buildClaim(
        offer: OfferQR,
        acquirerUsername: String,
        acquirerIrk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        acquirerAdminRootPubHex: String = "",
        issuedAt: Int64
    ) throws -> TransferClaimBody {
        if offer.expiresAt <= issuedAt { throw TransferError.expired }
        // The claim's `acquirerIrkPubHex` field STAYS the acquirer's registered
        // IRK — `.com` requires `claim.acquirerIrkPub == acquirer.irkPubHex`
        // (identity), independent of the signature. Slice D signs the SENSITIVE
        // claim order with the acquirer's admin master root (`orderKey`) when
        // supplied (else the IRK); `.com` gates the signature against the
        // acquirer's admin root. §9.8: the v2 canonical additionally commits to
        // `acquirerAdminRootPubHex` ("" when the account has none) — the anchor
        // the box re-pins on re-home rides INSIDE the acquirer's signature, so
        // `.com` can't substitute it.
        let acquirerIrkHex = HexUtil.encode(acquirerIrk.publicKey.rawRepresentation)
        let lowered = acquirerUsername.lowercased()
        let order = ServerTransferClaimOrder(
            serverDomain: offer.serverDomain,
            transferNonce: offer.transferNonce,
            acquirerUsername: lowered,
            acquirerIrkPubHex: acquirerIrkHex,
            acquirerAdminRootPubHex: acquirerAdminRootPubHex,
            issuedAt: issuedAt
        )
        let sig = try order.sign(with: orderKey ?? acquirerIrk)
        return TransferClaimBody(
            claim: TransferClaimWire(
                serverDomain: offer.serverDomain,
                transferNonce: offer.transferNonce,
                acquirerUsername: lowered,
                acquirerIrkPub: acquirerIrkHex,
                acquirerAdminRootPub: acquirerAdminRootPubHex,
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

    // MARK: - GIVER: admin-root hand-off (spec §9.8)

    /// Build + sign the `flagship/admin-root-transfer/v1` hand-off proof with
    /// the GIVER's admin master root (the box's pinned anchor). The box
    /// verifies the signature against its pin before re-pinning to
    /// `acquirerAdminRootPubHex` — "" means unpin (acquirer has no admin root).
    /// `serverDomain` is the box's OLD canonical.
    public static func buildAdminHandoff(
        serverDomain: String,
        giverUsername: String,
        acquirerUsername: String,
        acquirerAdminRootPubHex: String,
        giverAdminRoot: Curve25519.Signing.PrivateKey,
        transferNonce: String,
        issuedAt: Int64
    ) throws -> TransferAdminHandoffBody {
        let oldPubHex = HexUtil.encode(giverAdminRoot.publicKey.rawRepresentation)
        let handoff = AdminRootTransfer(
            serverDomain: serverDomain,
            giverUsername: giverUsername,
            acquirerUsername: acquirerUsername,
            oldAdminRootPubHex: oldPubHex,
            newAdminRootPubHex: acquirerAdminRootPubHex,
            transferNonce: transferNonce,
            issuedAt: issuedAt
        )
        let sig = try handoff.sign(withGiverAdminRoot: giverAdminRoot)
        return TransferAdminHandoffBody(
            handoff: TransferAdminHandoffWire(
                serverDomain: serverDomain,
                giverUsername: giverUsername,
                acquirerUsername: acquirerUsername,
                oldAdminRootPub: oldPubHex,
                newAdminRootPub: acquirerAdminRootPubHex,
                transferNonce: transferNonce,
                issuedAt: issuedAt
            ),
            signatureHex: HexUtil.encode(sig)
        )
    }

    // MARK: - GIVER: legacy re-home authorization (v1-sec GAP 3)

    /// Build + sign the `flagship/server-rehome-auth/v1` re-home authorization
    /// with the GIVER's owner IRK (the box's pinned owner IRK until it re-homes).
    /// A box with NO pinned admin master root verifies this against its pin
    /// before writing the re-home marker — never on `.com`'s unsigned word. The
    /// deposit body carries only `issuedAt` + the signature; `.com` reconstructs
    /// the signed (old/new domain, acquirer IRK) fields from the claimed row.
    /// `oldServerDomain` is the box's OLD canonical; `newServerDomain` +
    /// `acquirerIrkPubHex` come from the giver's claim poll.
    public static func buildRehomeAuth(
        oldServerDomain: String,
        newServerDomain: String,
        acquirerIrkPubHex: String,
        giverIrk: Curve25519.Signing.PrivateKey,
        issuedAt: Int64
    ) throws -> TransferRehomeAuthBody {
        let order = RehomeAuthorizationOrder(
            oldServerDomain: oldServerDomain,
            newServerDomain: newServerDomain,
            acquirerIrkPubHex: acquirerIrkPubHex,
            issuedAt: issuedAt
        )
        let sig = try order.sign(withGiverIrk: giverIrk)
        return TransferRehomeAuthBody(issuedAt: issuedAt, signatureHex: HexUtil.encode(sig))
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
