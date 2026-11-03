import XCTest
@testable import FlagshipBuilderCore

/// The "Disk to install on" field's check against the shared vectors (test-vectors/install-disk-stop.json),
/// which also pin the generator's TARGET_DISK_PATTERN.
final class TargetDiskTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Lists: Decodable { let valid: [String]; let invalid: [String] }
        let targetDiskPattern: String
        let targetDisk: Lists
    }

    private func load() throws -> Vectors {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let url = dir.appendingPathComponent("test-vectors/install-disk-stop.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
            }
            dir.deleteLastPathComponent()
        }
        throw XCTSkip("test-vectors/install-disk-stop.json not found above \(#filePath)")
    }

    func testPatternMatchesTheGenerator() throws {
        XCTAssertEqual(try load().targetDiskPattern, TargetDisk.pattern)
    }

    func testValidAndInvalidNames() throws {
        let v = try load()
        for s in v.targetDisk.valid {
            XCTAssertEqual(TargetDisk.check(s), .valid(s), s)
            XCTAssertEqual(TargetDisk.check("  \(s)\n"), .valid(s), "trimmed \(s)")
        }
        for s in v.targetDisk.invalid {
            XCTAssertEqual(TargetDisk.check(s), .invalid, s)
        }
        XCTAssertEqual(TargetDisk.check(""), .none)
        XCTAssertEqual(TargetDisk.check("   "), .none)
    }
}
