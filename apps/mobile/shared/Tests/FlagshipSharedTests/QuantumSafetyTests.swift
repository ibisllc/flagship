import XCTest
import CryptoKit
@testable import FlagshipCore

final class QuantumSafetyTests: XCTestCase {
    private let account = "alice"
    private let server = "home.alice.flagship.services"

    /// An admin root with its ML-DSA key bound, as the device that bound it holds them.
    private func adminRoot() throws -> (edPub: [UInt8], ed: Curve25519.Signing.PrivateKey, held: PqHeldKey, binding: VerifiedPqKeyBinding) {
        let ed = Curve25519.Signing.PrivateKey()
        let edPub = [UInt8](ed.publicKey.rawRepresentation)
        let seed = [UInt8](repeating: 7, count: 32)
        let mlPub = try PqHybrid.mldsa65PublicKey(seed: seed)
        let held = PqHeldKey(mldsaPubHex: PqBin.hex(mlPub), custody: .hardwareWrapped) { m, c in try PqHybrid.mldsa65Sign(seed: seed, message: m, context: c) }
        let st = PqKeyBindingStatement(role: "admin-root", subjectId: account, ed25519PubHex: PqBin.hex(edPub), mldsaPubHex: PqBin.hex(mlPub), issuedAt: 1)
        let wire = try PqTrust.signPqKeyBinding(st) { purpose, payload in
            try PqHybrid.hybridSign(edPublicKey: edPub, mldsaPublicKey: mlPub, purpose: purpose, payload: payload,
                                    edSign: { [UInt8](try ed.signature(for: Data($0))) }, mldsaSign: held.sign)
        }
        let b = try PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(role: "admin-root", subjectId: account, ed25519PubHex: PqBin.hex(edPub), now: 10))
        return (edPub, ed, held, b)
    }

    private func signed(_ c: AssurancePolicyChange, _ k: (edPub: [UInt8], ed: Curve25519.Signing.PrivateKey, held: PqHeldKey, binding: VerifiedPqKeyBinding)) throws -> AssurancePolicy.SignedChange {
        let env = try QuantumSafety.hybridEnvelope(message: try AssurancePolicy.canonical(c), edPublicKey: k.edPub,
                                                   edSign: { [UInt8](try k.ed.signature(for: Data($0))) }, held: k.held)
        return AssurancePolicy.SignedChange(change: c, signature: env)
    }

    func testStrictWithTheBrowserAnswerThenLeavingItAndAntiRollback() throws {
        let k = try adminRoot()
        let scope = PolicyScope(kind: .installation, id: server)
        let root = PqBin.hex(k.edPub)
        let replay = { (chain: [AssurancePolicy.SignedChange], current: PolicyState?) in
            try QuantumSafety.replay(scope: scope, account: self.account, chain: chain, current: current, adminRootHex: root,
                                     isAdminDevice: { _ in false }, bindingFor: { $0 == root ? k.binding : nil })
        }
        let legacy = AssurancePolicy.legacyState(scope)
        let on = try signed(QuantumSafety.strictChange(account: account, scope: scope, from: legacy, browsersAllowed: false, peers: [server],
                                                       signerKind: .adminRoot, signerKeyId: root, now: 100), k)
        let r1 = try replay([on], nil)
        XCTAssertTrue(AssurancePolicy.strictInForce(r1.state))
        XCTAssertFalse(r1.browsersAllowed)

        let off = try signed(QuantumSafety.compatibilityChange(account: account, scope: scope, from: r1.state, loss: QuantumSafety.leavingStrictLoss,
                                                               peers: [server], signerKind: .adminRoot, signerKeyId: root, now: 200), k)
        let r2 = try replay([on, off], r1.state)
        XCTAssertFalse(AssurancePolicy.strictInForce(r2.state))
        XCTAssertTrue(r2.browsersAllowed)

        let store = QuantumSafety.Store(defaults: UserDefaults(suiteName: "qs-\(UUID())")!)
        try store.adopt(account: account, r2)
        // A served chain that stops before the opt-out is older: refused, the held state stays.
        XCTAssertThrowsError(try store.adopt(account: account, r1))
        XCTAssertThrowsError(try replay([on], r2.state))
        XCTAssertEqual(store.replayed(account: account, scope: scope)?.state, r2.state)
        store.forget(account: account)
        XCTAssertNil(store.replayed(account: account, scope: scope))
    }

    func testBrowsersAllowedIsSignedIntoTheChangeAndAClassicalChangeCannotTurnStrictOn() throws {
        let k = try adminRoot()
        let scope = QuantumSafety.serviceScope(server: server, service: "alice--chess")
        let root = PqBin.hex(k.edPub)
        let legacy = AssurancePolicy.legacyState(scope)
        let c = QuantumSafety.strictChange(account: account, scope: scope, from: legacy, browsersAllowed: true, peers: [server], signerKind: .adminRoot, signerKeyId: root, now: 1)
        XCTAssertEqual(c.acknowledgedLoss, [QuantumSafety.browserLoss])
        let r = try QuantumSafety.replay(scope: scope, account: account, chain: [try signed(c, k)], current: nil, adminRootHex: root,
                                         isAdminDevice: { _ in false }, bindingFor: { $0 == root ? k.binding : nil })
        XCTAssertTrue(r.browsersAllowed)
        // Classical-only (the binding withheld): refused.
        XCTAssertThrowsError(try QuantumSafety.replay(scope: scope, account: account, chain: [try signed(c, k)], current: nil, adminRootHex: root,
                                                      isAdminDevice: { _ in false }, bindingFor: { _ in nil }))
    }

    func testReadinessNamesWhatIsMissingAndConnectorsNeedAChoiceUnlessContentFree() {
        let r = QuantumSafety.Readiness(devicesBound: 1, devices: 2, thisDeviceBound: true, thisDeviceIsAdmin: true, recoveryChecked: false, serverBound: true)
        XCTAssertFalse(r.ready)
        XCTAssertEqual(r.missing.count, 2)
        let c = QuantumSafety.connectors(aiProviders: ["openai", "flagship-inference"])
        XCTAssertEqual(c.filter(\.needsChoice).map(\.id), ["ai-flagship-inference", "ai-openai"])
        XCTAssertTrue(c.contains { $0.id == "push-apns" && !$0.needsChoice })
        XCTAssertEqual(QuantumSafety.affectedPeersDigest(["B", "a", "b"]), QuantumSafety.affectedPeersDigest(["a", "b"]))
    }
}
