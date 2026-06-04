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

    /// Cert autonomy is now a binary: default OFF = "managed" (an admin device
    /// renews). The renewal window is the account-wide CertValidityStore.
    func test_defaultCertIsManaged() {
        XCTAssertFalse(makeVM().certCanMint)
    }
}

/// The account-wide certificate-validity store: presets, default, and the
/// clamp that keeps a stray value from widening the window.
@MainActor
final class CertValidityStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let d = UserDefaults(suiteName: "cert-validity-test-\(UUID().uuidString)")!
        return d
    }

    func test_defaultIsThirtyDays() {
        XCTAssertEqual(CertValidityStore(defaults: freshDefaults()).days, 30)
    }

    func test_presetsAreSevenThirtyNinety() {
        XCTAssertEqual(CertValidityStore.presets, [7, 30, 90])
    }

    func test_nonPresetWriteClampsToDefault() {
        let store = CertValidityStore(defaults: freshDefaults())
        store.days = 7
        XCTAssertEqual(store.days, 7)
        store.days = 45  // not a preset
        XCTAssertEqual(store.days, 30)
    }

    func test_persistsAcrossInstances() {
        let d = freshDefaults()
        CertValidityStore(defaults: d).days = 90
        XCTAssertEqual(CertValidityStore(defaults: d).days, 90)
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
        // A managed window ⇒ `ca=managed:<days>`.
        let managed = signed(certAutonomy: .init(mode: "managed", offlineWindowDays: 30))
        XCTAssertTrue(
            String(data: managed.blob.canonicalBytes(), encoding: .utf8)!
                .hasSuffix("|\(rck)|ca=managed:30")
        )
        // Autonomous ⇒ `ca=autonomous:0` (days default to 0 on the wire).
        let autonomous = signed(certAutonomy: .init(mode: "autonomous"))
        XCTAssertTrue(
            String(data: autonomous.blob.canonicalBytes(), encoding: .utf8)!
                .hasSuffix("|\(rck)|ca=autonomous:0")
        )
    }

    // MARK: - On-wire JSON: certAutonomy key with mode + offlineWindowDays.

    func test_managedIncludesCertAutonomyWithDaysOnWire() throws {
        let j = try json(signed(certAutonomy: .init(mode: "managed", offlineWindowDays: 7)))
        XCTAssertTrue(j.contains("\"certAutonomy\""))
        XCTAssertTrue(j.contains("\"mode\":\"managed\""))
        XCTAssertTrue(j.contains("\"offlineWindowDays\":7"))
    }

    func test_autonomousOmitsOfflineWindowDaysOnWire() throws {
        // Autonomous ⇒ offlineWindowDays is nil ⇒ omitted (not `null`), matching
        // the optional TS field so the round-trip reconstructs identical bytes.
        let j = try json(signed(certAutonomy: .init(mode: "autonomous")))
        XCTAssertTrue(j.contains("\"certAutonomy\""))
        XCTAssertTrue(j.contains("\"mode\":\"autonomous\""))
        XCTAssertFalse(j.contains("offlineWindowDays"))
    }

    // MARK: - Round-trip parity with the OnWire decode (mode + days survive).

    func test_onWireCertAutonomyDecodesBackToManagedChoice() throws {
        let wire = signed(certAutonomy: .init(mode: "managed", offlineWindowDays: 30)).onWire()
        let data = try JSONEncoder().encode(wire)
        let back = try JSONDecoder().decode(SignedInstallBlob.OnWire.self, from: data)
        XCTAssertEqual(back.blob.certAutonomy?.mode, "managed")
        XCTAssertEqual(back.blob.certAutonomy?.offlineWindowDays, 30)
    }
}
