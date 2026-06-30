import Foundation
import SwiftUI
import FlagshipBurnerCore

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

    /// Top-level burner state. The live phone session is the gate: `.locked`
    /// shows the QR + short code; `.pairing` shows the SAS to confirm on the
    /// phone; `.session` is the unlocked burn UI (Advanced available);
    /// `.recipeFile` is the out-of-band "I have a recipe" path (Simple only,
    /// no Advanced — there's no live session to authorize anything).
    enum BurnerUIStage: Equatable { case locked, pairing, session, recipeFile }

    @Published var burnerStage: BurnerUIStage = .locked
    /// The QR payload + short code shown on the locked cover (from the engine).
    @Published var pairQrPayload: String? = nil
    @Published var pairCodeDisplay: String? = nil
    /// One-line status under the QR ("Waiting for your phone…", etc.).
    @Published var pairStatus: String = "Waiting for your phone…"
    /// The 6-digit SAS to confirm on the phone (set in `.pairing`).
    @Published var pairMatchCode: String? = nil
    /// Why the last session ended (shown briefly on the cover after a drop).
    @Published var lastSessionEndReason: String? = nil
    /// True while the phone has stepped away after pairing and we're holding
    /// the prepared burn, waiting for it to reconnect. The session UI stays
    /// up (you can still finish the burn); a banner explains the wait.
    @Published var isReconnecting: Bool = false
    /// Session auto-lock deadline (from the relay). Drives the countdown shown
    /// next to the "Disconnect from phone" button.
    @Published var sessionExpiresAt: Date? = nil

    /// Advanced features (BYO ISO, debug, embed-secrets, save-ISO) are only
    /// available inside a live phone session — the out-of-band recipe path
    /// is deliberately Simple-only.
    var advancedAllowed: Bool { burnerStage == .session }

    private var sessionClient: BurnerSessionClient? = nil

    init() {
        suppressWifiPersist = true
        wifiSSID = WifiCredentialStore.loadSSID()
        wifiPassword = WifiCredentialStore.loadPassword()
        suppressWifiPersist = false
        beginPairing()
    }

    // MARK: - Pairing lifecycle

    /// Spin up a fresh pairing session: new ephemeral keypair, new QR + code,
    /// connect to the relay, and wait for a phone. Called on launch and after
    /// a session drops (so the cover always shows a live, joinable code).
    func beginPairing() {
        sessionClient?.close()
        let client = BurnerSessionClient()
        sessionClient = client
        pairQrPayload = client.qrPayload
        pairCodeDisplay = client.humanCodeDisplay
        pairMatchCode = nil
        pairStatus = "Waiting for your phone…"
        burnerStage = .locked
        isReconnecting = false
        sessionExpiresAt = nil
        client.onStage = { [weak self] stage in Task { @MainActor in self?.applyEngineStage(stage) } }
        client.onRecipe = { [weak self] data in Task { @MainActor in self?.handleSessionRecipe(data) } }
        client.onLog = { [weak self] msg in Task { @MainActor in self?.appendLog(stream: .stderr, text: msg) } }
        client.onExpiresAt = { [weak self] ms in
            Task { @MainActor in self?.sessionExpiresAt = Date(timeIntervalSince1970: ms / 1000) }
        }
        client.onConsentGranted = { [weak self] setting, grantJSON in
            Task { @MainActor in self?.applyConsentGranted(setting: setting, grantJSON: grantJSON) }
        }
        client.onConsentDenied = { [weak self] setting in
            Task { @MainActor in self?.applyConsentDenied(setting: setting) }
        }
        client.connect()
    }

    // MARK: - Advanced consent (debug)

    /// The signed debug-access grant the phone returned (embedded at flash).
    @Published var debugGrantJSON: String? = nil
    /// True while we're waiting for the phone to approve the Debug toggle.
    @Published var debugConsentPending: Bool = false

    /// Whether debug is armed (a valid grant is in hand to embed).
    var debugArmed: Bool { debugGrantJSON != nil }

    /// User flipped the Advanced "Debug mode" toggle. ON ⇒ ask the phone to
    /// approve (it shows a security warning + Face ID and returns a signed
    /// grant). OFF ⇒ drop the grant. Only meaningful in a live session.
    func setDebugRequested(_ on: Bool) {
        guard burnerStage == .session else { return }
        if !on { debugGrantJSON = nil; debugConsentPending = false; return }
        guard let domain = verified?.serverDomain else { return }
        debugConsentPending = true
        sessionClient?.requestConsent(
            setting: "debug",
            serverDomain: domain,
            warning: "Turning on debug lets someone log into this server's console. Only approve this for a box you're actively debugging.")
    }

    private func applyConsentGranted(setting: String, grantJSON: String) {
        guard setting == "debug" else { return }
        debugGrantJSON = grantJSON
        debugConsentPending = false
    }

    private func applyConsentDenied(setting: String) {
        guard setting == "debug" else { return }
        debugGrantJSON = nil
        debugConsentPending = false
    }

    private func applyEngineStage(_ stage: BurnerPairingEngine.Stage) {
        switch stage {
        case .waitingForPhone:
            // Phone left before pairing — keep the SAME QR live and wait again.
            isReconnecting = false
            pairMatchCode = nil
            pairStatus = "Waiting for your phone…"
            burnerStage = .locked
        case .awaitingConfirm(let code):
            isReconnecting = false
            pairMatchCode = code
            pairStatus = "Phone connected — confirm the code matches."
            burnerStage = .pairing
        case .paired:
            isReconnecting = false
            pairStatus = "Paired."
            burnerStage = .session
        case .reconnecting:
            // Phone stepped away after pairing. HOLD the burn — don't wipe.
            // Keep the session UI up so the burn can still be finished.
            isReconnecting = true
            pairStatus = "Phone disconnected — waiting for it to reconnect…"
        case .ended(let reason):
            wipeAndRelock(reason, notifyPhone: false)
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
        Task { await runVerify() }
    }

    /// The burner-side "Disconnect from phone" button: wipe everything we were
    /// working on and return to a fresh locked cover. Use it to clear the
    /// desktop before walking away even without the phone in hand. Tells the
    /// phone (best-effort) so it wipes its half too.
    func disconnectFromPhone() {
        wipeAndRelock("You disconnected this burner.", notifyPhone: true)
    }

    /// Complete wipe of the in-progress burn + session, then return to the
    /// locked cover with a FRESH QR (so the old code is retired). Triggered on
    /// an explicit disconnect, the session time-limit, or a phone-initiated
    /// end. A transient phone drop does NOT come here — that's `.reconnecting`.
    func wipeAndRelock(_ reason: String?, notifyPhone: Bool) {
        // Don't yank a burn that's mid-write out from under the user.
        guard !isRunning else { return }
        if notifyPhone { sessionClient?.sendSessionEnded() }
        lastSessionEndReason = reason
        // Sensitive session/recipe material.
        recipe = nil
        verified = nil
        recipeError = nil
        pairMatchCode = nil
        debugGrantJSON = nil
        debugConsentPending = false
        // Reset Advanced selections so a fresh pairing starts clean.
        mode = .simple
        debugMode = false
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
        debugMode = false
        useSystemISO = false
        burnerStage = .recipeFile
    }

    /// Back from the recipe-file path to the pairing cover.
    func returnToCover() {
        recipe = nil
        verified = nil
        recipeError = nil
        beginPairing()
    }
    /// Simple = fetch a server-named Debian base ISO + remaster it with the
    /// recipe (default). Advanced = remaster a stock Ubuntu/Debian ISO the user
    /// supplies. Both end in the same remaster+flash path.
    @Published var mode: BurnerMode = .simple

    /// DEBUG build toggle (default OFF). On ⇒ the burned image keeps the
    /// `debug`/`flagship` sudo console account + the "DEBUG BUILD" banner. Off ⇒
    /// a production image with neither. The ONLY way to get those debug features.
    @Published var debugMode: Bool = false

    /// Debug is an ADVANCED-only feature (the checkbox is hidden in Simple), so
    /// the flag only ever takes effect in Advanced — a Simple burn is always a
    /// production image even if the flag was left on from an earlier Advanced run.
    var effectiveDebugMode: Bool { debugMode && mode == .advanced }

    /// Advanced-mode only: use the server-named base ISO (fetched/cached) like
    /// Simple does, instead of bringing your own ISO file. Default OFF.
    @Published var useSystemISO: Bool = false

    /// Whether the user must supply an ISO file: Advanced needs one UNLESS they
    /// opted into the system-provided ISO (then it's fetched like Simple).
    var effectiveRequiresUserISO: Bool { mode.requiresUserISO && !useSystemISO }

    /// True when the burner fetches the base ISO itself (Simple, or Advanced
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
        var data = try Data(contentsOf: recipe)
        // Debug access is consent-as-crypto: when the phone approved the Debug
        // toggle it returned a signed grant. Embed it as the recipe's UNSIGNED
        // `debugGrant` sibling (mirrors swkHex/pairingOrder); the box-side gate
        // verifies it against the owner IRK and enables the debug user from it.
        // We do NOT bake the debug user into the preseed (debugMode: false) —
        // the daemon is the single, owner-authorized enabler.
        if let grant = debugGrantJSON,
           var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            obj["debugGrant"] = grant
            if let merged = try? JSONSerialization.data(withJSONObject: obj) { data = merged }
        }
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
                                                wifiPassword: wifiPassword.isEmpty ? nil : wifiPassword,
                                                debugMode: false)
        let preseed = try UserData.debianPreseed(recipeJSON: data,
                                                 installerGitRef: parsed.installerGitRef,
                                                 encryptRoot: encryptRoot,
                                                 bootUnlockMode: parsed.effectiveBootUnlockMode,
                                                 wifiSSID: wifiSSID.isEmpty ? nil : wifiSSID,
                                                 wifiPassword: wifiPassword.isEmpty ? nil : wifiPassword,
                                                 debugMode: false)
        return (yaml, preseed)
    }

    /// Simple mode: ask the server which Debian base ISO to hold, download +
    /// verify it if ordered (or reuse the cache), and return the local ISO. The
    /// download URL is surfaced under the progress bar via `baseDownloadURL`;
    /// the boot/after-download path+sha logging happens inside IsoBaseCache.
    private func ensureBaseISO() async throws -> URL {
        let cache = IsoBaseCache(log: { [weak self] line in
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
            appendLog(stream: .stderr, text: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
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
        progress = nil
        phase = nil
        baseDownloadURL = nil
        didRemasterForTest = false
        defer { isRunning = false; endProgress() }

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
                appendLog(stream: .stderr, text: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
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
            appendLog(stream: .stderr, text: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            try? FileManager.default.removeItem(at: preparedURL)
            return
        }
        preparedToCleanup = preparedURL
        imagePath = preparedURL.path

        // PRIVILEGED: the signed launchd helper does the raw write.
        do {
            try HelperClient.ensureEnabled()
        } catch {
            appendLog(stream: .stderr,
                      text: (error as? LocalizedError)?.errorDescription ?? "\(error)")
            return
        }

        let logFile = "/tmp/flagship-burner-\(UUID().uuidString).log"
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
        } else {
            appendLog(stream: .stderr,
                      text: result.message.isEmpty ? "write failed (code \(result.code))" : result.message)
        }
    }

    private final class Box<T> {
        var value: T
        init(_ value: T) { self.value = value }
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
