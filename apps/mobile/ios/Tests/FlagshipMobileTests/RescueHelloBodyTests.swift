import XCTest
@testable import FlagshipUI
@testable import FlagshipCore

/// The box's hello travels without the server's name; the phone puts back the name it connected to.
final class RescueHelloBodyTests: XCTestCase {
    private func body(extra: String = "") -> Data {
        Data("""
        {"hello":{\(extra)"clientNonce":"\(String(repeating: "11", count: 16))","boxNonce":"\(String(repeating: "22", count: 16))","certSha256":"\(String(repeating: "ab", count: 32))","issuedAt":5},"signatureHex":"\(String(repeating: "00", count: 64))"}
        """.utf8)
    }

    func testTheHelloBodyNamesNoServerAndThePhonePutsItsOwnNameBack() {
        let w = LiveRescueConnection.helloBody(body(), serverDomain: "Home.Harry.flagship.services")
        XCTAssertEqual(w?.hello, Rescue.Exchange(serverDomain: "home.harry.flagship.services", clientNonce: String(repeating: "11", count: 16),
                                                 boxNonce: String(repeating: "22", count: 16), certSha256: String(repeating: "ab", count: 32), issuedAt: 5))
    }

    func testANameInTheBodyIsNotTrustedOverThePhonesOwn() {
        let w = LiveRescueConnection.helloBody(body(extra: "\"serverDomain\":\"evil.example\","), serverDomain: "home.harry.flagship.services")
        XCTAssertEqual(w?.hello.serverDomain, "home.harry.flagship.services")
    }
}
