import XCTest
@testable import FlagshipAPI

final class FlagshipServerClientTests: XCTestCase {

    private func makeClient() -> MockFlagshipServerClient {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        return c
    }

    func test_mintBuildCode_returnsCodeSerialAndIso() async throws {
        let c = makeClient()
        let resp = try await c.mintBuildCode(.init(
            username: "harry",
            podName: "Garage",
            podDescription: "Music projects"
        ))
        XCTAssertEqual(resp.buildCode.count, 12)
        XCTAssertEqual(resp.serial.count, 10)
        XCTAssertTrue(resp.isoUrl.hasPrefix("https://flagshipserver.com/build/"))
        XCTAssertTrue(resp.isoUrl.contains(resp.buildCode))
        XCTAssertGreaterThan(resp.expiresAt, Int64(Date().timeIntervalSince1970 * 1000))
    }

    func test_usernameAvailable_acceptsValidLowercase() async throws {
        let c = makeClient()
        let r = try await c.usernameAvailable("harry42")
        XCTAssertTrue(r.available)
        XCTAssertNil(r.reason)
    }

    func test_usernameAvailable_rejectsReserved() async throws {
        let c = makeClient()
        let r = try await c.usernameAvailable("root")
        XCTAssertFalse(r.available)
        XCTAssertEqual(r.reason, "Reserved.")
    }

    func test_usernameAvailable_rejectsTooShort() async throws {
        let c = makeClient()
        let r = try await c.usernameAvailable("a")
        XCTAssertFalse(r.available)
        XCTAssertNotNil(r.reason)
    }

    func test_recoveryEnvelope_roundTrip() async throws {
        let c = makeClient()
        let req = RecoveryEnvelopeRequest(
            credentialId: "cred-1",
            wrappedUmkBase64: "Zm9v",
            nonceBase64: "YmFy"
        )
        _ = try await c.registerRecoveryEnvelope(req)
        let fetched = try await c.fetchRecoveryEnvelope(credentialId: "cred-1")
        XCTAssertEqual(fetched.credentialId, "cred-1")
        XCTAssertEqual(fetched.wrappedUmkBase64, "Zm9v")
        XCTAssertEqual(fetched.nonceBase64, "YmFy")
    }

    func test_fetchRecoveryEnvelope_unknownCredentialThrows404() async {
        let c = makeClient()
        do {
            _ = try await c.fetchRecoveryEnvelope(credentialId: "unknown")
            XCTFail("expected throw")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 404)
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }
}
