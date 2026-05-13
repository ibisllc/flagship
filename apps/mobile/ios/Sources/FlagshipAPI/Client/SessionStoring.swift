import Foundation

/// Actor-protocol that decouples LiveScreensClient from the concrete
/// session-store implementation. Both SessionStore (UserDefaults) and
/// KeychainSessionStore (Keychain) conform, so callers pick the right
/// backend without LiveScreensClient knowing.
public protocol SessionStoring: Actor {
    var podBaseUrl: String? { get }
    var sessionToken: String? { get }
    func setPodBaseUrl(_ url: String?) async
    func setSessionToken(_ token: String?) async
    func clear() async
}

extension SessionStore: SessionStoring {}
extension KeychainSessionStore: SessionStoring {}
