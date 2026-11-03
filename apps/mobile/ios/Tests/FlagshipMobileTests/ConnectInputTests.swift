import XCTest
@testable import FlagshipUI

/// "Connect to an existing account": what each field does with what's typed
/// or pasted. Mirrors apps/web/tests/webappConnectAccount.test.ts and
/// Android's ConnectInputTest.
final class ConnectInputTests: XCTestCase {
    private let pk = String(repeating: "A", count: 43)
    private var httpsLink: String { "https://flagshipserver.com/join?sid=abc123&pk=\(pk)" }
    private var legacyLink: String { "flagship://join?sid=abc123&pk=\(pk)" }
    private var bareCode: String { "sid=abc123&pk=\(pk)" }

    func testReadsEveryPairingFormTheJoinParserReads() {
        for link in [httpsLink, legacyLink, bareCode] {
            XCTAssertEqual(ConnectInput.classify("  \(link)\n"), .pairing(link))
            XCTAssertEqual(ConnectInput.readPairingField(link), .join(link))
        }
    }

    func testPairingLinkInTheNameFieldGoesToJoinWithANote() {
        XCTAssertEqual(ConnectInput.readNameField(httpsLink), .join(link: httpsLink, note: ConnectInput.routedToJoin))
        XCTAssertEqual(ConnectInput.readNameField(legacyLink), .join(link: legacyLink, note: ConnectInput.routedToJoin))
    }

    func testAnAccountNameSignsInLowercased() {
        XCTAssertEqual(ConnectInput.readNameField("  Bright-Maple "), .signIn("bright-maple"))
        XCTAssertEqual(ConnectInput.readNameField("@demo"), .signIn("demo"))
        XCTAssertEqual(ConnectInput.readNameField("  "), .none)
        XCTAssertEqual(ConnectInput.readNameField("50cent"), .signIn("50cent"))
        XCTAssertEqual(ConnectInput.readNameField(String(repeating: "a", count: 30)), .signIn(String(repeating: "a", count: 30)))
    }

    func testAMalformedAccountNameSaysWhatIsWrong() {
        XCTAssertEqual(ConnectInput.readNameField("ab"), .error(NameRuleText.problem(.tooShort)))
        XCTAssertEqual(ConnectInput.readNameField(String(repeating: "a", count: 31)), .error(NameRuleText.problem(.tooLong)))
        XCTAssertEqual(ConnectInput.readNameField("bright--maple"), .error(NameRuleText.problem(.hyphens)))
        XCTAssertEqual(ConnectInput.readNameField("bright_maple"), .error(NameRuleText.problem(.characters)))
    }

    func testOtherLinksAreRefusedInASentence() {
        let other = "https://flagshipserver.com/share#s=1"
        XCTAssertEqual(ConnectInput.readNameField(other), .error(ConnectInput.badLinkMessage))
        XCTAssertEqual(ConnectInput.readPairingField(other), .error(ConnectInput.badLinkMessage))
        XCTAssertEqual(ConnectInput.readPairingField("https://flagshipserver.com/join?sid=abc"), .error(ConnectInput.badLinkMessage))
    }

    func testANameInTheCodeFieldPointsAtSignIn() {
        XCTAssertEqual(ConnectInput.readPairingField("bright-maple"), .error(ConnectInput.nameInCode))
        XCTAssertEqual(ConnectInput.readPairingField("50cent"), .error(ConnectInput.nameInCode))
        XCTAssertEqual(ConnectInput.readPairingField("not a code!"), .error(ConnectInput.notACode))
        XCTAssertEqual(ConnectInput.readPairingField(""), .none)
        for msg in [ConnectInput.routedToJoin, ConnectInput.notACode, ConnectInput.nameInCode, ConnectInput.badLinkMessage, ConnectInput.emptyCode] {
            XCTAssertTrue(msg.first!.isUppercase && msg.hasSuffix("."), msg)
        }
    }
}
