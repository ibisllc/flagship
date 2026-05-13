import XCTest
@testable import FlagshipAPI

final class VerifyCustomDomainTests: XCTestCase {

    func test_verify_returnsPendingFirstThenVerified() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let first = try await c.verifyCustomDomain(.init(fqdn: "app.mydomain.com"))
        XCTAssertEqual(first.status, .pending)
        XCTAssertNotNil(first.expectedTxtRecord)
        XCTAssertNil(first.observedTxtRecord)
        XCTAssertNotNil(first.reason, "Pending should include a propagation hint.")

        let second = try await c.verifyCustomDomain(.init(fqdn: "app.mydomain.com"))
        XCTAssertEqual(second.status, .verified)
        XCTAssertEqual(second.observedTxtRecord, second.expectedTxtRecord)
        XCTAssertNil(second.reason)
    }

    func test_verify_expectedTxtIsStablePerFqdn() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let a1 = try await c.verifyCustomDomain(.init(fqdn: "a.example.com"))
        let a2 = try await c.verifyCustomDomain(.init(fqdn: "a.example.com"))
        XCTAssertEqual(a1.expectedTxtRecord, a2.expectedTxtRecord)
    }

    func test_verify_yieldsDistinctTokensPerFqdn() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let a = try await c.verifyCustomDomain(.init(fqdn: "a.example.com"))
        let b = try await c.verifyCustomDomain(.init(fqdn: "b.example.com"))
        XCTAssertNotEqual(a.expectedTxtRecord, b.expectedTxtRecord)
    }
}
