import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// This account's device names, decrypted on the phone from the signed,
/// encrypted account directory (the one the trusted-devices list reads).
/// Names never leave the phone: `.com` and the box only ever see device ids.
public enum AccountDeviceNames {

    /// The name a directory device shows: the admin-set name, else the
    /// device's own, else "<platform> · Device <support code>".
    public static func displayName(
        of device: AccountDirectoryDevice,
        in directory: AccountDirectoryResponse,
        accountId: String,
        directoryKey: Data
    ) -> String {
        decryptedName(of: device.deviceId, in: directory, accountId: accountId, directoryKey: directoryKey)
            ?? String(localized: "\(platformDisplay(device.platformClass)) · Device \(device.supportCode)")
    }

    /// Every device the directory lists (revoked ones too: an invite outlives
    /// the device that made it), keyed by lowercase device id.
    public static func names(in directory: AccountDirectoryResponse, accountId: String, umk: Data) -> [String: String] {
        guard let key = try? AccountMetadata.deriveDeviceDirectoryKey(umk: umk) else { return [:] }
        var out: [String: String] = [:]
        for device in directory.devices {
            out[device.deviceId.lowercased()] = displayName(of: device, in: directory, accountId: accountId, directoryKey: key)
        }
        return out
    }

    static func decryptedName(of deviceId: String, in directory: AccountDirectoryResponse,
                              accountId: String, directoryKey: Data) -> String? {
        if let managed = directory.managedProfiles.first(where: { $0.deviceId == deviceId }) {
            return try? AccountMetadata.decrypt(
                ciphertext: .init(nonceHex: managed.nonceHex, ciphertextHex: managed.ciphertextHex),
                keyBytes: directoryKey,
                coordinates: .init(accountId: accountId, deviceId: deviceId, recordType: .deviceManagedProfile,
                                   revision: managed.revision, keyVersion: managed.keyVersion))
        }
        guard let own = directory.selfProfiles.first(where: { $0.deviceId == deviceId }) else { return nil }
        return try? AccountMetadata.decrypt(
            ciphertext: .init(nonceHex: own.nonceHex, ciphertextHex: own.ciphertextHex),
            keyBytes: directoryKey,
            coordinates: .init(accountId: accountId, deviceId: deviceId, recordType: .deviceSelfProfile,
                               revision: own.revision, keyVersion: own.keyVersion))
    }

    static func platformDisplay(_ value: String?) -> String {
        switch value {
        case "ios": return "iPhone"
        case "android": return "Android"
        case "web": return String(localized: "Web browser")
        case "macos": return String(localized: "Mac")
        default: return String(localized: "Device")
        }
    }

    @MainActor private static var cached: (account: String, at: Date, names: [String: String])?
    private static let cacheLifetime: TimeInterval = 5 * 60

    /// The names, or nil when they can't be read: a locked session (this
    /// never prompts), no account device id, or a directory this device may
    /// not read. Cached for a few minutes per account.
    @MainActor
    public static func load(username: String, deviceId: String?, server: any FlagshipServerClient) async -> [String: String]? {
        let account = username.lowercased()
        if let c = cached, c.account == account, Date().timeIntervalSince(c.at) < cacheLifetime { return c.names }
        guard !account.isEmpty, let deviceId, deviceId.count == 32,
              let umk = Keystore.sessionUMKIfCached() else { return nil }
        do {
            let deviceKey = try Keystore.accountDeviceSigningKey(umk: umk, accountId: username, deviceId: deviceId)
            let signerPubHex = HexUtil.encode(deviceKey.publicKey.rawRepresentation)
            let requestId = try AccountMetadata.generateDeviceId()
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let canonical = AccountMetadata.canonicalDirectoryRequest(
                accountId: username, deviceId: deviceId, signerPubHex: signerPubHex, method: "GET",
                path: "/api/accounts/\(account)/directory", requestId: requestId, issuedAt: issuedAt)
            let signature = try deviceKey.signature(for: canonical)
            let directory = try await server.accountDirectory(
                accountId: username,
                authorization: AccountDirectoryAuthorization(
                    deviceId: deviceId, signerPubHex: signerPubHex, requestId: requestId,
                    issuedAt: issuedAt, signatureHex: HexUtil.encode(Data(signature))))
            let names = names(in: directory, accountId: username, umk: umk)
            cached = (account, Date(), names)
            return names
        } catch {
            return nil
        }
    }
}
