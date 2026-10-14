import XCTest
import CryptoKit
@testable import FlagshipUI
import FlagshipAPI
import FlagshipCore

final class AccountReadCredentialsTests: XCTestCase {
    private final class Calls: @unchecked Sendable {
        var umk = 0
        var irk = 0
    }

    private let deviceId = "0123456789abcdef0123456789abcdef"

    func testNothingWithoutAStoredKeyOrASessionAndNoPromptPath() {
        let calls = Calls()
        let builder = AccountReadCredentials(
            storedDeviceKey: { _, _ in nil },
            sessionUMK: { calls.umk += 1; return nil },
            sessionIRK: { calls.irk += 1; return nil }
        )
        XCTAssertTrue(builder.credentials(username: "alice", deviceId: deviceId).isEmpty)
        // Only the no-prompt session readers were consulted.
        XCTAssertEqual(calls.umk, 1)
        XCTAssertEqual(calls.irk, 1)
    }

    func testAStoredDeviceKeySignsTheReadTokenPath() throws {
        let key = Curve25519.Signing.PrivateKey()
        let builder = AccountReadCredentials(
            storedDeviceKey: { _, _ in key },
            sessionUMK: { nil },
            sessionIRK: { nil },
            now: { 1_760_000_000_000 }
        )
        let creds = builder.credentials(username: "Alice", deviceId: deviceId)
        guard case .device(let auth)? = creds.first, creds.count == 1 else { return XCTFail("expected one device credential") }
        let canonical = AccountMetadata.canonicalDirectoryRequest(
            accountId: "alice", deviceId: deviceId, signerPubHex: auth.signerPubHex,
            method: "POST", path: "/api/accounts/alice/read-token",
            requestId: auth.requestId, issuedAt: auth.issuedAt
        )
        XCTAssertTrue(key.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(auth.signatureHex)), for: canonical))
    }

    func testASessionUmkGivesTheDeviceThenTheIrk() throws {
        let umk = Data(repeating: 0x2a, count: 32)
        let irk = Curve25519.Signing.PrivateKey()
        let builder = AccountReadCredentials(
            storedDeviceKey: { _, _ in nil },
            sessionUMK: { umk },
            sessionIRK: { irk }
        )
        let creds = builder.credentials(username: "plucky-avocet", deviceId: deviceId)
        XCTAssertEqual(creds.count, 2)
        guard case .device(let auth) = creds[0], case .irk(let envelope) = creds[1] else { return XCTFail("order") }
        let expected = try AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: "plucky-avocet", deviceId: deviceId)
        XCTAssertEqual(auth.signerPubHex, HexUtil.encode(expected.publicKey.rawRepresentation))
        XCTAssertEqual(envelope.auth.endpointLabel, "account-read-token")
        XCTAssertEqual(envelope.auth.phoneIrkPub, HexUtil.encode(irk.publicKey.rawRepresentation))
    }

    func testARecoveredPhoneWithoutADeviceIdUsesTheIrk() {
        let builder = AccountReadCredentials(
            storedDeviceKey: { _, _ in Curve25519.Signing.PrivateKey() },
            sessionUMK: { Data(repeating: 1, count: 32) },
            sessionIRK: { Curve25519.Signing.PrivateKey() }
        )
        let creds = builder.credentials(username: "alice", deviceId: "")
        XCTAssertEqual(creds.count, 1)
        if case .irk = creds.first {} else { XCTFail("expected the IRK") }
    }
}
