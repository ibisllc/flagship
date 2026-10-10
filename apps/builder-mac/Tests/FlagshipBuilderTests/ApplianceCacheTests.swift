import CryptoKit
import XCTest
@testable import FlagshipBuilderCore

final class ApplianceCacheTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("appliance-cache-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "qcow2", withExtension: nil)).appendingPathComponent(name)
    }

    private func sha(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }

    /// A distribution whose two parts are the split fixture image.
    private func distribution(ref: String = "main") throws -> (Data, [String: URL]) {
        let a = try fixture("fixture-compressed.qcow2.part-a"), b = try fixture("fixture-compressed.qcow2.part-b")
        let whole = try Data(contentsOf: a) + Data(contentsOf: b)
        let archiveSha = SHA256.hash(data: whole).map { String(format: "%02x", $0) }.joined()
        let rawSha = try String(contentsOf: fixture("fixture.raw.sha256"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let rawSize = try String(contentsOf: fixture("fixture.raw.size"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let json = """
        {"version":1,"arch":"arm64","installerGitRef":"\(ref)","format":"qcow2","sha256":"\(archiveSha)",
         "sizeBytes":\(whole.count),
         "parts":[{"name":"part-00","sizeBytes":\(try Data(contentsOf: a).count),"sha256":"\(try sha(a))"},
                  {"name":"part-01","sizeBytes":\(try Data(contentsOf: b).count),"sha256":"\(try sha(b))"}],
         "rawSha256":"\(rawSha)","rawSizeBytes":\(rawSize)}
        """
        return (Data(json.utf8), ["part-00": a, "part-01": b])
    }

    private final class Counter: @unchecked Sendable { var downloads = 0 }

    private func cache(manifest: Data?, status: Int = 200, parts: [String: URL],
                       corrupt: String? = nil, counter: Counter = Counter(),
                       offline: Bool = false, free: UInt64? = nil) -> ApplianceCache {
        ApplianceCache(
            arch: .arm64, origin: URL(string: "https://example.test")!, cacheRoot: root,
            fetch: { _ in
                if offline { throw URLError(.notConnectedToInternet) }
                return (manifest ?? Data(), status)
            },
            download: { remote, local in
                counter.downloads += 1
                let name = String(remote.lastPathComponent.split(separator: ".").last ?? "")
                guard let src = parts[name] else { return 404 }
                var data = try Data(contentsOf: src)
                if name == corrupt { data[0] ^= 0xff }
                try data.write(to: local)
                return 200
            },
            freeBytes: { _ in free },
            log: { _ in })
    }

    func testDownloadsVerifiesAndExpandsThenServesFromCache() async throws {
        let (manifest, parts) = try distribution()
        let counter = Counter()
        let base = try await cache(manifest: manifest, parts: parts, counter: counter).ensure(installerGitRef: "main")
        let rawSha = try String(contentsOf: fixture("fixture.raw.sha256"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(try ApplianceProvisioner.sha256OfFile(base), rawSha)
        XCTAssertEqual(counter.downloads, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: base.deletingLastPathComponent()
            .appendingPathComponent("parts").path), "parts are deleted once expanded")

        let provisioner = try ApplianceProvisioner.load(baseURL: base, expectedArch: .arm64, installerGitRef: "main")
        XCTAssertEqual(provisioner.manifest.sha256, rawSha)

        let again = try await cache(manifest: manifest, parts: parts, counter: counter).ensure(installerGitRef: "main")
        XCTAssertEqual(again, base)
        XCTAssertEqual(counter.downloads, 2, "a cached base is not downloaded again")
    }

    func testUsesTheCachedBaseWhenOffline() async throws {
        let (manifest, parts) = try distribution()
        let base = try await cache(manifest: manifest, parts: parts).ensure(installerGitRef: "main")
        let offline = try await cache(manifest: nil, parts: [:], offline: true).ensure(installerGitRef: "main")
        XCTAssertEqual(offline.resolvingSymlinksInPath(), base.resolvingSymlinksInPath())
    }

    func testRefusesACorruptPartAndRecoversOnRetry() async throws {
        let (manifest, parts) = try distribution()
        do {
            _ = try await cache(manifest: manifest, parts: parts, corrupt: "part-01").ensure(installerGitRef: "main")
            XCTFail("expected a checksum failure")
        } catch let error as ApplianceCache.CacheError {
            XCTAssertEqual(error, .checksumMismatch("part-01"))
            XCTAssertFalse(error.fallsBackToInstaller)
        }
        let counter = Counter()
        _ = try await cache(manifest: manifest, parts: parts, counter: counter).ensure(installerGitRef: "main")
        XCTAssertEqual(counter.downloads, 1, "the verified first part is kept for the retry")
    }

    func testFallsBackWhenNothingIsPublishedOrTheRefDiffers() async throws {
        let (manifest, parts) = try distribution(ref: "release-1")
        for (m, status, want) in [(Data(), 404, ApplianceCache.CacheError.unavailable(.arm64)),
                                  (manifest, 200, .refMismatch(published: "release-1", recipe: "main"))] {
            do {
                _ = try await cache(manifest: m, status: status, parts: parts).ensure(installerGitRef: "main")
                XCTFail("expected \(want)")
            } catch let error as ApplianceCache.CacheError {
                XCTAssertEqual(error, want)
                XCTAssertTrue(error.fallsBackToInstaller)
            }
        }
    }

    func testStopsBeforeDownloadingWhenTheDiskIsTooFull() async throws {
        let (manifest, parts) = try distribution()
        let counter = Counter()
        do {
            _ = try await cache(manifest: manifest, parts: parts, counter: counter, free: 1_000).ensure(installerGitRef: "main")
            XCTFail("expected insufficientSpace")
        } catch ApplianceCache.CacheError.insufficientSpace {
            XCTAssertEqual(counter.downloads, 0)
        }
    }

    func testKeyPrefixMatchesTheFactoryWorkflow() throws {
        let (manifest, _) = try distribution(ref: "feat/x y")
        let dist = try JSONDecoder().decode(ApplianceDistribution.self, from: manifest)
        XCTAssertEqual(dist.keyPrefix, "flagship-vm-appliance-arm64-feat-x-y-\(dist.sha256.prefix(12)).qcow2")
    }

    func testPublishedManifestsDecodeAndValidate() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../apps/web/public/downloads").standardizedFileURL
        for arch in IsoArch.allCases {
            let url = repo.appendingPathComponent("FlagshipVMAppliance-\(arch.rawValue).json")
            let dist = try JSONDecoder().decode(ApplianceDistribution.self, from: Data(contentsOf: url))
            XCTAssertEqual(dist.arch, arch)
            XCTAssertNoThrow(try dist.validate())
        }
    }
}
