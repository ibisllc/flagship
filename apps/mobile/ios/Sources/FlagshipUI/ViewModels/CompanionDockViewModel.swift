import Foundation
import Observation
import FlagshipAPI

/// P14 — backs Settings → "Dock a browser". Loads the active companion
/// list, mints a 60-second pairing ticket, and revokes individual
/// companions. The view renders the freshly-minted ticket as a QR (the
/// desktop browser scans it to become a 4-hour read-only companion).
@MainActor
@Observable
public final class CompanionDockViewModel {
    public private(set) var state: LoadingState<CompanionListResponse> = .idle
    public private(set) var mintedTicket: CompanionMintTicketResponse?
    public private(set) var mintError: String?
    public private(set) var revokePending: Set<String> = []

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            state = .loaded(try await client.companionList())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    public func mint(label: String?) async {
        mintError = nil
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = (trimmed?.isEmpty ?? true) ? nil : trimmed
        do {
            mintedTicket = try await client.companionMintTicket(
                CompanionMintTicketRequest(label: normalized)
            )
        } catch {
            mintedTicket = nil
            mintError = error.localizedDescription
        }
    }

    public func dismissMintedTicket() {
        mintedTicket = nil
    }

    public func revoke(tokenPrefix: String) async {
        revokePending.insert(tokenPrefix)
        defer { revokePending.remove(tokenPrefix) }
        do {
            _ = try await client.companionRevoke(
                CompanionRevokeRequest(tokenPrefix: tokenPrefix)
            )
            if case .loaded(let list) = state {
                state = .loaded(
                    CompanionListResponse(
                        companions: list.companions.filter { $0.tokenPrefix != tokenPrefix }
                    )
                )
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
