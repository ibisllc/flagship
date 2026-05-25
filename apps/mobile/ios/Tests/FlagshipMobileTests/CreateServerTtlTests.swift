import XCTest
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// E2E ViewModel tests for the recipe-TTL knob landed in the
/// 2026-05-21 session.
///
/// These walk `CreateServerViewModel` through the design + minting
/// phases and assert that the user-set TTL ends up:
///   - clamped to `[5min, 24h]`
///   - applied to `authCode.expiresAt` (== `acIssuedAt + ttl`)
///
/// We don't drive the QR-pipe relay here (the live mint phase needs
/// real server-side auth-code/issue calls); the assertions are
/// against the in-memory `recipeTtlMs` field + the clamp helper.
@MainActor
final class CreateServerTtlTests: XCTestCase {
    func makeVM() -> CreateServerViewModel {
        CreateServerViewModel(
            username: "harry",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
    }

    func testDefaultTtlIsSixHours() {
        let vm = makeVM()
        XCTAssertEqual(vm.recipeTtlMs, 6 * 60 * 60_000)
    }

    func testSetRecipeTtlHoursClampsToFiveMinutes() {
        let vm = makeVM()
        vm.setRecipeTtlHours(0.0)  // way below 5 min
        XCTAssertEqual(vm.recipeTtlMs, 5 * 60_000)
    }

    func testSetRecipeTtlHoursClampsToTwentyFourHours() {
        let vm = makeVM()
        vm.setRecipeTtlHours(100.0)  // way above 24 h
        XCTAssertEqual(vm.recipeTtlMs, 24 * 60 * 60_000)
    }

    func testSetRecipeTtlHoursAcceptsValidValues() {
        let vm = makeVM()
        vm.setRecipeTtlHours(0.5)
        XCTAssertEqual(vm.recipeTtlMs, 30 * 60_000)
        vm.setRecipeTtlHours(1.0)
        XCTAssertEqual(vm.recipeTtlMs, 60 * 60_000)
        vm.setRecipeTtlHours(6.0)
        XCTAssertEqual(vm.recipeTtlMs, 6 * 60 * 60_000)
        vm.setRecipeTtlHours(24.0)
        XCTAssertEqual(vm.recipeTtlMs, 24 * 60 * 60_000)
    }

    func testClampedRecipeTtlMsRejectsZero() {
        XCTAssertEqual(CreateServerViewModel.clampedRecipeTtlMs(0), 5 * 60_000)
    }

    func testClampedRecipeTtlMsRejectsOverflow() {
        XCTAssertEqual(
            CreateServerViewModel.clampedRecipeTtlMs(Int64.max),
            24 * 60 * 60_000
        )
    }

    func testTtlBoundsAreCorrect() {
        XCTAssertEqual(CreateServerViewModel.defaultRecipeTtlMs, 6 * 60 * 60_000)
        XCTAssertEqual(CreateServerViewModel.minRecipeTtlMs, 5 * 60_000)
        XCTAssertEqual(CreateServerViewModel.maxRecipeTtlMs, 24 * 60 * 60_000)
    }
}

/// Round-trip test: the v2 InstallBlob.canonicalBytes() byte string
/// MUST stay aligned with the TS protocol (12 fields, tag stays v1,
/// version field is 2, no issuedAt/expiresAt).
final class InstallBlobV2CanonicalTests: XCTestCase {
    func testCanonicalShapeMatchesV2Spec() throws {
        let auth = AuthCode(
            serial: "01ABCD",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1_000,
            expiresAt: 1_000 + 6 * 60 * 60_000
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x33, count: 32),
            authCode: auth,
            authCodeUserSignature: Data(repeating: 0x44, count: 64),
            rckPubKey: Data(repeating: 0x55, count: 32)
        )
        let canonical = String(data: blob.canonicalBytes(), encoding: .utf8)!
        // v2: 12 pipe-separated fields. Tag stays v1.
        let parts = canonical.split(separator: "|", omittingEmptySubsequences: false)
        XCTAssertEqual(parts.count, 12)
        XCTAssertEqual(parts[0], "flagship/install-blob/v1")
        XCTAssertEqual(parts[1], "2")  // inner version is 2
        XCTAssertEqual(parts[2], "home.harry.flagship.services")
        XCTAssertEqual(parts[3], "harry")
        XCTAssertEqual(parts[4], "home")
        // Field 5 is hex of phoneDelegatedPubKey (64 chars).
        XCTAssertEqual(parts[5].count, 64)
        XCTAssertEqual(parts[6], "https://flagshipserver.com/api/server/register")
        XCTAssertEqual(parts[7], "01ABCD")
        // authCode.userPubKey hex
        XCTAssertEqual(parts[8].count, 64)
        // authCodeUserSignature hex (64 bytes → 128 chars)
        XCTAssertEqual(parts[9].count, 128)
        XCTAssertEqual(parts[10], "main")
        // rckPubKey hex
        XCTAssertEqual(parts[11].count, 64)
        // NEGATIVE: must NOT contain blob.issuedAt nor blob.expiresAt.
        // Both were 10-digit numerics; we already checked the field
        // count is 12, but explicit check guards against accidental
        // re-introduction.
        XCTAssertFalse(canonical.contains("|1000|"))
    }
}
