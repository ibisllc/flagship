import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class SettingsViewModel {
    public private(set) var tier: LoadingState<TierStatusResponse> = .idle
    /// Peer-class trusted devices on this user's account — the
    /// new "Trusted devices" section the user manages from Settings.
    /// Backed by GET /api/users/:u/devices.
    public private(set) var trustedDevices: LoadingState<[TrustedDevice]> = .idle
    /// Most-recent ETag the Worker returned. Held so the host can
    /// pass it as If-Match on Disconnect / Replace requests, fencing
    /// the device-list-changed-mid-action race (cf. A3).
    public private(set) var devicesEtag: String?
    /// Per-pod browser sessions on the user's daemon. Kept around for
    /// the existing "Browser sessions" surface; a separate section
    /// from the peer trusted devices.
    public private(set) var browserSessions: LoadingState<[PairedSessionSummary]> = .idle

    private let screens: any ScreensClient
    private let server: any FlagshipServerClient
    /// Closure rather than a stored String so the VM picks up
    /// AppState.currentUser changes (e.g. after sign-out + sign-in)
    /// without a re-init.
    private let currentUsername: @MainActor () -> String?

    public init(
        client: any ScreensClient,
        server: any FlagshipServerClient,
        username: @MainActor @escaping () -> String?
    ) {
        self.screens = client
        self.server = server
        self.currentUsername = username
    }

    public func load() async {
        tier = .loading
        browserSessions = .loading
        trustedDevices = .loading
        do {
            async let t  = screens.tierStatus()
            async let s  = screens.pairedSessionsList()
            let (ti, ss) = try await (t, s)
            tier = .loaded(ti)
            browserSessions = .loaded(ss.sessions)
        } catch {
            tier = .failed(error.localizedDescription)
            browserSessions = .failed(error.localizedDescription)
        }
        await loadTrustedDevices()
    }

    /// Refresh just the trusted-devices section. Used by pull-to-
    /// refresh + after a Disconnect/Replace settles to pick up the
    /// new ETag.
    public func loadTrustedDevices() async {
        guard let username = currentUsername(), !username.isEmpty else {
            trustedDevices = .loaded([])
            devicesEtag = nil
            return
        }
        do {
            let resp = try await server.listDevices(username: username)
            trustedDevices = .loaded(resp.devices)
            devicesEtag = resp.etag
        } catch {
            trustedDevices = .failed(error.localizedDescription)
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

    // Legacy alias — older call sites read .controlDevices. Kept so
    // SettingsScreen + tests build until B5's renames land.
    public var controlDevices: LoadingState<[PairedSessionSummary]> { browserSessions }
}
