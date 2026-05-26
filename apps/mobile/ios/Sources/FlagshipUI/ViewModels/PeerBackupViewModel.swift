import Foundation
import Observation
import FlagshipAPI

/// P9 — backs the peer-backup management screen. Loads
/// `GET /api/screens/peer-backup/status` and routes the participation
/// toggle through `POST /api/screens/peer-backup/toggle`. Both endpoints
/// return the same `PeerBackupStatusResponse` shape, so toggle replaces
/// `state` with the freshly-served snapshot.
@MainActor
@Observable
public final class PeerBackupViewModel {
    public private(set) var state: LoadingState<PeerBackupStatusResponse> = .idle
    public private(set) var togglePending: Bool = false

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            state = .loaded(try await client.peerBackupStatus())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    public func toggle() async {
        let next: Bool
        switch state {
        case .loaded(let s): next = !s.participating
        default: next = true
        }
        togglePending = true
        defer { togglePending = false }
        do {
            state = .loaded(try await client.peerBackupToggle(participate: next))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
