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
        /// `progress`: the AI's latest step, from the build's journal.
        case adapting(progress: String?)
        case deploying
        /// Installed — carries the live URL.
        case installed(url: String)
    }

    public var gitUrl: String = ""
    public var ref: String = ""
    /// Optional. Blank: the box names it from the repo and branch.
    public var name: String = ""
    /// Set when "Check repo" was refused because the name is taken; the
    /// screen sends the owner to that build or asks for another name.
    public var conflict: VibeCodeNameCheck?
    /// The name the box will install it under, once the repo is checked.
    public private(set) var assignedName: String?
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

    /// The typed name as the address label it becomes.
    public var slug: String {
        name.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
    }

    /// While the repo is being cloned the form holds still.
    public var isChecking: Bool {
        if case .checking = phase { return true }
        return false
    }

    public func checkRepo() async {
        let url = gitUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        let trimmedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        let wanted = slug
        errorMessage = nil
        conflict = nil
        assignedName = nil
        buildId = nil
        phase = .checking
        do {
            let r = try await client.buildGit(
                BuildGitRequest(gitUrl: url, ref: trimmedRef.isEmpty ? nil : trimmedRef,
                                name: wanted.isEmpty ? nil : wanted)
            )
            buildId = r.buildId
            assignedName = r.name ?? (wanted.isEmpty ? nil : wanted)
            lastVerdict = r
            phase = .verdict(r)
        } catch {
            phase = .idle
            if let taken = VibeCodeNameCheck.conflict(in: error) {
                conflict = taken
                return
            }
            if case let ScreensClientError.http(status, _) = error, status == 400 || status == 422,
               let reason = ScreensClientError.boxReason(error) {
                errorMessage = reason
                return
            }
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
        phase = .adapting(progress: nil)
        do {
            let r = try await client.buildAdaptStart(
                buildId: buildId,
                BuildAdaptRequest(credential: credential, background: true)
            )
            if r.started == true {
                try await followAdapt(buildId: buildId)
            } else {
                finishAdapt(fileCount: r.fileCount ?? 0, deployedUrl: r.deployed == true ? r.deployedUrl : nil)
            }
        } catch let ScreensClientError.http(status, _) where status == 503 {
            shouldFallBackToScratch = true
        } catch {
            failAdapt(ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error))
        }
    }

    /// How often a background adapt is polled, and for how long at most.
    var pollInterval: Duration = .seconds(2)
    var pollLimit: Duration = .seconds(45 * 60)

    private func followAdapt(buildId: String) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now + pollLimit
        var misses = 0
        while clock.now < deadline {
            try await Task.sleep(for: pollInterval)
            let status: BuildAdaptStatus?
            do {
                status = try await client.buildState(buildId: buildId).state.adapt
                misses = 0
            } catch {
                // A dropped poll (Wi-Fi blip, box restarting) isn't the end.
                misses += 1
                if misses >= 5 { throw error }
                continue
            }
            switch status?.status {
            case "done":
                finishAdapt(fileCount: status?.fileCount ?? 0,
                            deployedUrl: status?.deployed == true ? status?.deployedUrl : nil)
                return
            case "failed":
                failAdapt(status?.reason ?? "The AI couldn't adapt this repo.")
                return
            default:
                if let last = try? await client.buildJournal(buildId: buildId).entries.last {
                    phase = .adapting(progress: last.summary)
                }
            }
        }
        failAdapt("The AI is taking unusually long. Check Build sessions later to see how it went.")
    }

    private func finishAdapt(fileCount: Int, deployedUrl: String?) {
        // The AI may have deployed it itself: then it's already live.
        if let url = deployedUrl { phase = .installed(url: url) } else { phase = .adapted(fileCount: fileCount) }
    }

    private func failAdapt(_ message: String) {
        // Restore the not-fit verdict so the user can retry the adapt.
        errorMessage = message
        if let v = lastVerdict { phase = .verdict(v) } else { phase = .idle }
    }

    public func deploy() async {
        guard let buildId else { return }
        errorMessage = nil
        phase = .deploying
        do {
            let r = try await client.buildDeploy(buildId: buildId)
            phase = .installed(url: r.url)
        } catch {
            errorMessage = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
            // Keep the build alive so the user can retry Install.
            phase = .adapted(fileCount: 0)
        }
    }

    public func reset() {
        gitUrl = ""
        ref = ""
        name = ""
        conflict = nil
        assignedName = nil
        phase = .idle
        errorMessage = nil
        shouldFallBackToScratch = false
        buildId = nil
        lastVerdict = nil
    }
}
