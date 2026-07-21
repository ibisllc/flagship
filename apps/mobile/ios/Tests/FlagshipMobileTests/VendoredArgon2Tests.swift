import XCTest
import Foundation
@testable import FlagshipArgon2

/// Byte-compatibility gate for the locally-vendored phc-winner-argon2
/// (`Vendor/CArgon2` + `FlagshipArgon2`), which replaced the external
/// `Argon2Kit` SPM submodule. argon2id (v1.3) is the KDF for both the
/// `.flagshipkey` backup and recovery, and those outputs MUST stay
/// byte-identical with Android (BouncyCastle) + the webapp (WASM). A single
/// wrong byte here breaks every existing keyfile / recovery enrolment.
///
/// The vendored source is the same repo at the same pinned revision Argon2Kit
/// 0.1.1 wrapped (`62358ba2123abd17fccf2a108a301d4b52c01a7c`), built with the
/// portable `ref.c` — so the output is identical by construction. This test
/// PROVES it with a known-answer vector computed directly against the
/// reference `argon2_hash(...)` C API.
final class VendoredArgon2Tests: XCTestCase {

    private func hex(_ d: Data) -> String {
        d.map { String(format: "%02x", $0) }.joined()
    }

    /// KAT computed against the reference phc-winner-argon2 `argon2_hash` API
    /// (pinned revision) with EXACTLY the `.flagshipkey` parameters
    /// (m=65536 KiB, t=3, p=4, len=32, argon2id, v1.3):
    ///
    ///   password = utf8("flagship-argon2-vendor-vector")
    ///   salt     = utf8("flagship-fixed-salt")
    ///   t=3, m=65536, p=4, len=32, Argon2_id, ARGON2_VERSION_13
    ///   => d537ad628de17b523d3d70aa1b5830b5b7db8407869e1661ef04e21c9d6d436f
    ///
    /// Reproduce upstream:
    ///   printf 'flagship-argon2-vendor-vector' | \
    ///     ./argon2 'flagship-fixed-salt' -id -v 13 -t 3 -m 16 -p 4 -l 32 -r
    /// (the CLI's `-m 16` is log2 of the m_cost; 2^16 = 65536 KiB.)
    func test_flagshipkeyParams_rawHash_matchesReferenceKAT() throws {
        let digest = try Argon2.hash(
            password: Data("flagship-argon2-vendor-vector".utf8),
            salt: Data("flagship-fixed-salt".utf8),
            iterations: 3,
            memory: 65536,
            threads: 4,
            length: 32,
            type: .id,
            version: .v13
        )
        XCTAssertEqual(
            hex(digest.rawData),
            "d537ad628de17b523d3d70aa1b5830b5b7db8407869e1661ef04e21c9d6d436f",
            "Vendored argon2id output drifted from the reference KAT — this BREAKS cross-platform keyfile/recovery compatibility."
        )
        XCTAssertEqual(digest.rawData.count, 32)
    }

    /// Second KAT at the recovery params (m=46*1024 KiB, t=3, p=1, len=32),
    /// the exact shape `RecoveryDerivation` feeds Argon2 before its HKDF split.
    /// Computed against the same reference C API at the pinned revision:
    ///
    ///   password = utf8("correct horse battery staple")
    ///   salt     = utf8("flagship.recovery.argon2.v1|demo1234")
    ///   t=3, m=47104, p=1, len=32, Argon2_id, ARGON2_VERSION_13
    ///   => 3caa60297e4e7b47706de4daad0113474b83adceb347d687cd75f95be68abc59
    ///
    /// This is the SAME Argon2 master key the cross-platform
    /// RecoveryDerivation vector (iOS/Android/webapp) derives from before HKDF,
    /// so it directly pins Android/webapp parity at the recovery params too.
    func test_recoveryParams_rawHash_matchesCrossPlatformMasterKey() throws {
        let digest = try Argon2.hash(
            password: Data("correct horse battery staple".utf8),
            salt: Data("flagship.recovery.argon2.v1|demo1234".utf8),
            iterations: 3,
            memory: 46 * 1024,
            threads: 1,
            length: 32,
            type: .id,
            version: .v13
        )
        XCTAssertEqual(
            hex(digest.rawData),
            "3caa60297e4e7b47706de4daad0113474b83adceb347d687cd75f95be68abc59",
            "Vendored argon2id recovery master key drifted from the cross-platform vector."
        )
    }
}
