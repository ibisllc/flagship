import XCTest
@testable import FlagshipCore
import FlagshipAPI

/// Pins `ProvisionQuiet` to packages/protocol/test-vectors/provision-quiet/vectors.json
/// (Android and the webapp read the same file).
final class ProvisionQuietVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/provision-quiet/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func testThresholdsAndCopyMatchTheVectors() throws {
        let v = try vectors()
        XCTAssertEqual(ProvisionQuiet.installerQuietAfterMs, (v["installerQuietAfterMs"] as? NSNumber)?.int64Value)
        XCTAssertEqual(ProvisionQuiet.stuckAfterMs, (v["stuckAfterMs"] as? NSNumber)?.int64Value)
        XCTAssertEqual(ProvisionQuiet.stuckPhases, Set(try XCTUnwrap(v["stuckPhases"] as? [String])))
        let copy = try XCTUnwrap(v["copy"] as? [String: String])
        XCTAssertEqual(ProvisionQuiet.installerFinishedDetail, copy["installerFinished"])
        XCTAssertEqual(ProvisionQuiet.stuckDetail, copy["stuck"])
        XCTAssertEqual(ProvisionQuiet.stuckAdvice, copy["stuckAdvice"])
    }

    func testEveryCase() throws {
        let cases = try XCTUnwrap(try vectors()["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let got = ProvisionQuiet.of(
                phase: c["phase"] as? String,
                updatedAtMs: try XCTUnwrap((c["updatedAt"] as? NSNumber)?.int64Value),
                nowMs: try XCTUnwrap((c["nowMs"] as? NSNumber)?.int64Value))
            let want: ProvisionQuiet
            switch c["quiet"] as? String {
            case "installerFinished": want = .installerFinished
            case "stuck": want = .stuck
            default: want = .none
            }
            XCTAssertEqual(got, want, name)
        }
    }

    /// home.serene-parrot (2026-11-02): "Installing the bootloader (2 min)" stayed on the
    /// current row for an hour after the installer had stopped.
    func testTheLadderReplacesAStaleInstallerCheckpoint() {
        let at: Int64 = 1_800_000_000_000
        let status = ProvisionStatus(
            serial: "01ABCDEF", phase: .installing, detail: "Installing the bootloader (2 min)", updatedAt: at,
            history: [.init(phase: .installing, detail: "Installing the bootloader (2 min)", ts: at)])
        let date = { (ms: Int64) in Date(timeIntervalSince1970: Double(ms) / 1000) }
        let installing = 2
        XCTAssertEqual(ProvisionTimelineLadder.rows(for: status, now: date(at + 60_000))[installing].detail,
                       "Installing the bootloader (2 min)")
        XCTAssertEqual(ProvisionTimelineLadder.rows(for: status, now: date(at + 6 * 60_000))[installing].detail,
                       ProvisionQuiet.installerFinishedDetail)
        let stuck = ProvisionTimelineLadder.rows(for: status, now: date(at + 25 * 60_000))[installing]
        XCTAssertEqual(stuck.detail, ProvisionQuiet.stuckDetail)
        XCTAssertEqual(stuck.state, .current)
        // Without a clock the box's own words stay (existing callers, the watch).
        XCTAssertEqual(ProvisionTimelineLadder.rows(for: status)[installing].detail, "Installing the bootloader (2 min)")
    }
}
