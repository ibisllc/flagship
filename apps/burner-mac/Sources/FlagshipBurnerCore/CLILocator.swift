import Foundation

/// Find the bundled `flagship-burn` CLI entry point. The CLI is a Node
/// program, so we resolve to the .ts (dev) or .js (production) entry +
/// the absolute path of `node`. The GUI shells out to `node <entry>`.
///
/// Resolution order (first hit wins):
///   1. env var `FLAGSHIP_BURN_ENTRY` — for dev overrides / tests
///   2. ../../packages/flagship-burner/src/cli.ts relative to the
///      executable (dev path when run via `swift run` from `apps/burner-mac`)
///   3. Bundle.main resources/flagship-burner/src/cli.ts
///
/// The "user must have node installed" caveat lives in README.md. We do
/// NOT bundle a Node runtime in Phase 2.
public enum CLILocator {

    public struct Resolved: Equatable, Sendable {
        public let nodePath: String
        public let entryPath: String
        public init(nodePath: String, entryPath: String) {
            self.nodePath = nodePath
            self.entryPath = entryPath
        }
    }

    public enum LocateError: Error, Equatable {
        case nodeNotFound(searched: [String])
        case cliEntryNotFound(searched: [String])
    }

    public static func locate(fileManager: FileManager = .default,
                              environment: [String: String] = ProcessInfo.processInfo.environment,
                              executableURL: URL? = Bundle.main.executableURL) throws -> Resolved {
        let node = try findNode(fileManager: fileManager, environment: environment)
        let entry = try findEntry(fileManager: fileManager, environment: environment, executableURL: executableURL)
        return Resolved(nodePath: node, entryPath: entry)
    }

    static func findNode(fileManager: FileManager, environment: [String: String]) throws -> String {
        if let override = environment["FLAGSHIP_NODE_PATH"], fileManager.isExecutableFile(atPath: override) {
            return override
        }
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        for c in candidates where fileManager.isExecutableFile(atPath: c) {
            return c
        }
        // Last-ditch: PATH lookup via `/usr/bin/env`. We don't shell out
        // here — we just record where we looked so the error is honest.
        throw LocateError.nodeNotFound(searched: candidates)
    }

    static func findEntry(fileManager: FileManager,
                          environment: [String: String],
                          executableURL: URL?) throws -> String {
        if let override = environment["FLAGSHIP_BURN_ENTRY"], fileManager.fileExists(atPath: override) {
            return override
        }
        var searched: [String] = []
        if let exe = executableURL {
            // .build/{debug,release}/FlagshipBurner -> walk up to apps/burner-mac,
            // then over to packages/flagship-burner/src/cli.ts.
            let candidate = exe
                .deletingLastPathComponent()        // .../debug
                .deletingLastPathComponent()        // .../.build
                .deletingLastPathComponent()        // .../burner-mac
                .deletingLastPathComponent()        // .../apps
                .appendingPathComponent("packages/flagship-burner/src/cli.ts")
            searched.append(candidate.path)
            if fileManager.fileExists(atPath: candidate.path) {
                return candidate.path
            }
        }
        // App-bundle resources path (Phase 2 packaging will copy the CLI here).
        if let resURL = Bundle.main.resourceURL {
            let r = resURL.appendingPathComponent("flagship-burner/src/cli.ts")
            searched.append(r.path)
            if fileManager.fileExists(atPath: r.path) {
                return r.path
            }
            let rJS = resURL.appendingPathComponent("flagship-burner/dist/cli.js")
            searched.append(rJS.path)
            if fileManager.fileExists(atPath: rJS.path) {
                return rJS.path
            }
        }
        throw LocateError.cliEntryNotFound(searched: searched)
    }
}
