import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// First contact (docs/first-contact.md): one pin store, the first blessing, refusals, the code, Studio's
/// confirmation and the app-name grant's upkeep.
final class FirstContactTests: XCTestCase {
    private let username = "alice"
    private let domain = "home.alice.flagship.services"
    private let serial = "AC-7Q2M-91XZ"
    private let secret = Data(repeating: 0x77, count: 32)
    private let stk = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x07, count: 32))
    private let irk = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x01, count: 32))
    private let admin = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x02, count: 32))
    private var stkHex: String { HexUtil.encode(stk.publicKey.rawRepresentation) }

    private func vectors(_ name: String) throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/\(name)/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(name) vectors not found")
    }

    // MARK: - The pin store

    func testAKeyIsPinnedOnceAndNeverReplacedSilently() {
        let pins = ServerKeyPins.volatile()
        let a = Data(repeating: 1, count: 32), b = Data(repeating: 2, count: 32)
        XCTAssertEqual(pins.check(a, for: domain), .unpinned)
        XCTAssertTrue(pins.pin(a, for: "Home.Alice.flagship.services."))
        XCTAssertEqual(pins.pinnedStk(domain), a, "Names are normalised.")
        XCTAssertEqual(pins.check(a, for: domain), .matches)
        XCTAssertFalse(pins.pin(b, for: domain), "A second key is refused.")
        XCTAssertEqual(pins.check(b, for: domain), .changed)
        XCTAssertEqual(pins.pinnedStk(domain), a, "The first pin stays.")
        XCTAssertEqual(pins.pinnedServer(forHost: "blog.\(domain)"), domain, "An app name belongs to its server.")
        pins.forget(domain)
        XCTAssertTrue(pins.pin(b, for: domain), "Re-trust is explicit.")
        XCTAssertFalse(pins.pin(Data(repeating: 3, count: 31), for: "x.alice.flagship.services"))
    }

    func testTheCertPinRegistryReadsOnlyThePinStore() {
        let pins = ServerKeyPins.volatile()
        let reg = CertPinRegistry(persistingIn: nil, serverKeys: pins)
        XCTAssertNil(reg.stkPub(forDomain: domain))
        XCTAssertFalse(reg.isKnownBox(host: domain))
        pins.pin(stk.publicKey.rawRepresentation, for: domain)
        XCTAssertEqual(reg.stkPub(forDomain: domain), stk.publicKey.rawRepresentation)
        XCTAssertTrue(reg.isKnownBox(host: "blog.\(domain)"))
    }

    // MARK: - Weighing a request

    private func assess(_ purpose: SecretPurpose, proof: String?, pins: ServerKeyPins = .volatile(),
                        secrets: FirstContactSecretStore = InMemoryFirstContactSecrets()) -> FirstContactTrust {
        FirstContact.assess(serverDomain: domain, stkPubHex: stkHex, purpose: purpose, enrollmentProof: proof,
                            pins: pins, secrets: secrets)
    }

    private func holding() -> InMemoryFirstContactSecrets {
        let s = InMemoryFirstContactSecrets()
        s.save(FirstContactSecret(enrollmentKeyHex: HexUtil.encode(secret), authCodeSerial: serial), for: domain)
        return s
    }

    private var proof: String {
        Enrollment.proofHex(secret: secret, serverDomain: domain, stkPubHex: stkHex, authCodeSerial: serial)!
    }

    func testFirstSightWithoutTheSecretShowsTheCodeComputedFromTheKey() {
        let code = Enrollment.serverCode(stkPubHex: stkHex)!
        XCTAssertEqual(assess(.entitlement, proof: nil), .firstSight(code: code, pinsOnApprove: true))
        XCTAssertEqual(FirstContact.pretty("482913"), "482 913")
        XCTAssertEqual(FirstContact.codeLine("482913"), "If your machine has a monitor, it is showing this code: 482 913")
    }

    func testTheServerCodeMatchesTheSharedVectors() throws {
        let v = try vectors("enrollment")
        for c in v["codes"] as? [[String: Any]] ?? [] {
            XCTAssertEqual(Enrollment.serverCode(stkPubHex: c["stkPubHex"] as! String), c["code"] as? String)
        }
    }

    func testTheCreatingDeviceNeedsAValidProof() {
        let code = Enrollment.serverCode(stkPubHex: stkHex)!
        XCTAssertEqual(assess(.entitlement, proof: proof, secrets: holding()), .firstSight(code: code, pinsOnApprove: true))
        XCTAssertEqual(assess(.entitlement, proof: nil, secrets: holding()), .notFromRecipe, "Missing proof.")
        let wrong = Enrollment.proofHex(secret: Data(repeating: 0x78, count: 32), serverDomain: domain, stkPubHex: stkHex,
                                        authCodeSerial: serial)!
        XCTAssertEqual(assess(.entitlement, proof: wrong, secrets: holding()), .notFromRecipe, "Wrong proof.")
        XCTAssertEqual(assess(.unlockKey, proof: wrong, secrets: holding()), .notFromRecipe)
        XCTAssertEqual(assess(.unlockKey, proof: nil, secrets: holding()), .firstSight(code: code, pinsOnApprove: false),
                       "A disk unlock before the box asks to serve opens the disk but pins nothing.")
    }

    func testAPinnedKeyMatchesAndAnyOtherKeyIsRefused() {
        let pins = ServerKeyPins.volatile()
        pins.pin(stk.publicKey.rawRepresentation, for: domain)
        XCTAssertEqual(assess(.unlockKey, proof: nil, pins: pins), .pinned)
        let other = ServerKeyPins.volatile()
        other.pin(Data(repeating: 9, count: 32), for: domain)
        XCTAssertEqual(assess(.entitlement, proof: proof, pins: other, secrets: holding()), .keyChanged)
        XCTAssertTrue(FirstContactTrust.keyChanged.isRefused)
        XCTAssertEqual(FirstContact.keyChangedText, "This server's key changed. If you did not rebuild it, do not approve anything for it.")
        XCTAssertEqual(FirstContact.notFromRecipeText, "This server was not built from your recipe. Do not approve it.")
    }

    // MARK: - Studio

    func testStudioConfirmsOnlyTheExactKeyUnderTheKeptKey() {
        let key = Data(repeating: 0x22, count: 32)
        let mac = FirstContact.studioSeenMacHex(key: key, serverDomain: "Home.Alice.flagship.services", stkPubHex: stkHex)!
        let msg = Data("flagship/server-code-seen/v1|\(domain)|\(stkHex)".utf8)
        XCTAssertEqual(mac, HexUtil.encode(Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: key)))))
        XCTAssertTrue(FirstContact.studioConfirms(key: key, serverDomain: domain, seenStkPubHex: stkHex, macHex: mac,
                                                  expectedStkPubHex: stkHex))
        XCTAssertFalse(FirstContact.studioConfirms(key: key, serverDomain: domain, seenStkPubHex: stkHex,
                                                   macHex: String(repeating: "0", count: 64), expectedStkPubHex: stkHex),
                       "A wrong MAC is ignored.")
        XCTAssertFalse(FirstContact.studioConfirms(key: key, serverDomain: domain, seenStkPubHex: stkHex, macHex: mac,
                                                   expectedStkPubHex: String(repeating: "ab", count: 32)),
                       "Studio saw another key.")

        let secrets = holding()
        var kept = secrets.secret(for: domain)!
        kept.studioConfirmKeyHex = HexUtil.encode(key)
        secrets.save(kept, for: domain)
        let store = StudioSeenStore(secrets: { secrets })
        XCTAssertFalse(store.confirmed(serverDomain: domain, stkPubHex: stkHex))
        let junk = String(repeating: "1", count: 64)
        store.record(ProvisionStatus(serial: serial, serverDomain: domain, phase: .installing, updatedAt: 1, history: [],
                                     serverSeen: [.init(stkPubHex: stkHex, macHex: junk, at: 1),
                                                  .init(stkPubHex: stkHex, macHex: mac, at: 2)]))
        XCTAssertTrue(store.confirmed(serverDomain: domain, stkPubHex: stkHex), "Any entry that verifies counts.")
        XCTAssertFalse(store.confirmed(serverDomain: domain, stkPubHex: String(repeating: "ab", count: 32)))
        store.record(ProvisionStatus(serial: serial, serverDomain: domain, phase: .installing, updatedAt: 2, history: [],
                                     serverSeen: [.init(stkPubHex: stkHex, macHex: junk, at: 3)]))
        XCTAssertFalse(store.confirmed(serverDomain: domain, stkPubHex: stkHex), "A wrong MAC is ignored.")
    }

    func testOrderStatusDecodesServerSeen() throws {
        let json = #"{"serial":"S","serverDomain":"home.alice.flagship.services","phase":"installing","updatedAt":1,"history":[],"serverSeen":[{"stkPubHex":"ab","macHex":"cd","at":7}]}"#
        let s = try JSONDecoder().decode(ProvisionStatus.self, from: Data(json.utf8))
        XCTAssertEqual(s.serverSeen, [.init(stkPubHex: "ab", macHex: "cd", at: 7)])
        let old = #"{"serial":"S","phase":"installing","updatedAt":1,"history":[]}"#
        XCTAssertNil(try JSONDecoder().decode(ProvisionStatus.self, from: Data(old.utf8)).serverSeen)
    }

    // MARK: - The first blessing, end to end against a mock .com

    @MainActor
    private func world(purpose: SecretPurpose, proof: String?, secrets: FirstContactSecretStore, pins: ServerKeyPins,
                       keeper: ServerWildcardGrantKeeper)
        -> (MockSecretMailboxClient, SecretRequestCoordinator) {
        let m = MockSecretMailboxClient()
        let nonce = Data(repeating: 0x33, count: 32)
        let req = SecretRequest(serverDomain: domain, stkPub: stk.publicKey.rawRepresentation, purpose: purpose, nonce: nonce,
                                issuedAt: 1_700_000_000_000)
        let sig = try! stk.signature(for: req.canonicalBytes())
        m.pending = [PendingSecretRequest(serverDomain: domain, requestNonceHex: HexUtil.encode(nonce), stkPub: stkHex,
                                          purpose: purpose.rawValue, issuedAt: req.issuedAt, requestSignature: HexUtil.encode(sig),
                                          deviceInfo: DeviceInfoHint(ip: "203.0.113.7", enrollmentProof: proof),
                                          postedAt: 1, expiresAt: 1_700_000_300_000)]
        // `.com` lists the server under some other key: never consulted.
        m.directory = [PodDirectoryEntry(serverDomain: domain, identityPubKey: String(repeating: "cd", count: 32))]
        let unseal = Data(repeating: 0x0a, count: 32)
        let unsealPub = try! Curve25519.Signing.PrivateKey(rawRepresentation: unseal).publicKey.rawRepresentation
        m.sealedLuksKeyHex = HexUtil.encode(try! SecretSeal.sealForEd25519Recipient(plaintext: Data(repeating: 0x5a, count: 32),
                                                                                     recipientEd25519Pub: unsealPub))
        let irk = self.irk, admin = self.admin
        let c = SecretRequestCoordinator(mailbox: m, username: username, irkProvider: { irk }, unsealSeedProvider: { _ in [unseal] },
                                         orderKeyProvider: { admin }, now: { 1_700_000_001_000 },
                                         serverKeys: pins, firstContactSecrets: secrets,
                                         studioSeen: StudioSeenStore(secrets: { secrets }), wildcardGrants: keeper)
        return (m, c)
    }

    private func keeper() -> ServerWildcardGrantKeeper {
        ServerWildcardGrantKeeper(defaults: UserDefaults(suiteName: "fc-grants-\(UUID().uuidString)")!)
    }

    @MainActor
    func testTheFirstBlessingPinsTheKeyForgetsTheSecretAndSignsTheGrantOverThePin() async throws {
        let pins = ServerKeyPins.volatile(), secrets = holding(), grants = keeper()
        let (m, c) = world(purpose: .entitlement, proof: proof, secrets: secrets, pins: pins, keeper: grants)
        let list = try await c.fetchVerifiedRequests()
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].serverCode, Enrollment.serverCode(stkPubHex: stkHex))
        XCTAssertEqual(list[0].stkPubHex, stkHex)
        try await c.confirmAndRespond(list[0])
        XCTAssertEqual(pins.pinnedStk(domain), stk.publicKey.rawRepresentation, "Pinned at the blessing.")
        XCTAssertNil(secrets.secret(for: domain), "The secret is gone once pinned.")
        XCTAssertEqual(m.postedResponses.count, 1, "The entitlement went out.")
        let signed = try XCTUnwrap(grants.pending(domain, pinnedStk: stk.publicKey.rawRepresentation))
        let g = ServerWildcardGrant(username: username, serverDomain: domain, stkPubHex: stkHex, issuedAt: signed.issuedAt)
        XCTAssertTrue(admin.publicKey.isValidSignature(HexUtil.decode(signed.signatureHex)!, for: try g.canonicalBytes()),
                      "Signed with the sensitive-order key over the pinned key.")
        XCTAssertEqual(FirstContact.assess(serverDomain: domain, stkPubHex: stkHex, purpose: .unlockKey, enrollmentProof: nil,
                                           pins: pins, secrets: secrets), .pinned, "The next request is checked against the pin.")
    }

    @MainActor
    func testARecipeProofThatFailsIsRefusedAndNothingIsPinnedOrSent() async throws {
        let pins = ServerKeyPins.volatile(), grants = keeper()
        let (m, c) = world(purpose: .entitlement, proof: nil, secrets: holding(), pins: pins, keeper: grants)
        let list = try await c.fetchVerifiedRequests()
        XCTAssertEqual(list.first?.trust, .notFromRecipe)
        do {
            try await c.confirmAndRespond(list[0])
            XCTFail("must refuse")
        } catch let e as SecretRequestCoordinator.CoordinatorError {
            XCTAssertEqual(e.errorDescription, FirstContact.notFromRecipeText)
        }
        XCTAssertNil(pins.pinnedStk(domain))
        XCTAssertTrue(m.postedResponses.isEmpty)
        XCTAssertNil(grants.pending(domain, pinnedStk: stk.publicKey.rawRepresentation))
    }

    @MainActor
    func testAChangedKeyIsRefusedAndNothingIsSealed() async throws {
        let pins = ServerKeyPins.volatile()
        pins.pin(Data(repeating: 9, count: 32), for: domain)
        let (m, c) = world(purpose: .unlockKey, proof: nil, secrets: InMemoryFirstContactSecrets(), pins: pins, keeper: keeper())
        let list = try await c.fetchVerifiedRequests()
        XCTAssertEqual(list.first?.trust, .keyChanged)
        do {
            try await c.confirmAndRespond(list[0])
            XCTFail("must refuse")
        } catch let e as SecretRequestCoordinator.CoordinatorError {
            XCTAssertEqual(e.errorDescription, FirstContact.keyChangedText)
        }
        XCTAssertTrue(m.postedResponses.isEmpty, "Nothing sealed to the other key.")
        XCTAssertEqual(pins.pinnedStk(domain), Data(repeating: 9, count: 32))
    }

    @MainActor
    func testADeviceWithoutTheSecretPinsOnFirstSight() async throws {
        let pins = ServerKeyPins.volatile()
        let (m, c) = world(purpose: .unlockKey, proof: nil, secrets: InMemoryFirstContactSecrets(), pins: pins, keeper: keeper())
        let list = try await c.fetchVerifiedRequests()
        guard case .firstSight(_, true) = list[0].trust else { return XCTFail("first sight, pins: \(list[0].trust)") }
        try await c.confirmAndRespond(list[0])
        XCTAssertEqual(pins.pinnedStk(domain), stk.publicKey.rawRepresentation)
        XCTAssertEqual(m.entitlementDeposits.count, 1, "Consent to boot is consent to serve, once pinned.")
    }

    @MainActor
    func testAnUnlockBeforeTheProofOpensTheDiskButPinsNothing() async throws {
        let pins = ServerKeyPins.volatile()
        let (m, c) = world(purpose: .unlockKey, proof: nil, secrets: holding(), pins: pins, keeper: keeper())
        let list = try await c.fetchVerifiedRequests()
        try await c.confirmAndRespond(list[0], depositAutoLease: true)
        XCTAssertEqual(m.postedResponses.count, 1)
        XCTAssertNil(pins.pinnedStk(domain), "The entitlement request with the proof pins it.")
        XCTAssertTrue(m.entitlementDeposits.isEmpty, "No entitlement before the proof.")
        XCTAssertTrue(m.deposited.isEmpty, "No lease before the pin.")
    }

    @MainActor
    func testTheServerCardRefusesAKeyOtherThanTheOneItShowed() async throws {
        let (_, c) = world(purpose: .entitlement, proof: nil, secrets: InMemoryFirstContactSecrets(), pins: .volatile(), keeper: keeper())
        do {
            _ = try await c.approvePendingEntitlement(serverDomain: domain, expectedStkPubHex: String(repeating: "ab", count: 32))
            XCTFail("must refuse")
        } catch let e as SecretRequestCoordinator.CoordinatorError {
            XCTAssertEqual(e, .keyChanged(domain))
        }
        do {
            _ = try await c.approvePendingEntitlement(serverDomain: domain, expectedStkPubHex: nil)
            XCTFail("a first sight needs its code on screen")
        } catch let e as SecretRequestCoordinator.CoordinatorError {
            XCTAssertEqual(e, .codeNotShown(domain))
        }
    }

    // MARK: - Grant upkeep

    func testUpkeepSignsSilentlyWithAnOpenKeyElseMarksItOwedForTheNextFaceID() async throws {
        let pins = ServerKeyPins.volatile()
        pins.pin(stk.publicKey.rawRepresentation, for: domain)
        let grants = keeper()
        let box = DeliveredBox()
        grants.deliver = { _, signed in await box.take(signed) }

        let owed = await ServerWildcardGrantUpkeep.run(username: username, serverDomain: domain, keeper: grants, pins: pins,
                                                       status: { false }, silentKey: { nil }, now: 5)
        XCTAssertEqual(owed, .owed, "The admin root opens only inside a Face ID.")
        XCTAssertEqual(grants.owed().map(\.serverDomain), [domain])
        XCTAssertEqual(grants.signOwed(key: admin, pins: pins, now: 6), [domain], "Signed at the next Face ID.")
        let awaited1 = await grants.deliverKept(domain, pins: pins)
        XCTAssertTrue(awaited1)
        let taken = await box.taken
        XCTAssertEqual(taken.count, 1)

        let irk = self.irk
        let silent = await ServerWildcardGrantUpkeep.run(username: username, serverDomain: domain, keeper: grants, pins: pins,
                                                         status: { false }, silentKey: { irk }, now: 7)
        XCTAssertEqual(silent, .signedAndDelivered)
        let held = await ServerWildcardGrantUpkeep.run(username: username, serverDomain: domain, keeper: grants, pins: pins,
                                                       status: { true }, silentKey: { irk }, now: 8)
        XCTAssertEqual(held, .alreadyGranted)
        let unpinned = await ServerWildcardGrantUpkeep.run(username: username, serverDomain: "x.alice.flagship.services",
                                                           keeper: grants, pins: pins, status: { false }, silentKey: { irk }, now: 9)
        XCTAssertEqual(unpinned, .skipped, "Never a grant over a key this device did not pin.")
    }

    // MARK: - No derived server key anywhere in app code

    func testNoAppSourceDerivesAServerKeyOrTrustsTheDirectoryKey() throws {
        var mobile = URL(fileURLWithPath: #filePath)
        while mobile.lastPathComponent != "mobile" { mobile.deleteLastPathComponent() }
        let roots = ["shared/Sources", "ios/Sources", "ios/App"].map { mobile.appendingPathComponent($0) }
        let banned = ["deriveStk", "deriveIRKAndBoxStkPub", "deriveIRKBoxStkAndSwk", "registerBoxStk", "WatchBootStkPins",
                      "flagship.stk.v1"]
        var hits: [String] = []
        for root in roots {
            guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { continue }
            for case let url as URL in e where url.pathExtension == "swift" {
                let text = try String(contentsOf: url, encoding: .utf8)
                for b in banned where text.contains(b) { hits.append("\(url.lastPathComponent): \(b)") }
            }
        }
        XCTAssertEqual(hits, [], "A server key is pinned at first blessing, never derived.")
    }
}

private actor DeliveredBox {
    var taken: [ServerWildcardGrantKeeper.Signed] = []
    func take(_ s: ServerWildcardGrantKeeper.Signed) -> Bool { taken.append(s); return true }
}
