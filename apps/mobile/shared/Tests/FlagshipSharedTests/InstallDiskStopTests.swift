import XCTest
@testable import FlagshipCore

/// The installer's disk stops (test-vectors/install-disk-stop.json) become the app's own sentence plus
/// the re-burn advice; any other failure keeps the box's own words.
final class InstallDiskStopTests: XCTestCase {
    private struct Stop: Decodable {
        let detail: String
        let kind: String?
        let count: String?
        let sizes: String?
        let pin: String?
    }
    private struct Vectors: Decodable { let stops: [Stop] }

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

    func testVectors() throws {
        let v = try load()
        XCTAssertFalse(v.stops.isEmpty)
        for s in v.stops {
            let parsed = InstallDiskStop.parse(s.detail)
            XCTAssertEqual(parsed?.kind, s.kind, s.detail)
            switch parsed {
            case .several(let count, let sizes)?:
                XCTAssertEqual(count, s.count)
                XCTAssertEqual(sizes, s.sizes)
            case .missing(let disk)?, .ambiguous(let disk)?:
                XCTAssertEqual(disk, s.pin)
            default:
                break
            }
            let shown = ProvisionProgress.failureDetail(s.detail)
            if let parsed {
                XCTAssertEqual(shown, parsed.message)
                XCTAssertTrue(shown?.hasSuffix(InstallDiskStop.advice) == true)
                XCTAssertTrue(shown?.contains("Nothing was erased.") == true)
            } else {
                XCTAssertFalse(shown?.contains(InstallDiskStop.advice) == true, s.detail)
            }
        }
    }

    func testSentencesCarryTheirValues() {
        XCTAssertEqual(InstallDiskStop.several(count: "2", sizes: "500 GB, 2000 GB").sentence,
                       "This computer has 2 disks the installer could erase (500 GB, 2000 GB), so it stopped. Nothing was erased.")
        XCTAssertEqual(InstallDiskStop.missing(disk: "serial:NOPE").sentence,
                       "The disk this installer was made for (serial:NOPE) isn't in this computer. Nothing was erased.")
    }

    func testTheTimelineRowCarriesTheAdvice() {
        let steps = ProvisionProgress.stepStates(
            phase: "error",
            lastError: "This machine has no fixed disk of 8 GB or more to install on. Nothing was erased. Name the disk to install on and make the installer again.",
            prevPhase: "partitioning")
        XCTAssertEqual(steps.first(where: { $0.state == .failed })?.detail,
                       InstallDiskStop.noDisk.message)
    }
}
