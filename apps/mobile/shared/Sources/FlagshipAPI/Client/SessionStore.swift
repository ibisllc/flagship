import Foundation

/// Holds the paired pod's base URL + the 32-byte hex session token used
/// for `x-flagship-session`. Persisted across launches.
///
/// The URL lives in UserDefaults (non-secret); the token is also held
/// here in dev/mock mode. Production wires `tokenAccessor` to a Keychain
/// reader so the secret never lands on disk in plaintext.
public actor SessionStore {
    private let defaults: UserDefaults
    private let podBaseKey = "flagship.podBaseUrl"
    private let sessionTokenKey = "flagship.sessionToken"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var podBaseUrl: String? {
        defaults.string(forKey: podBaseKey)
    }

    public var sessionToken: String? {
        defaults.string(forKey: sessionTokenKey)
    }

    public func setPodBaseUrl(_ url: String?) {
        if let url { defaults.set(url, forKey: podBaseKey) }
        else { defaults.removeObject(forKey: podBaseKey) }
    }

    public func setSessionToken(_ token: String?) {
        if let token { defaults.set(token, forKey: sessionTokenKey) }
        else { defaults.removeObject(forKey: sessionTokenKey) }
    }

    public func clear() {
        defaults.removeObject(forKey: podBaseKey)
        defaults.removeObject(forKey: sessionTokenKey)
        defaults.removeObject(forKey: podTokensKey)
    }

    // MARK: - Per-pod token store (Fix B)

    private let podTokensKey = "flagship.podTokens"

    private func readPodTokens() -> [String: String] {
        guard let data = defaults.data(forKey: podTokensKey),
              let map = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return map
    }

    private func writePodTokens(_ map: [String: String]) {
        if map.isEmpty { defaults.removeObject(forKey: podTokensKey); return }
        if let data = try? JSONEncoder().encode(map) { defaults.set(data, forKey: podTokensKey) }
    }

    public func sessionToken(forPodId podId: String) -> String? {
        guard !podId.isEmpty else { return nil }
        return readPodTokens()[podId.lowercased()]
    }

    public func setSessionToken(_ token: String?, forPodId podId: String) {
        guard !podId.isEmpty else { return }
        var map = readPodTokens()
        let key = podId.lowercased()
        if let token { map[key] = token } else { map.removeValue(forKey: key) }
        writePodTokens(map)
    }

    public func podTokenIds() -> [String] {
        Array(readPodTokens().keys)
    }

    public func migrateSingleTokenToPod(_ anchorPodId: String) {
        let key = anchorPodId.lowercased()
        guard !key.isEmpty else { return }
        var map = readPodTokens()
        guard map[key] == nil else { return }                 // already attributed
        guard let legacy = defaults.string(forKey: sessionTokenKey), !legacy.isEmpty else { return }
        map[key] = legacy
        writePodTokens(map)
    }
}
