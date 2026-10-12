import Foundation
import Observation
import FlagshipAPI

/// Backs the git build mode. One option: paste a repo URL → "Check repo"
/// runs the box's Flagship-fitness check → the verdict card offers either
/// "Install it" (fit) or "Use AI to prepare repo for Flagship" (not fit →
/// adapt, with a 503 fall-back to from-scratch).
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
    /// Share the adaptation with Flagship's public store, so others can
    /// install this repo without AI. Chosen on the not-ready card and sent
    /// with the adapt request; back to on for every new check.
    public var share: Bool = true
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

    /// A verdict card is up: it carries its own "Check again", so the form's
    /// "Check repo" button steps aside until the verdict clears.
    public var showsVerdict: Bool {
        if case .verdict = phase { return true }
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
        share = true
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
                BuildAdaptRequest(credential: credential, background: true, share: share)
            )
            if r.started == true {
                try await followAdapt(buildId: buildId)
            } else {
                finishAdapt(fileCount: r.fileCount ?? 0, deployedUrl: r.deployed == true ? r.deployedUrl : nil)
            }
        } catch let ScreensClientError.http(status, _) where status == 503 {
            shouldFallBackToScratch = true
        } catch let ScreensClientError.http(status, _) where status == 409 {
            // The box started the AI itself (a shared adaptation crashed and
            // it had a key): follow that run.
            do { try await followAdapt(buildId: buildId) } catch {
                failAdapt(ScreensClientError.userFacing(error))
            }
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
            // A shared adaptation that crashed here: the repo needs the
            // owner's AI now, so show the card that offers it.
            if Self.needsAdapt(error) {
                let v = BuildGitResponse(buildId: buildId, fit: false, reason: errorMessage ?? "",
                                         fileCount: lastVerdict?.fileCount ?? 0, name: assignedName)
                lastVerdict = v
                errorMessage = nil
                phase = .verdict(v)
                return
            }
            // Keep the build alive so the user can retry Install.
            phase = .adapted(fileCount: 0)
        }
    }

    /// Set once the flagship.app.json for this repo is ready to share.
    public var adapterFileURL: URL?
    public private(set) var exportingAdapter = false

    /// Fetch the file that makes this repo run the way this build does, and
    /// save it where the share sheet can hand it on.
    public func exportAdapter() async {
        guard let buildId, !exportingAdapter else { return }
        exportingAdapter = true
        defer { exportingAdapter = false }
        errorMessage = nil
        do {
            let text = try await client.buildAdapterFile(buildId: buildId)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("adapter-\(buildId)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent("flagship.app.json")
            try Data(text.utf8).write(to: url, options: .atomic)
            adapterFileURL = url
        } catch {
            errorMessage = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
        }
    }

    static func needsAdapt(_ error: Error) -> Bool {
        guard case let ScreensClientError.http(_, message) = error,
              let obj = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] else { return false }
        return obj["needsAdapt"] as? Bool == true
    }

    public func reset() {
        gitUrl = ""
        ref = ""
        name = ""
        share = true
        conflict = nil
        assignedName = nil
        phase = .idle
        errorMessage = nil
        shouldFallBackToScratch = false
        buildId = nil
        lastVerdict = nil
    }
}
