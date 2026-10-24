import XCTest
import CryptoKit
@testable import FlagshipCore

final class PqIdentityBinderTests: XCTestCase {
    private func ids() -> (irk: PqIdentity, admin: PqIdentity, device: PqIdentity) {
        (PqIdentity(role: .accountIrk, subjectId: "Alice", edKey: .init()),
         PqIdentity(role: .adminRoot, subjectId: "alice", edKey: .init()),
         PqIdentity(role: .device, subjectId: String(repeating: "ab", count: 16), edKey: .init()))
    }

    private func trust(_ com: MockPqKeyBindingClient, _ all: [PqIdentity]) {
        for i in all { com.currentKeys["\(i.role.rawValue)|\(i.subjectId)"] = i.edPubHex }
    }

    func testBindsEveryIdentityOnceAndTheBindingsVerify() async throws {
        let (irk, admin, device) = ids()
        let store = InMemoryPqIdentityKeyStore(), com = MockPqKeyBindingClient()
        trust(com, [irk, admin, device])
        let binder = PqIdentityBinder(store: store, client: com)
        let out = await binder.run(username: "alice", identities: [irk, admin, device])
        XCTAssertEqual(out, [.accountIrk: .bound, .adminRoot: .bound, .device: .bound])
        let remote = try await com.fetch(username: "alice")
        let w = try XCTUnwrap(remote?.accountIrk)
        XCTAssertEqual(w.subjectId, "alice")
        XCTAssertNoThrow(try PqTrust.verifyPqKeyBinding(w, PqBindingExpectation(role: "account-irk", subjectId: "alice", ed25519PubHex: irk.edPubHex, now: w.issuedAt)))
        // A second run does nothing new.
        com.offline = true
        let again = await binder.run(username: "alice", identities: [irk, admin, device])
        XCTAssertEqual(again, [.accountIrk: .bound, .adminRoot: .bound, .device: .bound])
    }

    func testDefersWhenOfflineOrKeysUnavailableOrComRefuses() async {
        let (irk, _, device) = ids()
        let store = InMemoryPqIdentityKeyStore(), com = MockPqKeyBindingClient()
        trust(com, [device])
        let binder = PqIdentityBinder(store: store, client: com)
        // The IRK is not .com's current key (e.g. a re-pair still waiting): refused, retried later.
        com.offline = true
        var out = await binder.run(username: "alice", identities: [irk, device])
        XCTAssertEqual(out, [.accountIrk: .pending, .device: .pending])
        com.offline = false
        store.available = false
        out = await binder.run(username: "alice", identities: [device])
        XCTAssertEqual(out[.device], .pending)
        store.available = true
        out = await binder.run(username: "alice", identities: [irk, device])
        XCTAssertEqual(out, [.accountIrk: .pending, .device: .bound])
        // The re-pair completes: the rotated IRK is now current and binds.
        trust(com, [irk])
        out = await binder.run(username: "alice", identities: [irk])
        XCTAssertEqual(out[.accountIrk], .bound)
    }

    func testAnotherDevicesBindingWinsAndThisOneStops() async throws {
        let (irk, _, _) = ids()
        let com = MockPqKeyBindingClient()
        trust(com, [irk])
        // Device 1 binds the IRK.
        let first = PqIdentityBinder(store: InMemoryPqIdentityKeyStore(), client: com)
        _ = await first.run(username: "alice", identities: [irk])
        // Device 2 holds the same IRK (same UMK) but cannot rebind it: 409, stop.
        let store2 = InMemoryPqIdentityKeyStore()
        let second = PqIdentityBinder(store: store2, client: com)
        var out = await second.run(username: "alice", identities: [irk])
        XCTAssertEqual(out[.accountIrk], .boundElsewhere)
        out = await second.run(username: "alice", identities: [irk])
        XCTAssertEqual(out[.accountIrk], .boundElsewhere)
        // With .com's view at hand, a third device skips it without making a key.
        let third = PqIdentityBinder(store: InMemoryPqIdentityKeyStore(), client: com)
        out = await third.run(username: "alice", identities: [irk], remote: try await com.fetch(username: "alice"))
        XCTAssertEqual(out[.accountIrk], .boundElsewhere)
    }

    func testCustodyLabelsAreTheOwnersWording() {
        XCTAssertEqual(PqCustody.hardwareWrapped.label, "PQ, hardware-wrapped")
        XCTAssertEqual(PqCustody.hardware.label, "hardware PQ")
    }

    func testPutOutcomesFollowTheServerContract() {
        func o(_ s: Int, _ e: String?) -> PqBindingPutOutcome {
            LivePqKeyBindingClient.outcome(status: s, body: e.map { Data("{\"error\":\"\($0)\"}".utf8) } ?? Data("{\"ok\":true}".utf8))
        }
        XCTAssertEqual(o(200, nil), .stored)
        XCTAssertEqual(o(409, "stale"), .alreadyStored)
        XCTAssertEqual(o(409, "pq-key-changed"), .boundElsewhere)
        XCTAssertEqual(o(403, "binding-key-mismatch"), .retryLater("binding-key-mismatch"))
        XCTAssertEqual(o(404, "unknown account"), .retryLater("unknown account"))
    }
}

/// A served policy chain replayed through the gate: a strict scope is enforced end to end,
/// a classical-only or forked or replayed change is refused.
final class AssurancePolicyChainTests: XCTestCase {
    private let scope = PolicyScope(kind: .installation, id: "home.alice.flagship.services")

    private func signed(_ c: AssurancePolicyChange, edSeed: [UInt8], mlSeed: [UInt8], suite: SignatureSuite) throws -> AssurancePolicy.SignedChange {
        let msg = try AssurancePolicy.canonical(c)
        let sig: [UInt8]
        switch suite {
        case .hybrid: sig = try PqHybrid.hybridSign(secretKey: edSeed + mlSeed, purpose: AssurancePolicy.tag, payload: msg)
        case .ed25519: sig = PqBytes(try Curve25519.Signing.PrivateKey(rawRepresentation: edSeed).signature(for: msg))
        }
        return .init(change: c, signature: SignatureEnvelope(suite: suite.rawValue, signature: PqBin.hex(sig)))
    }

    func testStrictChainReplaysAndRefusesDowngrades() throws {
        let edSeed = PqHybrid.randomSeed(), mlSeed = PqHybrid.randomSeed()
        let kp = try PqHybrid.hybridSigKeygen(edSeed: edSeed, mldsaSeed: mlSeed)
        let edHex = PqBin.hex(Array(kp.publicKey[0..<32])), mlHex = PqBin.hex(Array(kp.publicKey[32...]))
        let now: Int64 = 1_790_000_000_000
        let stmt = PqKeyBindingStatement(role: "admin-root", subjectId: "alice", ed25519PubHex: edHex, mldsaPubHex: mlHex, issuedAt: now)
        let wire = try PqTrust.signPqKeyBinding(stmt) { try PqHybrid.hybridSign(secretKey: edSeed + mlSeed, purpose: $0, payload: $1) }
        let binding = try PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(role: "admin-root", subjectId: "alice", ed25519PubHex: edHex, now: now))

        var start = AssurancePolicy.legacyState(scope)
        start = try AssurancePolicy.advanceRollout(start, to: .capable, evidence: .init(capabilityAdvertised: true))
        start = try AssurancePolicy.advanceRollout(start, to: .prepared, evidence: .init(boundPublicKeys: true, recipientsVerified: true, recoveryChecked: true))

        let toStrict = AssurancePolicyChange(account: "alice", scope: scope, prior: .compatibility, next: .strict, generation: 1,
                                             prevDigest: AssurancePolicy.genesisDigest, affectedPeersDigest: String(repeating: "a", count: 64),
                                             acknowledgedLoss: [], reentry: nil, signerKind: .adminRoot, signerKeyId: edHex, suite: .hybrid, issuedAt: now)
        let link1 = try signed(toStrict, edSeed: edSeed, mlSeed: mlSeed, suite: .hybrid)
        let check: (_ m: [UInt8], _ l: AssurancePolicy.SignedChange, _ s: PolicyState) -> (suiteVerified: Bool, signerActive: Bool) = { m, l, s in
            AssurancePolicy.gateCheck(m, l, stateBefore: s, binding: binding, signerActive: l.change.signerKeyId == edHex)
        }
        let strict = try AssurancePolicy.replay(chain: [link1], start: start, current: nil, check: check)
        XCTAssertTrue(AssurancePolicy.strictInForce(strict))

        // A classical-only opt-out cannot weaken it.
        let out = AssurancePolicyChange(account: "alice", scope: scope, prior: .strict, next: .compatibility, generation: 2,
                                        prevDigest: strict.headDigest, affectedPeersDigest: String(repeating: "a", count: 64),
                                        acknowledgedLoss: ["classical-signatures-accepted"], reentry: nil, signerKind: .adminRoot,
                                        signerKeyId: edHex, suite: .ed25519, issuedAt: now + 1)
        let classical = try signed(out, edSeed: edSeed, mlSeed: mlSeed, suite: .ed25519)
        XCTAssertThrowsError(try AssurancePolicy.replay(chain: [link1, classical], start: start, current: strict, check: check)) {
            XCTAssertEqual(($0 as? PolicyError)?.code, "bad-signature")
        }
        // The same opt-out signed hybrid is accepted.
        var hybridOut = out; hybridOut.suite = .hybrid
        let link2 = try signed(hybridOut, edSeed: edSeed, mlSeed: mlSeed, suite: .hybrid)
        let compat = try AssurancePolicy.replay(chain: [link1, link2], start: start, current: strict, check: check)
        XCTAssertFalse(AssurancePolicy.strictInForce(compat))
        XCTAssertTrue(compat.enforcedEver)
        // A served chain shorter than what this device holds is a rollback.
        XCTAssertThrowsError(try AssurancePolicy.replay(chain: [link1], start: start, current: compat, check: check)) {
            XCTAssertEqual(($0 as? PolicyError)?.code, "rollback-refused")
        }
        // Another signer is not an owner authority.
        XCTAssertThrowsError(try AssurancePolicy.replay(chain: [link1], start: start, current: nil) { m, l, s in
            AssurancePolicy.gateCheck(m, l, stateBefore: s, binding: binding, signerActive: false)
        }) { XCTAssertEqual(($0 as? PolicyError)?.code, "signer-not-active") }
    }
}
