import XCTest
@testable import FlagshipAPI

/// The update card's sentence for the box's `lastUpdate` (docs/support/update-rollback.md): one whole
/// sentence per case, the same English as the webapp's describeLastUpdate and Android's LastUpdate.
final class LastUpdateSummaryTests: XCTestCase {
    private let a = String(repeating: "a", count: 40)
    private let b = String(repeating: "b", count: 40)

    func test_rollbackKeptInRecoveryIsStuckNotWentBack() throws {
        let json = """
        {"outcome":"rolled-back","at":5,"previousCommit":"\(a)","targetCommit":"\(b)","bootAttempts":3,"rollbackRefused":true}
        """
        let stuck = try JSONDecoder().decode(LastUpdate.self, from: Data(json.utf8))
        XCTAssertTrue(stuck.keptInRecovery)
        XCTAssertTrue(stuck.needsAttention)
        XCTAssertEqual(stuck.summary, "The update to bbbbbbbb didn't start cleanly, and the version before it is too old to go back to safely. The server stays on bbbbbbbb in recovery mode until a fixed update arrives: install it from this card when it's offered. Your apps and data are kept.")
        XCTAssertFalse(stuck.summary?.contains("on its own") ?? true)
        XCTAssertEqual(LastUpdate(outcome: "rolled-back", at: 1, rollbackRefused: true).summary,
                       "The last update didn't start cleanly, and the version before it is too old to go back to safely. The server stays on the new version in recovery mode until a fixed update arrives: install it from this card when it's offered. Your apps and data are kept.")
    }

    func test_rollbackSentencesAreWhole() {
        XCTAssertEqual(LastUpdate(outcome: "rolled-back", at: 1, targetCommit: b, previousCommit: a).summary,
                       "The last update to bbbbbbbb didn't start cleanly, so the server went back to aaaaaaaa on its own.")
        XCTAssertEqual(LastUpdate(outcome: "rolled-back", at: 1, targetCommit: b).summary,
                       "The last update to bbbbbbbb didn't start cleanly, so the server went back on its own.")
        XCTAssertEqual(LastUpdate(outcome: "rolled-back", at: 1, previousCommit: a).summary,
                       "The last update didn't start cleanly, so the server went back to aaaaaaaa on its own.")
        XCTAssertEqual(LastUpdate(outcome: "rolled-back", at: 1).summary,
                       "The last update didn't start cleanly, so the server went back on its own.")
        XCTAssertFalse(LastUpdate(outcome: "rolled-back", at: 1, targetCommit: b).needsAttention)
    }

    func test_everyRefusalIsItsOwnSentence() {
        let expected: [String: String] = [
            "unendorsed": "The server refused the last update: Flagship's maintainers haven't endorsed that release.",
            "from-commit-mismatch": "The server refused the last update: the server was no longer on the version the update was made for. Send it again.",
            "apply-failed": "The server refused the last update: it couldn't download or build the new version. Nothing changed.",
            "rejected": "The server refused the last update: the request wasn't signed by this account's admin key.",
            "stale": "The server refused the last update: the request was too old. Send it again.",
            "wrong-domain": "The server refused the last update: the request was for a different server.",
        ]
        for (reason, sentence) in expected {
            XCTAssertEqual(LastUpdate(outcome: "refused", at: 1, reason: reason).summary, sentence, reason)
        }
        XCTAssertEqual(LastUpdate(outcome: "refused", at: 1, reason: "new").summary, "The server refused the last update.")
        XCTAssertTrue(LastUpdate(outcome: "refused", at: 1).needsAttention)
        XCTAssertNil(LastUpdate(outcome: "exploded", at: 1).summary)
    }

    func test_updateReportsSettingDecodesTheBoxAnswer() throws {
        let s = try JSONDecoder().decode(UpdateReportsSetting.self, from: Data(#"{"share":true,"source":"owner","sends":["release"]}"#.utf8))
        XCTAssertEqual(s, UpdateReportsSetting(share: true, source: "owner"))
        let posted = try JSONDecoder().decode(UpdateReportsSetting.self, from: Data(#"{"share":false}"#.utf8))
        XCTAssertEqual(posted, UpdateReportsSetting(share: false))
    }

    func test_mockClientRecordsTheChoice() async throws {
        let mock = MockScreensClient()
        let before = try await mock.updateReportsSetting()
        XCTAssertEqual(before.share, false)
        _ = try await mock.setUpdateReports(share: true)
        let after = try await mock.updateReportsSetting()
        XCTAssertEqual(after, UpdateReportsSetting(share: true, source: "owner"))
        XCTAssertEqual(mock.setUpdateReportsCalls, [true])
    }
}
