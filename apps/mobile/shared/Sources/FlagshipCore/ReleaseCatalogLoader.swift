import Foundation
import FlagshipAPI

/// Loads the release list for the "Update this server" card and sheet. Mirrors
/// the webapp's `loadReleaseCatalog` (`apps/web/public/webapp/lib/serverUpdate.js`).
public enum ReleaseCatalogLoader {

    /// Asks the box first. Boxes running code from before 2026-10-11 have no
    /// `/api/screens/updates` route and answer 404; only then, and only when the
    /// box reported a full commit, the list comes from `.com` instead. Any other
    /// box error is thrown unchanged.
    public static func load(
        screens: any ScreensClient,
        mailbox: any SecretMailboxClient,
        currentCommit: String?,
        refresh: Bool
    ) async throws -> ReleaseCatalogResponse {
        do {
            return try await screens.serverUpdates(refresh: refresh)
        } catch {
            guard case ScreensClientError.http(status: 404, _) = error,
                  let commit = currentCommit?.lowercased(),
                  ServerUpdateFlow.isValidCommit(commit) else { throw error }
            return try await mailbox.fetchReleaseCatalog(currentCommit: commit, refresh: refresh)
        }
    }
}
