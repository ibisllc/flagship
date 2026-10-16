import Foundation
import Observation
import Flagship
import FlagshipAPI

/// Backs the git build mode. One option: paste a repo URL → "Check repo"
/// runs the box's Flagship-fitness check → the verdict card offers either
/// "Install it" (fit) or "Use AI to adapt and deploy" (not fit → the AI
/// adapts and tests a private copy, then the box puts it live; a 503 falls
/// back to from-scratch).
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
        /// `stage`: the box's `adapt.phase` ("staging" | "going-live").
        case adapting(progress: String?, stage: String? = nil)
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
    /// The box handed this build to go live, so no AI may run on it again:
    /// the not-ready card offers "Check again" (a new build) instead.
    public private(set) var sealed = false
    /// The key the last adapt ran with, for "Turn the relay off for this key".
    public private(set) var adaptCredential: LlmProviderCredential?
    /// The box reported the AI run failed but kept the build's files (e.g. a
    /// restart cut it off): the card offers to run the AI again or deploy.
    public private(set) var keptFiles = false

    private var lastVerdict: BuildGitResponse?
    private let client: any ScreensClient
    private let keys: SavedKeyStore

    public init(client: any ScreensClient, keys: SavedKeyStore = SavedKeyStore()) {
        self.client = client
        self.keys = keys
    }

    /// The progress line for a running adapt.
    public static func adaptingText(stage: String?) -> String {
        switch stage {
        case "staging": return "The AI is adapting and testing the app on a private copy with sample data…"
        case "going-live": return "Installing the tested app…"
        default: return "The AI is adapting the repo…"
        }
    }

    /// The last adapt failed because its key asks for the Flagship relay and
    /// the relay wasn't there.
    public var relayFailed: Bool {
        adaptCredential != nil && RelayFailure.matches(errorMessage)
    }

    /// Turn the relay off for the key the adapt used; the owner then retries.
    public func turnRelayOffForAdaptKey() {
        guard let cred = adaptCredential else { return }
        if let entry = keys.entry(for: cred) { try? keys.setRelay(id: entry.id, relay: false) }
        adaptCredential = LlmProviderCredential(provider: cred.provider, apiKey: cred.apiKey,
                                                baseUrl: cred.baseUrl, relay: false)
        errorMessage = AiKeyRelayCopy.turnedOff
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
        sealed = false
        keptFiles = false
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
        guard let buildId, !sealed else { return }
        errorMessage = nil
        if let credential { adaptCredential = credential }
        phase = .adapting(progress: nil)
        do {
            let r = try await client.buildAdaptStart(
                buildId: buildId,
                BuildAdaptRequest(credential: credential, background: true, share: share)
            )
            if r.started == true {
                try await followAdapt(buildId: buildId)
            } else {
                finishAdapt(fileCount: r.fileCount ?? 0, deployedUrl: r.deployed == true ? r.deployedUrl : nil,
                            reason: r.reason)
            }
        } catch let ScreensClientError.http(status, _) where status == 503 {
            shouldFallBackToScratch = true
        } catch let error as ScreensClientError where Self.closedToAI(error) {
            sealed = true
            failAdapt(ScreensClientError.boxReason(error) ?? Self.closedText)
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
                let state = try await client.buildState(buildId: buildId).state
                status = state.adapt
                if state.sealed == true { sealed = true }
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
                            deployedUrl: status?.deployed == true ? status?.deployedUrl : nil,
                            reason: status?.reason)
                return
            case "failed":
                keptFiles = status?.reason != nil
                failAdapt(status?.reason ?? "The AI couldn't adapt this repo.")
                return
            default:
                let stage = status?.phase
                let last = try? await client.buildJournal(buildId: buildId).entries.last
                if case .adapting(let progress, _) = phase {
                    phase = .adapting(progress: last?.summary ?? progress, stage: stage)
                } else {
                    phase = .adapting(progress: last?.summary, stage: stage)
                }
            }
        }
        failAdapt("The AI is taking unusually long. Check Build sessions later to see how it went.")
    }

    private func finishAdapt(fileCount: Int, deployedUrl: String?, reason: String? = nil) {
        // The box put the tested app live.
        if let url = deployedUrl { phase = .installed(url: url); return }
        // It finished but the app didn't go live: say why, and offer another run.
        if let reason, !reason.isEmpty {
            failAdapt(Self.notLiveText(reason))
            return
        }
        // An older box (or no tested copy): the files are ready to install.
        phase = .adapted(fileCount: fileCount)
    }

    static let closedText = "This build is closed to the AI. Check the repo again to start a new build."

    static func notLiveText(_ reason: String) -> String {
        "The app didn't go live: \(reason)"
    }

    /// The box's 409 for a build that was handed over to go live.
    static func closedToAI(_ error: ScreensClientError) -> Bool {
        guard case let .http(status, _) = error, status == 409,
              let reason = ScreensClientError.boxReason(error) else { return false }
        return reason.hasPrefix("This build is closed to the AI")
    }

    private func failAdapt(_ message: String) {
        // Restore the not-fit verdict so the user can retry the adapt.
        errorMessage = message
        if let v = lastVerdict { phase = .verdict(v) } else { phase = .idle }
    }

    /// Open a build the box kept (Build sessions → a git build whose AI run
    /// failed, e.g. cut off by a restart): show the box's reason with the
    /// not-ready card, so the owner can run the AI again or deploy.
    public func resume(buildId id: String) async {
        reset()
        buildId = id
        phase = .checking
        do {
            let r = try await client.buildState(buildId: id)
            let st = r.state
            assignedName = st.name
            sealed = st.sealed == true
            if let a = st.adapt, a.status == "done", a.deployed == true, let url = a.deployedUrl ?? st.deployedUrl {
                phase = .installed(url: url)
                return
            }
            if let a = st.adapt, a.status == "failed" {
                let v = BuildGitResponse(buildId: id, fit: false, reason: Self.noManifestReason,
                                         fileCount: r.files.count, name: st.name)
                lastVerdict = v
                keptFiles = true
                errorMessage = a.reason ?? "The AI couldn't adapt this repo."
                phase = .verdict(v)
                return
            }
            phase = .adapted(fileCount: st.adapt?.fileCount ?? r.files.count)
        } catch {
            phase = .idle
            errorMessage = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
        }
    }

    static let noManifestReason = "no flagship.app.json"

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
        sealed = false
        keptFiles = false
        adaptCredential = nil
        lastVerdict = nil
    }
}
