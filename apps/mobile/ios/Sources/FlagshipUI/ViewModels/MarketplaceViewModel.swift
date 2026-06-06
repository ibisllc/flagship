import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class MarketplaceViewModel {
    public private(set) var state: LoadingState<[MarketplaceListing]> = .idle
    public var searchQuery: String = ""

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public var filtered: [MarketplaceListing] {
        guard let listings = state.value else { return [] }
        if searchQuery.isEmpty { return listings }
        let q = searchQuery.lowercased()
        return listings.filter {
            $0.title.lowercased().contains(q)
                || $0.summary.lowercased().contains(q)
                || $0.creator.lowercased().contains(q)
        }
    }

    public func load() async {
        state = .loading
        do {
            let resp = try await client.marketplaceBrowse()
            state = .loaded(resp.listings)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
