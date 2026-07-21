import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

@Observable
@MainActor
public final class SettingsViewModel {
    public struct DirectoryDevice: Equatable, Sendable, Identifiable {
        public let deviceId: String
        public let displayName: String
        public let platformClass: String?
        public let supportCode: String
        public let createdAt: Int64
        public let lastSeenAt: Int64
        public let isCurrent: Bool
        public let isAdministrator: Bool
        public let isRestricted: Bool
        public let isManaged: Bool
        public let isLocked: Bool
        public var id: String { deviceId }
    }

    public private(set) var trustedDevices: LoadingState<[DirectoryDevice]> = .idle
    public private(set) var accountDisplayName: String?
    public private(set) var devicesEtag: String?
    /// v1.2 Phase 4 — account-type badge state read from
    /// `GET /api/users/:u`. Nil while loading or on failure;
    /// "single" / "multi" otherwise.
    public private(set) var accountType: String?
    /// Per-pod browser sessions on the user's daemon. Kept around for
    /// the existing "Browser sessions" surface; a separate section
    /// from the peer trusted devices.
    public private(set) var browserSessions: LoadingState<[PairedSessionSummary]> = .idle
    /// M4 — the pending re-pair snapshot (GET /api/users/:u/re-pair),
    /// mirroring the webapp. Drives the Trusted-devices "Replace pending"
    /// banner so a device replacement started on ANY device surfaces here
    /// with a grace countdown + a "Finalize now" entry into the existing
    /// finalize screen. nil while loading / when nothing is pending /
    /// when the endpoint is unavailable (older Worker).
    public private(set) var pendingRePair: PendingRePairSnapshot?

    private let screens: any ScreensClient
    private let server: any FlagshipServerClient
    /// Closure rather than a stored String so the VM picks up
    /// AppState.currentUser changes (e.g. after sign-out + sign-in)
    /// without a re-init.
    private let currentUsername: @MainActor () -> String?
    private let currentProfile: @MainActor () -> Profile?
    private let cacheNames: @MainActor (String, String?) -> Void
    private let now: () -> Int64
    private var directorySnapshot: AccountDirectoryResponse?

    public init(
        client: any ScreensClient,
        server: any FlagshipServerClient,
        username: @MainActor @escaping () -> String?,
        profile: @MainActor @escaping () -> Profile? = { nil },
        cacheNames: @MainActor @escaping (String, String?) -> Void = { _, _ in },
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.screens = client
        self.server = server
        self.currentUsername = username
        self.currentProfile = profile
        self.cacheNames = cacheNames
        self.now = now
    }

    public func load() async {
        browserSessions = .loading
        trustedDevices = .loading
        do {
            let ss = try await screens.pairedSessionsList()
            browserSessions = .loaded(ss.sessions)
        } catch {
            browserSessions = .failed(error.localizedDescription)
        }
        await loadTrustedDevices()
        await loadAccountType()
    }

    /// v1.2 Phase 4 — read the account-type badge state. Non-fatal:
    /// failures leave the badge as nil and the Settings row falls
    /// back to the "Single-device" default copy.
    public func loadAccountType() async {
        guard let username = currentUsername(), !username.isEmpty else {
            accountType = nil
            return
        }
        do {
            let rec = try await server.getUsernameRecord(username: username)
            accountType = rec.accountType
        } catch {
            accountType = nil
        }
    }

    /// Refresh just the trusted-devices section. Used by pull-to-
    /// refresh + after a Disconnect/Replace settles to pick up the
    /// new ETag.
    public func loadTrustedDevices() async {
        guard let username = currentUsername(), !username.isEmpty else {
            trustedDevices = .loaded([])
            pendingRePair = nil
            return
        }
        guard let profile = currentProfile(), profile.deviceId.count == 32 else {
            trustedDevices = .failed("This device has no account-scoped identity.")
            return
        }
        do {
            let umk = try await Keystore.currentUMK(reason: "View trusted devices")
            let umkData = umk.withUnsafeBytes { Data($0) }
            let deviceKey = try Keystore.accountDeviceSigningKey(
                umk: umkData,
                accountId: username,
                deviceId: profile.deviceId
            )
            let signerPubHex = HexUtil.encode(deviceKey.publicKey.rawRepresentation)
            let requestId = try AccountMetadata.generateDeviceId()
            let issuedAt = now()
            let path = "/api/accounts/\(username.lowercased())/directory"
            let canonical = AccountMetadata.canonicalDirectoryRequest(
                accountId: username,
                deviceId: profile.deviceId,
                signerPubHex: signerPubHex,
                method: "GET",
                path: path,
                requestId: requestId,
                issuedAt: issuedAt
            )
            let signature = try deviceKey.signature(for: canonical)
            let directory = try await server.accountDirectory(
                accountId: username,
                authorization: AccountDirectoryAuthorization(
                    deviceId: profile.deviceId,
                    signerPubHex: signerPubHex,
                    requestId: requestId,
                    issuedAt: issuedAt,
                    signatureHex: HexUtil.encode(Data(signature))
                )
            )
            directorySnapshot = directory
            let accountKey = try AccountMetadata.deriveAccountProfileKey(umk: umkData)
            let directoryKey = try AccountMetadata.deriveDeviceDirectoryKey(umk: umkData)
            let decryptedAccountName = directory.accountProfile.flatMap { record in
                try? AccountMetadata.decrypt(
                    ciphertext: .init(nonceHex: record.nonceHex, ciphertextHex: record.ciphertextHex),
                    keyBytes: accountKey,
                    coordinates: .init(
                        accountId: username,
                        recordType: .accountProfile,
                        revision: record.revision,
                        keyVersion: record.keyVersion
                    )
                )
            }
            accountDisplayName = decryptedAccountName

            let selfProfiles = Dictionary(uniqueKeysWithValues: directory.selfProfiles.map { ($0.deviceId, $0) })
            let managedProfiles = Dictionary(uniqueKeysWithValues: directory.managedProfiles.map { ($0.deviceId, $0) })
            let grants = Dictionary(grouping: directory.grants, by: \.deviceId)
            let presentations = directory.devices.filter { $0.revokedAt == nil }.map { device in
                let managed = managedProfiles[device.deviceId]
                let own = selfProfiles[device.deviceId]
                let encryptedName: String? = {
                    if let managed {
                        return try? AccountMetadata.decrypt(
                            ciphertext: .init(nonceHex: managed.nonceHex, ciphertextHex: managed.ciphertextHex),
                            keyBytes: directoryKey,
                            coordinates: .init(
                                accountId: username,
                                deviceId: device.deviceId,
                                recordType: .deviceManagedProfile,
                                revision: managed.revision,
                                keyVersion: managed.keyVersion
                            )
                        )
                    }
                    guard let own else { return nil }
                    return try? AccountMetadata.decrypt(
                        ciphertext: .init(nonceHex: own.nonceHex, ciphertextHex: own.ciphertextHex),
                        keyBytes: directoryKey,
                        coordinates: .init(
                            accountId: username,
                            deviceId: device.deviceId,
                            recordType: .deviceSelfProfile,
                            revision: own.revision,
                            keyVersion: own.keyVersion
                        )
                    )
                }()
                let deviceGrants = grants[device.deviceId] ?? []
                let scopeSet = deviceGrants.reduce(into: Set<String>()) { $0.formUnion($1.scopes) }
                let fallbackPlatform = Self.platformDisplay(device.platformClass)
                return DirectoryDevice(
                    deviceId: device.deviceId,
                    displayName: encryptedName ?? "\(fallbackPlatform) · Device \(device.supportCode)",
                    platformClass: device.platformClass,
                    supportCode: device.supportCode,
                    createdAt: device.createdAt,
                    lastSeenAt: device.lastSeenAt,
                    isCurrent: device.deviceId == profile.deviceId,
                    isAdministrator: scopeSet.contains("admin"),
                    isRestricted: !scopeSet.contains("view-directory"),
                    isManaged: managed != nil,
                    isLocked: managed?.locked == true
                )
            }
            trustedDevices = .loaded(presentations.sorted { $0.createdAt < $1.createdAt })
            cacheNames(decryptedAccountName ?? username, presentations.first(where: { $0.isCurrent })?.displayName)
        } catch {
            trustedDevices = .failed(error.localizedDescription)
        }
        await loadPendingRePair()
    }

    /// M4 — read the pending re-pair snapshot. Best-effort: a network /
    /// decode failure (or an older Worker, surfaced as `unavailable`)
    /// just leaves the banner hidden rather than erroring the whole
    /// section. Mirrors the webapp's try/catch-to-null.
    public func loadPendingRePair() async {
        guard let username = currentUsername(), !username.isEmpty else {
            pendingRePair = nil
            return
        }
        do {
            pendingRePair = try await server.fetchPendingRePair(username: username)
        } catch {
            pendingRePair = nil
        }
    }

    public func revoke(_ session: PairedSessionSummary) async {
        do {
            try await screens.revokePairedSession(tokenPrefix: session.tokenPrefix)
            if case .loaded(var sessions) = browserSessions {
                sessions.removeAll { $0.tokenPrefix == session.tokenPrefix }
                browserSessions = .loaded(sessions)
            }
        } catch {
            // ignore — UI shows the unchanged list until next refresh
        }
    }

    @discardableResult
    public func disconnect(_ device: DirectoryDevice) async -> Bool {
        guard let username = currentUsername(), !device.isCurrent else { return false }
        let path = "/api/accounts/\(username.lowercased())/devices/\(device.deviceId)"
        do {
            let context = try await directoryContext(method: "DELETE", path: path, reason: "Revoke this device")
            try await server.revokeAccountDevice(
                accountId: username,
                deviceId: device.deviceId,
                authorization: context.authorization
            )
            await loadTrustedDevices()
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    public func renameAccount(_ displayName: String) async -> Bool {
        guard let username = currentUsername(), let snapshot = directorySnapshot else { return false }
        let expected = snapshot.accountProfile?.revision ?? 0
        let revision = expected + 1
        let path = "/api/accounts/\(username.lowercased())/profile"
        do {
            let context = try await directoryContext(method: "PUT", path: path, reason: "Rename this account")
            let admin = try await Keystore.adminRootKey(reason: "Rename this account")
            let signerPub = HexUtil.encode(admin.publicKey.rawRepresentation)
            let ciphertext = try AccountMetadata.encrypt(
                displayName: displayName,
                keyBytes: AccountMetadata.deriveAccountProfileKey(umk: context.umk),
                coordinates: .init(accountId: username, recordType: .accountProfile, revision: revision, keyVersion: 1)
            )
            let issuedAt = now()
            let signature = try admin.signature(for: AccountMetadata.canonicalAccountProfile(
                accountId: username, revision: revision, keyVersion: 1,
                ciphertext: ciphertext, issuedAt: issuedAt, signerPubHex: signerPub
            ))
            try await server.putAccountProfile(
                accountId: username,
                authorization: context.authorization,
                body: .init(profile: .init(
                    accountId: username, revision: revision, keyVersion: 1,
                    nonceHex: ciphertext.nonceHex, ciphertextHex: ciphertext.ciphertextHex,
                    issuedAt: issuedAt, signerPubHex: signerPub,
                    signatureHex: HexUtil.encode(Data(signature))
                ), expectedRevision: expected)
            )
            await loadTrustedDevices()
            return true
        } catch { return false }
    }

    @discardableResult
    public func renameCurrentDevice(_ displayName: String) async -> Bool {
        guard let username = currentUsername(), let profile = currentProfile(), let snapshot = directorySnapshot else { return false }
        let expected = snapshot.selfProfiles.first(where: { $0.deviceId == profile.deviceId })?.revision ?? 0
        let revision = expected + 1
        let path = "/api/accounts/\(username.lowercased())/devices/\(profile.deviceId)/profile"
        do {
            let context = try await directoryContext(method: "PUT", path: path, reason: "Rename this device")
            let deviceKey = try Keystore.accountDeviceSigningKey(umk: context.umk, accountId: username, deviceId: profile.deviceId)
            let signerPub = HexUtil.encode(deviceKey.publicKey.rawRepresentation)
            let ciphertext = try AccountMetadata.encrypt(
                displayName: displayName,
                keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: context.umk),
                coordinates: .init(accountId: username, deviceId: profile.deviceId, recordType: .deviceSelfProfile, revision: revision, keyVersion: 1)
            )
            let issuedAt = now()
            let signature = try deviceKey.signature(for: AccountMetadata.canonicalDeviceSelfProfile(
                accountId: username, deviceId: profile.deviceId, revision: revision, keyVersion: 1,
                ciphertext: ciphertext, issuedAt: issuedAt, signerPubHex: signerPub
            ))
            try await server.putDeviceSelfProfile(
                accountId: username, deviceId: profile.deviceId,
                authorization: context.authorization,
                body: .init(profile: .init(
                    accountId: username, deviceId: profile.deviceId, revision: revision, keyVersion: 1,
                    nonceHex: ciphertext.nonceHex, ciphertextHex: ciphertext.ciphertextHex,
                    issuedAt: issuedAt, signerPubHex: signerPub,
                    signatureHex: HexUtil.encode(Data(signature))
                ), expectedRevision: expected)
            )
            await loadTrustedDevices()
            return true
        } catch { return false }
    }

    @discardableResult
    public func setManagedName(for deviceId: String, displayName: String, locked: Bool) async -> Bool {
        guard let username = currentUsername(), let snapshot = directorySnapshot else { return false }
        let expected = snapshot.managedProfiles.first(where: { $0.deviceId == deviceId })?.revision ?? 0
        let revision = expected + 1
        let path = "/api/accounts/\(username.lowercased())/devices/\(deviceId)/managed-profile"
        do {
            let context = try await directoryContext(method: "PUT", path: path, reason: "Manage this device name")
            let admin = try await Keystore.adminRootKey(reason: "Manage this device name")
            let signerPub = HexUtil.encode(admin.publicKey.rawRepresentation)
            let ciphertext = try AccountMetadata.encrypt(
                displayName: displayName,
                keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: context.umk),
                coordinates: .init(accountId: username, deviceId: deviceId, recordType: .deviceManagedProfile, revision: revision, keyVersion: 1)
            )
            let issuedAt = now()
            let signature = try admin.signature(for: AccountMetadata.canonicalDeviceManagedProfile(
                accountId: username, deviceId: deviceId, revision: revision, keyVersion: 1,
                ciphertext: ciphertext, locked: locked, issuedAt: issuedAt, signerPubHex: signerPub
            ))
            try await server.putDeviceManagedProfile(
                accountId: username, deviceId: deviceId,
                authorization: context.authorization,
                body: .init(profile: .init(
                    accountId: username, deviceId: deviceId, revision: revision, keyVersion: 1,
                    nonceHex: ciphertext.nonceHex, ciphertextHex: ciphertext.ciphertextHex,
                    locked: locked, issuedAt: issuedAt, signerPubHex: signerPub,
                    signatureHex: HexUtil.encode(Data(signature))
                ), expectedRevision: expected)
            )
            await loadTrustedDevices()
            return true
        } catch { return false }
    }

    @discardableResult
    public func removeManagedName(for deviceId: String) async -> Bool {
        guard let username = currentUsername(),
              let expected = directorySnapshot?.managedProfiles.first(where: { $0.deviceId == deviceId })?.revision
        else { return false }
        let path = "/api/accounts/\(username.lowercased())/devices/\(deviceId)/managed-profile"
        do {
            _ = try await Keystore.adminRootKey(reason: "Remove the managed device name")
            let context = try await directoryContext(method: "DELETE", path: path, reason: "Remove the managed device name")
            try await server.deleteDeviceManagedProfile(
                accountId: username, deviceId: deviceId,
                authorization: context.authorization, expectedRevision: expected
            )
            await loadTrustedDevices()
            return true
        } catch { return false }
    }

    private func directoryContext(method: String, path: String, reason: String) async throws -> (umk: Data, authorization: AccountDirectoryAuthorization) {
        guard let username = currentUsername(), let profile = currentProfile() else { throw Keystore.KeystoreError.keyNotFound }
        let umkKey = try await Keystore.currentUMK(reason: reason)
        let umk = umkKey.withUnsafeBytes { Data($0) }
        let deviceKey = try Keystore.accountDeviceSigningKey(umk: umk, accountId: username, deviceId: profile.deviceId)
        let signerPub = HexUtil.encode(deviceKey.publicKey.rawRepresentation)
        let requestId = try AccountMetadata.generateDeviceId()
        let issuedAt = now()
        let signature = try deviceKey.signature(for: AccountMetadata.canonicalDirectoryRequest(
            accountId: username, deviceId: profile.deviceId, signerPubHex: signerPub,
            method: method, path: path, requestId: requestId, issuedAt: issuedAt
        ))
        return (umk, AccountDirectoryAuthorization(
            deviceId: profile.deviceId, signerPubHex: signerPub, requestId: requestId,
            issuedAt: issuedAt, signatureHex: HexUtil.encode(Data(signature))
        ))
    }

    private static func platformDisplay(_ value: String?) -> String {
        switch value {
        case "ios": return "iPhone"
        case "android": return "Android"
        case "web": return "Web browser"
        case "macos": return "Mac"
        default: return "Device"
        }
    }

    // Legacy alias — older call sites read .controlDevices. Kept so
    // SettingsScreen + tests build until B5's renames land.
    public var controlDevices: LoadingState<[PairedSessionSummary]> { browserSessions }
}
