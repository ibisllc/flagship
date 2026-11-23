import Foundation
import CryptoKit
import Security
import FlagshipCore

/// This device's call-only key, for answering voi.ci calls while Flagship is locked (docs/voici-calls.md, owner
/// decisions 2026-11-15; the setting "Answer calls while Flagship is locked", off by default).
///
/// A P-256 key: Secure Enclave where there is one, else a software key, either kept in the Keychain as
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` with no user presence, so a ringing phone can sign after its
/// first unlock since boot. It is bound once under the owner messages key (`flagship/voici-call-key/v1`) and signs only
/// a call's room join, answer and owner end order; `.com` and the caller's browser refuse it for anything else.
/// The binding and what a locked call needs (account, device, page, the page's ownerSignPub) are kept with it; none
/// of that is secret (the page is public).
public struct VoiciCallKey: Sendable {
    public let username: String
    public let deviceId: String
    public let pageId: String
    /// The ownerSignPub the binding verifies under (a rotated inbox key needs a fresh binding).
    public let ownerSignPub: String
    public let pubHex: String
    /// `{binding, signature}`, as the answer carries it.
    public let proof: JSONValue
    fileprivate let secret: Secret

    fileprivate enum Secret: Sendable {
        case enclave(Data)
        case software(Data)
    }

    /// IEEE P1363 r‖s, 64 bytes.
    public func sign(_ bytes: [UInt8]) throws -> [UInt8] {
        switch secret {
        case .enclave(let d): return Array(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: d).signature(for: Data(bytes)).rawRepresentation)
        case .software(let d): return Array(try P256.Signing.PrivateKey(rawRepresentation: d).signature(for: Data(bytes)).rawRepresentation)
        }
    }

    public var deviceRef: String? { try? VoiciCalls.deviceRef(devicePubHex: pubHex) }

    /// The room join headers (`flagship/voici-call-join/v1`) for one call.
    public func joinHeaders(callId: String, now: Int64) -> [String: String]? {
        guard let bytes = try? VoiciCalls.canonicalCallJoin(username: username, callId: callId, deviceId: deviceId, callKeyPub: pubHex, issuedAt: now),
              let sig = try? sign(bytes) else { return nil }
        return ["x-flagship-call-key-device": deviceId, "x-flagship-call-key-pub": pubHex, "x-flagship-call-key-at": String(now),
                "x-flagship-call-key-sig": CanonicalJson.hex(sig)]
    }

    /// The same key under a fresh binding (after an inbox-key rotation).
    func rebound(pageId: String, ownerSignPub: String, proof: JSONValue) -> VoiciCallKey {
        VoiciCallKey(username: username, deviceId: deviceId, pageId: pageId, ownerSignPub: ownerSignPub, pubHex: pubHex, proof: proof, secret: secret)
    }

    /// The revocation this key signs itself (when the owner key is not at hand).
    public func selfRevoke(at: Int64) -> (revoke: JSONValue, signature: String)? {
        guard let bytes = try? VoiciCalls.canonicalCallKeyRevoke(username: username, deviceId: deviceId, callKeyPub: pubHex, revokedAt: at),
              let sig = try? sign(bytes) else { return nil }
        return (VoiciCalls.revokeJson(username: username, deviceId: deviceId, callKeyPub: pubHex, revokedAt: at), CanonicalJson.hex(sig))
    }
}

public enum VoiciCallKeyStore {
    static let service = "com.flagship.voici.call-key"

    private struct Stored: Codable {
        var kind: String
        var key: Data
        var username: String
        var deviceId: String
        var pageId: String
        var ownerSignPub: String
        var pubHex: String
        var proof: String
    }

    /// A fresh key (not stored yet): Secure Enclave when available.
    public static func generate() throws -> (secret: Data, enclave: Bool, pubHex: String) {
        if SecureEnclave.isAvailable {
            var error: Unmanaged<CFError>?
            if let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error),
               let k = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access) {
                return (k.dataRepresentation, true, CanonicalJson.hex(Array(k.publicKey.x963Representation)))
            }
        }
        let k = P256.Signing.PrivateKey()
        return (k.rawRepresentation, false, CanonicalJson.hex(Array(k.publicKey.x963Representation)))
    }

    /// Signs with a generated secret before it is stored (the binding's proof-of-possession is the answer itself).
    static func key(username: String, deviceId: String, pageId: String, ownerSignPub: String, secret: Data, enclave: Bool, pubHex: String, proof: JSONValue) -> VoiciCallKey {
        VoiciCallKey(username: username, deviceId: deviceId, pageId: pageId, ownerSignPub: ownerSignPub, pubHex: pubHex, proof: proof,
                     secret: enclave ? .enclave(secret) : .software(secret))
    }

    public static func save(_ k: VoiciCallKey) throws {
        let (kind, data): (String, Data) = switch k.secret {
        case .enclave(let d): ("enclave", d)
        case .software(let d): ("software", d)
        }
        let s = Stored(kind: kind, key: data, username: k.username, deviceId: k.deviceId, pageId: k.pageId, ownerSignPub: k.ownerSignPub,
                       pubHex: k.pubHex, proof: (try? CanonicalJson.canonicalJson(k.proof)) ?? "")
        let blob = try JSONEncoder().encode(s)
        delete(username: k.username)
        let st = SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: k.username.lowercased(),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: blob,
        ] as CFDictionary, nil)
        guard st == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(st)) }
    }

    public static func load(username: String) -> VoiciCallKey? {
        var out: CFTypeRef?
        let st = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: username.lowercased(),
            kSecReturnData as String: true,
        ] as CFDictionary, &out)
        guard st == errSecSuccess, let data = out as? Data, let s = try? JSONDecoder().decode(Stored.self, from: data),
              let proof = JSONValue.parse(s.proof) else { return nil }
        return VoiciCallKey(username: s.username, deviceId: s.deviceId, pageId: s.pageId, ownerSignPub: s.ownerSignPub, pubHex: s.pubHex,
                            proof: proof, secret: s.kind == "enclave" ? .enclave(s.key) : .software(s.key))
    }

    public static func delete(username: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrAccount as String: username.lowercased()] as CFDictionary)
    }

    /// The account last used on this device, so a locked phone knows whose key to use when a call arrives.
    static let lastAccountKey = "flagship.voici.callKey.account"
    public static func rememberAccount(_ username: String?) {
        if let username, !username.isEmpty { UserDefaults.standard.set(username.lowercased(), forKey: lastAccountKey) }
    }
    /// The account last used on this device (any device of it: ring-backs reach non-admin devices too).
    public static var lastAccount: String? { UserDefaults.standard.string(forKey: lastAccountKey) }
    public static var currentAccountKey: VoiciCallKey? {
        UserDefaults.standard.string(forKey: lastAccountKey).flatMap { load(username: $0) }
    }
}
