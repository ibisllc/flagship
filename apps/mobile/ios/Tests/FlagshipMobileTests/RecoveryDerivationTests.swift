import XCTest
import CryptoKit
@testable import Flagship

/// THE cross-platform lock for WebAuthn-PRF cloud recovery (Tasks #2/#4).
///
/// `RecoveryDerivation.derivePassphraseSecrets` must produce byte-identical
/// `fetchToken` + `prfSalt` to the webapp's canonical reference
/// `apps/web/public/recovery/recovery.js` (`derivePassphraseSecrets`). The
/// known-answer vector below was generated from that JS impl for
/// passphrase = "correct horse battery staple", username = "demo1234"; if
/// the iOS derivation drifts, a passphrase enrolled on the webapp will not
/// re-derive here (and vice-versa), silently bricking cross-device cloud
/// recovery. These assertions are the regression guard.
final class RecoveryDerivationTests: XCTestCase {

    private let passphrase = "correct horse battery staple"
    private let username = "demo1234"

    // For reference (the Argon2id 32-byte master key before the HKDF split),
    // independently confirmed against recovery.js's noble argon2id:
    //   3caa60297e4e7b47706de4daad0113474b83adceb347d687cd75f95be68abc59
    private let expectedFetchToken =
        "abc2929a7c417541d592d50e97e1ae50b6f1e04a97332c951f9be7fb445a2f35"
    private let expectedPrfSalt =
        "989187b759f0532849837ced25036b2d8b6fec7e3fd2b8980ad94063ad4d46f2"
    private let expectedFetchTokenHash =
        "1855f76047a70b68cd18403ca6c907cfa633763a66778d81eb365d27bfd852ef"
    private let expectedPrfSaltHash =
        "7b4f096b4f508e43a587721de4f8377ea694bee808d6ba3061d83ddd1f33d5bd"

    /// THE slow test (~1-2s): Argon2id at 46 MiB is intentionally expensive.
    /// It locks our derivation byte-for-byte to recovery.js.
    func test_kat_derivePassphraseSecrets_matchesWebappReference() throws {
        let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, username)
        XCTAssertEqual(hex(secrets.fetchToken), expectedFetchToken, "fetchToken drift from recovery.js")
        XCTAssertEqual(hex(secrets.prfSalt), expectedPrfSalt, "prfSalt drift from recovery.js")
        XCTAssertEqual(secrets.fetchToken.count, 32)
        XCTAssertEqual(secrets.prfSalt.count, 32)
    }

    /// The SHA-256 hashes shipped to / compared by the Worker
    /// (`fetchTokenHash` / `prfSaltHash`).
    func test_kat_hashes_matchReference() throws {
        let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, username)
        XCTAssertEqual(RecoveryDerivation.sha256Hex(secrets.fetchToken), expectedFetchTokenHash)
        XCTAssertEqual(RecoveryDerivation.sha256Hex(secrets.prfSalt), expectedPrfSaltHash)
    }

    /// The salt is the LOWER-CASED username (recovery.js lower-cases it),
    /// so a mixed-case username derives the same secrets as its lowercase
    /// form. Reuses one derivation result rather than paying Argon2 twice.
    func test_usernameIsLowercased() throws {
        let lower = try RecoveryDerivation.derivePassphraseSecrets(passphrase, "demo1234")
        let mixed = try RecoveryDerivation.derivePassphraseSecrets(passphrase, "DEMO1234")
        XCTAssertEqual(lower, mixed)
        XCTAssertEqual(hex(lower.fetchToken), expectedFetchToken)
    }

    private func hex(_ d: Data) -> String {
        d.map { String(format: "%02x", $0) }.joined()
    }
}
