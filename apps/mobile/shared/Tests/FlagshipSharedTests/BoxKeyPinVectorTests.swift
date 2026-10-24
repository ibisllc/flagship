import XCTest
@testable import FlagshipCore
import FlagshipAPI
import CryptoKit

/// Pins `BoxKeyPins` to packages/protocol/test-vectors/box-key-pin/vectors.json
/// (also read by the TS reference, the webapp and Android).
final class BoxKeyPinVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/box-key-pin/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private let user = "plucky-avocet"

    func testDecisionsMatchTheVectors() throws {
        let v = try vectors()
        for d in try XCTUnwrap(v["decisions"] as? [[String: Any]]) {
            let pinned = d["pinned"] as? String
            let verdict = BoxKeyPins.decide(pinned: pinned, reported: d["reported"] as! String)
            XCTAssertEqual(verdict.rawValue, d["verdict"] as? String, "\(d)")
        }
    }

    func testBootKeyBindingVerifiesOnlyUnderThePinnedStk() throws {
        let v = try vectors()
        let b = try XCTUnwrap(v["bootKeyBinding"] as? [String: Any])
        let binding = try XCTUnwrap(b["binding"] as? [String: Any])
        let expect = try XCTUnwrap(b["expect"] as? [String: Any])
        let domain = binding["serverDomain"] as! String
        let boot = binding["bootPubHex"] as! String
        let issuedAt = (binding["issuedAt"] as! NSNumber).int64Value
        let canonical = try XCTUnwrap(BoxKeyPins.canonicalBootKeyBinding(serverDomain: domain, bootPubHex: boot, issuedAt: issuedAt))
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self), b["canonical"] as? String)
        let stk = try XCTUnwrap(HexUtil.decode(v["stkPubHex"] as! String))
        let other = try XCTUnwrap(HexUtil.decode(v["otherPubHex"] as! String))
        let sig = try XCTUnwrap(HexUtil.decode(b["signatureHex"] as! String))
        let forged = try XCTUnwrap(HexUtil.decode(b["signedByOtherKeyHex"] as! String))
        func check(_ s: Data, _ k: Data, _ server: String) -> Bool {
            BoxKeyPins.verifyBootKeyBinding(serverDomain: domain, bootPubHex: boot, issuedAt: issuedAt,
                                            signature: s, pinnedStkPub: k, forServer: server)
        }
        XCTAssertEqual(check(sig, stk, domain), expect["signatureUnderPinnedStk"] as? Bool)
        XCTAssertEqual(check(forged, stk, domain), expect["signedByOtherKeyUnderPinnedStk"] as? Bool)
        XCTAssertEqual(check(sig, other, domain), expect["signatureUnderOtherKey"] as? Bool)
        XCTAssertEqual(check(sig, stk, expect["otherServerDomain"] as! String), expect["signatureForOtherServer"] as? Bool)
    }

    func testFirstSightNeverPinsAndASubstitutedKeyIsRefused() throws {
        let v = try vectors()
        let pins = BoxKeyPins(defaults: nil)
        let domain = v["serverDomain"] as! String
        let stk = v["stkPubHex"] as! String
        let other = v["otherPubHex"] as! String
        XCTAssertThrowsError(try pins.require(username: user, serverDomain: domain, reportedHex: stk)) {
            XCTAssertTrue($0 is BoxKeyNotPinnedError)
        }
        XCTAssertTrue(pins.observe(username: user, pods: [PodDirectoryEntryLike(domain: domain, stkHex: stk, revoked: false)]).isEmpty)
        XCTAssertNil(pins.pinned(username: user, serverDomain: domain), "a listed key is never pinned")
        XCTAssertTrue(pins.serverKeys.pin(try XCTUnwrap(HexUtil.decode(stk)), for: domain))
        XCTAssertEqual(try pins.require(username: user, serverDomain: domain, reportedHex: stk), stk)
        XCTAssertEqual(try pins.require(username: user, serverDomain: domain.uppercased(), reportedHex: stk.uppercased()), stk)
        XCTAssertThrowsError(try pins.require(username: user, serverDomain: domain, reportedHex: other)) { e in
            let changed = e as? BoxKeyChangedError
            XCTAssertEqual(changed?.reportedHex, other)
            XCTAssertEqual(changed?.pinnedHex, stk)
            XCTAssertEqual(changed?.username, self.user)
            XCTAssertEqual(changed?.errorDescription, FirstContact.keyChangedText)
        }
        XCTAssertEqual(pins.observe(username: user, pods: [PodDirectoryEntryLike(domain: domain, stkHex: other, revoked: false)]), [domain])
        XCTAssertEqual(pins.pinned(username: user, serverDomain: domain), stk)
    }

    func testTheBootKeyLivesInTheOnePinStore() throws {
        let v = try vectors()
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "flagship.boxKeyPins.test.\(UUID().uuidString)"))
        let domain = v["serverDomain"] as! String
        let stk = v["stkPubHex"] as! String
        defaults.set([domain: stk], forKey: "flagship.serverKeyPins.v1")
        let serverKeys = ServerKeyPins(defaults: defaults)
        let pins = BoxKeyPins(serverKeys: serverKeys)
        XCTAssertEqual(pins.pinned(username: user, serverDomain: domain), stk, "a pin kept before reads the same")
        let b = try XCTUnwrap(v["bootKeyBinding"] as? [String: Any])
        let binding = try XCTUnwrap(b["binding"] as? [String: Any])
        let boot = binding["bootPubHex"] as! String
        XCTAssertEqual(pins.acceptBootKeyBinding(username: user, serverDomain: domain, bootPubHex: boot,
                                                 issuedAt: (binding["issuedAt"] as! NSNumber).int64Value,
                                                 signatureHex: b["signatureHex"] as! String), boot)
        XCTAssertEqual(ServerKeyPins(defaults: defaults).record(domain)?.boot, boot)
        XCTAssertTrue(serverKeys.pin(try XCTUnwrap(HexUtil.decode(stk)), for: domain))
        XCTAssertEqual(pins.pinnedBootKey(username: user, serverDomain: domain), boot, "pinning the same key keeps it")
        serverKeys.forget(domain)
        XCTAssertFalse(serverKeys.update(domain, stkHex: stk) { $0.boot = boot })
        XCTAssertNil(pins.pinnedBootKey(username: user, serverDomain: domain))
    }

    func testRepinAfterAReinstallMovesThePinAndDropsTheBootKey() throws {
        let v = try vectors()
        let pins = BoxKeyPins(defaults: nil)
        let domain = v["serverDomain"] as! String
        let b = try XCTUnwrap(v["bootKeyBinding"] as? [String: Any])
        let binding = try XCTUnwrap(b["binding"] as? [String: Any])
        let boot = binding["bootPubHex"] as! String
        let issuedAt = (binding["issuedAt"] as! NSNumber).int64Value
        XCTAssertNil(pins.acceptBootKeyBinding(username: user, serverDomain: domain, bootPubHex: boot,
                                               issuedAt: issuedAt, signatureHex: b["signatureHex"] as! String))
        pins.repin(username: user, serverDomain: domain, stkHex: v["stkPubHex"] as! String)
        XCTAssertNil(pins.acceptBootKeyBinding(username: user, serverDomain: domain, bootPubHex: boot,
                                               issuedAt: issuedAt, signatureHex: b["signedByOtherKeyHex"] as! String))
        XCTAssertEqual(pins.acceptBootKeyBinding(username: user, serverDomain: domain, bootPubHex: boot,
                                                 issuedAt: issuedAt, signatureHex: b["signatureHex"] as! String), boot)
        pins.repin(username: user, serverDomain: domain, stkHex: v["otherPubHex"] as! String)
        XCTAssertNil(pins.pinnedBootKey(username: user, serverDomain: domain))
        XCTAssertNoThrow(try pins.require(username: user, serverDomain: domain, reportedHex: v["otherPubHex"] as! String))
        XCTAssertThrowsError(try pins.require(username: user, serverDomain: domain, reportedHex: v["stkPubHex"] as! String))
        pins.forget(username: user, serverDomain: domain)
        XCTAssertThrowsError(try pins.require(username: user, serverDomain: domain, reportedHex: v["stkPubHex"] as! String)) {
            XCTAssertTrue($0 is BoxKeyNotPinnedError)
        }
    }
}

/// The relay responder never seals a disk-key reply to a key other than the pinned one.
@MainActor
final class BoxKeyPinCoordinatorTests: XCTestCase {
    func testASubstitutedBoxKeyGetsNothingAndNoPromptFires() async throws {
        let domain = "home.plucky-avocet.flagship.services"
        let real = String(repeating: "ab", count: 32)
        let rogue = String(repeating: "cd", count: 32)
        let pins = BoxKeyPins(defaults: nil)
        pins.repin(username: "plucky-avocet", serverDomain: domain, stkHex: real)
        let mailbox = MockSecretMailboxClient()
        mailbox.sealedLuksKeyHex = "00"
        var prompted = false
        let coord = SecretRequestCoordinator(
            mailbox: mailbox, username: "plucky-avocet",
            irkProvider: { prompted = true; return Curve25519.Signing.PrivateKey() },
            unsealSeedProvider: { _ in [] },
            pins: pins
        )
        let pending = PendingSecretRequest(
            serverDomain: domain, requestNonceHex: String(repeating: "11", count: 32), stkPub: rogue,
            purpose: "unlock-key", issuedAt: 1, requestSignature: String(repeating: "22", count: 64),
            deviceInfo: nil, postedAt: 1, expiresAt: .max
        )
        let verified = SecretRequestCoordinator.VerifiedRequest(pending: pending, stkPubHex: rogue)
        do {
            try await coord.confirmAndRespond(verified)
            XCTFail("sealed to a substituted key")
        } catch let e as SecretRequestCoordinator.CoordinatorError {
            XCTAssertEqual(e, .keyChanged(domain))
        }
        XCTAssertFalse(prompted)
        XCTAssertTrue(mailbox.postedResponses.isEmpty)
    }
}
