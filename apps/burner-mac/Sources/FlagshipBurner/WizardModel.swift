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

    private var currentRunner: CLIRunner? = nil

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
        return recipe != nil && iso != nil && selectedDisk != nil
    }

    var readinessSummary: String {
        var missing: [String] = []
        if recipe == nil { missing.append("Certificate") }
        if iso == nil { missing.append("ISO") }
        if selectedDisk == nil { missing.append("USB drive") }
        if missing.isEmpty {
            return "Ready: \(iso?.lastPathComponent ?? "") → \(selectedDisk?.deviceNode ?? "")"
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
        await runCLI(arguments: { entry in
            CLIArgs.verify(entryPath: entry, recipePath: recipe.path)
        }, onSuccess: { [weak self] stdoutBuf in
            guard let self = self else { return }
            if let parsed = VerifyResult.parse(jsonText: stdoutBuf) {
                self.verified = parsed
            }
        })
    }

    func runPrepare() async {
        guard let recipe = recipe, let iso = iso else { return }
        let outURL = iso.deletingLastPathComponent()
            .appendingPathComponent(iso.deletingPathExtension().lastPathComponent + ".flagship.iso")
        self.outIsoPath = outURL
        await runCLI(arguments: { entry in
            CLIArgs.prepare(entryPath: entry,
                            recipePath: recipe.path,
                            isoPath: iso.path,
                            outIsoPath: outURL.path,
                            keepRecipe: true)
        }, onSuccess: { [weak self] _ in
            guard let self = self else { return }
            self.isFinished = true
        })
    }

    /// One-click "Bake" — write the recipe + ISO directly to the
    /// selected USB device. Needs root, so we wrap the CLI invocation
    /// in `osascript do shell script with administrator privileges`,
    /// which surfaces the standard macOS Touch-ID / password prompt.
    func runWrite() async {
        guard let recipe = recipe, let iso = iso, let disk = selectedDisk else { return }
        guard !isRunning else { return }
        isRunning = true
        progress = nil
        phase = nil
        defer { isRunning = false; endProgress() }

        let resolved: CLILocator.Resolved
        do { resolved = try CLILocator.locate() }
        catch {
            appendLog(stream: .stderr, text: "CLI locate failed: \(error)")
            return
        }

        // Step 1 (UNPRIVILEGED): remaster the autoinstall ISO into a temp
        // file. This reads the recipe + source ISO in the app's context,
        // which holds the user's Downloads grant. The root step below can't
        // read protected folders (different responsible process → TCC
        // denies it), so the reads must happen here.
        phase = "remaster"
        let preparedURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flagship-prepared-\(UUID().uuidString).iso")
        let prepareArgs = CLIArgs.prepare(entryPath: resolved.entryPath,
                                          recipePath: recipe.path,
                                          isoPath: iso.path,
                                          outIsoPath: preparedURL.path,
                                          keepRecipe: true)
        appendLog(stream: .stdout, text: "+ node \(prepareArgs.joined(separator: " "))")
        let prep = CLIRunner(nodePath: resolved.nodePath, arguments: prepareArgs)
        currentRunner = prep
        do {
            for await line in try prep.start() {
                if handleControlLine(line.text) { continue }
                appendLog(stream: line.stream, text: line.text)
            }
        } catch {
            appendLog(stream: .stderr, text: "prepare spawn failed: \(error)")
            currentRunner = nil
            try? FileManager.default.removeItem(at: preparedURL)
            return
        }
        currentRunner = nil
        if prep.terminationStatus != 0 {
            appendLog(stream: .stderr, text: "prepare exited \(prep.terminationStatus)")
            try? FileManager.default.removeItem(at: preparedURL)
            return
        }
        // Clean up the prepared image whenever we leave from here on.
        defer { try? FileManager.default.removeItem(at: preparedURL) }

        // Step 2 (PRIVILEGED): hand the raw write to the signed helper
        // daemon over XPC. Unlike osascript "administrator privileges"
        // (whose process runs under the auth trampoline and can't be granted
        // disk access), a launchd daemon runs in a clean root context that
        // can open the raw device.
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
        appendLog(stream: .stdout,
                  text: "+ helper write-image \(preparedURL.lastPathComponent) → \(disk.deviceNode)")

        let conn = HelperClient.makeConnection()
        let result: (code: Int, message: String) = await withCheckedContinuation { cont in
            var resumed = false
            func finish(_ r: (Int, String)) { if !resumed { resumed = true; cont.resume(returning: r) } }
            let proxy = conn.remoteObjectProxyWithErrorHandler { err in
                finish((-1, "helper connection error: \(err.localizedDescription)"))
            } as? FlagshipHelperProtocol
            guard let proxy = proxy else { finish((-1, "could not reach the helper")); return }
            proxy.writeImage(nodePath: resolved.nodePath,
                             bundlePath: resolved.entryPath,
                             imagePath: preparedURL.path,
                             devicePath: disk.deviceNode,
                             logPath: logFile) { code, msg in finish((code, msg)) }
        }
        stopTail.value = true
        conn.invalidate()
        if result.code == 0 {
            // Single-use recipe: shred it now that the burn succeeded. The
            // app context can remove it; the root step never saw it.
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

    func cancel() {
        currentRunner?.cancel()
    }

    func clearLog() {
        logLines.removeAll()
    }

    // MARK: - Internals

    private func runCLI(arguments: (String) -> [String],
                        onSuccess: @escaping (String) -> Void) async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        let resolved: CLILocator.Resolved
        do { resolved = try CLILocator.locate() }
        catch {
            appendLog(stream: .stderr, text: "CLI locate failed: \(error)")
            return
        }
        let args = arguments(resolved.entryPath)
        appendLog(stream: .stdout, text: "+ node \(args.joined(separator: " "))")

        let runner = CLIRunner(nodePath: resolved.nodePath, arguments: args)
        currentRunner = runner
        defer { currentRunner = nil }

        var stdoutBuf = ""
        do {
            let stream = try runner.start()
            for await line in stream {
                appendLog(stream: line.stream, text: line.text)
                if line.stream == .stdout {
                    stdoutBuf += line.text + "\n"
                }
            }
        } catch {
            appendLog(stream: .stderr, text: "spawn failed: \(error)")
            return
        }
        let status = runner.terminationStatus
        if status == 0 {
            onSuccess(stdoutBuf)
        } else {
            appendLog(stream: .stderr, text: "CLI exited \(status)")
        }
    }

    private func appendLog(stream: CLILogLine.Stream, text: String) {
        // Trim trailing CR that often shows up alongside LF.
        let cleaned = text.hasSuffix("\r") ? String(text.dropLast()) : text
        logLines.append(CLILogLine(stream: stream, text: cleaned))
    }
}
