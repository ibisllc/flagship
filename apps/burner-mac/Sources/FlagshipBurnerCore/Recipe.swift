import Foundation
import CryptoKit

/// A phone-signed install recipe (InstallBlob v2). Parsing + verification is
/// a pure-Swift reimplementation of packages/flagship-burner loadBlob +
/// @flagship/protocol verifyInstallBlob. The canonical-byte layout MUST match
/// the TypeScript exactly (see RecipeTests' golden vector) or signatures fail.

public struct RecipeAuthCode: Sendable, Equatable {
    public let version: Int
    public let serial: String
    public let username: String
    public let serverName: String
    public let serverDomain: String
    public let delegatedPubKeyHex: String
    public let userPubKeyHex: String
    public let issuedAt: Int64
    public let expiresAt: Int64
}

/// Cert-autonomy policy (mirrors @flagship/protocol InstallBlob.certAutonomy).
/// Phone-signed; nil (absent) ⇒ omitted from the canonical bytes so legacy
/// recipes keep verifying.
public struct RecipeCertAutonomy: Sendable, Equatable {
    public let mode: String            // "managed" | "autonomous"
    public let offlineWindowDays: Int? // nil ⇒ 0 on the wire
}

public struct Recipe: Sendable, Equatable {
    public let version: Int
    public let serverDomain: String
    public let username: String
    public let serverName: String
    public let phoneDelegatedPubKeyHex: String
    public let registrationUrl: String
    public let authCode: RecipeAuthCode
    public let authCodeUserSignatureHex: String
    public let installerGitRef: String
    public let rckPubKeyHex: String
    public let blobSignatureHex: String
    /// Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
    /// Phone-signed in the blob; nil (absent) ⇒ treat as "auto" (the default).
    /// Mirrors @flagship/protocol InstallBlob.bootUnlockMode — OPTIONAL so the
    /// canonical-bytes match the TS (absent omits the field, present appends it).
    public let bootUnlockMode: String?
    /// Cert-autonomy policy — phone-signed; nil omits it from the canonical
    /// bytes. Mirrors @flagship/protocol InstallBlob.certAutonomy.
    public let certAutonomy: RecipeCertAutonomy?

    /// The effective mode the box bakes/dispatches on (absence ⇒ "auto").
    public var effectiveBootUnlockMode: String {
        bootUnlockMode == "approve" ? "approve" : "auto"
    }

    public var expiresAtDate: Date {
        Date(timeIntervalSince1970: Double(authCode.expiresAt) / 1000.0)
    }
}

public enum RecipeError: LocalizedError, Equatable {
    case malformed(String)
    case wrongVersion(Int)
    case expired(Date)
    case badSignature

    public var errorDescription: String? {
        switch self {
        case .malformed(let why): return "Not a valid recipe: \(why)"
        case .wrongVersion(let v): return "Unsupported recipe version \(v) (expected 2)."
        case .expired(let when):
            return "This recipe expired \(when.formatted(date: .abbreviated, time: .shortened))."
        case .badSignature:
            return "The recipe's signature doesn't verify — it may be tampered or corrupt."
        }
    }
}

public enum RecipeLoader {
    public static func load(contentsOf url: URL, now: Date = Date()) throws -> Recipe {
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch { throw RecipeError.malformed("cannot read \(url.lastPathComponent): \(error.localizedDescription)") }
        return try load(data: data, now: now)
    }

    public static func load(data: Data, now: Date = Date()) throws -> Recipe {
        let recipe = try parse(data)
        if recipe.version != 2 { throw RecipeError.wrongVersion(recipe.version) }
        // v2: the auth-code expiry is the recipe expiry. Refuse before any work.
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        if nowMs > recipe.authCode.expiresAt {
            throw RecipeError.expired(recipe.expiresAtDate)
        }
        guard verifySignature(recipe) else { throw RecipeError.badSignature }
        return recipe
    }

    /// canonicalInstallBlob — must match @flagship/protocol byte-for-byte.
    /// Hex fields are lowercased to mirror the TS `hex(bytes)` output.
    static func canonicalBytes(_ r: Recipe) -> Data {
        var parts = [
            "flagship/install-blob/v1",
            String(r.version),
            r.serverDomain,
            r.username,
            r.serverName,
            r.phoneDelegatedPubKeyHex.lowercased(),
            r.registrationUrl,
            r.authCode.serial,
            r.authCode.userPubKeyHex.lowercased(),
            r.authCodeUserSignatureHex.lowercased(),
            r.installerGitRef,
            r.rckPubKeyHex.lowercased(),
        ]
        // Backward-compatible extension (matches @flagship/protocol exactly): a
        // blob WITHOUT bootUnlockMode produces the pre-existing canonical bytes
        // (old signatures keep verifying); present ⇒ appended, so the signer
        // commits to it and a relay can neither strip nor downgrade it.
        if let mode = r.bootUnlockMode { parts.append(mode) }
        // certAutonomy appended after bootUnlockMode with a `ca=` prefix that
        // can't collide with a bootUnlockMode value. MUST match @flagship/protocol
        // canonicalInstallBlob byte-for-byte (the `certAutonomy` append).
        if let ca = r.certAutonomy {
            parts.append("ca=\(ca.mode):\(ca.offlineWindowDays ?? 0)")
        }
        return Data(parts.joined(separator: "|").utf8)
    }

    static func verifySignature(_ r: Recipe) -> Bool {
        guard let pubData = Data(hexString: r.authCode.userPubKeyHex), pubData.count == 32,
              let sigData = Data(hexString: r.blobSignatureHex), sigData.count == 64,
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: pubData)
        else { return false }
        return pub.isValidSignature(sigData, for: canonicalBytes(r))
    }

    // MARK: - JSON

    private struct DTO: Decodable {
        struct AC: Decodable {
            let version: Int?
            let serial: String
            let username: String?
            let serverName: String?
            let serverDomain: String?
            let delegatedPubKey: String?
            let userPubKey: String
            let issuedAt: Int64
            let expiresAt: Int64
        }
        let version: Int
        let serverDomain: String
        let username: String
        let serverName: String
        let phoneDelegatedPubKey: String
        let registrationUrl: String
        let authCode: AC
        let authCodeUserSignature: String
        let installerGitRef: String
        let rckPubKey: String
        let blobSignatureHex: String
        let bootUnlockMode: String?
        struct CA: Decodable {
            let mode: String
            let offlineWindowDays: Int?
        }
        let certAutonomy: CA?
    }

    /// Accept both the flattened recipe and the issued envelope that .com /
    /// the website hand out: `{ "blob": {…}, "blobSignature": "…" }`. The
    /// envelope is flattened (blob fields + blobSignatureHex) before decoding.
    static func normalizeEnvelope(_ data: Data) -> Data {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return data }
        if var blob = obj["blob"] as? [String: Any], let sig = obj["blobSignature"] as? String {
            blob["blobSignatureHex"] = sig
            return (try? JSONSerialization.data(withJSONObject: blob)) ?? data
        }
        return data
    }

    private static func parse(_ data: Data) throws -> Recipe {
        let dto: DTO
        do { dto = try JSONDecoder().decode(DTO.self, from: normalizeEnvelope(data)) }
        catch { throw RecipeError.malformed("\(error.localizedDescription)") }
        let ac = RecipeAuthCode(
            version: dto.authCode.version ?? 1,
            serial: dto.authCode.serial,
            username: dto.authCode.username ?? dto.username,
            serverName: dto.authCode.serverName ?? dto.serverName,
            serverDomain: dto.authCode.serverDomain ?? dto.serverDomain,
            delegatedPubKeyHex: dto.authCode.delegatedPubKey ?? dto.phoneDelegatedPubKey,
            userPubKeyHex: dto.authCode.userPubKey,
            issuedAt: dto.authCode.issuedAt,
            expiresAt: dto.authCode.expiresAt)
        return Recipe(
            version: dto.version,
            serverDomain: dto.serverDomain,
            username: dto.username,
            serverName: dto.serverName,
            phoneDelegatedPubKeyHex: dto.phoneDelegatedPubKey,
            registrationUrl: dto.registrationUrl,
            authCode: ac,
            authCodeUserSignatureHex: dto.authCodeUserSignature,
            installerGitRef: dto.installerGitRef,
            rckPubKeyHex: dto.rckPubKey,
            blobSignatureHex: dto.blobSignatureHex,
            bootUnlockMode: dto.bootUnlockMode,
            certAutonomy: dto.certAutonomy.map {
                RecipeCertAutonomy(mode: $0.mode, offlineWindowDays: $0.offlineWindowDays)
            })
    }
}

extension Data {
    /// Decode a hex string (even length, [0-9a-fA-F]) to bytes; nil if invalid.
    init?(hexString: String) {
        let s = Substring(hexString)
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            guard let byte = UInt8(s[idx..<next], radix: 16) else { return nil }
            out.append(byte)
            idx = next
        }
        self = out
    }

    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
