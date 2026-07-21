import Foundation
import CryptoKit
import Security

public enum AccountMetadataRecordType: String, Sendable {
    case accountProfile = "account-profile"
    case deviceSelfProfile = "device-self-profile"
    case deviceManagedProfile = "device-managed-profile"
}

public struct AccountMetadataCoordinates: Sendable {
    public let accountId: String
    public let deviceId: String?
    public let recordType: AccountMetadataRecordType
    public let revision: Int64
    public let keyVersion: Int64

    public init(
        accountId: String,
        deviceId: String? = nil,
        recordType: AccountMetadataRecordType,
        revision: Int64,
        keyVersion: Int64
    ) {
        self.accountId = accountId
        self.deviceId = deviceId
        self.recordType = recordType
        self.revision = revision
        self.keyVersion = keyVersion
    }
}

public struct AccountMetadataCiphertext: Equatable, Sendable {
    public let nonceHex: String
    public let ciphertextHex: String

    public init(nonceHex: String, ciphertextHex: String) {
        self.nonceHex = nonceHex
        self.ciphertextHex = ciphertextHex
    }
}

public enum AccountMetadata {
    private static let salt = Data("flagship/account-metadata/v1".utf8)
    private static let accountInfo = Data("account-profile".utf8)
    private static let directoryInfo = Data("device-directory".utf8)
    private static let deviceIdPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{32}$")
    private static let bidiControls: Set<UInt32> = [
        0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
        0x2066, 0x2067, 0x2068, 0x2069,
    ]

    public static func deriveAccountProfileKey(umk: Data) throws -> Data {
        try deriveKey(umk: umk, info: accountInfo)
    }

    public static func deriveDeviceDirectoryKey(umk: Data) throws -> Data {
        try deriveKey(umk: umk, info: directoryInfo)
    }

    public static func deriveAccountDeviceKey(umk: Data, accountId: String, deviceId: String) throws -> Curve25519.Signing.PrivateKey {
        guard !accountId.isEmpty, !accountId.contains("|"),
              deviceIdPattern.firstMatch(in: deviceId, range: NSRange(deviceId.startIndex..., in: deviceId)) != nil
        else { throw AccountMetadataError.malformed }
        let material = SymmetricKey(data: umk)
        let seed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: material,
            salt: Data(),
            info: Data("flagship/account-device-key/v1|\(accountId.lowercased())|\(deviceId)".utf8),
            outputByteCount: 32
        )
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    public static func generateDeviceId() throws -> String {
        HexUtil.encode(try randomData(count: 16))
    }

    public static func deviceSupportCode(accountId: String, deviceId: String, devicePublicKey: Data) -> String {
        let digest = SHA256.hash(data: Data(
            "flagship/device-support-code/v1|\(accountId)|\(deviceId)|\(HexUtil.encode(devicePublicKey))".utf8
        ))
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var accumulator = 0
        var bits = 0
        var encoded = ""
        for byte in digest {
            accumulator = (accumulator << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                encoded.append(alphabet[(accumulator >> bits) & 31])
            }
            if encoded.count == 8 { return "\(encoded.prefix(4))-\(encoded.suffix(4))" }
        }
        return "\(encoded.prefix(4))-\(encoded.suffix(4))"
    }

    public static func validateDisplayName(_ input: String) throws -> String {
        let value = input
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .precomposedStringWithCanonicalMapping
        guard !value.isEmpty else { throw AccountMetadataError.invalidName }
        for scalar in value.unicodeScalars {
            if scalar.value <= 0x1f || (0x7f...0x9f).contains(scalar.value) || bidiControls.contains(scalar.value) {
                throw AccountMetadataError.invalidName
            }
        }
        guard value.count <= 64, value.lengthOfBytes(using: .utf8) <= 256 else {
            throw AccountMetadataError.invalidName
        }
        return value
    }

    public static func encrypt(
        displayName: String,
        keyBytes: Data,
        coordinates: AccountMetadataCoordinates,
        nonceData: Data? = nil
    ) throws -> AccountMetadataCiphertext {
        let name = try validateDisplayName(displayName)
        try validate(coordinates)
        guard keyBytes.count == 32 else { throw AccountMetadataError.invalidKey }
        let nonceBytes = try nonceData ?? randomData(count: 12)
        guard nonceBytes.count == 12 else { throw AccountMetadataError.malformed }
        let quotedName = try JSONEncoder().encode(name)
        var plaintext = Data("{\"version\":1,\"displayName\":".utf8)
        plaintext.append(quotedName)
        plaintext.append(Data("}".utf8))
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let sealed = try AES.GCM.seal(
            plaintext,
            using: SymmetricKey(data: keyBytes),
            nonce: nonce,
            authenticating: aad(coordinates)
        )
        var ciphertext = Data(sealed.ciphertext)
        ciphertext.append(sealed.tag)
        return AccountMetadataCiphertext(
            nonceHex: HexUtil.encode(nonceBytes),
            ciphertextHex: HexUtil.encode(ciphertext)
        )
    }

    public static func decrypt(
        ciphertext: AccountMetadataCiphertext,
        keyBytes: Data,
        coordinates: AccountMetadataCoordinates
    ) throws -> String {
        try validate(coordinates)
        guard keyBytes.count == 32,
              let nonceBytes = HexUtil.decode(ciphertext.nonceHex), nonceBytes.count == 12,
              let encrypted = HexUtil.decode(ciphertext.ciphertextHex), encrypted.count >= 16
        else { throw AccountMetadataError.malformed }
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let box = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: encrypted.dropLast(16),
            tag: encrypted.suffix(16)
        )
        let plaintext = try AES.GCM.open(
            box,
            using: SymmetricKey(data: keyBytes),
            authenticating: aad(coordinates)
        )
        guard let object = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              object.count == 2,
              object["version"] as? Int == 1,
              let displayName = object["displayName"] as? String
        else { throw AccountMetadataError.malformed }
        return try validateDisplayName(displayName)
    }

    public static func canonicalAccountProfile(
        accountId: String,
        revision: Int64,
        keyVersion: Int64,
        ciphertext: AccountMetadataCiphertext,
        issuedAt: Int64,
        signerPubHex: String
    ) -> Data {
        canonicalSignedProfile(
            tag: "flagship/account-profile/v1", accountId: accountId, deviceId: "",
            revision: revision, keyVersion: keyVersion, ciphertext: ciphertext,
            locked: "", issuedAt: issuedAt, signerPubHex: signerPubHex
        )
    }

    public static func canonicalDeviceSelfProfile(
        accountId: String,
        deviceId: String,
        revision: Int64,
        keyVersion: Int64,
        ciphertext: AccountMetadataCiphertext,
        issuedAt: Int64,
        signerPubHex: String
    ) -> Data {
        canonicalSignedProfile(
            tag: "flagship/device-profile-self/v1", accountId: accountId, deviceId: deviceId,
            revision: revision, keyVersion: keyVersion, ciphertext: ciphertext,
            locked: "", issuedAt: issuedAt, signerPubHex: signerPubHex
        )
    }

    public static func canonicalDeviceManagedProfile(
        accountId: String,
        deviceId: String,
        revision: Int64,
        keyVersion: Int64,
        ciphertext: AccountMetadataCiphertext,
        locked: Bool,
        issuedAt: Int64,
        signerPubHex: String
    ) -> Data {
        canonicalSignedProfile(
            tag: "flagship/device-profile-admin/v1", accountId: accountId, deviceId: deviceId,
            revision: revision, keyVersion: keyVersion, ciphertext: ciphertext,
            locked: locked ? "1" : "0", issuedAt: issuedAt, signerPubHex: signerPubHex
        )
    }

    public static func canonicalDirectoryRequest(
        accountId: String,
        deviceId: String,
        signerPubHex: String,
        method: String,
        path: String,
        requestId: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            "flagship/account-directory-request/v1", method, path, accountId.lowercased(),
            deviceId, signerPubHex, requestId, String(issuedAt),
        ].joined(separator: "|").utf8)
    }

    private static func canonicalSignedProfile(
        tag: String,
        accountId: String,
        deviceId: String,
        revision: Int64,
        keyVersion: Int64,
        ciphertext: AccountMetadataCiphertext,
        locked: String,
        issuedAt: Int64,
        signerPubHex: String
    ) -> Data {
        Data([
            tag, accountId.lowercased(), deviceId, String(revision), String(keyVersion),
            ciphertext.nonceHex, ciphertext.ciphertextHex, locked, String(issuedAt), signerPubHex,
        ].joined(separator: "|").utf8)
    }

    private static func deriveKey(umk: Data, info: Data) throws -> Data {
        guard umk.count == 32 else { throw AccountMetadataError.invalidKey }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umk),
            salt: salt,
            info: info,
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    private static func validate(_ coordinates: AccountMetadataCoordinates) throws {
        guard !coordinates.accountId.isEmpty,
              !coordinates.accountId.contains("|"),
              coordinates.revision > 0,
              coordinates.keyVersion > 0
        else { throw AccountMetadataError.malformed }
        switch coordinates.recordType {
        case .accountProfile:
            guard coordinates.deviceId == nil || coordinates.deviceId == "" else {
                throw AccountMetadataError.malformed
            }
        case .deviceSelfProfile, .deviceManagedProfile:
            guard let deviceId = coordinates.deviceId,
                  deviceIdPattern.firstMatch(
                    in: deviceId,
                    range: NSRange(deviceId.startIndex..., in: deviceId)
                  ) != nil
            else { throw AccountMetadataError.malformed }
        }
    }

    private static func aad(_ coordinates: AccountMetadataCoordinates) -> Data {
        Data([
            "flagship/account-metadata-aad/v1",
            coordinates.accountId.lowercased(),
            coordinates.recordType.rawValue,
            coordinates.deviceId ?? "",
            String(coordinates.revision),
            String(coordinates.keyVersion),
        ].joined(separator: "|").utf8)
    }

    private static func randomData(count: Int) throws -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
        }
        guard status == errSecSuccess else { throw AccountMetadataError.randomFailure }
        return data
    }
}

public enum AccountMetadataError: Error, Equatable {
    case invalidKey
    case invalidName
    case malformed
    case randomFailure
}
