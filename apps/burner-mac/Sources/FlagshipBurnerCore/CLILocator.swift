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
        // Prefer the self-contained esbuild bundle — it runs under plain
        // `node` with zero workspace deps (the .ts entry chains to the
        // protocol's TS source, which plain node can't resolve). Build it
        // with `npm run bundle` in packages/flagship-burner.
        let workspaceRoots: [URL]
        if let exe = executableURL {
            // .build/{debug,release}/FlagshipBurner → walk up to apps/burner-mac,
            // then over to packages/flagship-burner/.
            workspaceRoots = [
                exe.deletingLastPathComponent()   // .../debug
                   .deletingLastPathComponent()   // .../.build
                   .deletingLastPathComponent()   // .../burner-mac
                   .deletingLastPathComponent(),  // .../apps
            ]
        } else {
            workspaceRoots = []
        }
        for root in workspaceRoots {
            let bundle = root.appendingPathComponent("packages/flagship-burner/dist/flagship-burn.mjs")
            searched.append(bundle.path)
            if fileManager.fileExists(atPath: bundle.path) {
                return bundle.path
            }
            // Fall back to the .ts entry (only works if the GUI is run via
            // an environment that has tsx; kept for dev convenience).
            let ts = root.appendingPathComponent("packages/flagship-burner/src/cli.ts")
            searched.append(ts.path)
            if fileManager.fileExists(atPath: ts.path) {
                return ts.path
            }
        }
        // App-bundle resources path (release packaging copies the bundle here).
        if let resURL = Bundle.main.resourceURL {
            let rBundle = resURL.appendingPathComponent("flagship-burner/flagship-burn.mjs")
            searched.append(rBundle.path)
            if fileManager.fileExists(atPath: rBundle.path) {
                return rBundle.path
            }
        }
        throw LocateError.cliEntryNotFound(searched: searched)
    }
}
