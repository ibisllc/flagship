import Foundation
import CryptoKit
import FlagshipAPI

/// Phase 3b — the sealed payload the admin sends to the incoming device
/// over the pairing relay. Carries the account master key seed (so the
/// new device can derive the same IRK/BAK/SWK as the rest of the
/// account) plus the admin-signed `DeviceAdmit` envelope (the vouch the
/// incoming device presents to .com).
///
/// This is the cross-ecosystem analog of the iCloud-Keychain sync that
/// a same-Apple-ID second device would get for free: iCloud can't carry
/// the credential to a collaborator's own Apple ID, so the UMK moves
/// out-of-band, AEAD-sealed under the QR-derived key, only AFTER the
/// human confirms the SAS match.
public struct PairingBundle: Codable, Equatable, Sendable {
    /// The account UMK seed, lowercased hex (32 bytes → 64 hex chars).
    public let umkSeedHex: String
    /// The DeviceAdmit envelope fields the incoming device re-builds +
    /// verifies under the account IRK before installing the UMK.
    public let admit: AdmitFields
    /// Ed25519 signature over the admit, by the account's CURRENT IRK
    /// (hex). The incoming device verifies this under `irkPubHex` (and
    /// .com re-verifies it under the IRK it has on file for the account).
    public let admitSig: String
    /// The account's CURRENT IRK public key (hex). Carried so the
    /// incoming device can verify `admitSig` locally BEFORE installing
    /// the UMK — it has no other source for the account IRK pubkey at
    /// pairing time. .com is the authoritative re-check on
    /// `/devices/admit` (it verifies under the IRK it stores), so a
    /// forged carried pubkey can't actually admit a device.
    public let irkPubHex: String
    public let grant: GrantFields
    public let grantSignature: String
    /// Slice D §4.2 (promote-a-device, "seal the master root"). Present ONLY
    /// when the admin toggled "Also make this device an admin" in the
    /// synchronous SAS ceremony (D-4): the account's ADMIN MASTER ROOT private
    /// seed, lowercased hex (32 bytes → 64 hex chars). Carried inside this
    /// AEAD-sealed bundle EXACTLY like `umkSeedHex` (the outer QR-derived seal
    /// is the wrapping), so the incoming device unwraps it and seals it
    /// device-local ⇒ it becomes a bare-master-root admin, indistinguishable
    /// from the first device. Absent (nil) ⇒ the new device joins non-admin.
    /// Optional + defaulted so a pre-D bundle decodes byte-identically.
    public let wrappedAdminRoot: String?

    public struct AdmitFields: Codable, Equatable, Sendable {
        public let username: String
        public let deviceId: String
        public let newDevicePubHex: String
        public let issuedAt: Int64
        public init(username: String, deviceId: String, newDevicePubHex: String, issuedAt: Int64) {
            self.username = username
            self.deviceId = deviceId
            self.newDevicePubHex = newDevicePubHex
            self.issuedAt = issuedAt
        }
    }

    public struct GrantFields: Codable, Equatable, Sendable {
        public let grantId: String
        public let username: String
        public let deviceId: String
        public let devicePubHex: String
        public let scopes: [String]
        public let issuedAt: Int64
        public let expiresAt: Int64
        public let signerRoot: String

        public init(grantId: String, username: String, deviceId: String, devicePubHex: String, scopes: [String], issuedAt: Int64, expiresAt: Int64, signerRoot: String) {
            self.grantId = grantId; self.username = username; self.deviceId = deviceId
            self.devicePubHex = devicePubHex; self.scopes = scopes; self.issuedAt = issuedAt
            self.expiresAt = expiresAt; self.signerRoot = signerRoot
        }
    }

    public init(
        umkSeedHex: String,
        admit: AdmitFields,
        admitSig: String,
        irkPubHex: String,
        grant: GrantFields,
        grantSignature: String,
        wrappedAdminRoot: String? = nil
    ) {
        self.umkSeedHex = umkSeedHex
        self.admit = admit
        self.admitSig = admitSig
        self.irkPubHex = irkPubHex
        self.grant = grant
        self.grantSignature = grantSignature
        self.wrappedAdminRoot = wrappedAdminRoot
    }

    public func encoded() throws -> Data {
        try JSONEncoder().encode(self)
    }

    public static func decode(_ data: Data) throws -> PairingBundle {
        try JSONDecoder().decode(PairingBundle.self, from: data)
    }
}

/// Phase 3b — admin-side helpers for the pairing QR + the SAS/AEAD
/// derivation. The pairing QR is a UNIVERSAL LINK so the incoming
/// phone's native camera opens it straight into the app:
///
///   https://flagshipserver.com/join?sid=<relaySid>&pk=<adminX25519PubB64u>
///
/// The relay session id + the admin's EPHEMERAL X25519 public key ride
/// the URL; the incoming device generates its own ephemeral X25519 key,
/// computes the same shared secret, and both derive the SAS + AEAD key
/// via the audited `QrRelay.deriveMaterial`.
public enum PairingQr {
    /// Control apex host, via `Endpoints` (prod-default + test override).
    public static var joinHost: String { Endpoints.controlHost }
    public static let joinPath = "/join"

    /// Build the universal-link QR string the admin renders.
    public static func joinUrl(sid: String, adminEphemeralPub: Data) -> String {
        let pk = Base64URL.encode(adminEphemeralPub)
        var comps = URLComponents()
        comps.scheme = "https"
        comps.host = joinHost
        comps.path = joinPath
        comps.queryItems = [
            URLQueryItem(name: "sid", value: sid),
            URLQueryItem(name: "pk", value: pk),
        ]
        return comps.url?.absoluteString ?? "https://\(joinHost)\(joinPath)?sid=\(sid)&pk=\(pk)"
    }

    /// Parsed contents of a `/join` pairing link.
    public struct JoinSession: Equatable, Sendable {
        public let sid: String
        public let adminPublicKey: Data    // raw 32-byte X25519
        public init(sid: String, adminPublicKey: Data) {
            self.sid = sid; self.adminPublicKey = adminPublicKey
        }
    }

    public enum ParseError: Error, LocalizedError, Sendable {
        case malformed(String)
        case badPublicKey
        public var errorDescription: String? {
            switch self {
            case .malformed(let m): return "Pairing link: \(m)"
            case .badPublicKey:     return "Pairing link public key must be 32 raw X25519 bytes."
            }
        }
    }

    /// Parse a scanned / deep-linked `/join` pairing URL. Accepts:
    ///   - https://flagshipserver.com/join?sid=<sid>&pk=<pk>
    ///   - flagship://join?sid=<sid>&pk=<pk>
    ///   - sid=<sid>&pk=<pk>
    public static func parseJoinUrl(_ raw: String) throws -> JoinSession {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ParseError.malformed("empty") }
        var sid: String?
        var pk: String?
        if text.contains("?") || text.lowercased().hasPrefix("http") || text.hasPrefix("flagship://") {
            let normalized = text.hasPrefix("flagship://")
                ? text.replacingOccurrences(of: "flagship://", with: "https://_/")
                : text
            guard let comps = URLComponents(string: normalized) else {
                throw ParseError.malformed("could not parse")
            }
            for q in comps.queryItems ?? [] {
                if q.name == "sid" { sid = q.value }
                if q.name == "pk" { pk = q.value }
            }
        } else if text.contains("=") {
            for pair in text.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                guard kv.count == 2 else { continue }
                if kv[0] == "sid" { sid = kv[1] }
                if kv[0] == "pk" { pk = kv[1] }
            }
        }
        guard let s = sid, !s.isEmpty, let k = pk, !k.isEmpty else {
            throw ParseError.malformed("missing sid= or pk=")
        }
        guard let raw = Base64URL.decode(k) else {
            throw ParseError.malformed("pk is not valid base64url")
        }
        guard raw.count == 32 else { throw ParseError.badPublicKey }
        return JoinSession(sid: s, adminPublicKey: raw)
    }
}
