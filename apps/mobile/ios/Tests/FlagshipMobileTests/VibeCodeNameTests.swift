import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

final class VibeCodeNameTests: XCTestCase {
    func testAStartRefusedForATakenNameIsReadAsAConflict() {
        let body = #"{"ok":false,"kind":"session","sessionId":"abcd","message":"A build session already uses the name \"garden\".","error":"x"}"#
        let c = VibeCodeNameCheck.conflict(in: ScreensClientError.http(status: 409, message: body))
        XCTAssertEqual(c?.kind, "session")
        XCTAssertEqual(c?.sessionId, "abcd")
        XCTAssertNil(VibeCodeNameCheck.conflict(in: ScreensClientError.http(status: 502, message: body)))
        XCTAssertNil(VibeCodeNameCheck.conflict(in: ScreensClientError.http(status: 409, message: "not json")))
    }

    @MainActor
    func testTheWarningSendsSessionClashesToTheListAndAppClashesToAnotherName() {
        let session = VibeCodeNameCheck(ok: false, name: "garden", kind: "session", sessionId: "abcd")
        XCTAssertTrue(VibeCodeDescribeScreen.conflictMessage(session, name: "garden").contains("open Build sessions and discard"))
        let app = VibeCodeNameCheck(ok: false, name: "notes", kind: "app", serviceId: "alice--notes")
        XCTAssertEqual(VibeCodeDescribeScreen.conflictMessage(app, name: "notes"),
                       "You already have a service called \"notes\". Pick another name.")
    }

    func testOnlyUndeployedSessionsOfferDiscard() {
        XCTAssertTrue(VibeCodeSessionMeta(sessionId: "a", startedAt: 0, status: "failed", name: "x").canDiscard)
        XCTAssertFalse(VibeCodeSessionMeta(sessionId: "b", startedAt: 0, status: "deployed").canDiscard)
    }

    func testSessionsAndDeploysDecodeTheNewFields() throws {
        let meta = try JSONDecoder().decode(VibeCodeSessionMeta.self,
            from: Data(#"{"sessionId":"a","startedAt":1,"status":"streaming","name":"garden","visibility":"just-me"}"#.utf8))
        XCTAssertEqual(meta.name, "garden")
        let old = try JSONDecoder().decode(BuildDeployResponse.self,
            from: Data(#"{"ok":true,"serviceId":"alice--x","url":"https://x"}"#.utf8))
        XCTAssertNil(old.inviteOnly)
    }
}

final class BuildListNameTests: XCTestCase {
    func testPastBuildsShowTheirNameAndHowTheyWereMade() {
        let named = BuildSummary(buildId: "a", mode: "scratch", serviceId: "alice--garden", name: "garden",
                                 startedAt: 0, lastAt: 0, entryCount: 3, lastKind: "deployed")
        XCTAssertEqual(named.displayName, "garden")
        XCTAssertEqual(named.methodLabel, "AI chat")
        let fromService = BuildSummary(buildId: "b", mode: "git", serviceId: "alice--notes",
                                       startedAt: 0, lastAt: 0, entryCount: 1, lastKind: "deployed")
        XCTAssertEqual(fromService.displayName, "notes")
        XCTAssertEqual(fromService.methodLabel, "From Git")
        let bare = BuildSummary(buildId: "c", mode: "mcp", startedAt: 0, lastAt: 0, entryCount: 1, lastKind: "error")
        XCTAssertEqual(bare.displayName, "Unnamed build")
        XCTAssertEqual(bare.methodLabel, "From your IDE")
    }
}
