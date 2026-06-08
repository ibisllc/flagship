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
    /// never part of the signed recipe.
    @Published var wifiSSID = ""
    @Published var wifiPassword = ""
    /// Advanced = remaster a stock Ubuntu/Debian ISO with a JSON recipe.
    @Published var mode: BurnerMode = .advanced

    /// Test seam: set inside `runWrite()` only on the branch that actually
    /// runs the remaster step. The model-level unit tests can assert against
    /// it without having to stub the privileged helper.
    var didRemasterForTest = false

    var phaseLabel: String? {
        switch phase {
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
            if p == "remaster" {
                progress = nil
                DockProgress.set(nil)
            } else if p == "write" {
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
        DockProgress.set(nil)
    }

    var canFlash: Bool {
        guard selectedDisk != nil else { return false }
        if mode.requiresUserISO && iso == nil { return false }
        if mode.requiresRecipe && recipe == nil { return false }
        return true
    }

    var readinessSummary: String {
        var missing: [String] = []
        if mode.requiresRecipe && recipe == nil { missing.append("Certificate") }
        if mode.requiresUserISO && iso == nil { missing.append("ISO") }
        if selectedDisk == nil { missing.append("USB drive") }
        if missing.isEmpty {
            let what = mode.requiresUserISO ? (iso?.lastPathComponent ?? "") : (verified?.serverDomain ?? "your server")
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
        let data = try Data(contentsOf: recipe)
        let parsed = try RecipeLoader.load(data: data)
        let yaml = try UserData.autoinstallYAML(recipeJSON: data,
                                                installerGitRef: parsed.installerGitRef,
                                                bootUnlockMode: parsed.effectiveBootUnlockMode,
                                                wifiSSID: wifiSSID.isEmpty ? nil : wifiSSID,
                                                wifiPassword: wifiPassword.isEmpty ? nil : wifiPassword)
        let preseed = try UserData.debianPreseed(recipeJSON: data,
                                                 installerGitRef: parsed.installerGitRef,
                                                 bootUnlockMode: parsed.effectiveBootUnlockMode,
                                                 wifiSSID: wifiSSID.isEmpty ? nil : wifiSSID,
                                                 wifiPassword: wifiPassword.isEmpty ? nil : wifiPassword)
        return (yaml, preseed)
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
    /// We first remaster the stock Ubuntu/Debian ISO with the user's JSON
    /// recipe (unprivileged — the app holds the Downloads grant; the helper
    /// can't read user folders) then hand the prepared image to the helper.
    func runWrite() async {
        guard let disk = selectedDisk else { return }
        if mode.requiresUserISO && iso == nil { return }
        if mode.requiresRecipe && recipe == nil { return }
        guard !isRunning else { return }
        isRunning = true
        progress = nil
        phase = nil
        didRemasterForTest = false
        defer { isRunning = false; endProgress() }

        // Remaster the user-supplied stock ISO with the recipe, then flash.
        let imagePath: String
        var preparedToCleanup: URL? = nil
        defer { if let p = preparedToCleanup { try? FileManager.default.removeItem(at: p) } }

        guard let iso = iso, let recipe = recipe else { return }
        phase = "remaster"
        let preparedURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flagship-prepared-\(UUID().uuidString).iso")
        do {
            let cfgs = try installerConfigs(forRecipe: recipe)
            appendLog(stream: .stdout, text: "+ remaster \(iso.lastPathComponent) → prepared image")
            let used = try await Task.detached(priority: .userInitiated) { () -> String in
                try Remaster.remasterInstaller(srcISO: iso, outISO: preparedURL,
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
