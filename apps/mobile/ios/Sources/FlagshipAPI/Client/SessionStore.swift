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
    }
}
