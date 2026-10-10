import XCTest
@testable import FlagshipBuilderCore

final class Qcow2ExpanderTests: XCTestCase {
    private func fixture(_ name: String) throws -> URL {
        let dir = try XCTUnwrap(Bundle.module.url(forResource: "qcow2", withExtension: nil))
        return dir.appendingPathComponent(name)
    }

    private func expected() throws -> (sha: String, size: UInt64) {
        let sha = try String(contentsOf: fixture("fixture.raw.sha256"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let size = try XCTUnwrap(UInt64(String(contentsOf: fixture("fixture.raw.size"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)))
        return (sha, size)
    }

    private func tempOutput() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("qcow2-\(UUID().uuidString).raw")
    }

    func testExpandsCompressedImageSplitAcrossParts() throws {
        let source = try MultiPartSource(parts: [
            fixture("fixture-compressed.qcow2.part-a"),
            fixture("fixture-compressed.qcow2.part-b"),
        ])
        let out = tempOutput()
        defer { try? FileManager.default.removeItem(at: out) }
        let result = try Qcow2Expander.expand(source: source, to: out)
        let want = try expected()
        XCTAssertEqual(result.sha256, want.sha)
        XCTAssertEqual(result.sizeBytes, want.size)
        XCTAssertEqual(try ApplianceProvisioner.sha256OfFile(out), want.sha)
    }

    func testExpandsPlainVersion2ImageWithSmallClusters() throws {
        let source = try MultiPartSource(parts: [fixture("fixture-plain-v2.qcow2")])
        let out = tempOutput()
        defer { try? FileManager.default.removeItem(at: out) }
        let result = try Qcow2Expander.expand(source: source, to: out)
        XCTAssertEqual(result.sha256, try expected().sha)
    }

    func testRefusesNonQcow2Input() throws {
        let junk = tempOutput()
        try Data(repeating: 0x41, count: 4096).write(to: junk)
        defer { try? FileManager.default.removeItem(at: junk) }
        XCTAssertThrowsError(try Qcow2Expander.expand(source: MultiPartSource(parts: [junk]), to: tempOutput())) {
            XCTAssertEqual($0 as? Qcow2Error, .notQcow2)
        }
    }

    func testRefusesBackingFiles() throws {
        var header = try Data(contentsOf: fixture("fixture-plain-v2.qcow2")).prefix(4096)
        header[header.startIndex + 15] = 0x01
        let path = tempOutput()
        try header.write(to: path)
        defer { try? FileManager.default.removeItem(at: path) }
        XCTAssertThrowsError(try Qcow2Expander.expand(source: MultiPartSource(parts: [path]), to: tempOutput())) {
            XCTAssertEqual($0 as? Qcow2Error, .unsupported("backing file"))
        }
    }

    func testMultiPartReadsAcrossABoundary() throws {
        let a = tempOutput(), b = tempOutput()
        try Data([1, 2, 3]).write(to: a)
        try Data([4, 5, 6, 7]).write(to: b)
        defer { [a, b].forEach { try? FileManager.default.removeItem(at: $0) } }
        let source = try MultiPartSource(parts: [a, b])
        XCTAssertEqual(source.size, 7)
        XCTAssertEqual(try source.read(at: 1, count: 4), Data([2, 3, 4, 5]))
        XCTAssertEqual(try source.read(at: 5, count: 10), Data([6, 7]))
    }
}
