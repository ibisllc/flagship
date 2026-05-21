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

    private var currentRunner: CLIRunner? = nil

    var canFlash: Bool {
        return recipe != nil && iso != nil && selectedDisk != nil
    }

    var readinessSummary: String {
        var missing: [String] = []
        if recipe == nil { missing.append("recipe") }
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
