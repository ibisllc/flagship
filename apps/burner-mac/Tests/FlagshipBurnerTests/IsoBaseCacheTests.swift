import XCTest
import CryptoKit
@testable import FlagshipBurnerCore

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

    private func writeCachedBase(version: String, body: Data) -> URL {
        let url = tmpDir.appendingPathComponent("flagship-base-\(version).iso")
        try? body.write(to: url)
        return url
    }

    private func makeCache() -> IsoBaseCache {
        let session = StubURLProtocol.makeSession()
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint, session: session)
        return IsoBaseCache(client: client,
                            burnerVersion: "test",
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

        var readyFromCache = false
        let cache = makeCache()
        let result = try await cache.ensure(progress: { phase in
            if case .ready(_, _, let fromCache) = phase { readyFromCache = fromCache }
        })
        XCTAssertEqual(result.standardizedFileURL, cached.standardizedFileURL)
        XCTAssertTrue(readyFromCache)
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

        var sawURL: String? = nil
        var readyFromCache: Bool? = nil
        let cache = makeCache()
        let result = try await cache.ensure(progress: { phase in
            switch phase {
            case .downloading(let url, _, _): sawURL = url
            case .ready(_, _, let fc): readyFromCache = fc
            default: break
            }
        })
        XCTAssertEqual(sawURL, isoURL, "the URL must be surfaced for the UI")
        XCTAssertEqual(readyFromCache, false)
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
