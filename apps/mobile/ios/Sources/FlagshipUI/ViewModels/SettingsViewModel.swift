import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class SettingsViewModel {
    public private(set) var tier: LoadingState<TierStatusResponse> = .idle
    public private(set) var controlDevices: LoadingState<[PairedSessionSummary]> = .idle

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        tier = .loading
        controlDevices = .loading
        do {
            async let t = client.tierStatus()
            async let s = client.pairedSessionsList()
            let (ti, ss) = try await (t, s)
            tier = .loaded(ti)
            controlDevices = .loaded(ss.sessions)
        } catch {
            tier = .failed(error.localizedDescription)
            controlDevices = .failed(error.localizedDescription)
        }
    }

    public func revoke(_ session: PairedSessionSummary) async {
        do {
            try await client.revokePairedSession(tokenPrefix: session.tokenPrefix)
            if case .loaded(var sessions) = controlDevices {
                sessions.removeAll { $0.tokenPrefix == session.tokenPrefix }
                controlDevices = .loaded(sessions)
            }
        } catch {
            // ignore — UI shows the unchanged list until next refresh
        }
    }
}
