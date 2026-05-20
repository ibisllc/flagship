import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// v1.2 Phase 4 — drives the AccountSecurityViewModel through the
/// enrollment happy path, code-mismatch sad path, the disable flow,
/// and the recovery-codes display gate.
@MainActor
final class AccountSecurityFlowTests: XCTestCase {

    override func tearDown() async throws {
        Keystore.wipe()
        try await super.tearDown()
    }

    private func makeUMK() async throws {
        // AccountSecurityViewModel signs all three TOTP envelopes with
        // Keystore.deriveIRK — materialize a UMK so deriveIRK works.
        try await Keystore.generateUMK(reason: "test")
    }

    private func freshMock() async throws -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        // Pretend the username is already claimed so getUsernameRecord
        // resolves rather than 404'ing. The Mock's claimUsername is
        // the only writer (setter is private) — that's also how the
        // real app primes the row, so the test stays representative.
        try await s.claimUsername(UsernameClaimRequest(
            request: .init(username: "alice", irkPub: String(repeating: "00", count: 32), issuedAt: 0),
            signature: String(repeating: "00", count: 64)
        ))
        return s
    }

    func test_load_returnsSingleDeviceByDefault() async throws {
        try await makeUMK()
        let server = try await freshMock()
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.load()

        XCTAssertEqual(vm.accountType, "single")
        XCTAssertFalse(vm.isMultiDevice)
        XCTAssertNil(vm.totpEnrolledAt)
    }

    func test_load_returnsMultiDeviceWhenEnrolled() async throws {
        try await makeUMK()
        let server = try await freshMock()
        server.accountTypeByUser["alice"] = "multi"
        server.totpEnrolledAtByUser["alice"] = 1_700_000_000_000
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.load()

        XCTAssertEqual(vm.accountType, "multi")
        XCTAssertTrue(vm.isMultiDevice)
        XCTAssertEqual(vm.totpEnrolledAt, 1_700_000_000_000)
    }

    func test_enrollHappyPath_stagesSecretThenConfirms_returnsRecoveryCodes() async throws {
        try await makeUMK()
        let server = try await freshMock()
        server.totpExpectedConfirmCode = "654321"
        let issuedCodes = (1...10).map { "RC-\($0)" }
        server.totpRecoveryCodesToIssue = issuedCodes
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.beginEnrollment()
        guard case .staged(let staged) = vm.phase else {
            return XCTFail("expected .staged, got \(vm.phase)")
        }
        XCTAssertFalse(staged.secret.isEmpty)
        XCTAssertTrue(staged.otpauthUrl.hasPrefix("otpauth://totp/Flagship:"))
        XCTAssertFalse(staged.qrPngBase64.isEmpty)
        XCTAssertEqual(staged.issuer, "Flagship")

        await vm.confirmEnrollment(sampleCode: "654321")
        guard case .confirmed(let result) = vm.phase else {
            return XCTFail("expected .confirmed, got \(vm.phase)")
        }
        XCTAssertEqual(result.recoveryCodes, issuedCodes)
        XCTAssertGreaterThan(result.totpEnrolledAt, 0)
        // Local-state echo of the badge flip.
        XCTAssertEqual(vm.accountType, "multi")
        // Worker mirror should also reflect the flip.
        XCTAssertEqual(server.accountTypeByUser["alice"], "multi")
        // Recovery codes were stored Mock-side too (proves the
        // enroll-confirm wrote them atomically — needed for the
        // disable handler's "consume on use" surface in Phase 3).
        XCTAssertEqual(server.recoveryCodesByUser["alice"], issuedCodes)
    }

    func test_codeMismatch_bouncesToFailedAndDoesNotEnroll() async throws {
        try await makeUMK()
        let server = try await freshMock()
        server.totpExpectedConfirmCode = "111111"
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.beginEnrollment()
        await vm.confirmEnrollment(sampleCode: "999999")

        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertTrue(msg.contains("didn't match"))
        XCTAssertNil(server.accountTypeByUser["alice"])     // not flipped
        XCTAssertNil(server.recoveryCodesByUser["alice"])   // codes not issued
    }

    func test_emptyCode_failsImmediately() async throws {
        try await makeUMK()
        let server = try await freshMock()
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })
        await vm.beginEnrollment()

        await vm.confirmEnrollment(sampleCode: "   ")

        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertTrue(msg.contains("6-digit"))
    }

    func test_recoveryCodesDisplayGate_dismissEnrollmentScrubsCodes() async throws {
        try await makeUMK()
        let server = try await freshMock()
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.beginEnrollment()
        await vm.confirmEnrollment(sampleCode: "123456")
        guard case .confirmed = vm.phase else {
            return XCTFail("expected .confirmed, got \(vm.phase)")
        }

        vm.dismissEnrollment()
        if case .idle = vm.phase {} else {
            XCTFail("expected .idle after dismissEnrollment, got \(vm.phase)")
        }
        // accountType still reflects the live multi-device flip; the
        // dismiss only scrubs the in-memory plaintext codes.
        XCTAssertEqual(vm.accountType, "multi")
    }

    func test_disable_happyPath_flipsBackToSingle() async throws {
        try await makeUMK()
        let server = try await freshMock()
        server.totpExpectedConfirmCode = "424242"
        // Pretend the user is already enrolled.
        server.accountTypeByUser["alice"] = "multi"
        server.totpEnrolledAtByUser["alice"] = 1_700_000_000_000
        server.totpSecretByUser["alice"] = "STAGED"
        server.recoveryCodesByUser["alice"] = ["abc"]
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.disableEnrollment(code: "424242")

        if case .disabled = vm.phase {} else {
            XCTFail("expected .disabled, got \(vm.phase)")
        }
        XCTAssertEqual(vm.accountType, "single")
        XCTAssertNil(vm.totpEnrolledAt)
        // Worker mirror also scrubbed.
        XCTAssertNil(server.totpSecretByUser["alice"])
        XCTAssertNil(server.recoveryCodesByUser["alice"])
    }

    func test_disable_codeMismatch_surfacedAsFailed() async throws {
        try await makeUMK()
        let server = try await freshMock()
        server.accountTypeByUser["alice"] = "multi"
        server.totpExpectedConfirmCode = "111111"
        let vm = AccountSecurityViewModel(server: server, username: { "alice" })

        await vm.disableEnrollment(code: "999999")

        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertTrue(msg.contains("didn't match"))
        XCTAssertEqual(server.accountTypeByUser["alice"], "multi") // still enrolled
    }

    func test_withoutUsername_beginFailsCleanly() async throws {
        try await makeUMK()
        let server = try await freshMock()
        let vm = AccountSecurityViewModel(server: server, username: { nil })

        await vm.beginEnrollment()

        if case .failed = vm.phase {} else {
            XCTFail("expected .failed when no username, got \(vm.phase)")
        }
    }

    func test_canonicalBytes_matchProtocolSpec() {
        // Conformance to packages/protocol/src/auth.ts canonical
        // strings ("flagship/totp-enroll-begin/v1|<username>|<ms>").
        // Mismatch here breaks the Ed25519 verify on the Worker side.
        let begin = TotpEnrollBeginCanonical.bytes(username: "alice", issuedAt: 100)
        XCTAssertEqual(String(data: begin, encoding: .utf8), "flagship/totp-enroll-begin/v1|alice|100")
        let confirm = TotpEnrollConfirmCanonical.bytes(username: "alice", issuedAt: 200)
        XCTAssertEqual(String(data: confirm, encoding: .utf8), "flagship/totp-enroll-confirm/v1|alice|200")
        let disable = TotpDisableCanonical.bytes(username: "alice", issuedAt: 300)
        XCTAssertEqual(String(data: disable, encoding: .utf8), "flagship/totp-disable/v1|alice|300")
    }
}
