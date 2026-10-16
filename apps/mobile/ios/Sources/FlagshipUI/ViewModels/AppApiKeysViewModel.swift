import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

public enum AppApiKeysCopy {
    public static let sectionTitle = "API KEYS"
    public static let intro = "Let scripts, devices and other servers call this app. Each key works until you revoke it."
    public static let empty = "No API keys yet."
    public static let create = "Create key"
    public static let createTitle = "New API key"
    public static let labelPlaceholder = "What it's for, e.g. Garden sensor"
    public static let shownOnceWarning = "Copy it now. Flagship can't show it again."
    public static let readOnlyNote = "Create and revoke keys from your owner app."
    public static let noKeyReturned = "Your server didn't return the new key."
    public static let maxLabelLength = 64

    public static func usage(_ key: String) -> String { "Authorization: Bearer \(key)" }

    public static func revokeTitle(_ label: String) -> String { "Revoke \"\(label)\"?" }
    public static let revokeMessage = "Anything using this key loses access to the app right away. This can't be undone."

    /// "Read · Created Oct 1 · Last used 2h ago". Keys don't expire; a past
    /// `expiresAt` from a box still shows as "Expired …".
    public static func details(_ key: AppApiKey, now: Date = Date()) -> String {
        func date(_ ms: Int64) -> String { Date.flagshipFormatted(epochMs: ms, now: now) }
        var parts = [key.scope.label, "Created \(date(key.createdAt))"]
        parts.append(key.lastUsedAt.map { "Last used \(date($0))" } ?? "Never used")
        if let exp = key.expiresAt, key.isExpired(now: now) { parts.append("Expired \(date(exp))") }
        return parts.joined(separator: " · ")
    }

    /// The box's refusal in plain words.
    public static func message(for error: Error) -> String {
        if let e = error as? AppApiKeyOrder.Failure { return e.message }
        guard case let ScreensClientError.http(status, _) = error else {
            return ScreensClientError.userFacing(error)
        }
        let reason = ScreensClientError.boxReason(error)
        switch status {
        case 400:
            return reason.map { "Your server didn't accept this key: \($0)" } ?? "Your server didn't accept this key."
        case 403:
            let r = reason?.lowercased() ?? ""
            if r.contains("companion") || r.contains("read-only") { return readOnlyNote }
            if r.contains("stale") || r.contains("issuedat") || r.contains("clock") {
                return "Your phone's clock is more than 10 minutes off. Check the date and time, then try again."
            }
            if r.contains("different server") || r.contains("serverdomain") {
                return "This key was signed for a different server. Reload the page and try again."
            }
            if r.contains("signature") { return "Your server didn't accept this key's signature." }
            return reason ?? "Your server refused this key."
        case 404: return "This app isn't installed on this server anymore."
        case 409: return "A key with that id already exists. Try again."
        default: return ScreensClientError.plainLanguage(forStatus: status)
        }
    }
}

/// Pick a keyId → sign `flagship/app-api-key/v1` with the sensitive-order key
/// → POST. `serverDomain` is the box the client talks to (its own FQDN), not
/// the leader: the box checks the grant names itself.
public enum AppApiKeyOrder {
    public struct Failure: Error, Equatable {
        public let message: String
    }

    public static func create(
        label: String,
        scope: AppApiKeyScope,
        serviceId: String,
        appName: String,
        client: any ScreensClient,
        fallbackServerDomain: String?,
        signer: AppAccessSigner,
        now: () -> Date = Date.init,
        keyId: () -> String = AppApiKeyId.random
    ) async throws -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw Failure(message: "Give the key a name, so you know what uses it.") }
        // UTF-16 length, as the box and the webapp count it.
        guard trimmed.utf16.count <= AppApiKeysCopy.maxLabelLength else {
            throw Failure(message: "Keep the name under \(AppApiKeysCopy.maxLabelLength + 1) characters.")
        }
        let boxDomain = await client.boxDomain()
        guard let domain = boxDomain ?? fallbackServerDomain, !domain.isEmpty else {
            throw Failure(message: "No server to send this to.")
        }
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Create an API key for \(appName)")
        } catch {
            throw Failure(message: "Couldn't access your account key: \(error.localizedDescription)")
        }
        // A 409 (that keyId is taken) is retried once with a fresh one.
        for attempt in 0..<2 {
            let issuedAt = Int64(now().timeIntervalSince1970 * 1000)
            // No expiry (owner decision): a key works until it's revoked.
            let grant = AppApiKeyGrant(serverDomain: domain, serviceId: serviceId, keyId: keyId(), scope: scope,
                                       expiresAt: 0, issuedAt: issuedAt)
            let signature: Data
            do {
                signature = try key.signature(for: grant.canonicalBytes())
            } catch {
                throw Failure(message: "Couldn't sign the key: \(error.localizedDescription)")
            }
            let r: AppApiKeyCreateResponse
            do {
                r = try await client.serviceApiKeyCreate(
                    serviceId: serviceId,
                    AppApiKeyCreateRequest(grant: grant, signature: HexUtil.encode(signature), label: trimmed))
            } catch ScreensClientError.http(409, _) where attempt == 0 {
                continue
            }
            guard let secret = r.key, isKey(secret, keyId: grant.keyId) else {
                throw Failure(message: AppApiKeysCopy.noKeyReturned)
            }
            return secret
        }
        throw Failure(message: AppApiKeysCopy.message(for: ScreensClientError.http(status: 409, message: "")))
    }

    /// `fsk_<keyId>_<secret>`, the secret base64url.
    static func isKey(_ key: String, keyId: String) -> Bool {
        let prefix = "fsk_\(keyId)_"
        guard key.hasPrefix(prefix) else { return false }
        let secret = key.dropFirst(prefix.count)
        return !secret.isEmpty && secret.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "-" || $0 == "_"
        }
    }
}

/// The "API keys" section of one app's page: the keys, Create (signed, shown
/// once) and Revoke.
@Observable
@MainActor
public final class AppApiKeysController {
    /// A key the box just made: shown once, then forgotten.
    public struct CreatedKey: Equatable, Identifiable, Sendable {
        public let label: String
        public let key: String
        public var id: String { key }
        public var usage: String { AppApiKeysCopy.usage(key) }
    }

    public let serviceId: String
    public private(set) var appName: String
    public private(set) var state: LoadingState<[AppApiKey]> = .idle
    /// The box has no API keys (404 on the list, or a client without them):
    /// the page shows nothing.
    public private(set) var isHidden = false
    /// Create and Revoke (off on a restricted profile or a non-admin device:
    /// the box refuses them).
    public let canChange: Bool
    /// Why `canChange` is off, shown under the list.
    public let readOnlyNote: String
    public private(set) var isCreating = false
    public private(set) var revokingKeyId: String?
    public private(set) var errorMessage: String?
    public private(set) var createError: String?
    public private(set) var createdKey: CreatedKey?

    private let client: any ScreensClient
    private let fallbackServerDomain: String?
    private let signer: AppAccessSigner

    public init(serviceId: String, appName: String, client: any ScreensClient, serverDomain: String?,
                canChange: Bool = true, readOnlyNote: String = AppApiKeysCopy.readOnlyNote,
                signer: AppAccessSigner? = nil) {
        self.serviceId = serviceId
        self.appName = appName
        self.client = client
        self.fallbackServerDomain = serverDomain
        self.canChange = canChange
        self.readOnlyNote = readOnlyNote
        self.signer = signer ?? AppAccessOrder.defaultSigner
    }

    public var keys: [AppApiKey] { state.value ?? [] }

    public func setAppName(_ name: String) { appName = name }

    public func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await client.serviceApiKeys(serviceId: serviceId).keys
                .sorted { $0.createdAt > $1.createdAt })
            isHidden = false
        } catch {
            if Self.meansUnsupported(error) {
                isHidden = true
                state = .idle
            } else if state.value == nil {
                state = .failed(ScreensClientError.userFacing(error))
            }
        }
    }

    static func meansUnsupported(_ error: Error) -> Bool {
        switch error as? ScreensClientError {
        case .http(404, _)?, .notImplemented?: return true
        default: return false
        }
    }

    @discardableResult
    public func create(label: String, scope: AppApiKeyScope) async -> Bool {
        guard canChange, !isCreating else { return false }
        isCreating = true
        createError = nil
        defer { isCreating = false }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let secret = try await AppApiKeyOrder.create(
                label: trimmed, scope: scope, serviceId: serviceId, appName: appName,
                client: client, fallbackServerDomain: fallbackServerDomain, signer: signer)
            createdKey = CreatedKey(label: trimmed, key: secret)
            await load()
            return true
        } catch {
            createError = AppApiKeysCopy.message(for: error)
            // The box may have made a key it didn't return: show it in the list.
            if (error as? AppApiKeyOrder.Failure)?.message == AppApiKeysCopy.noKeyReturned { await load() }
            return false
        }
    }

    /// Forget the shown key (the sheet closed).
    public func dismissCreatedKey() {
        createdKey = nil
        createError = nil
    }

    @discardableResult
    public func revoke(keyId: String) async -> Bool {
        guard canChange, revokingKeyId == nil else { return false }
        revokingKeyId = keyId
        errorMessage = nil
        defer { revokingKeyId = nil }
        do {
            try await client.serviceApiKeyRevoke(serviceId: serviceId, keyId: keyId)
        } catch ScreensClientError.http(404, _) {
            // Already revoked.
        } catch {
            errorMessage = AppApiKeysCopy.message(for: error)
            return false
        }
        state = .loaded(keys.filter { $0.keyId != keyId })
        await load()
        return true
    }
}
