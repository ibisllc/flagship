import XCTest
@testable import FlagshipCore

/// PINNED cross-platform vectors for the maintainer-trust ENFORCEMENT feature
/// (`verifyComBlessing` / `authorizedCaKeys`), the half of the maintainers port
/// the app's control-server trust gate calls.
///
/// The vectors below are produced by a node script run against
/// `@ibisllc/maintainers` with the SAME fixed seeds as
/// `maintainers/packages/cli/tests/caEndorsement.test.ts` (`caRootMandate`):
/// maintainer = `keypair(1)` (seed = 32 bytes, byte[0]=1), hotCa = `keypair(9)`.
/// Captured literal canonical-byte strings + signatures + pubkeys are embedded
/// here exactly like `DaemonStatusVerifierTests`. They MUST match Worker A's
/// `packages/protocol/tests/fixtures/maintainerTrust.vectors.json` and the
/// Android `MaintainerTrustVectorTest.kt` byte-for-byte — regenerate only on a
/// deliberate v2 of the format.
final class MaintainerTrustVectorTests: XCTestCase {

    // MARK: - Pinned vector values (authoritative, from @ibisllc/maintainers)

    static let pin = "a170c80dcf3b6d1d42fcc196c8d5f2dbec7a87db6a3d5d2692773442af4a62ee"
    static let maintainerPub = "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
    static let hotCaPub = "bb5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a"
    static let roguePub = "d523845a249f6994b019cbb33057d352237858ff79a98cb2359d805ee45044d6"

    static let rootSig =
        "5a72395870ce102c85eadec3c5927aeb28f02a90e2d56eea59773b60a7ea5dd5" +
        "96c1c5ba70965fba939d6f558afcb222ddffc50dc8856f2e7fe1c5e8792fa402"
    static let endorsementSig =
        "1702e3497ea944eff9586b5f596787715fa3f37431fbe381adac87d6ed440da3" +
        "8d62bee536d701f9b76326ea1823b6244271ef27e18fd062b51ca8843f178102"

    static let rootCanonical =
        "maintainers/mandate/v1|ca-root-0000-4000-8000-000000000000|ca|" +
        "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc|" +
        "2026-01-01T00:00:00.000Z|2027-01-01T00:00:00.000Z|" +
        "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc|" +
        "1|1|31536000|31536000|flagship|harry@flagship.services||ca|" +
        "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"

    static let endCanonical =
        "maintainers/ca-endorsement/v1|ca-e1-0000-0000-0000-000000000000|ca|" +
        "bb5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a|" +
        "flagship/directory-attestation|2026-05-17T12:00:00.000Z|" +
        "2026-05-24T12:00:00.000Z|2026-05-17T12:00:00.000Z|" +
        "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"

    // Lease window: notBefore .. notAfter = 2026-05-17 .. 2026-05-24.
    static let withinMs: Int64 = 1_779_235_200_000 // 2026-05-20
    static let afterMs: Int64 = 1_782_777_600_000  // 2026-06-30 (lapsed)
    static let beforeMs: Int64 = 1_777_593_600_000 // 2026-05-01 (not-yet)

    // MARK: - Fixtures

    static func root() -> Mandate {
        Mandate(
            kind: "Mandate", version: 1,
            mandateId: "ca-root-0000-4000-8000-000000000000",
            track: "ca", holder: maintainerPub,
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2027-01-01T00:00:00.000Z",
            successors: [maintainerPub],
            approvalRule: .init(kind: "threshold", threshold: 1),
            minSuccessors: 1,
            maxDurationSeconds: 31_536_000,
            defaultDurationSeconds: 31_536_000,
            project: .init(name: "flagship", contact: "harry@flagship.services",
                           homepage: nil, tracks: ["ca"]),
            signedBy: maintainerPub,
            signatures: [.init(pubkey: maintainerPub, sig: rootSig)]
        )
    }

    static func endorsement(caPubkey: String = hotCaPub,
                            signedBy: String = maintainerPub,
                            sig: String = endorsementSig) -> CaEndorsement {
        CaEndorsement(
            kind: "CaEndorsement", version: 1,
            endorsementId: "ca-e1-0000-0000-0000-000000000000",
            track: "ca", caPubkey: caPubkey,
            scope: "flagship/directory-attestation",
            notBefore: "2026-05-17T12:00:00.000Z",
            notAfter: "2026-05-24T12:00:00.000Z",
            issuedAt: "2026-05-17T12:00:00.000Z",
            signedBy: signedBy,
            signatures: [.init(pubkey: maintainerPub, sig: sig)]
        )
    }

    private func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000.0) }

    // MARK: - Byte identity

    func testCanonicalBytesByteIdentical() throws {
        // Mandate
        let m = try XCTUnwrap(try? MaintainersCanonical.canonicalMandate(Self.root()))
        XCTAssertEqual(String(data: m, encoding: .utf8), Self.rootCanonical)
        // CaEndorsement
        let e = try XCTUnwrap(try? MaintainersCanonical.canonicalCaEndorsement(Self.endorsement()))
        XCTAssertEqual(String(data: e, encoding: .utf8), Self.endCanonical)
    }

    func testPinHashMatches() throws {
        let h = try MaintainersCanonical.mandatePinHash(Self.root())
        XCTAssertEqual(h, Self.pin)
    }

    func testPinnedSignaturesVerify() throws {
        let mBytes = try MaintainersCanonical.canonicalMandate(Self.root())
        XCTAssertTrue(MaintainersEd25519.verify(sigHex: Self.rootSig, message: mBytes,
                                                pubKeyHex: Self.maintainerPub))
        let eBytes = try MaintainersCanonical.canonicalCaEndorsement(Self.endorsement())
        XCTAssertTrue(MaintainersEd25519.verify(sigHex: Self.endorsementSig, message: eBytes,
                                                pubKeyHex: Self.maintainerPub))
    }

    // MARK: - Chain + authorized keys verdicts

    func testChainAnchorsAtPin() {
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: Self.pin, mandates: [Self.root()])
        XCTAssertNil(chain.rootError)
        XCTAssertEqual(chain.validMandates.count, 1)
        XCTAssertEqual(chain.root?.holder, Self.maintainerPub)
    }

    func testAuthorizedKeysWithinWindow() {
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: Self.pin, mandates: [Self.root()])
        let keys = MaintainersCaVerifier.authorizedCaKeys(
            [Self.endorsement()], caChain: chain, now: date(Self.withinMs))
        XCTAssertEqual(keys, [Self.hotCaPub])
    }

    func testAuthorizedKeysEmptyWhenLapsed() {
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: Self.pin, mandates: [Self.root()])
        XCTAssertEqual(
            MaintainersCaVerifier.authorizedCaKeys([Self.endorsement()], caChain: chain,
                                                   now: date(Self.afterMs)),
            [])
    }

    func testAuthorizedKeysEmptyWhenNotYet() {
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: Self.pin, mandates: [Self.root()])
        XCTAssertEqual(
            MaintainersCaVerifier.authorizedCaKeys([Self.endorsement()], caChain: chain,
                                                   now: date(Self.beforeMs)),
            [])
    }

    func testEmptyPinFailsClosed() {
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: "", mandates: [Self.root()])
        XCTAssertEqual(chain.rootError, .noPin)
        XCTAssertEqual(
            MaintainersCaVerifier.authorizedCaKeys([Self.endorsement()], caChain: chain,
                                                   now: date(Self.withinMs)),
            [])
    }

    // MARK: - verifyComBlessing (the feature's top-level verdict)

    private func blessing(pin: String? = nil,
                          caPubkey: String? = nil,
                          mandates: [Mandate]? = nil,
                          endorsements: [CaEndorsement]? = nil)
        -> MaintainerBlessing {
        MaintainerBlessing(
            pinnedMandateHash: pin ?? Self.pin,
            caPubkey: caPubkey ?? Self.hotCaPub,
            mandates: mandates ?? [Self.root()],
            caEndorsements: endorsements ?? [Self.endorsement()])
    }

    func testBlessingTrustedWithinWindow() {
        XCTAssertTrue(
            MaintainersTrust.verifyComBlessing(
                blessing(), now: date(Self.withinMs), bakedPinOverride: Self.pin))
    }

    func testBlessingUntrustedWhenLapsed() {
        XCTAssertFalse(
            MaintainersTrust.verifyComBlessing(
                blessing(), now: date(Self.afterMs), bakedPinOverride: Self.pin))
    }

    func testBlessingUntrustedWhenComServesUnauthorizedKey() {
        // `.com` claims a CA pubkey the lease did not authorize.
        XCTAssertFalse(
            MaintainersTrust.verifyComBlessing(
                blessing(caPubkey: Self.roguePub),
                now: date(Self.withinMs), bakedPinOverride: Self.pin))
    }

    func testBlessingUntrustedWhenComLowersTheFloor() {
        // `.com` asserts a DIFFERENT pin than our baked one — never accepted.
        XCTAssertFalse(
            MaintainersTrust.verifyComBlessing(
                blessing(pin: String(repeating: "0", count: 64)),
                now: date(Self.withinMs), bakedPinOverride: Self.pin))
    }

    func testBlessingUntrustedWhenSignedByRogue() {
        // A lease whose signer isn't the chain authority is rejected.
        let bad = Self.endorsement(signedBy: Self.roguePub)
        XCTAssertFalse(
            MaintainersTrust.verifyComBlessing(
                blessing(endorsements: [bad]),
                now: date(Self.withinMs), bakedPinOverride: Self.pin))
    }

    func testBlessingFailsClosedOnEmptyBakedPin() {
        XCTAssertFalse(
            MaintainersTrust.verifyComBlessing(
                blessing(), now: date(Self.withinMs), bakedPinOverride: ""))
    }
}
