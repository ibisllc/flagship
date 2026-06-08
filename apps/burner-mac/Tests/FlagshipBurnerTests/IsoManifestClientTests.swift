import XCTest
@testable import FlagshipBurnerCore

/// URLProtocol stub: captures the outgoing request body and returns a canned
/// (status, body) so the manifest client can be exercised without the network.
final class StubURLProtocol: URLProtocol {
    /// (statusCode, responseBody). Set per-test before making a request.
    nonisolated(unsafe) static var responder: ((URLRequest) -> (Int, Data))?
    /// Last request body seen (URLProtocol strips httpBody into a stream, so we
    /// capture it here for assertions).
    nonisolated(unsafe) static var lastBody: Data?

    static func reset() { responder = nil; lastBody = nil }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let bufSize = 4096
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            while stream.hasBytesAvailable {
                let read = stream.read(buf, maxLength: bufSize)
                if read <= 0 { break }
                data.append(buf, count: read)
            }
            buf.deallocate()
            stream.close()
            Self.lastBody = data
        } else if let body = request.httpBody {
            Self.lastBody = body
        }

        let (status, body) = Self.responder?(request) ?? (500, Data())
        let resp = HTTPURLResponse(url: request.url!, statusCode: status,
                                   httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// A URLSession whose only protocol is this stub.
    static func makeSession() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }
}

final class IsoManifestClientTests: XCTestCase {

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    /// Decodes the "download an ISO" response shape.
    func testDecodesDownloadOrder() async throws {
        StubURLProtocol.responder = { _ in
            let json = """
            {"download":{"url":"https://flagshipserver.com/iso/debian.iso",
            "sha256":"abc123","version":"debian-12.5","sizeBytes":654321,
            "attestation":"https://flagshipserver.com/iso/debian.iso.att"}}
            """
            return (200, Data(json.utf8))
        }
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint,
                                       session: StubURLProtocol.makeSession())
        let resp = try await client.fetch(IsoManifestRequest(burnerVersion: "1.0", current: nil))
        let dl = try XCTUnwrap(resp.download)
        XCTAssertEqual(dl.url, "https://flagshipserver.com/iso/debian.iso")
        XCTAssertEqual(dl.sha256, "abc123")
        XCTAssertEqual(dl.version, "debian-12.5")
        XCTAssertEqual(dl.sizeBytes, 654321)
        XCTAssertEqual(dl.attestation, "https://flagshipserver.com/iso/debian.iso.att")
    }

    /// Decodes the "keep what you have" response shape.
    func testDecodesNullDownload() async throws {
        StubURLProtocol.responder = { _ in (200, Data(#"{"download":null}"#.utf8)) }
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint,
                                       session: StubURLProtocol.makeSession())
        let resp = try await client.fetch(IsoManifestRequest(burnerVersion: "1.0", current: nil))
        XCTAssertNil(resp.download)
    }

    /// The request carries platform=mac, the burner version, and `current`.
    func testRequestBodyShape() async throws {
        StubURLProtocol.responder = { _ in (200, Data(#"{"download":null}"#.utf8)) }
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint,
                                       session: StubURLProtocol.makeSession())
        let current = IsoManifestCurrent(version: "debian-12.4", sha256: "deadbeef")
        _ = try await client.fetch(IsoManifestRequest(burnerVersion: "2.3", current: current))
        let body = try XCTUnwrap(StubURLProtocol.lastBody)
        let decoded = try JSONDecoder().decode(IsoManifestRequest.self, from: body)
        XCTAssertEqual(decoded.platform, "mac")
        XCTAssertEqual(decoded.burnerVersion, "2.3")
        XCTAssertEqual(decoded.current, current)
    }

    /// A non-2xx surfaces as `.httpStatus`.
    func testHTTPErrorSurfaces() async {
        StubURLProtocol.responder = { _ in (503, Data()) }
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint,
                                       session: StubURLProtocol.makeSession())
        do {
            _ = try await client.fetch(IsoManifestRequest(burnerVersion: "1.0", current: nil))
            XCTFail("expected an error")
        } catch let e as IsoManifestError {
            guard case .httpStatus(503) = e else { return XCTFail("wrong error: \(e)") }
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    /// Garbage body surfaces as `.decode`.
    func testDecodeErrorSurfaces() async {
        StubURLProtocol.responder = { _ in (200, Data("not json".utf8)) }
        let client = IsoManifestClient(endpoint: IsoManifestClient.endpoint,
                                       session: StubURLProtocol.makeSession())
        do {
            _ = try await client.fetch(IsoManifestRequest(burnerVersion: "1.0", current: nil))
            XCTFail("expected an error")
        } catch let e as IsoManifestError {
            guard case .decode = e else { return XCTFail("wrong error: \(e)") }
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }
}
