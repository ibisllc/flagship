import Foundation
import FlagshipAPI

/// A minted account read token as this device keeps it.
public struct StoredAccountReadToken: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: Int64
    public let mintedAt: Int64
    public init(token: String, expiresAt: Int64, mintedAt: Int64) {
        self.token = token
        self.expiresAt = expiresAt
        self.mintedAt = mintedAt
    }
}

/// Where read tokens live: device-local and outside biometrics (a token only
/// reads; minting one needs the account keys).
public protocol AccountReadTokenStore: Sendable {
    func load(username: String) -> StoredAccountReadToken?
    func save(_ token: StoredAccountReadToken, username: String)
    func remove(username: String)
    func removeAll()
}

public final class InMemoryAccountReadTokenStore: AccountReadTokenStore, @unchecked Sendable {
    private var tokens: [String: StoredAccountReadToken] = [:]
    private let lock = NSLock()
    public init() {}
    public func load(username: String) -> StoredAccountReadToken? {
        lock.lock(); defer { lock.unlock() }
        return tokens[username.lowercased()]
    }
    public func save(_ token: StoredAccountReadToken, username: String) {
        lock.lock(); defer { lock.unlock() }
        tokens[username.lowercased()] = token
    }
    public func remove(username: String) {
        lock.lock(); defer { lock.unlock() }
        tokens[username.lowercased()] = nil
    }
    public func removeAll() {
        lock.lock(); defer { lock.unlock() }
        tokens.removeAll()
    }
}

/// Keeps a read token for the account (docs/account-read-token.md).
///
/// It never prompts: `credentials` builds signed mint requests only from key
/// material already at hand (a stored device key, or a UMK this unlocked
/// session already holds) and returns none otherwise. A token is reused until
/// half its life has passed, then replaced whenever keys are at hand; past
/// expiry with no keys, reads go out without one and `.com` refuses them,
/// which `onPausedChanged` reports so Home can say status is paused.
public actor AccountReadTokenProvider: AccountReadTokenSource {
    private let minter: any AccountReadTokenMinting
    private let store: any AccountReadTokenStore
    private let credentials: @Sendable (String) async -> [AccountReadTokenCredential]
    private let isKeyless: @Sendable (String) async -> Bool
    private let onPausedChanged: @Sendable (Bool) -> Void
    private let now: @Sendable () -> Int64
    private let retryAfterMs: Int64
    private var inFlight: [String: Task<StoredAccountReadToken?, Never>] = [:]
    private var lastAttempt: [String: Int64] = [:]
    private var paused = false

    public init(
        minter: any AccountReadTokenMinting,
        store: any AccountReadTokenStore,
        credentials: @escaping @Sendable (String) async -> [AccountReadTokenCredential],
        isKeyless: @escaping @Sendable (String) async -> Bool = { _ in false },
        onPausedChanged: @escaping @Sendable (Bool) -> Void = { _ in },
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        retryAfterMs: Int64 = 60_000
    ) {
        self.minter = minter
        self.store = store
        self.credentials = credentials
        self.isKeyless = isKeyless
        self.onPausedChanged = onPausedChanged
        self.now = now
        self.retryAfterMs = retryAfterMs
    }

    public func token(for username: String) async -> String? {
        let u = username.lowercased()
        if await isKeyless(u) { return nil }
        let t = now()
        let stored = store.load(username: u)
        if let stored, stored.expiresAt > t {
            let halfLife = stored.mintedAt + (stored.expiresAt - stored.mintedAt) / 2
            if t < halfLife { return stored.token }
            return await mint(u)?.token ?? stored.token
        }
        return await mint(u)?.token
    }

    public func tokenAfterRejection(for username: String) async -> String? {
        let u = username.lowercased()
        if await isKeyless(u) { return nil }
        store.remove(username: u)
        guard let fresh = await mint(u) else {
            setPaused(true)
            return nil
        }
        return fresh.token
    }

    /// Forget every token: sign-out, wipe.
    public func clearAll() {
        store.removeAll()
        lastAttempt.removeAll()
        setPaused(false)
    }

    /// The owner just unlocked the account key on purpose: mint now, without
    /// waiting out a refusal's backoff. Returns whether a token is at hand.
    @discardableResult
    public func retryNow(for username: String) async -> Bool {
        let u = username.lowercased()
        if await isKeyless(u) { return true }
        lastAttempt[u] = nil
        return await mint(u) != nil
    }

    public func clear(username: String) {
        store.remove(username: username.lowercased())
        lastAttempt[username.lowercased()] = nil
    }

    /// After a refused mint, wait `retryAfterMs` before signing again, so a
    /// refusing `.com` isn't asked on every poll. Having no keys at hand is
    /// not a refusal: the next read after an unlock mints straight away.
    private func mint(_ u: String) async -> StoredAccountReadToken? {
        if let running = inFlight[u] { return await running.value }
        let t = now()
        if let last = lastAttempt[u], t - last < retryAfterMs { return nil }
        let task = Task { () -> StoredAccountReadToken? in
            let options = await credentials(u)
            guard !options.isEmpty else { return nil }
            for credential in options {
                if let minted = try? await minter.mintAccountReadToken(username: u, credential: credential) {
                    return StoredAccountReadToken(token: minted.token, expiresAt: minted.expiresAt, mintedAt: now())
                }
            }
            lastAttempt[u] = t
            return nil
        }
        inFlight[u] = task
        let result = await task.value
        inFlight[u] = nil
        if let result {
            lastAttempt[u] = nil
            store.save(result, username: u)
            setPaused(false)
        }
        return result
    }

    private func setPaused(_ value: Bool) {
        guard paused != value else { return }
        paused = value
        onPausedChanged(value)
    }
}
