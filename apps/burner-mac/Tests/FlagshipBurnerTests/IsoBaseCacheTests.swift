import XCTest
import CryptoKit
@testable import FlagshipBurnerCore

/// Box for values mutated from the cache's @Sendable progress closure (which
/// runs synchronously inside `ensure()`, so there is no actual race).
private final class Captured<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

final class IsoBaseCacheTests: XCTestCase {

    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flagship-base-cache-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func writeCachedBase(version: String, arch: IsoArch = .amd64, body: Data) -> URL {
        let prefix = arch == .amd64 ? "flagship-base-" : "flagship-base-\(arch.rawValue)-"
        let url = tmpDir.appendingPathComponent("\(prefix)\(version).iso")
        try? body.write(to: url)
        return url
    }

    private func makeCache(arch: IsoArch = .amd64) -> IsoBaseCache {
        let session = StubURLProtocol.makeSession()
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint, session: session)
        return IsoBaseCache(client: client,
                            burnerVersion: "test",
                            arch: arch,
                            downloadSession: session,
                            cacheDirOverride: tmpDir,
                            log: { _ in })
    }

    private func manifestJSON(download: (url: String, sha: String, version: String, size: Int)?) -> Data {
        if let d = download {
            return Data("""
            {"download":{"url":"\(d.url)","sha256":"\(d.sha)","version":"\(d.version)","sizeBytes":\(d.size),"attestation":"https://x/att"}}
            """.utf8)
        }
        return Data(#"{"download":null}"#.utf8)
    }

    // MARK: - keep

    /// Server says download:null + a cache exists → keep the cached ISO,
    /// untouched, and report it as fromCache.
    func testKeepWhenServerOrdersNull() async throws {
        let body = Data("an existing base iso".utf8)
        let cached = writeCachedBase(version: "debian-12.4", body: body)
        StubURLProtocol.responder = { _ in (200, self.manifestJSON(download: nil)) }

        let readyFromCache = Captured(false)
        let cache = makeCache()
        let result = try await cache.ensure(progress: { phase in
            if case .ready(_, _, let fromCache) = phase { readyFromCache.value = fromCache }
        })
        XCTAssertEqual(result.standardizedFileURL, cached.standardizedFileURL)
        XCTAssertTrue(readyFromCache.value)
        XCTAssertEqual(try Data(contentsOf: result), body)
    }

    /// download:null with NO cache → noBaseAvailable error.
    func testNoBaseAvailableWhenNullAndEmpty() async {
        StubURLProtocol.responder = { _ in (200, self.manifestJSON(download: nil)) }
        let cache = makeCache()
        do {
            _ = try await cache.ensure()
            XCTFail("expected noBaseAvailable")
        } catch let e as IsoBaseCache.CacheError {
            guard case .noBaseAvailable = e else { return XCTFail("wrong: \(e)") }
        } catch { XCTFail("wrong type: \(error)") }
    }

    // MARK: - download

    /// Server orders a download → fetch, sha verifies, store at the versioned
    /// path, report fromCache=false, and the URL is surfaced during download.
    func testDownloadVerifiesAndStores() async throws {
        let isoBody = Data(repeating: 0xAB, count: 5000)
        let isoURL = "https://flagshipserver.com/iso/debian-12.5.iso"
        let goodSha = sha256(isoBody)

        StubURLProtocol.responder = { req in
            if req.url?.absoluteString == isoURL { return (200, isoBody) }
            return (200, self.manifestJSON(download: (isoURL, goodSha, "debian-12.5", isoBody.count)))
        }

        let sawURL = Captured<String?>(nil)
        let readyFromCache = Captured<Bool?>(nil)
        let cache = makeCache()
        let result = try await cache.ensure(progress: { phase in
            switch phase {
            case .downloading(let url, _, _): sawURL.value = url
            case .ready(_, _, let fc): readyFromCache.value = fc
            default: break
            }
        })
        XCTAssertEqual(sawURL.value, isoURL, "the URL must be surfaced for the UI")
        XCTAssertEqual(readyFromCache.value, false)
        XCTAssertEqual(result.lastPathComponent, "flagship-base-debian-12.5.iso")
        XCTAssertEqual(try Data(contentsOf: result), isoBody)
    }

    /// A fresh download supersedes an older cached base (prune).
    func testDownloadPrunesOlderBase() async throws {
        _ = writeCachedBase(version: "debian-12.4", body: Data("old".utf8))
        let isoBody = Data(repeating: 0x01, count: 2048)
        let isoURL = "https://flagshipserver.com/iso/debian-12.5.iso"
        let goodSha = sha256(isoBody)
        StubURLProtocol.responder = { req in
            if req.url?.absoluteString == isoURL { return (200, isoBody) }
            return (200, self.manifestJSON(download: (isoURL, goodSha, "debian-12.5", isoBody.count)))
        }
        let cache = makeCache()
        _ = try await cache.ensure()
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmpDir.appendingPathComponent("flagship-base-debian-12.4.iso").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: tmpDir.appendingPathComponent("flagship-base-debian-12.5.iso").path))
    }

    // MARK: - sha mismatch

    /// Downloaded bytes whose sha != the manifest sha → checksumMismatch and the
    /// partial file is deleted (nothing left in the cache dir).
    func testShaMismatchDeletesAndErrors() async {
        let isoBody = Data(repeating: 0x02, count: 4096)
        let isoURL = "https://flagshipserver.com/iso/bad.iso"
        let wrongSha = String(repeating: "0", count: 64)
        StubURLProtocol.responder = { req in
            if req.url?.absoluteString == isoURL { return (200, isoBody) }
            return (200, self.manifestJSON(download: (isoURL, wrongSha, "debian-bad", isoBody.count)))
        }
        let cache = makeCache()
        do {
            _ = try await cache.ensure()
            XCTFail("expected checksumMismatch")
        } catch let e as IsoBaseCache.CacheError {
            guard case .checksumMismatch = e else { return XCTFail("wrong: \(e)") }
        } catch { XCTFail("wrong type: \(error)") }

        let leftover = (try? FileManager.default.contentsOfDirectory(atPath: tmpDir.path)) ?? []
        XCTAssertTrue(leftover.allSatisfy { !$0.hasSuffix(".iso") && !$0.hasSuffix(".partial") },
                      "no iso/partial should remain after a mismatch, got \(leftover)")
    }

    // MARK: - inspect reports current

    /// When a cache exists the request's `current` carries that version + sha.
    func testInspectReportsCurrentToServer() async throws {
        let body = Data("cached".utf8)
        _ = writeCachedBase(version: "debian-12.4", body: body)
        let expectedSha = sha256(body)
        StubURLProtocol.responder = { _ in (200, self.manifestJSON(download: nil)) }
        let cache = makeCache()
        _ = try await cache.ensure()
        let reqBody = try XCTUnwrap(StubURLProtocol.lastBody)
        let decoded = try JSONDecoder().decode(IsoManifestRequest.self, from: reqBody)
        XCTAssertEqual(decoded.current?.version, "debian-12.4")
        XCTAssertEqual(decoded.current?.sha256, expectedSha)
    }

    // MARK: - per-arch

    /// The host path's arm64 cache asks the server for arch=arm64; the burn
    /// path's default request carries no arch key at all (byte-compat).
    func testArm64RequestCarriesArch() async throws {
        _ = writeCachedBase(version: "debian-13.5.0", arch: .arm64, body: Data("arm base".utf8))
        StubURLProtocol.responder = { _ in (200, self.manifestJSON(download: nil)) }
        _ = try await makeCache(arch: .arm64).ensure()
        let reqBody = try XCTUnwrap(StubURLProtocol.lastBody)
        let decoded = try JSONDecoder().decode(IsoManifestRequest.self, from: reqBody)
        XCTAssertEqual(decoded.arch, .arm64)
        XCTAssertEqual(decoded.current?.version, "debian-13.5.0",
                       "the arm64 inspect must report the arm64 entry's version")
    }

    /// arm64 + download:null + NOTHING cached is "hosting unavailable for this
    /// architecture", never "up to date": the error points at Advanced mode
    /// with an arm64 ISO.
    func testArm64NullWithNoCacheSaysHostingUnavailable() async {
        StubURLProtocol.responder = { _ in (200, self.manifestJSON(download: nil)) }
        do {
            _ = try await makeCache(arch: .arm64).ensure()
            XCTFail("expected noBaseAvailable")
        } catch let e as IsoBaseCache.CacheError {
            guard case .noBaseAvailable(.arm64) = e else { return XCTFail("wrong: \(e)") }
            let msg = e.errorDescription ?? ""
            XCTAssertTrue(msg.contains("Advanced mode"), "must point at the escape hatch, got: \(msg)")
            XCTAssertTrue(msg.contains("arm64"), "must name the missing arch, got: \(msg)")
        } catch { XCTFail("wrong type: \(error)") }
    }

    /// An amd64 burn base and an arm64 host base coexist: the arm64 download
    /// must not evict the amd64 entry, and vice versa.
    func testPerArchCacheCoexistence() async throws {
        let amdBody = Data("amd64 burn base".utf8)
        let amdURL = writeCachedBase(version: "debian-13.5.0", body: amdBody)

        let armBody = Data(repeating: 0xA6, count: 4096)
        let armISO = "https://flagshipserver.com/iso/debian-arm64.iso"
        StubURLProtocol.responder = { req in
            if req.url?.absoluteString == armISO { return (200, armBody) }
            return (200, self.manifestJSON(download: (armISO, self.sha256(armBody), "debian-13.5.0", armBody.count)))
        }
        let armURL = try await makeCache(arch: .arm64).ensure()
        XCTAssertEqual(armURL.lastPathComponent, "flagship-base-arm64-debian-13.5.0.iso")
        XCTAssertEqual(try Data(contentsOf: amdURL), amdBody,
                       "the arm64 download must not prune the amd64 burn base")

        // Now the reverse: a fresh amd64 download prunes the OLD amd64 base
        // but leaves the arm64 host base alone.
        let newAmdBody = Data(repeating: 0x64, count: 2048)
        let newAmdISO = "https://flagshipserver.com/iso/debian-13.6-amd64.iso"
        StubURLProtocol.responder = { req in
            if req.url?.absoluteString == newAmdISO { return (200, newAmdBody) }
            return (200, self.manifestJSON(download: (newAmdISO, self.sha256(newAmdBody), "debian-13.6.0", newAmdBody.count)))
        }
        _ = try await makeCache().ensure()
        XCTAssertFalse(FileManager.default.fileExists(atPath: amdURL.path), "old amd64 base pruned")
        XCTAssertEqual(try Data(contentsOf: armURL), armBody,
                       "the amd64 download must not prune the arm64 host base")
    }

    /// The amd64 inspect must not mistake an arm64 entry for its own cache —
    /// its filename shares the legacy amd64 prefix.
    func testAmd64InspectIgnoresArm64Entry() async throws {
        _ = writeCachedBase(version: "debian-13.5.0", arch: .arm64, body: Data("arm only".utf8))
        StubURLProtocol.responder = { _ in (200, self.manifestJSON(download: nil)) }
        do {
            _ = try await makeCache().ensure()
            XCTFail("expected noBaseAvailable — the arm64 entry is not an amd64 cache")
        } catch let e as IsoBaseCache.CacheError {
            guard case .noBaseAvailable(.amd64) = e else { return XCTFail("wrong: \(e)") }
        } catch { XCTFail("wrong type: \(error)") }
        let reqBody = try XCTUnwrap(StubURLProtocol.lastBody)
        let decoded = try JSONDecoder().decode(IsoManifestRequest.self, from: reqBody)
        XCTAssertNil(decoded.current, "the arm64 entry must not be reported as the amd64 current")
    }

    /// Empty cache → `current` is nil.
    func testInspectReportsNilWhenEmpty() async throws {
        let isoBody = Data(repeating: 0x03, count: 1024)
        let isoURL = "https://flagshipserver.com/iso/d.iso"
        let goodSha = sha256(isoBody)
        StubURLProtocol.responder = { req in
            if req.url?.absoluteString == isoURL { return (200, isoBody) }
            return (200, self.manifestJSON(download: (isoURL, goodSha, "d", isoBody.count)))
        }
        let cache = makeCache()
        _ = try await cache.ensure()
        let reqBody = try XCTUnwrap(StubURLProtocol.lastBody)
        let decoded = try JSONDecoder().decode(IsoManifestRequest.self, from: reqBody)
        XCTAssertNil(decoded.current)
    }
}
