import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

final class VibeTranscriptTests: XCTestCase {
    private let reply = """
    Here's your app.
    === flagship.app.json ===
    {"name":"todo"}
    === server.js ===
    const a = 1;
    const b = 2;
    === END ===
    """

    func testFinishedFilesCollapseToOneLineEach() {
        XCTAssertEqual(VibeTranscript.compact(reply), """
        Here's your app.
          wrote flagship.app.json (1 line)
          wrote server.js (2 lines)
        """)
    }

    func testFileBeingWrittenShowsItsTail() {
        let body = (1...10).map { "line \($0)" }.joined(separator: "\n")
        let out = VibeTranscript.compact("Working.\n=== app.js ===\n" + body, live: true)
        XCTAssertEqual(out.components(separatedBy: "\n").first, "Working.")
        XCTAssertTrue(out.contains("  writing app.js… (10 lines)"))
        XCTAssertTrue(out.hasSuffix("    line 10"))
        XCTAssertFalse(out.contains("line 4\n"))
    }

    func testQuestionTextStays() {
        let out = VibeTranscript.compact("=== QUESTION ===\nWhich colour?\n=== END ===")
        XCTAssertEqual(out, "Which colour?")
    }

    func testOnlyTheNewestMessagesAreKept() {
        let msgs = (0..<55).map { VibeCodeSessionMessage(role: $0 % 2 == 0 ? "user" : "assistant", text: "m\($0)", timestamp: 0) }
        let r = VibeTranscript.lines(msgs)
        XCTAssertEqual(r.hidden, 15)
        XCTAssertEqual(r.lines.count, 40)
        XCTAssertEqual(r.lines.last?.text, "m54")
    }

    func testBoxErrorReadsTheDaemonReason() {
        XCTAssertEqual(VibeCodeSessionScreen.boxError(#"{"error":"docker build failed: exit 1"}"#), "docker build failed: exit 1")
        XCTAssertNil(VibeCodeSessionScreen.boxError("<html>"))
    }
}
