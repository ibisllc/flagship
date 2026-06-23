import Foundation
import Observation
import FlagshipAPI

/// Backs the git build mode. One option: paste a repo URL → "Check repo"
/// runs the box's Flagship-fitness check → the verdict card offers either
/// "Install it" (fit) or "Build with AI instead" (not fit → adapt, with a
/// 503 fall-back to from-scratch).
///
/// Mirrors the canonical webapp `views/build-git.js`.
@MainActor
@Observable
public final class BuildGitViewModel {
    /// What the verdict card should render.
    public enum Phase: Equatable, Sendable {
        case idle
        case checking
        /// The box reported a fitness verdict for the cloned repo.
        case verdict(BuildGitResponse)
        /// A non-fit repo was AI-adapted and is ready to install.
        case adapted(fileCount: Int)
        case adapting
        case deploying
        /// Installed — carries the live URL.
        case installed(url: String)
    }

    public var gitUrl: String = ""
    public var ref: String = ""
    public private(set) var phase: Phase = .idle
    /// Non-nil after a recoverable failure (shown as a toast/inline note).
    public private(set) var errorMessage: String?
    /// Set true when an adapt call comes back 503 ("AI adapt not
    /// configured") so the host view can route into the scratch flow.
    public private(set) var shouldFallBackToScratch = false
    /// The build id the box assigned once "Check repo" succeeded.
    public private(set) var buildId: String?

    private var lastVerdict: BuildGitResponse?
    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public var canCheck: Bool {
        !gitUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func checkRepo() async {
        let url = gitUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        let trimmedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        phase = .checking
        do {
            let r = try await client.buildGit(
                BuildGitRequest(gitUrl: url, ref: trimmedRef.isEmpty ? nil : trimmedRef)
            )
            buildId = r.buildId
            lastVerdict = r
            phase = .verdict(r)
        } catch {
            phase = .idle
            // A 404 here means the box has no service/build platform wired —
            // the whole `/api/build/*` surface is absent, not this one repo.
            errorMessage = ScreensClientError.buildPlatformAbsent(error)
                ?? ScreensClientError.userFacing(error)
        }
    }

    /// Run the AI adapt pass on a non-fit repo. On a 503 the box has no
    /// model wired — flag the fall-back so the host pivots to scratch.
    /// `credential` is the BYOK key chosen at the AI-key step; it's delivered
    /// to the box over its own pinned pipe and never logged.
    public func adapt(credential: LlmProviderCredential? = nil) async {
        guard let buildId else { return }
        errorMessage = nil
        phase = .adapting
        do {
            let r = try await client.buildAdapt(
                buildId: buildId,
                BuildAdaptRequest(credential: credential)
            )
            phase = .adapted(fileCount: r.fileCount)
        } catch let ScreensClientError.http(status, _) where status == 503 {
            shouldFallBackToScratch = true
        } catch {
            // Restore the not-fit verdict so the user can retry the adapt.
            errorMessage = ScreensClientError.userFacing(error)
            if let v = lastVerdict { phase = .verdict(v) } else { phase = .idle }
        }
    }

    public func deploy() async {
        guard let buildId else { return }
        errorMessage = nil
        phase = .deploying
        do {
            let r = try await client.buildDeploy(buildId: buildId)
            phase = .installed(url: r.url)
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
            // Keep the build alive so the user can retry Install.
            phase = .adapted(fileCount: 0)
        }
    }

    public func reset() {
        gitUrl = ""
        ref = ""
        phase = .idle
        errorMessage = nil
        shouldFallBackToScratch = false
        buildId = nil
        lastVerdict = nil
    }
}
