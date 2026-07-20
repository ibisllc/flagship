import Foundation
import SwiftUI
import Combine
import Network
import FlagshipBuilderCore

/// Wizard controller — drives the CLI, tracks the user's selections,
/// publishes log lines to the view. Single source of truth for the
/// wizard's state machine.
@MainActor
final class WizardModel: ObservableObject {
    @Published var recipe: URL? = nil
    @Published var pastedRecipeStaging: URL? = nil
    @Published var iso: URL? = nil
    // LUKS-encrypted, phone-gated root is the locked DEFAULT (UserData.swift) —
    // not a user choice, so no model state / no toggle here.
    @Published var disks: [USBDisk] = []
    @Published var selectedDisk: USBDisk? = nil
    @Published var isRefreshingDisks = false
    @Published var isRunning = false
    @Published var logLines: [CLILogLine] = []
    @Published var recipeError: String? = nil
    /// User-visible failure for a burn/host operation. The log keeps the full
    /// transcript, but a collapsed log must never make a failed download look
    /// like the button simply reset itself.
    @Published var operationError: String? = nil
    @Published var verified: VerifyResult? = nil
    @Published var outIsoPath: URL? = nil
    @Published var isFinished: Bool = false
    /// 0…1 during the byte-write; nil means indeterminate (or idle).
    @Published var progress: Double? = nil
    /// Raw phase token from the CLI: "remaster" | "write".
    @Published var phase: String? = nil
    /// Optional Wi-Fi for a box with no Ethernet — a burn-time local input,
    /// never part of the signed recipe. Prefilled on launch from the persisted
    /// store (SSID in UserDefaults, password in the Keychain) and re-persisted
    /// whenever the user edits them, so they're not retyped every burn.
    @Published var wifiSSID = "" {
        didSet {
            guard !suppressWifiPersist, wifiSSID != oldValue else { return }
            WifiCredentialStore.saveSSID(wifiSSID)
        }
    }
    @Published var wifiPassword = "" {
        didSet {
            guard !suppressWifiPersist, wifiPassword != oldValue else { return }
            WifiCredentialStore.savePassword(wifiPassword)
        }
    }

    /// Set while we prefill the fields on launch so the loaded values don't
    /// immediately round-trip back through `didSet` into the store.
    private var suppressWifiPersist = false

    // MARK: - Pairing / session gate

    /// Top-level builder state. The one-shot phone deposit is the gate: `.locked`
    /// shows the QR + short code; `.pairing` shows the SAS to confirm on the
    /// phone; `.session` is the in-flight handoff and `.recipeReady` is the
    /// disconnected burn UI (Advanced available);
    /// `.recipeFile` is the out-of-band "I have a recipe" path (Simple only,
    /// no Advanced).
    enum BuilderUIStage: Equatable { case locked, pairing, session, recipeReady, recipeFile }

    @Published var builderStage: BuilderUIStage = .locked
    /// The QR payload + short code shown on the locked cover (from the engine).
    @Published var pairQrPayload: String? = nil
    @Published var pairCodeDisplay: String? = nil
    /// One-line status under the QR ("Waiting for your phone…", etc.).
    @Published var pairStatus: String = "Waiting for your phone…"
    /// The 6-digit SAS to confirm on the phone (set in `.pairing`).
    @Published var pairMatchCode: String? = nil
    /// Network reachability. The locked cover swaps its whole pairing block for a
    /// "waiting for internet connection" placeholder while this is false, and no
    /// relay session is spun up until it flips back true — so the QR can't churn
    /// against a dead network.
    @Published var isOnline: Bool = true
    private let pathMonitor = NWPathMonitor()
    /// After a recipe has been consumed by a USB/VM operation, briefly confirm
    /// the handoff before returning the center pane to a fresh pairing QR.
    @Published private(set) var homeResetCountdown: Int? = nil

    /// Advanced features stay available for a phone-delivered recipe after its
    /// one-shot session ends; the out-of-band recipe path is Simple-only.
    var advancedAllowed: Bool { builderStage == .session || builderStage == .recipeReady }

    private var sessionClient: BuilderSessionClient? = nil
    private var homeResetTask: Task<Void, Never>? = nil

    // MARK: - Destinations (Burn to USB / Host here)

    /// Where the delivered recipe goes. nil ⇒ the chooser is showing. Burn to
    /// USB is today's flow, unchanged; Host here creates a managed VM
    /// appliance on this Mac (docs/desktop-vm-appliance.md).
    @Published var destination: ServerDestination? = nil {
        didSet {
            if destination != oldValue { operationError = nil }
        }
    }

    /// Sidebar selection: when set, the main area shows that hosted server's
    /// detail instead of the wizard stage.
    @Published var selectedHostedServer: String? = nil

    /// One-shot request from a sidebar row action ("Open console" / double-click
    /// on a debug VM) to auto-open the detail pane's serial console for the named
    /// server. The detail view consumes it and clears it. Mirrors the Windows
    /// ServerRow_OpenConsole path (select the row, then flip the console toggle).
    @Published var consoleAutoOpenFor: String? = nil

    /// Hosted-VM orchestrator (inventory + lifecycles + VZ hosts).
    let vmManager = VMManager()
    private var cancellables = Set<AnyCancellable>()

    init() {
        suppressWifiPersist = true
        wifiSSID = WifiCredentialStore.loadSSID()
        wifiPassword = WifiCredentialStore.loadPassword()
        suppressWifiPersist = false
        // Nested ObservableObject: forward its changes so the sidebar/detail
        // views observing the WizardModel re-render on VM state changes.
        vmManager.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        vmManager.log = { [weak self] line in
            self?.appendLog(stream: .stdout, text: "+ \(line)")
        }
        startConnectivityMonitor()
        beginPairing()
    }

    // MARK: - Connectivity

    /// Watch network reachability. While offline we tear the pairing session
    /// down (so the QR stops churning against a dead relay) and the cover swaps
    /// to a "waiting for internet connection" placeholder; when connectivity
    /// returns we spin a fresh session back up.
    private func startConnectivityMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.handleConnectivityChange(online) }
        }
        pathMonitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    private func handleConnectivityChange(_ online: Bool) {
        guard online != isOnline else { return }
        isOnline = online
        if online {
            // Only auto-(re)start pairing from the locked/pairing cover — never
            // disturb a delivered recipe, the recipe-file path, or a live burn.
            if builderStage == .locked || builderStage == .pairing {
                beginPairing()
            }
        } else {
            // Offline — stop the connect/relock churn. The cover renders the
            // "waiting for internet connection" placeholder off `isOnline`.
            sessionClient?.close()
            sessionClient = nil
        }
    }

    // MARK: - Pairing lifecycle

    /// Spin up a fresh pairing session: new ephemeral keypair, new QR + code,
    /// connect to the relay, and wait for a phone. Called on launch and after
    /// a session drops (so the cover always shows a live, joinable code).
    func beginPairing() {
        sessionClient?.close()
        sessionClient = nil
        pairMatchCode = nil
        builderStage = .locked
        // No relay session without a network — the cover shows the "waiting for
        // internet connection" placeholder until connectivity returns, at which
        // point handleConnectivityChange calls back in. This is what stops the QR
        // from churning (fresh keypair per failed connect) while offline.
        guard isOnline else { return }
        let client = BuilderSessionClient()
        sessionClient = client
        pairQrPayload = client.qrPayload
        pairCodeDisplay = client.humanCodeDisplay
        pairStatus = "Waiting for your phone…"
        client.onStage = { [weak self] stage in Task { @MainActor in self?.applyEngineStage(stage) } }
        client.onRecipe = { [weak self] data in Task { @MainActor in self?.handleSessionRecipe(data) } }
        client.onRecipeReceiptQueued = { [weak self] in
            Task { @MainActor in
                self?.pairStatus = "Recipe received — phone session finished."
                self?.builderStage = .recipeReady
            }
        }
        client.onLog = { [weak self] msg in Task { @MainActor in self?.appendLog(stream: .stderr, text: msg) } }
        client.connect()
    }

    private func applyEngineStage(_ stage: BuilderPairingEngine.Stage) {
        switch stage {
        case .waitingForPhone:
            // Phone left before pairing — keep the SAME QR live and wait again.
            pairMatchCode = nil
            pairStatus = "Waiting for your phone…"
            builderStage = .locked
        case .awaitingConfirm(let code):
            pairMatchCode = code
            pairStatus = "Phone connected — confirm the code matches."
            builderStage = .pairing
        case .paired:
            pairStatus = "Paired."
            builderStage = .session
        case .reconnecting:
            pairStatus = "Phone left before sending the recipe — waiting for it to reconnect…"
            builderStage = .session
        case .ended(let reason):
            // One-shot deposit: a DELIVERED recipe survives a phone disconnect.
            // The phone's job is done after delivery and it may lock/leave — keep
            // the recipe + burn UI. Only an undelivered session relocks.
            switch SessionEndPolicy.onSessionEnded(recipeDelivered: recipe != nil) {
            case .keepDeliveredRecipe:
                // Drop the now-dead socket but hold everything we're burning.
                sessionClient?.close()
                sessionClient = nil
                builderStage = .recipeReady
            case .relock:
                wipeAndRelock(reason)
            }
        }
    }

    /// A recipe arrived over the live session. Stage it to a 0600 temp file
    /// (same as the paste path) and run the existing verify.
    private func handleSessionRecipe(_ data: Data) {
        let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
        let staging = tmpDir.appendingPathComponent("flagship-recipe-\(UUID().uuidString).json")
        do {
            try data.write(to: staging, options: [.atomic])
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: staging.path)
        } catch {
            appendLog(stream: .stderr, text: "Couldn't stage the received recipe: \(error.localizedDescription)")
            return
        }
        pastedRecipeStaging = staging
        recipe = staging
        Task {
            await runVerify()
            if verified != nil { sessionClient?.acknowledgeRecipe() }
        }
    }

    /// Discard the staged recipe and start over with a fresh pairing code.
    /// There is no phone connection to disconnect after the one-shot receipt.
    func startOver() {
        wipeAndRelock(nil)
    }

    /// Keep the completed handoff visible just long enough to be legible, then
    /// prepare a fresh pairing session. VM installation continues independently
    /// in VMManager and remains visible/actionable in the persistent sidebar.
    func scheduleHomeReset(after seconds: Int = 5) {
        homeResetTask?.cancel()
        let duration = max(1, seconds)
        homeResetCountdown = duration
        homeResetTask = Task { [weak self] in
            for remaining in stride(from: duration - 1, through: 0, by: -1) {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) }
                catch { return }
                guard let self, !Task.isCancelled else { return }
                self.homeResetCountdown = remaining
            }
            guard let self, !Task.isCancelled else { return }
            self.wipeAndRelock(nil)
        }
    }

    /// Complete wipe of the in-progress burn + session, then return to the
    /// locked cover with a FRESH QR (so the old code is retired). Triggered by
    /// Start over, or by a session that ended BEFORE a
    /// recipe was delivered (a delivered recipe is kept instead — see
    /// `applyEngineStage(.ended)`).
    func wipeAndRelock(_ reason: String?) {
        // Don't yank a burn that's mid-write out from under the user.
        guard !isRunning else { return }
        homeResetTask?.cancel()
        homeResetTask = nil
        homeResetCountdown = nil
        // The old yellow "session ended" cover notice is gone; keep the reason in
        // the log for diagnostics instead of surfacing a sticky banner.
        if let reason { appendLog(stream: .stderr, text: "Pairing session ended: \(reason)") }
        // Sensitive session/recipe material.
        recipe = nil
        verified = nil
        recipeError = nil
        operationError = nil
        pairMatchCode = nil
        destination = nil
        // Reset Advanced selections so a fresh pairing starts clean.
        mode = .simple
        useSystemISO = false
        iso = nil
        // Drop any staged recipe temp file from the live-session path.
        if let staging = pastedRecipeStaging {
            try? FileManager.default.removeItem(at: staging)
            pastedRecipeStaging = nil
        }
        beginPairing()
    }

    /// "I have a recipe" — the out-of-band path. No live session; Simple-only.
    func enterRecipeFileMode() {
        sessionClient?.close()
        sessionClient = nil
        mode = .simple
        useSystemISO = false
        builderStage = .recipeFile
    }

    /// Back from the recipe-file path to the pairing cover.
    func returnToCover() {
        recipe = nil
        verified = nil
        recipeError = nil
        destination = nil
        beginPairing()
    }
    /// Simple = fetch a server-named Debian base ISO + remaster it with the
    /// recipe (default). Advanced = remaster a stock Ubuntu/Debian ISO the user
    /// supplies. Both end in the same remaster+flash path.
    @Published var mode: BuilderMode = .simple

    /// Advanced-mode only: use the server-named base ISO (fetched/cached) like
    /// Simple does, instead of bringing your own ISO file. Default OFF.
    @Published var useSystemISO: Bool = false

    /// Whether the user must supply an ISO file: Advanced needs one UNLESS they
    /// opted into the system-provided ISO (then it's fetched like Simple).
    var effectiveRequiresUserISO: Bool { mode.requiresUserISO && !useSystemISO }

    /// True when the builder fetches the base ISO itself (Simple, or Advanced
    /// with "Use system-provided ISO").
    var fetchesBaseISO: Bool { mode == .simple || useSystemISO }

    /// The base-ISO URL currently being downloaded in Simple mode — surfaced
    /// under the download progress bar so the user can see exactly what's being
    /// fetched. nil when not downloading.
    @Published var baseDownloadURL: String? = nil

    /// Test seam: set inside `runWrite()` only on the branch that actually
    /// runs the remaster step. The model-level unit tests can assert against
    /// it without having to stub the privileged helper.
    var didRemasterForTest = false

    var phaseLabel: String? {
        switch phase {
        case "download": return "Downloading base image…"
        case "verify": return "Verifying base image…"
        case "remaster": return "Building image…"
        case "write": return "Writing to USB…"
        default: return nil
        }
    }

    /// Parse a machine-readable control line emitted by the CLI. Returns
    /// true if the line was consumed (so it's not shown in the log).
    func handleControlLine(_ line: String) -> Bool {
        if line.hasPrefix("FLAGSHIP_PROGRESS:") {
            progress = Double(line.dropFirst("FLAGSHIP_PROGRESS:".count))
            DockProgress.set(progress)
            return true
        }
        if line.hasPrefix("FLAGSHIP_PHASE:") {
            let p = String(line.dropFirst("FLAGSHIP_PHASE:".count))
            phase = p
            if p == "remaster" || p == "verify" {
                progress = nil
                DockProgress.set(nil)
            } else if p == "write" || p == "download" {
                progress = 0
                DockProgress.set(0)
            }
            return true
        }
        return false
    }

    private func endProgress() {
        progress = nil
        phase = nil
        baseDownloadURL = nil
        DockProgress.set(nil)
    }

    var canFlash: Bool {
        guard selectedDisk != nil else { return false }
        if effectiveRequiresUserISO && iso == nil { return false }
        if mode.requiresRecipe && recipe == nil { return false }
        return true
    }

    var readinessSummary: String {
        var missing: [String] = []
        if mode.requiresRecipe && recipe == nil { missing.append("Certificate") }
        if effectiveRequiresUserISO && iso == nil { missing.append("ISO") }
        if selectedDisk == nil { missing.append("USB drive") }
        if missing.isEmpty {
            let what = effectiveRequiresUserISO ? (iso?.lastPathComponent ?? "") : (verified?.serverDomain ?? "your server")
            return "Ready: \(what) → \(selectedDisk?.deviceNode ?? "")"
        }
        return "Need: \(missing.joined(separator: ", "))."
    }

    // MARK: - Step 1

    func acceptRecipeFile(url: URL) {
        recipeError = nil
        recipe = url
        // Auto-verify so the user gets immediate feedback.
        Task { await runVerify() }
    }

    func acceptRecipeText(_ text: String) {
        recipeError = nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            recipeError = "Pasted recipe was empty."
            return
        }
        // Stage to a temp file the CLI can read. Marked 0o600 so it isn't
        // world-readable in the user's temp dir.
        let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
        let staging = tmpDir.appendingPathComponent("flagship-recipe-\(UUID().uuidString).json")
        do {
            try trimmed.data(using: .utf8)!
                .write(to: staging, options: [.atomic])
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: 0o600)],
                ofItemAtPath: staging.path
            )
        } catch {
            recipeError = "Could not stage pasted recipe: \(error.localizedDescription)"
            return
        }
        pastedRecipeStaging = staging
        recipe = staging
        Task { await runVerify() }
    }

    // MARK: - Step 2

    func acceptISOFile(url: URL) {
        iso = url
    }

    // MARK: - Step 3

    func refreshDisks() async {
        guard !isRefreshingDisks else { return }
        isRefreshingDisks = true
        defer { isRefreshingDisks = false }
        let fetched = await Task.detached(priority: .userInitiated) { () -> [USBDisk] in
            (try? DiskEnumerator.enumerate()) ?? []
        }.value
        self.disks = fetched
        if let sel = selectedDisk, !fetched.contains(where: { $0.id == sel.id }) {
            selectedDisk = nil
        }
    }

    // MARK: - Step 4 (verify + prepare)

    func runVerify() async {
        guard let recipe = recipe else { return }
        do {
            let r = try RecipeLoader.load(contentsOf: recipe)
            verified = VerifyResult(recipe: r)
            recipeError = nil
        } catch {
            verified = nil
            recipeError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Read + verify the recipe and build BOTH unattended configs for it — the
    /// Ubuntu cloud-init user-data and the Debian d-i preseed. The remaster
    /// picks the right one for the detected ISO family; building both is cheap
    /// (pure string work) and keeps the privilege-split flow simple.
    private func installerConfigs(forRecipe recipe: URL) throws -> (yaml: String, preseed: String) {
        // The phone delivers the FULL recipe with its Advanced choices already
        // baked in — including the unsigned `debugGrant` sibling (consent-as-
        // crypto, verified box-side against the owner IRK). The builder passes the
        // recipe bytes through UNCHANGED; the preseed engine forwards whatever is
        // in `data` (debugGrant included). The builder makes no security choices.
        let data = try Data(contentsOf: recipe)
        let parsed = try RecipeLoader.load(data: data)
        // Disk encryption follows the phone-signed recipe: an explicit "none"
        // (the Wi-Fi-only fallback) leaves the root unencrypted; otherwise the
        // box LUKS-encrypts. The choice is in the signed canonical bytes, so a
        // tampered recipe can't downgrade it without failing verification.
        let encryptRoot = parsed.encryptsDisk
        let yaml = try UserData.autoinstallYAML(recipeJSON: data,
                                                installerGitRef: parsed.installerGitRef,
                                                encryptRoot: encryptRoot,
                                                bootUnlockMode: parsed.effectiveBootUnlockMode,
                                                wifiSSID: wifiSSID.isEmpty ? nil : wifiSSID,
                                                wifiPassword: wifiPassword.isEmpty ? nil : wifiPassword)
        let preseed = try UserData.debianPreseed(recipeJSON: data,
                                                 installerGitRef: parsed.installerGitRef,
                                                 encryptRoot: encryptRoot,
                                                 bootUnlockMode: parsed.effectiveBootUnlockMode,
                                                 wifiSSID: wifiSSID.isEmpty ? nil : wifiSSID,
                                                 wifiPassword: wifiPassword.isEmpty ? nil : wifiPassword)
        return (yaml, preseed)
    }

    /// Simple mode: ask the server which Debian base ISO to hold, download +
    /// verify it if ordered (or reuse the cache), and return the local ISO. The
    /// download URL is surfaced under the progress bar via `baseDownloadURL`;
    /// the boot/after-download path+sha logging happens inside IsoBaseCache.
    private func ensureBaseISO(arch: IsoArch = .amd64) async throws -> URL {
        let cache = IsoBaseCache(arch: arch, log: { [weak self] line in
            Task { @MainActor in self?.appendLog(stream: .stdout, text: "+ \(line)") }
        })
        return try await cache.ensure(progress: { [weak self] phase in
            Task { @MainActor in
                guard let self = self else { return }
                switch phase {
                case .inspected:
                    break
                case .downloading(let url, _, let p):
                    self.phase = "download"
                    self.baseDownloadURL = url
                    self.progress = p
                    DockProgress.set(p)
                case .verifying:
                    self.phase = "verify"
                    self.baseDownloadURL = nil
                    self.progress = nil
                    DockProgress.set(nil)
                case .ready:
                    // Hand off to the verify→remaster phase.
                    self.phase = "verify"
                    self.baseDownloadURL = nil
                    self.progress = nil
                    DockProgress.set(nil)
                }
            }
        })
    }

    /// Save a remastered ISO to disk for flashing elsewhere.
    func runPrepare() async {
        guard let recipe = recipe, let iso = iso else { return }
        guard !isRunning else { return }
        isRunning = true
        operationError = nil
        phase = "remaster"
        defer { isRunning = false; endProgress() }
        let outURL = iso.deletingLastPathComponent()
            .appendingPathComponent(iso.deletingPathExtension().lastPathComponent + ".flagship.iso")
        outIsoPath = outURL
        do {
            let cfgs = try installerConfigs(forRecipe: recipe)
            appendLog(stream: .stdout, text: "+ remaster \(iso.lastPathComponent) → \(outURL.lastPathComponent)")
            let used = try await Task.detached(priority: .userInitiated) { () -> String in
                try Remaster.remasterInstaller(srcISO: iso, outISO: outURL,
                                               userDataYAML: cfgs.yaml, preseedCfg: cfgs.preseed)
            }.value
            appendLog(stream: .stdout, text: "+ installer family: \(used)")
            isFinished = true
        } catch {
            reportOperationFailure(error)
        }
    }

    /// One-click "Bake".
    ///
    /// Simple: fetch the server-named Debian base ISO (cached), then remaster it
    /// with the recipe. Advanced: remaster the user-supplied stock ISO. Either
    /// way the remaster is unprivileged (the app holds the Downloads grant; the
    /// helper can't read user folders) and the prepared image is handed to the
    /// signed helper for the raw write.
    func runWrite() async {
        guard let disk = selectedDisk else { return }
        if effectiveRequiresUserISO && iso == nil { return }
        if mode.requiresRecipe && recipe == nil { return }
        guard !isRunning else { return }
        isRunning = true
        operationError = nil
        progress = nil
        phase = nil
        baseDownloadURL = nil
        didRemasterForTest = false
        defer { isRunning = false; endProgress() }

        // Give macOS a chance to grant the narrower Removable Volumes access
        // before the root helper attempts to open /dev/rdiskN. Some macOS 26
        // systems still require Full Disk Access for an SMAppService daemon;
        // that failure opens the exact settings pane below.
        HelperClient.requestRemovableVolumeAccess(for: disk.deviceNode)

        let imagePath: String
        var preparedToCleanup: URL? = nil
        defer { if let p = preparedToCleanup { try? FileManager.default.removeItem(at: p) } }

        guard let recipe = recipe else { return }

        // The ISO to remaster: fetch the server-named Debian base when we own the
        // ISO (Simple, or Advanced + "Use system-provided ISO"); otherwise use
        // the stock ISO the user supplied.
        let srcISO: URL
        if fetchesBaseISO {
            phase = "download"
            do {
                srcISO = try await ensureBaseISO()
            } catch {
                reportOperationFailure(error)
                return
            }
        } else {
            guard let iso = iso else { return }
            srcISO = iso
        }

        // Shared remaster+flash path for both modes.
        phase = "remaster"
        baseDownloadURL = nil
        progress = nil
        DockProgress.set(nil)
        let preparedURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flagship-prepared-\(UUID().uuidString).iso")
        do {
            let cfgs = try installerConfigs(forRecipe: recipe)
            appendLog(stream: .stdout, text: "+ remaster \(srcISO.lastPathComponent) → prepared image")
            let used = try await Task.detached(priority: .userInitiated) { () -> String in
                try Remaster.remasterInstaller(srcISO: srcISO, outISO: preparedURL,
                                               userDataYAML: cfgs.yaml, preseedCfg: cfgs.preseed)
            }.value
            didRemasterForTest = true
            appendLog(stream: .stdout, text: "+ installer family: \(used)")
        } catch {
            reportOperationFailure(error)
            try? FileManager.default.removeItem(at: preparedURL)
            return
        }
        preparedToCleanup = preparedURL
        imagePath = preparedURL.path

        // PRIVILEGED: the signed launchd helper does the raw write.
        do {
            try HelperClient.ensureEnabled()
        } catch {
            reportOperationFailure(error)
            return
        }

        let logFile = "/tmp/flagship-builder-\(UUID().uuidString).log"
        FileManager.default.createFile(atPath: logFile, contents: nil)
        let stopTail = Box(false)
        Task.detached {
            var lastSize: Int = 0
            while !stopTail.value {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let data = try? Data(contentsOf: URL(fileURLWithPath: logFile)),
                      data.count > lastSize else { continue }
                let new = data.subdata(in: lastSize..<data.count)
                lastSize = data.count
                if let s = String(data: new, encoding: .utf8) {
                    for line in s.split(separator: "\n", omittingEmptySubsequences: false) {
                        if line.isEmpty { continue }
                        let text = String(line)
                        await MainActor.run { [weak self] in
                            guard let self = self else { return }
                            if self.handleControlLine(text) { return }
                            self.appendLog(stream: .stdout, text: text)
                        }
                    }
                }
            }
        }
        appendLog(stream: .stdout, text: "+ helper write-image → \(disk.deviceNode)")

        let conn = HelperClient.makeConnection()
        let result: (code: Int, message: String) = await withCheckedContinuation { cont in
            var resumed = false
            func finish(_ r: (Int, String)) { if !resumed { resumed = true; cont.resume(returning: r) } }
            let proxy = conn.remoteObjectProxyWithErrorHandler { err in
                finish((-1, "helper connection error: \(err.localizedDescription)"))
            } as? FlagshipHelperProtocol
            guard let proxy = proxy else { finish((-1, "could not reach the helper")); return }
            proxy.writeImage(imagePath: imagePath,
                             devicePath: disk.deviceNode,
                             logPath: logFile) { code, msg in finish((code, msg)) }
        }
        stopTail.value = true
        conn.invalidate()
        if result.code == 0 {
            // Shred the single-use recipe file now that the burn succeeded.
            try? FileManager.default.removeItem(at: recipe)
            isFinished = true
            scheduleHomeReset()
        } else {
            if result.message.contains("Full Disk Access") {
                HelperClient.openFullDiskAccessSettings()
            }
            reportOperationFailure(result.message.isEmpty
                ? "Write failed (code \(result.code))."
                : result.message)
        }
    }

    // MARK: - Host here (VM appliance)

    /// "Host here": the SAME recipe → the SAME remastered installer ISO, but
    /// applied to a managed VM on this Mac instead of a USB stick. The guest
    /// boot chain (autoinstall → LUKS → phone-home unlock → register) runs
    /// unmodified inside the VM; this app never holds a key.
    func runHostHere() async {
        guard let recipe = recipe else { return }
        if effectiveRequiresUserISO && iso == nil { return }
        guard !isRunning else { return }
        isRunning = true
        operationError = nil
        progress = nil
        phase = nil
        baseDownloadURL = nil
        defer { isRunning = false; endProgress() }

        let parsed: Recipe
        let recipeData: Data
        do {
            recipeData = try Data(contentsOf: recipe)
            parsed = try RecipeLoader.load(data: recipeData)
        } catch {
            reportOperationFailure(error)
            return
        }

        let host = HostResources.current()
        let cap = VMResourcePlan.maxVMCount(host: host)
        guard cap > 0 else {
            reportOperationFailure("This Mac doesn't have enough free memory to host a server (each server needs ~\(VMResourcePlan.minimumVMMemoryBytes / VMResourcePlan.gib) GiB).")
            return
        }
        guard vmManager.servers.count < cap else {
            reportOperationFailure("This Mac is at its hosting limit (\(cap) server\(cap == 1 ? "" : "s")). Remove one first, or burn to USB.")
            return
        }

        let config = VMConfig.plan(recipe: parsed, recipeJSON: recipeData, host: host)

        // Same base-ISO selection as the USB path EXCEPT the arch: the guest
        // must match this Mac's silicon (Virtualization.framework boots
        // native-arch guests only), whereas a burn always targets amd64
        // boxes. Advanced BYO-ISO hosting uses the user's ISO unchanged —
        // that's the escape hatch while the server has no arm64 manifest.
        let srcISO: URL
        if fetchesBaseISO {
            phase = "download"
            do {
                srcISO = try await ensureBaseISO(arch: HostArch.current())
            } catch {
                reportOperationFailure(error)
                return
            }
        } else {
            guard let iso = iso else { return }
            srcISO = iso
        }

        // Create the bundle, then remaster the installer INTO it — identical
        // remaster to the USB path (same preseed engine, same recipe bytes).
        phase = "remaster"
        baseDownloadURL = nil
        progress = nil
        DockProgress.set(nil)
        do {
            try vmManager.createServer(config: config)
        } catch {
            reportOperationFailure(error)
            return
        }
        do {
            let cfgs = try installerConfigs(forRecipe: recipe)
            let outISO = vmManager.installerISOPath(for: config.name)
            appendLog(stream: .stdout, text: "+ remaster \(srcISO.lastPathComponent) → VM installer")
            let used = try await Task.detached(priority: .userInitiated) { () -> String in
                try Remaster.remasterInstaller(srcISO: srcISO, outISO: outISO,
                                               userDataYAML: cfgs.yaml, preseedCfg: cfgs.preseed)
            }.value
            didRemasterForTest = true
            appendLog(stream: .stdout, text: "+ installer family: \(used)")
        } catch {
            reportOperationFailure(error)
            await vmManager.deleteServer(named: config.name)
            return
        }

        // Shred the single-use recipe, exactly like a successful USB burn.
        try? FileManager.default.removeItem(at: recipe)
        await vmManager.beginInstall(named: config.name)
        scheduleHomeReset()
    }

    private final class Box<T> {
        var value: T
        init(_ value: T) { self.value = value }
    }

    private func reportOperationFailure(_ error: Error) {
        reportOperationFailure((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
    }

    private func reportOperationFailure(_ message: String) {
        operationError = message
        appendLog(stream: .stderr, text: message)
    }

    func clearLog() {
        logLines.removeAll()
    }

    private func appendLog(stream: CLILogLine.Stream, text: String) {
        // Trim trailing CR that often shows up alongside LF.
        let cleaned = text.hasSuffix("\r") ? String(text.dropLast()) : text
        logLines.append(CLILogLine(stream: stream, text: cleaned))
    }
}
