import XCTest
@testable import FlagshipBurnerCore

/// Proves the macOS burner's JavaScriptCore run of the SINGLE canonical
/// preseed / user-data generator is byte-for-byte identical to Node, across the
/// shared golden vectors (`packages/flagship-burner/engine/golden/
/// preseed-vectors.json`). This is the contract that REPLACES the deleted
/// ~2,200-line Swift re-implementation of the generator + its per-string pin
/// tests (the former EngineTests generation cases). A drift guard additionally
/// asserts the shipped JS resource is identical to the canonical source.
final class PreseedEngineTests: XCTestCase {

    private struct Vector: Decodable {
        let name: String
        let recipeJson: String
        let burnOptsJson: String
        let expectedPreseed: String
        let expectedUserData: String
    }
    private struct Golden: Decodable {
        let version: Int
        let vectors: [Vector]
    }

    private func loadGolden() throws -> Golden {
        guard let url = Bundle.module.url(forResource: "preseed-vectors", withExtension: "json") else {
            throw XCTSkip("preseed-vectors.json test resource missing")
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Golden.self, from: data)
    }

    /// JavaScriptCore == Node, byte for byte, for every golden vector. The engine
    /// is driven directly via raw recipe + burnOpts JSON (the exact wire shape
    /// the canonical generator + Node golden use), so this isolates JSC fidelity
    /// from the Swift façade.
    func testEngineMatchesGoldenVectorsByteForByte() throws {
        let golden = try loadGolden()
        XCTAssertGreaterThan(golden.vectors.count, 0, "no golden vectors loaded")
        let engine = try PreseedEngine(bundleSource: PreseedEngine.loadBundledSource())

        for v in golden.vectors {
            let recipe = Data(v.recipeJson.utf8)
            let preseed = try engine.buildPreseedRaw(recipeJSON: recipe, burnOptsJson: v.burnOptsJson)
            XCTAssertEqual(preseed, v.expectedPreseed,
                           "preseed mismatch for vector '\(v.name)'")
            let userData = try engine.buildUserDataRaw(recipeJSON: recipe, burnOptsJson: v.burnOptsJson)
            XCTAssertEqual(userData, v.expectedUserData,
                           "user-data mismatch for vector '\(v.name)'")
        }
    }

    /// Drift guard: the JS the burner ships as an SPM resource must be a verbatim
    /// copy of the canonical engine bundle. A stale copy here (forgot to re-copy
    /// after `npm run bundle:engine`) would let JSC silently diverge from Node.
    func testShippedResourceMatchesCanonicalSource() throws {
        let shipped = try PreseedEngine.loadBundledSource()
        // This test file lives at apps/burner-mac/Tests/FlagshipBurnerTests/.
        // The canonical bundle is at packages/flagship-burner/engine/ from repo
        // root (four directory levels up).
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let canonicalURL = here
            .deletingLastPathComponent()      // Tests
            .deletingLastPathComponent()      // burner-mac
            .deletingLastPathComponent()      // apps
            .deletingLastPathComponent()      // repo root
            .appendingPathComponent("packages/flagship-burner/engine/preseed-engine.js")
        guard FileManager.default.fileExists(atPath: canonicalURL.path) else {
            throw XCTSkip("canonical preseed-engine.js not reachable at \(canonicalURL.path)")
        }
        let canonical = try String(contentsOf: canonicalURL, encoding: .utf8)
        XCTAssertEqual(shipped, canonical,
                       "shipped Resources/preseed-engine.js drifted from the canonical engine bundle — re-copy it")
    }

    /// The Swift façade (UserData) routes through the engine and yields the same
    /// bytes the engine produces directly. Covers the burnOpts marshalling
    /// (encryptRoot / Wi-Fi / git ref / repo / boot host).
    func testUserDataFacadeMatchesEngineForLuksAndWifi() throws {
        let golden = try loadGolden()
        let engine = try PreseedEngine(bundleSource: PreseedEngine.loadBundledSource())

        // luks-default ({} burnOpts) — the façade passes encryptRoot:true + the
        // default repo/bootHost, which the engine treats identically to {}.
        if let luks = golden.vectors.first(where: { $0.name == "luks-default" }) {
            let recipe = Data(luks.recipeJson.utf8)
            let facade = try UserData.debianPreseed(recipeJSON: recipe, installerGitRef: "")
            let direct = try engine.buildPreseedRaw(recipeJSON: recipe, burnOptsJson: "{}")
            XCTAssertEqual(facade, direct, "façade preseed diverged from engine for luks-default")
            XCTAssertEqual(facade, luks.expectedPreseed)
        }

        // wifi vector — the façade marshals wifiSSID/wifiPassword into burnOpts.
        if let wifi = golden.vectors.first(where: { $0.name == "wifi" }) {
            let recipe = Data(wifi.recipeJson.utf8)
            let yaml = try UserData.autoinstallYAML(recipeJSON: recipe,
                                                    installerGitRef: "",
                                                    wifiSSID: "myssid",
                                                    wifiPassword: "p@ss w0rd")
            XCTAssertEqual(yaml, wifi.expectedUserData, "façade user-data diverged for wifi vector")
        }
    }
}
