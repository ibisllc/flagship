import XCTest
@testable import FlagshipBurnerCore

final class CLIArgsTests: XCTestCase {

    func testVerify() {
        let a = CLIArgs.verify(entryPath: "/p/cli.ts", recipePath: "/r.json")
        XCTAssertEqual(a, ["/p/cli.ts", "verify", "/r.json"])
    }

    func testUserDataDefault() {
        let a = CLIArgs.userData(entryPath: "/p/cli.ts",
                                 recipePath: "/r.json",
                                 outPath: "/out.yaml",
                                 keepRecipe: false)
        XCTAssertEqual(a, ["/p/cli.ts", "user-data", "/r.json", "/out.yaml"])
    }

    func testUserDataKeepRecipe() {
        let a = CLIArgs.userData(entryPath: "/p/cli.ts",
                                 recipePath: "/r.json",
                                 outPath: "/out.yaml",
                                 keepRecipe: true)
        XCTAssertEqual(a, ["/p/cli.ts", "user-data", "/r.json", "/out.yaml", "--keep-recipe"])
    }

    func testPrepareKeepRecipe() {
        let a = CLIArgs.prepare(entryPath: "/p/cli.ts",
                                recipePath: "/r.json",
                                isoPath: "/in.iso",
                                outIsoPath: "/out.iso",
                                keepRecipe: true)
        XCTAssertEqual(a, ["/p/cli.ts", "prepare", "/r.json", "/in.iso", "/out.iso", "--keep-recipe"])
    }
}

final class CLILocatorTests: XCTestCase {

    func testFindNodeRespectsEnvOverride() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fake-node-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        FileManager.default.createFile(atPath: tmp.path, contents: Data("#!/bin/sh\necho hi\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: tmp.path)

        let env = ["FLAGSHIP_NODE_PATH": tmp.path]
        let resolved = try CLILocator.findNode(fileManager: .default, environment: env)
        XCTAssertEqual(resolved, tmp.path)
    }

    func testFindNodeFallsBackToKnownLocations() {
        // We can't promise where node lives on a given dev box, so the
        // test is only meaningful if at least one of the standard
        // homebrew/usr paths has a node executable. Skip silently otherwise.
        let env: [String: String] = [:]
        do {
            let r = try CLILocator.findNode(fileManager: .default, environment: env)
            XCTAssertTrue(r.hasPrefix("/"))
            XCTAssertTrue(FileManager.default.isExecutableFile(atPath: r))
        } catch CLILocator.LocateError.nodeNotFound(let searched) {
            XCTAssertFalse(searched.isEmpty)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testFindEntryRespectsEnvOverride() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fake-entry-\(UUID().uuidString).ts")
        defer { try? FileManager.default.removeItem(at: tmp) }
        FileManager.default.createFile(atPath: tmp.path, contents: Data("// fake\n".utf8))
        let env = ["FLAGSHIP_BURN_ENTRY": tmp.path]
        let resolved = try CLILocator.findEntry(
            fileManager: .default,
            environment: env,
            executableURL: nil
        )
        XCTAssertEqual(resolved, tmp.path)
    }

    func testFindEntryThrowsWhenNothingFound() {
        // Use a tmp dir as the fake executable URL so the walk-up doesn't
        // accidentally land in the actual flagship checkout.
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("nowhere-\(UUID().uuidString)/.build/debug")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir.deletingLastPathComponent().deletingLastPathComponent()) }
        let fakeExe = tmpDir.appendingPathComponent("FlagshipBurner")
        FileManager.default.createFile(atPath: fakeExe.path, contents: Data())

        // Drop Bundle.main resourceURL by overriding the environment too.
        XCTAssertThrowsError(try CLILocator.findEntry(
            fileManager: .default,
            environment: [:],
            executableURL: fakeExe
        ))
    }
}
