import Foundation
import CryptoKit

/// `flagship/watch-boot-delegate/v1`: the account key's attestation of a copy of one server's disk key
/// sealed to a watch's boot-only X25519 key, so a start-up can be approved from the watch while the phone
/// is locked (docs/watch-boot-approval-without-unlock.md, option (a)). Wire parity with
/// packages/protocol/src/watchBootDelegate.ts; must pass
/// packages/protocol/test-vectors/watch-boot-delegate/vectors.json.
///
///   flagship/watch-boot-delegate/v1|<serverDomain lowercase>|<delegatePubHex>|<decryptPubHex>|<keySha256Hex>|<issuedAt>|<expiresAt>
public struct WatchBootDelegate: Equatable, Sendable {
    public static let canonicalTag = "flagship/watch-boot-delegate/v1"
    /// A copy lasts at most the watch delegate's own seven days.
    public static let maxMs: Int64 = 7 * 24 * 3_600_000

    public struct Invalid: Error, Equatable { public let reason: String }

    public let serverDomain: String
    public let delegatePubHex: String
    public let decryptPubHex: String
    public let keySha256Hex: String
    public let issuedAt: Int64
    public let expiresAt: Int64

    public init(serverDomain: String, delegatePubHex: String, decryptPubHex: String, keySha256Hex: String, issuedAt: Int64, expiresAt: Int64) {
        self.serverDomain = serverDomain
        self.delegatePubHex = delegatePubHex
        self.decryptPubHex = decryptPubHex
        self.keySha256Hex = keySha256Hex
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    private static func lowerHex64(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    public func canonicalBytes() throws -> Data {
        guard !serverDomain.isEmpty, !serverDomain.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f }) else { throw Invalid(reason: "serverDomain") }
        guard Self.lowerHex64(delegatePubHex) else { throw Invalid(reason: "delegatePubHex") }
        guard Self.lowerHex64(decryptPubHex) else { throw Invalid(reason: "decryptPubHex") }
        guard Self.lowerHex64(keySha256Hex) else { throw Invalid(reason: "keySha256Hex") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
        guard expiresAt > issuedAt else { throw Invalid(reason: "expiresAt") }
        guard expiresAt - issuedAt <= Self.maxMs else { throw Invalid(reason: "a watch boot key lasts at most 7 days") }
        let parts = [Self.canonicalTag, serverDomain.lowercased(), delegatePubHex, decryptPubHex, keySha256Hex, String(issuedAt), String(expiresAt)]
        return Data(parts.joined(separator: "|").utf8)
    }
}

/// The deposit an admin device PUTs to the boot worker, and the watch's side of it.
public struct WatchBootDeposit: Equatable, Sendable {
    public let attestation: WatchBootDelegate
    public let sealedKeyHex: String
    public let signatureHex: String

    public init(attestation: WatchBootDelegate, sealedKeyHex: String, signatureHex: String) {
        self.attestation = attestation
        self.sealedKeyHex = sealedKeyHex
        self.signatureHex = signatureHex
    }

    /// Admin device: seal the unsealed disk key for the watch's decryption key and sign the attestation
    /// with the account key (admin root where pinned).
    public static func build(
        serverDomain: String,
        diskKey: Data,
        delegatePub: Data,
        decryptPub: Data,
        issuedAt: Int64,
        expiresAt: Int64,
        sign: (Data) throws -> Data
    ) throws -> WatchBootDeposit {
        let attestation = WatchBootDelegate(
            serverDomain: serverDomain.lowercased(),
            delegatePubHex: delegatePub.hexString,
            decryptPubHex: decryptPub.hexString,
            keySha256Hex: Data(SHA256.hash(data: diskKey)).hexString,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        )
        let sig = try sign(try attestation.canonicalBytes())
        let sealed = try SecretSeal.sealForRecipient(plaintext: diskKey, recipientX25519Pub: decryptPub)
        return WatchBootDeposit(attestation: attestation, sealedKeyHex: sealed.hexString, signatureHex: sig.hexString)
    }

    /// The JSON body of `PUT /api/boot/watch-key`.
    public var body: [String: Any] {
        [
            "deposit": [
                "serverDomain": attestation.serverDomain,
                "delegatePubHex": attestation.delegatePubHex,
                "decryptPubHex": attestation.decryptPubHex,
                "keySha256Hex": attestation.keySha256Hex,
                "issuedAt": attestation.issuedAt,
                "expiresAt": attestation.expiresAt,
                "sealedKeyHex": sealedKeyHex,
                "signatureHex": signatureHex,
            ] as [String: Any],
        ]
    }

    /// Watch: open the copy with the boot-only decryption key and check it is the key the account attested.
    public func openKey(decryptPriv: Data) throws -> Data {
        guard let sealed = Data(watchBootHex: sealedKeyHex) else { throw WatchBootDelegate.Invalid(reason: "sealedKeyHex") }
        let key = try SecretSeal.openWithX25519(blob: sealed, recipientX25519Priv: decryptPriv)
        guard Data(SHA256.hash(data: key)).hexString == attestation.keySha256Hex.lowercased() else {
            throw WatchBootDelegate.Invalid(reason: "the opened key is not the one the account attested")
        }
        return key
    }
}

private extension Data {
    // hexString (encode) is shared from BootAuthorization.swift
    init?(watchBootHex hexString: String) {
        guard hexString.count % 2 == 0 else { return nil }
        var d = Data(capacity: hexString.count / 2)
        var i = hexString.startIndex
        while i < hexString.endIndex {
            let n = hexString.index(i, offsetBy: 2)
            guard let b = UInt8(hexString[i..<n], radix: 16) else { return nil }
            d.append(b)
            i = n
        }
        self = d
    }
}
