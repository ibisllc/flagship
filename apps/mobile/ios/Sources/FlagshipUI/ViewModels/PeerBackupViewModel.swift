import Foundation
import Observation
import FlagshipAPI

/// Backs the peer-backup page (docs/peer-backup.md). Peer backup is a backup
/// policy, chosen on the server's Backups section; this page only shows how it
/// is going. Loads `GET /api/screens/peer-backup/status` (the v2 screen).
@MainActor
@Observable
public final class PeerBackupViewModel {
    public private(set) var state: LoadingState<PeerBackupStatusResponse> = .idle

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            state = .loaded(try await client.peerBackupStatus())
        } catch {
            state = .failed(UserErrorText.of(error))
        }
    }

    /// A box older than the v2 screen sends only the old fields.
    public var isOlderBox: Bool {
        if case .loaded(let s) = state { return s.v != 2 }
        return false
    }

    public static func formatTime(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    /// "Server 1" with its state, last proof and pieces.
    public var holderRows: [(label: String, line: String)] {
        guard case .loaded(let s) = state else { return [] }
        return (s.holderList ?? []).map { ($0.label, PeerBackupText.holderLine($0, formatTime: Self.formatTime)) }
    }

    public var restoreByLine: String {
        guard case .loaded(let s) = state else { return "" }
        return PeerBackupText.restoreByLine(keepUntil: s.keepUntil, now: Int64(Date().timeIntervalSince1970 * 1000), formatTime: Self.formatTime)
    }

    public var hostingLines: [String] {
        guard case .loaded(let s) = state else { return [] }
        return PeerBackupText.hostingLines(s.hosting)
    }
}
