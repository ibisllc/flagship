import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// Per-server cert-autonomy wiring (per-user-cert design, Q-A): the
/// create-server view-model's `certAutonomy` choice must (a) map onto the
/// signed `InstallBlob.CertAutonomy`, (b) flow into the canonical bytes as the
/// `ca=<mode>:<days>` token (so the daemon's reconstructed signature matches),
/// and (c) ride the on-wire JSON under the `certAutonomy` key with `mode` +
/// `offlineWindowDays`, matching trailer.ts `InstallBlobJson`.
///
/// Mirrors the proven bootUnlockMode wiring (BootUnlockTests.swift): construct
/// the blob directly + inspect canonical bytes / OnWire JSON — no Secure Enclave
/// needed.
@MainActor
final class CreateServerCertAutonomyTests: XCTestCase {
    private func makeVM() -> CreateServerViewModel {
        CreateServerViewModel(
            username: "harry",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
    }

    func test_defaultCertAutonomyIsNinetyDays() {
        XCTAssertEqual(makeVM().certAutonomy, .days90)
    }
}

/// The `CertAutonomyChoice` → `InstallBlob.CertAutonomy` mapping. Every finite
/// window is "managed" with its day count; "Indefinite" is "autonomous" (the
/// box becomes a minter). `installBlob` ALWAYS returns a value.
final class CertAutonomyChoiceTests: XCTestCase {
    func test_installBlobMappingForEveryCase() {
        XCTAssertEqual(CertAutonomyChoice.days3.installBlob,      .init(mode: "managed", offlineWindowDays: 3))
        XCTAssertEqual(CertAutonomyChoice.days7.installBlob,      .init(mode: "managed", offlineWindowDays: 7))
        XCTAssertEqual(CertAutonomyChoice.days15.installBlob,     .init(mode: "managed", offlineWindowDays: 15))
        XCTAssertEqual(CertAutonomyChoice.days30.installBlob,     .init(mode: "managed", offlineWindowDays: 30))
        XCTAssertEqual(CertAutonomyChoice.days90.installBlob,     .init(mode: "managed", offlineWindowDays: 90))
        XCTAssertEqual(CertAutonomyChoice.indefinite.installBlob, .init(mode: "autonomous", offlineWindowDays: nil))
    }

    func test_labelsAreUserFacing() {
        XCTAssertEqual(CertAutonomyChoice.days3.label, "3 days")
        XCTAssertEqual(CertAutonomyChoice.days7.label, "7 days")
        XCTAssertEqual(CertAutonomyChoice.days15.label, "15 days")
        XCTAssertEqual(CertAutonomyChoice.days30.label, "30 days")
        XCTAssertEqual(CertAutonomyChoice.days90.label, "90 days")
        XCTAssertEqual(CertAutonomyChoice.indefinite.label, "Indefinite")
    }

    func test_allCasesAreSurfaced() {
        XCTAssertEqual(
            CertAutonomyChoice.allCases,
            [.days3, .days7, .days15, .days30, .days90, .indefinite]
        )
    }
}

/// Canonical-bytes + on-wire JSON for the cert-autonomy choice. The canonical
/// suffix MUST be `ca=<mode>:<days>` (matching the TS `canonicalInstallBlob`),
/// and the JSON MUST carry a `certAutonomy` object with the same `mode` +
/// `offlineWindowDays` that the daemon round-trips via trailer.ts.
final class CertAutonomyWireTests: XCTestCase {
    private func signed(certAutonomy: InstallBlob.CertAutonomy?) -> SignedInstallBlob {
        let auth = AuthCode(
            serial: "01ABCD",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1_000,
            expiresAt: 2_000
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x33, count: 32),
            authCode: auth,
            authCodeUserSignature: Data(repeating: 0x44, count: 64),
            rckPubKey: Data(repeating: 0x55, count: 32),
            certAutonomy: certAutonomy
        )
        return SignedInstallBlob(blob: blob, signatureHex: "ab")
    }

    private func json(_ s: SignedInstallBlob) throws -> String {
        String(data: try JSONEncoder().encode(s.onWire()), encoding: .utf8)!
    }

    // MARK: - Canonical bytes: the choice flows into the signed bytes.

    func test_choiceFlowsIntoCanonicalBytes() {
        let rck = String(repeating: "55", count: 32)
        // The default 90-day choice ⇒ `ca=managed:90`.
        let managed = signed(certAutonomy: CertAutonomyChoice.days90.installBlob)
        XCTAssertTrue(
            String(data: managed.blob.canonicalBytes(), encoding: .utf8)!
                .hasSuffix("|\(rck)|ca=managed:90")
        )
        // Indefinite ⇒ `ca=autonomous:0` (days default to 0 on the wire).
        let autonomous = signed(certAutonomy: CertAutonomyChoice.indefinite.installBlob)
        XCTAssertTrue(
            String(data: autonomous.blob.canonicalBytes(), encoding: .utf8)!
                .hasSuffix("|\(rck)|ca=autonomous:0")
        )
    }

    // MARK: - On-wire JSON: certAutonomy key with mode + offlineWindowDays.

    func test_managedIncludesCertAutonomyWithDaysOnWire() throws {
        let j = try json(signed(certAutonomy: CertAutonomyChoice.days7.installBlob))
        XCTAssertTrue(j.contains("\"certAutonomy\""))
        XCTAssertTrue(j.contains("\"mode\":\"managed\""))
        XCTAssertTrue(j.contains("\"offlineWindowDays\":7"))
    }

    func test_autonomousOmitsOfflineWindowDaysOnWire() throws {
        // Autonomous ⇒ offlineWindowDays is nil ⇒ omitted (not `null`), matching
        // the optional TS field so the round-trip reconstructs identical bytes.
        let j = try json(signed(certAutonomy: CertAutonomyChoice.indefinite.installBlob))
        XCTAssertTrue(j.contains("\"certAutonomy\""))
        XCTAssertTrue(j.contains("\"mode\":\"autonomous\""))
        XCTAssertFalse(j.contains("offlineWindowDays"))
    }

    // MARK: - Round-trip parity with the OnWire decode (mode + days survive).

    func test_onWireCertAutonomyDecodesBackToManagedChoice() throws {
        let wire = signed(certAutonomy: CertAutonomyChoice.days30.installBlob).onWire()
        let data = try JSONEncoder().encode(wire)
        let back = try JSONDecoder().decode(SignedInstallBlob.OnWire.self, from: data)
        XCTAssertEqual(back.blob.certAutonomy?.mode, "managed")
        XCTAssertEqual(back.blob.certAutonomy?.offlineWindowDays, 30)
    }
}
