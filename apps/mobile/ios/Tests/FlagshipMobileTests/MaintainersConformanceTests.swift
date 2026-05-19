import XCTest
@testable import FlagshipCore

/// Cross-language conformance replay for the maintainers trust port (#10).
///
/// This loads the SHARED, dependency-free conformance artifact from disk
/// at runtime — the artifact ships inside the published
/// `@ibisllc/maintainers` npm package, so it is resolved from
/// `<repoRoot>/node_modules/@ibisllc/maintainers/conformance/manifest.json`
/// + `vectors/*.json` — the exact same set the TypeScript side replays.
/// The vectors are NOT transcribed into Swift literals; they are read and
/// parsed from the real files. For EVERY vector we run the native Swift
/// verifier for that subject and assert the verdict (accepted, and on
/// rejection the EXACT rejectReason) equals the manifest entry.
///
/// "Conformant iff it produces the expected verdict for EVERY vector,
/// including every fail-closed negative."
final class MaintainersConformanceTests: XCTestCase {

    // MARK: - JSON decoding of the portable vector shape

    private struct ManifestEntry: Decodable {
        let name: String
        let file: String
        let subject: String          // mandate-chain | release-endorsement | ca-endorsement
        let accepted: Bool
        let rejectReason: String?
    }

    private struct Manifest: Decodable {
        let schemaVersion: Int
        let count: Int
        let vectors: [ManifestEntry]
    }

    /// Mirror of the TS `ConformanceVector.input`. JSON values are decoded
    /// with the same tolerance the TS typed model implies; anything the TS
    /// `isMandateShape` would reject we still decode (the verifier itself
    /// is the gate, not the decoder) — the conformance vectors only carry
    /// shape-valid envelopes whose adversarial content is exercised inside
    /// the verifier (e.g. a non-hex holder ⇒ canonicalization fails ⇒
    /// `signature-invalid`).
    private struct VectorFile: Decodable {
        let name: String
        let input: Input
        let expect: Expect

        struct Expect: Decodable {
            let accepted: Bool
            let rejectReason: String?
            let subject: String
            let track: String
        }

        struct Input: Decodable {
            let pin: String
            let now: String
            let track: String
            let mandatesByTrack: [String: [MandateJSON]]
            let endorsements: [ReleaseEndorsementJSON]
            let caEndorsements: [CaEndorsementJSON]
        }
    }

    private struct SignatureJSON: Decodable {
        let pubkey: String
        let sig: String
    }

    private struct ApprovalRuleJSON: Decodable {
        let kind: String
        let threshold: Int
    }

    private struct ProjectJSON: Decodable {
        let name: String?
        let contact: String?
        let homepage: String?
        let tracks: [String]?
    }

    private struct MandateJSON: Decodable {
        let kind: String
        let version: Int
        let mandateId: String
        let track: String
        let holder: String
        let issuedAt: String
        let expiresAt: String
        let successors: [String]
        let approvalRule: ApprovalRuleJSON
        let minSuccessors: Int
        let maxDurationSeconds: Int
        let defaultDurationSeconds: Int
        let project: ProjectJSON?
        let signedBy: String
        let signatures: [SignatureJSON]

        func model() -> Mandate {
            Mandate(
                kind: kind, version: version, mandateId: mandateId, track: track,
                holder: holder, issuedAt: issuedAt, expiresAt: expiresAt,
                successors: successors,
                approvalRule: MaintainersApprovalRule(kind: approvalRule.kind,
                                                      threshold: approvalRule.threshold),
                minSuccessors: minSuccessors,
                maxDurationSeconds: maxDurationSeconds,
                defaultDurationSeconds: defaultDurationSeconds,
                project: project.map {
                    MaintainersProject(name: $0.name, contact: $0.contact,
                                       homepage: $0.homepage, tracks: $0.tracks)
                },
                signedBy: signedBy,
                signatures: signatures.map { MaintainersSignature(pubkey: $0.pubkey, sig: $0.sig) }
            )
        }
    }

    private struct ReleaseEndorsementJSON: Decodable {
        let kind: String
        let version: Int
        let releaseId: String
        let semverTag: String
        let commitHash: String
        let previousReleaseId: String?
        let previousCommitHash: String?
        let intermediateCommits: [String]
        let intermediateMerkleRoot: String
        let endorsedNotes: String?
        let issuedAt: String
        let signedBy: String
        let signatures: [SignatureJSON]

        func model() -> ReleaseEndorsement {
            ReleaseEndorsement(
                kind: kind, version: version, releaseId: releaseId,
                semverTag: semverTag, commitHash: commitHash,
                previousReleaseId: previousReleaseId,
                previousCommitHash: previousCommitHash,
                intermediateCommits: intermediateCommits,
                intermediateMerkleRoot: intermediateMerkleRoot,
                endorsedNotes: endorsedNotes, issuedAt: issuedAt,
                signedBy: signedBy,
                signatures: signatures.map { MaintainersSignature(pubkey: $0.pubkey, sig: $0.sig) }
            )
        }
    }

    private struct CaEndorsementJSON: Decodable {
        let kind: String
        let version: Int
        let endorsementId: String
        let track: String
        let caPubkey: String
        let scope: String
        let notBefore: String
        let notAfter: String
        let issuedAt: String
        let signedBy: String
        let signatures: [SignatureJSON]

        func model() -> CaEndorsement {
            CaEndorsement(
                kind: kind, version: version, endorsementId: endorsementId,
                track: track, caPubkey: caPubkey, scope: scope,
                notBefore: notBefore, notAfter: notAfter, issuedAt: issuedAt,
                signedBy: signedBy,
                signatures: signatures.map { MaintainersSignature(pubkey: $0.pubkey, sig: $0.sig) }
            )
        }
    }

    // MARK: - Locate the shared conformance artifact on disk

    private struct ConformanceArtifactMissing: Error, CustomStringConvertible {
        let searchedFrom: String
        var description: String {
            "could not locate node_modules/@ibisllc/maintainers/conformance"
                + "/manifest.json from \(searchedFrom)"
        }
    }

    /// Walk up from this test file to the repo root and into the published
    /// npm package's `conformance/` directory. Read at runtime — never
    /// transcribed. An unlocatable artifact is a real FAILURE here (never
    /// a skip): without it the cross-language guarantee is unverified.
    private func conformanceDir() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // FlagshipMobileTests
        for _ in 0..<12 {
            let candidate = dir
                .appendingPathComponent("node_modules")
                .appendingPathComponent("@ibisllc")
                .appendingPathComponent("maintainers")
                .appendingPathComponent("conformance")
            if FileManager.default.fileExists(
                atPath: candidate.appendingPathComponent("manifest.json").path
            ) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        let missing = ConformanceArtifactMissing(searchedFrom: #filePath)
        XCTFail(missing.description)
        throw missing
    }

    // MARK: - Replay (mirror of conformance.test.ts `replay`)

    private struct Verdict: Equatable {
        let accepted: Bool
        let rejectReason: String?
    }

    /// Exact mirror of the TS `replay(vec)`: same functions, same order,
    /// the consumer's own `now`. Totality: must never throw.
    private func replay(_ vec: VectorFile) -> Verdict {
        let nowDate = MaintainersConformanceTests.parseISO(vec.input.now)
        let list = (vec.input.mandatesByTrack[vec.input.track] ?? []).map { $0.model() }
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: vec.input.pin, mandates: list
        )

        switch vec.expect.subject {
        case "mandate-chain":
            if MaintainersVerifier.currentAuthority(chain, now: nowDate) != nil {
                return Verdict(accepted: true, rejectReason: nil)
            }
            let reason: String
            if chain.root == nil {
                reason = chain.rootError?.rawValue ?? "pin-not-in-log"
            } else {
                reason = chain.rejections.first?.reason.rawValue ?? "no-authority-at-now"
            }
            return Verdict(accepted: false, rejectReason: reason)

        case "release-endorsement":
            let endorsements = vec.input.endorsements.map { $0.model() }
            let r = MaintainersReleaseVerifier.verifyChainOfEndorsements(
                endorsements, releaseChain: chain
            )
            if r.rejections.isEmpty && !r.validEndorsements.isEmpty {
                return Verdict(accepted: true, rejectReason: nil)
            }
            return Verdict(accepted: false,
                           rejectReason: r.rejections.first?.reason.rawValue
                                ?? "no-authority-at-issuance")

        default: // ca-endorsement
            let caEndorsements = vec.input.caEndorsements.map { $0.model() }
            let r = MaintainersCaVerifier.verifyCaEndorsements(
                caEndorsements, caChain: chain, now: nowDate
            )
            if r.rejections.isEmpty && !r.validEndorsements.isEmpty {
                return Verdict(accepted: true, rejectReason: nil)
            }
            return Verdict(accepted: false,
                           rejectReason: r.rejections.first?.reason.rawValue
                                ?? "no-ca-authority-at-now")
        }
    }

    private static func parseISO(_ s: String) -> Date {
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime]
        if let d = f1.date(from: s) { return d }
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f2.date(from: s) { return d }
        return Date(timeIntervalSince1970: 0)
    }

    // MARK: - Tests

    /// The baked pin equals the published `MAINTAINER_PINNED_MANDATE_HASH`
    /// and an empty pin fails closed with `no-pin` (never falls back).
    func test_pinnedConstant_isExactPublishedValue_andEmptyPinFailsClosed() {
        XCTAssertEqual(
            MaintainersTrust.pinnedMandateHash,
            "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae"
        )
        let chain = MaintainersVerifier.verifyMandateChainFromPin(
            pinnedHash: "", mandates: []
        )
        XCTAssertNil(chain.root)
        XCTAssertEqual(chain.rootError, .noPin)
        XCTAssertTrue(chain.validMandates.isEmpty)
        XCTAssertNil(MaintainersVerifier.currentAuthority(chain, now: Date()))
    }

    /// EVERY manifest vector replays to its declared verdict. This is the
    /// objective correctness gate — a green run that skipped a negative
    /// is a failed task, so this asserts the full set with no exclusions.
    func test_allConformanceVectors_replayToManifestVerdict() throws {
        let dir = try conformanceDir()
        let manifestData = try Data(
            contentsOf: dir.appendingPathComponent("manifest.json")
        )
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)

        XCTAssertEqual(manifest.schemaVersion, 1)
        XCTAssertEqual(manifest.vectors.count, manifest.count)
        XCTAssertEqual(manifest.vectors.count, 17,
                       "expected the full 17-vector cross-language set")

        var replayed = 0
        for entry in manifest.vectors {
            let vecURL = dir.appendingPathComponent(entry.file)
            let vecData = try Data(contentsOf: vecURL)
            let vec = try JSONDecoder().decode(VectorFile.self, from: vecData)

            XCTAssertEqual(vec.name, entry.name, "vector file name mismatch for \(entry.name)")
            XCTAssertEqual(vec.expect.subject, entry.subject,
                           "subject drift between manifest and vector for \(entry.name)")
            XCTAssertEqual(vec.expect.accepted, entry.accepted,
                           "accepted drift between manifest and vector for \(entry.name)")
            XCTAssertEqual(vec.expect.rejectReason, entry.rejectReason,
                           "rejectReason drift between manifest and vector for \(entry.name)")

            // Totality: replay must never throw on any (incl. adversarial) vector.
            let verdict = replay(vec)

            XCTAssertEqual(verdict.accepted, entry.accepted,
                           "[\(entry.name)] accepted: got \(verdict.accepted) want \(entry.accepted)")
            XCTAssertEqual(verdict.rejectReason, entry.rejectReason,
                           "[\(entry.name)] rejectReason: got \(String(describing: verdict.rejectReason)) want \(String(describing: entry.rejectReason))")
            replayed += 1
        }
        XCTAssertEqual(replayed, 17, "every manifest vector must be replayed")
    }
}
