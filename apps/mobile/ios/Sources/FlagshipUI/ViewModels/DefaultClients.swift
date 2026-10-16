import Foundation
import FlagshipAPI

/// What a view model uses when its caller doesn't hand it a client. The app
/// always passes its own; these only decide what an unwired caller gets:
/// the real thing in Release builds, the in-process mock in Debug builds
/// (unit tests and the gym), which are the only builds with mocks in them.
public enum DefaultClients {
    public static func webAuthn() -> WebAuthnProvider {
        #if DEBUG
        MockWebAuthnProvider()
        #else
        PlatformWebAuthnProvider()
        #endif
    }

    public static func secretMailbox() -> any SecretMailboxClient {
        #if DEBUG
        MockSecretMailboxClient()
        #else
        LiveSecretMailboxClient()
        #endif
    }

    public static func serviceUninstall() -> any ServiceUninstallClient {
        #if DEBUG
        MockServiceUninstallClient()
        #else
        LiveServiceUninstallClient(urlSession: .shared)
        #endif
    }
}
