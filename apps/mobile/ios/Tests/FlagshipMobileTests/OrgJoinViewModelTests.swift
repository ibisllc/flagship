import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipUI

/// Seat keys in memory (no keychain): secrets kept plainly for the test.
final class FakeOrgSeatKeys: OrgSeatKeys, @unchecked Sendable {
    var stored: [String: (seat: Seat, secret: [UInt8]?)] = [:]
    var locked = false
    override func seats() -> [Seat] { stored.values.map(\.seat).sorted { $0.seatId < $1.seatId } }
    override func remember(orgId: String, seatId: String, orgName: String, genesisHash: String, binding: PqKeyBindingWire, secret: [UInt8]) throws {
        stored["\(orgId):\(seatId)"] = (Seat(orgId: orgId, seatId: seatId, orgName: orgName, genesisHash: genesisHash, binding: binding, memberOnly: nil), secret)
    }
    override func rememberMember(orgId: String, seatId: String, orgName: String, genesisHash: String, memberBinding: PqKeyBindingWire) throws {
        stored["\(orgId):\(seatId)"] = (Seat(orgId: orgId, seatId: seatId, orgName: orgName, genesisHash: genesisHash, binding: memberBinding, memberOnly: true), nil)
    }
    override func sign(_ seat: Seat, purpose: String, payload: [UInt8]) -> [UInt8]? {
        guard !locked, let s = stored[seat.id]?.secret else { return nil }
        return try? PqHybrid.hybridSign(secretKey: s, purpose: purpose, payload: payload)
    }
}

/// A one-admin org on a fake `.com` that stores what phones post and serves it back.
final class OrgFakeCom: @unchecked Sendable {
    let now: Int64 = 1_800_000_000_000
    let orgId = OrgAuthority.randomId(), founderSeat = OrgAuthority.randomId()
    let orgName = "acme"
    let founderKeys = FakeOrgSeatKeys()
    var genesisHash = ""
    var entries: [[String: Any]] = []
    var invites: [String: [String: Any]] = [:], offers: [String: String] = [:]
    var accepts: [[String: Any]] = [], grants: [[String: Any]] = [], ceremonies: [[String: Any]] = []
    var revokes: [[String: Any]] = [], rings: [[String: Any]] = [], seatKems: [[String: Any]] = [], boxKems: [[String: Any]] = [], servers: [[String: Any]] = []
    var inviteExpired = false
    var directory: [String: [String: Any]] = [:]
    var connectors: [[String: Any]] = [], proposals: [[String: Any]] = [], decisions: [[String: Any]] = [], slices: [String: [String: Any]] = [:]

    init() throws {
        let t0 = now - 3_600_000
        let (binding, secret) = try founderKeys.makeKey(orgId: orgId, seatId: founderSeat, now: t0)
        let record = OrgAuthority.genesis(orgId: orgId, founderSeatId: founderSeat, founderBinding: binding, issuedAt: t0)
        let keyId = OrgAuthority.keyIdHex(ed25519PubHex: binding.ed25519PubHex, mldsaPubHex: binding.mldsaPubHex)
        let approval = try OrgAuthority.signApproval(orgId: orgId, oarVersion: 0, order: try OrgAuthority.canonicalAuthority(record), seatId: founderSeat,
                                                     adminKeyId: keyId, issuedAt: t0, notAfter: t0 + OrgAuthority.day) { p, m in try PqHybrid.hybridSign(secretKey: secret, purpose: p, payload: m) }
        genesisHash = try OrgAuthority.authorityHash(record)
        entries = [OrgJSON.entry(OrgAuthorityEntry(record: record, via: "genesis", approvals: [approval], notice: nil, overturnOf: nil))]
        try founderKeys.remember(orgId: orgId, seatId: founderSeat, orgName: orgName, genesisHash: genesisHash, binding: binding, secret: secret)
    }

    var founder: OrgSeatKeys.Seat { founderKeys.seats()[0] }

    /// An invitation as an admin makes it; returns the link key (hex).
    func invite(seatId: String, roles: [OrgSeatRole], pseudonym: String = "Pat") throws -> String {
        let key = SymmetricKey(size: .bits256)
        let label = try AES.GCM.seal(Data(pseudonym.utf8), using: key).combined!
        let offer = try JSONSerialization.data(withJSONObject: ["orgId": orgId, "orgName": orgName, "genesisHash": genesisHash, "seatId": seatId,
                                                                "roles": OrgAuthorityWire.rolesJSON(roles), "pseudonym": pseudonym])
        let t = now - 60_000
        invites[seatId] = [
            "invite": ["orgId": orgId, "seatId": seatId, "labelSha256": OrgAuthority.sha256Hex([UInt8](label)), "rolesHash": try OrgAuthority.rolesHash(roles),
                       "oarVersion": 0, "issuedAt": NSNumber(value: t), "expiresAt": NSNumber(value: t + 7 * OrgAuthority.day)] as [String: Any],
            "roles": OrgAuthorityWire.rolesJSON(roles),
        ]
        offers[seatId] = OrgAuthority.hex([UInt8](try AES.GCM.seal(offer, using: key).combined!))
        return key.withUnsafeBytes { OrgAuthority.hex(Array($0)) }
    }

    /// JSON as it crosses the wire (so numbers decode the way `.com`'s do).
    private func wire(_ o: [String: Any]) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: o))) as? [String: Any] ?? [:]
    }

    lazy var client = OrgClient { [unowned self] method, path, body in
        let base = "/api/orgs/\(self.orgId)"
        switch (method, path) {
        case ("GET", "\(base)/authority"):
            return (200, wire(["org": ["name": orgName], "entries": entries, "freezes": [], "overturns": [], "vetoes": []]))
        case ("GET", "\(base)/seats"):
            return (200, wire(["grants": grants, "revokes": revokes, "invites": Array(invites.values), "accepts": accepts]))
        case ("GET", "\(base)/keys"):
            return (200, wire(["rings": rings, "seatKems": seatKems, "boxKems": boxKems]))
        case ("GET", "\(base)/servers"):
            return (200, wire(["servers": servers]))
        case ("POST", "\(base)/keys"):
            rings.append(wire(body!)); return (200, [:])
        case ("POST", "\(base)/seat-kems"):
            seatKems.append(wire(body!)); return (200, [:])
        case ("GET", "\(base)/directory"):
            return (200, wire(["entries": Array(directory.values)]))
        case ("POST", "\(base)/directory"):
            let e = body!["entry"] as! [String: Any]
            directory[e["entryId"] as! String] = wire(e); return (200, [:])
        case ("GET", "\(base)/connectors"):
            return (200, wire(["connectors": connectors]))
        case ("POST", "\(base)/connectors"):
            connectors.append(wire(body!)); return (200, [:])
        case ("GET", "\(base)/proposals"):
            return (200, wire(["proposals": proposals]))
        case ("POST", "\(base)/proposals/decisions"):
            decisions.append(wire(body!)); return (200, [:])
        case ("POST", "\(base)/revokes"):
            revokes.append(wire(body!)); return (200, [:])
        case ("POST", "\(base)/invites"):
            let inv = body!["invite"] as! [String: Any]
            invites[inv["seatId"] as! String] = wire(["invite": inv, "roles": body!["roles"]!])
            offers[inv["seatId"] as! String] = body!["offerHex"] as? String
            return (200, [:])
        case ("GET", "\(base)/ceremonies"):
            return (200, wire(["ceremonies": ceremonies]))
        case ("POST", "\(base)/seats"):
            grants.append(wire(body!))
            // As .com does: the KEM key a seat sent with its accept becomes its KEM key when the grant lands.
            let sid = (body!["grant"] as? [String: Any])?["seatId"] as? String
            if let k = accepts.first(where: { ($0["accept"] as? [String: Any])?["seatId"] as? String == sid })?["seatKem"] as? [String: Any] { seatKems.append(k) }
            return (200, [:])
        case ("GET", "\(base)/directory/slices"):
            return (200, wire(["slices": Array(slices.values)]))
        case ("POST", "\(base)/directory/slices"):
            let sl = body!["slice"] as! [String: Any]
            slices[sl["seatId"] as! String] = wire(body!); return (200, [:])
        case ("POST", "\(base)/ceremonies"):
            ceremonies.append(wire(["sha256": OrgAuthority.sha256Hex(Array((body!["order"] as! String).utf8)), "order": body!["order"]!,
                                    "payload": body!["payload"]!, "approvals": body!["approvals"]!]))
            return (200, [:])
        default:
            if method == "GET", path.hasPrefix("\(base)/invites/") {
                if inviteExpired { return (410, ["code": "org-invite-expired"]) }
                let seat = String(path.split(separator: "/").last!)
                guard var inv = invites[seat] else { return (404, [:]) }
                inv["offerHex"] = offers[seat]
                inv["accepted"] = accepts.contains { ($0["accept"] as? [String: Any])?["seatId"] as? String == seat }
                return (200, wire(inv))
            }
            if method == "POST", path.hasSuffix("/accept") { accepts.append(wire(body!)); return (200, [:]) }
            return (404, [:])
        }
    }
}

@MainActor
final class OrgJoinViewModelTests: XCTestCase {
    private let umk = [UInt8](repeating: 7, count: 32)

    private func joiner(_ com: OrgFakeCom, seat: String, key: String, keys: FakeOrgSeatKeys = FakeOrgSeatKeys()) -> OrgJoinViewModel {
        let umk = self.umk
        return OrgJoinViewModel(orgId: com.orgId, seatId: seat, keyHex: key, client: com.client, keys: keys, now: { com.now }, umk: { _ in umk })
    }

    private func admin(_ com: OrgFakeCom) -> OrgViewModel {
        let umk = self.umk
        return OrgViewModel(client: com.client, keys: com.founderKeys, now: { com.now }, umk: { _ in umk })
    }

    func testJoinShowsTheCodeTheAdminSeesAndTheAdmitVerifies() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.member])
        let mine = FakeOrgSeatKeys()
        let vm = joiner(com, seat: seat, key: key, keys: mine)
        await vm.load()
        XCTAssertEqual(vm.phase, .ready(orgName: "acme", pseudonym: "Pat", isAdminRole: false))
        await vm.accept()
        guard case .accepted(let code) = vm.phase else { return XCTFail("\(vm.phase)") }
        XCTAssertEqual(com.accepts.count, 1)
        XCTAssertEqual(mine.seats().first?.memberOnly, true)

        let a = admin(com)
        await a.load(com.founder)
        let waiting = try XCTUnwrap(a.pendingJoins.first)
        XCTAssertEqual(waiting.sas, code.replacingOccurrences(of: " ", with: ""))
        await a.admit(com.founder, waiting)
        XCTAssertEqual(com.grants.count, 1)
        let snap = try await com.client.snapshot(orgId: com.orgId, genesisHash: com.genesisHash, now: com.now)
        XCTAssertNotNil(snap.book.seats[seat])
        XCTAssertTrue(a.pendingJoins.isEmpty)
    }

    func testTheAcceptCarriesTheSeatsKemKeySignedByItsMemberKey() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.member])
        let vm = joiner(com, seat: seat, key: key)
        await vm.load(); await vm.accept()
        let a = admin(com)
        await a.load(com.founder)
        await a.admit(com.founder, try XCTUnwrap(a.pendingJoins.first))
        let k = try XCTUnwrap(com.accepts.first?["seatKem"] as? [String: Any])
        let snap = try await com.client.snapshot(orgId: com.orgId, genesisHash: com.genesisHash, now: com.now)
        let v = try OrgRotation.verifySeatKem(snap.state, snap.book, statement: k["statement"] as! [String: Any], kemPubHex: k["kemPubHex"] as! String,
                                              signatureHex: k["signature"] as! String, now: com.now)
        let expected = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umk, orgId: com.orgId))
        XCTAssertEqual(v.kemKeyId, OrgAuthority.kemKeyIdHex(expected.publicKey))
    }

    func testAdminsSeeThePseudonymTheInviterChoseAndComSeesNoName() async throws {
        let com = try OrgFakeCom()
        let a = admin(com)
        await a.load(com.founder)
        await a.invite(com.founder, pseudonym: "Ana Pérez", role: .member, target: "")
        let link = try XCTUnwrap(a.inviteLink)
        let frag = try XCTUnwrap(link.split(separator: "#").last)
        let parts = Dictionary(uniqueKeysWithValues: frag.split(separator: "&").map { p in (String(p.split(separator: "=")[0]), String(p.split(separator: "=")[1])) })
        let seat = try XCTUnwrap(parts["s"])
        let vm = joiner(com, seat: seat, key: try XCTUnwrap(parts["k"]))
        await vm.load(); await vm.accept()
        let b = admin(com)
        await b.load(com.founder)
        XCTAssertEqual(b.pendingJoins.first?.seatId, seat)
        XCTAssertEqual(b.name(com.founder, seat), "Ana Pérez")
        XCTAssertEqual(b.name(com.founder, com.founderSeat), String(localized: "You"))
        let stored = String(decoding: try JSONSerialization.data(withJSONObject: Array(com.directory.values)), as: UTF8.self)
        XCTAssertFalse(stored.contains("Ana"))
        XCTAssertEqual(com.directory.count, 1)
    }

    func testAnAdminRoleKeepsAnAdminKeyOnThisPhone() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.serverAdmin(servers: ["home.acme.flagship.services"])])
        let mine = FakeOrgSeatKeys()
        let vm = joiner(com, seat: seat, key: key, keys: mine)
        await vm.load()
        XCTAssertEqual(vm.phase, .ready(orgName: "acme", pseudonym: "Pat", isAdminRole: true))
        await vm.accept()
        XCTAssertNotNil(mine.stored.values.first?.secret)
        let a = admin(com)
        await a.load(com.founder)
        await a.admit(com.founder, try XCTUnwrap(a.pendingJoins.first))
        let snap = try await com.client.snapshot(orgId: com.orgId, genesisHash: com.genesisHash, now: com.now)
        XCTAssertNotNil(snap.book.seats[seat]?.admin)
    }

    func testAnExpiredInvitationSaysSo() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.member])
        com.inviteExpired = true
        let vm = joiner(com, seat: seat, key: key)
        await vm.load()
        guard case .failed = vm.phase else { return XCTFail("\(vm.phase)") }
    }

    func testAWrongLinkKeyOpensNothing() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        _ = try com.invite(seatId: seat, roles: [.member])
        let vm = joiner(com, seat: seat, key: String(repeating: "ab", count: 32))
        await vm.load()
        guard case .failed = vm.phase else { return XCTFail("\(vm.phase)") }
        XCTAssertTrue(com.accepts.isEmpty)
    }

    func testAnotherOrgsChainIsRefused() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.member])
        com.entries = try OrgFakeCom().entries
        let vm = joiner(com, seat: seat, key: key)
        await vm.load()
        guard case .failed = vm.phase else { return XCTFail("\(vm.phase)") }
    }

    func testALockedSessionCannotAdmit() async throws {
        let com = try OrgFakeCom()
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.member])
        let vm = joiner(com, seat: seat, key: key)
        await vm.load(); await vm.accept()
        com.founderKeys.locked = true
        let a = admin(com)
        await a.load(com.founder)
        await a.admit(com.founder, try XCTUnwrap(a.pendingJoins.first))
        XCTAssertTrue(com.grants.isEmpty)
        XCTAssertNotNil(a.message)
    }
}

/// "Rotate keys" after a server admin leaves: the Swift port of the rotation planner end to end.
@MainActor
final class OrgRotateViewModelTests: XCTestCase {
    private let domain = "home.acme.flagship.services"
    private let umkX = [UInt8](repeating: 9, count: 32)
    private let umkA = [UInt8](repeating: 5, count: 32)

    private func world() async throws -> (OrgFakeCom, String) {
        let com = try OrgFakeCom()
        let stk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 4, count: 32))
        com.servers = [["serverDomain": domain, "identityPubKeyHex": OrgAuthority.hex([UInt8](stk.publicKey.rawRepresentation))]]
        let box = try PqHybrid.hybridSealKeygen(seed: [UInt8](repeating: 8, count: 32))
        let boxId = OrgAuthority.kemKeyIdHex(box.publicKey)
        let bt = com.now - 50_000
        let boxMsg = try OrgAuthority.canonicalBoxKem(orgId: com.orgId, serverDomain: domain, kemKeyId: boxId, issuedAt: bt)
        com.boxKems = [["statement": ["orgId": com.orgId, "serverDomain": domain, "kemKeyId": boxId, "issuedAt": NSNumber(value: bt)] as [String: Any],
                        "kemPubHex": OrgAuthority.hex(box.publicKey), "signature": OrgAuthority.hex([UInt8](try stk.signature(for: Data(boxMsg))))]]
        // Seat X: a server admin of the box, admitted after the codes match.
        let x = OrgAuthority.randomId()
        let key = try com.invite(seatId: x, roles: [.serverAdmin(servers: [domain])])
        let umkX = self.umkX, umkA = self.umkA
        let j = OrgJoinViewModel(orgId: com.orgId, seatId: x, keyHex: key, client: com.client, keys: FakeOrgSeatKeys(), now: { com.now }, umk: { _ in umkX })
        await j.load(); await j.accept()
        let admin = OrgViewModel(client: com.client, keys: com.founderKeys, now: { com.now }, umk: { _ in umkA })
        await admin.load(com.founder)
        await admin.admit(com.founder, try XCTUnwrap(admin.pendingJoins.first))
        XCTAssertEqual(com.grants.count, 1)
        // X announces its KEM key under its member key, and receives version 1 of the box's backup keys.
        let kt = com.now - 40_000
        let xKem = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umkX, orgId: com.orgId))
        let xId = OrgAuthority.kemKeyIdHex(xKem.publicKey)
        let member = try OrgAuthority.memberKey(umk: umkX, orgId: com.orgId, seatId: x, issuedAt: kt)
        let xMsg = try OrgAuthority.canonicalSeatKem(orgId: com.orgId, seatId: x, kemKeyId: xId, issuedAt: kt)
        com.seatKems = [["statement": ["orgId": com.orgId, "seatId": x, "kemKeyId": xId, "issuedAt": NSNumber(value: kt)] as [String: Any],
                         "kemPubHex": OrgAuthority.hex(xKem.publicKey),
                         "signature": OrgAuthority.hex(try PqHybrid.hybridSign(secretKey: member.secret, purpose: OrgAuthority.tagSeatKem, payload: xMsg))]]
        let t1 = com.now - 30_000
        let snap = try await com.client.snapshot(orgId: com.orgId, genesisHash: com.genesisHash, now: t1)
        let plan = try await com.client.rotationPlan(snap, now: t1)
        let founder = com.founder
        let v1 = try OrgRotation.rotate(plan, kind: .archiveKeys, scope: domain, issuedAt: t1, key: [UInt8](repeating: 1, count: 32)) { order, oar in
            try OrgAuthority.signApproval(orgId: com.orgId, oarVersion: oar, order: order, seatId: founder.seatId, adminKeyId: founder.keyId,
                                          issuedAt: t1, notAfter: t1 + OrgAuthority.day) { p, m in com.founderKeys.sign(founder, purpose: p, payload: m)! }
        }
        XCTAssertTrue(v1.recipients.contains { $0.recipient == "seat:\(x)" })
        com.rings = [(try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: v1.json))) as! [String: Any]]
        // X is removed.
        let rt = com.now - 20_000
        let order = try OrgAuthority.canonicalSeatRevoke(orgId: com.orgId, seatId: x, reason: "removed", oarVersion: 0, issuedAt: rt)
        let a = try OrgAuthority.signApproval(orgId: com.orgId, oarVersion: 0, order: order, seatId: founder.seatId, adminKeyId: founder.keyId,
                                              issuedAt: rt, notAfter: rt + OrgAuthority.day) { p, m in com.founderKeys.sign(founder, purpose: p, payload: m)! }
        com.revokes = [["revoke": ["orgId": com.orgId, "seatId": x, "reason": "removed", "oarVersion": 0, "issuedAt": NSNumber(value: rt)] as [String: Any],
                        "approvals": [a.jsonObject]]]
        return (com, x)
    }

    func testRotateAnswersTheDepartedSeat() async throws {
        let (com, x) = try await world()
        let umkA = self.umkA
        let vm = OrgViewModel(client: com.client, keys: com.founderKeys, now: { com.now }, umk: { _ in umkA })
        await vm.load(com.founder)
        let pending = try XCTUnwrap(vm.rotations.first)
        XCTAssertEqual(pending.seatId, x)
        XCTAssertEqual(pending.keys, [.init(kind: .archiveKeys, scope: domain)])
        await vm.rotate(com.founder, pending)
        // Opening the org page also made the directory key (docs/org-directory.md); count the backup keys' chain.
        let archive = com.rings.filter { ($0["ring"] as? [String: Any])?["kind"] as? String == "archive-keys" }
        XCTAssertEqual(archive.count, 2)
        let v2 = try OrgKeyRingBundle.fromWire(archive.last)
        XCTAssertEqual(v2.ring.version, 2)
        XCTAssertEqual(v2.ring.retired, [x])
        XCTAssertFalse(v2.recipients.contains { $0.recipient == "seat:\(x)" })
        XCTAssertTrue(v2.recipients.contains { $0.recipient == "box:\(domain)" })
        XCTAssertTrue(vm.rotations.isEmpty)
        let box = try PqHybrid.hybridSealKeygen(seed: [UInt8](repeating: 8, count: 32))
        XCTAssertEqual(try OrgAuthority.openKeyRing(v2.ring, recipients: v2.recipients, recipient: "box:\(domain)", kemSecret: box.secretKey).count, 32)
    }

    func testALockedSessionRotatesNothing() async throws {
        let (com, _) = try await world()
        com.founderKeys.locked = true
        let umkA = self.umkA
        let vm = OrgViewModel(client: com.client, keys: com.founderKeys, now: { com.now }, umk: { _ in umkA })
        await vm.load(com.founder)
        await vm.rotate(com.founder, try XCTUnwrap(vm.rotations.first))
        XCTAssertEqual(com.rings.count, 1)
        XCTAssertNotNil(vm.message)
    }
}


/// The admin console's Directory: a connector's proposal opens on the admin's phone and is carried out
/// with the usual invitation; adding a SCIM connector seals its setup to the chosen server.
@MainActor
final class OrgDirectoryConsoleTests: XCTestCase {
    private let umk = [UInt8](repeating: 7, count: 32)
    private let domain = "home.acme.flagship.services"

    private func admin(_ com: OrgFakeCom) -> OrgViewModel {
        let umk = self.umk
        return OrgViewModel(client: com.client, keys: com.founderKeys, now: { com.now }, umk: { _ in umk })
    }

    func testAProposalOpensAndApprovingItMakesTheInvitation() async throws {
        let com = try OrgFakeCom()
        let a = admin(com)
        await a.load(com.founder)
        // A connector (its record as .com serves it) proposes inviting Ben, sealed to the founder's seat KEM key.
        let conn = try PqHybrid.hybridSigKeygen(edSeed: [UInt8](repeating: 0x61, count: 32), mldsaSeed: [UInt8](repeating: 0x62, count: 32))
        let connector = OrgConnector(orgId: com.orgId, connectorId: OrgAuthority.randomId(), kind: "scim", serverDomain: domain,
                                     connectorKeyId: try OrgConnectors.connectorKeyId(conn.publicKey), scopes: OrgConnectors.scopes,
                                     mappingSha256: String(repeating: "ab", count: 32), status: "active", issuedAt: com.now - 1000)
        com.connectors = [["connector": OrgConnectors.connectorJSON(connector), "connectorPubHex": OrgAuthority.hex(conn.publicKey), "approvals": []]]
        let kem = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umk, orgId: com.orgId))
        let pending = OrgAuthority.randomId(), proposalId = OrgAuthority.randomId(), t = com.now - 500
        let body = try OrgDirectory.canonicalBody(OrgDirectoryEntry(seatId: "", pendingId: pending, pseudonym: "Ben Okafor", email: "ben@acme.example",
                                                                    source: "scim", updatedAt: t))
        let recipient = "seat:\(com.founderSeat)"
        let sealed = try PqHybrid.hybridSeal(recipientPublicKey: kem.publicKey,
                                             options: HybridSealOptions(purpose: OrgConnectors.tagProposal, senderKeyId: [UInt8](repeating: 0, count: 32), issuedAt: UInt64(t)),
                                             context: [com.orgId, proposalId, recipient].map { Array($0.utf8) }, plaintext: body)
        let recipients = [(recipient: recipient, kemKeyId: OrgAuthority.kemKeyIdHex(kem.publicKey), sealedHex: OrgAuthority.hex(sealed))]
        let roles: [OrgSeatRole] = [.member]
        let proposal = OrgProposal(orgId: com.orgId, proposalId: proposalId, connectorId: connector.connectorId, kind: "invite", subject: pending,
                                   rolesHash: try OrgAuthority.rolesHash(roles), sealedSha256: try OrgConnectors.recipientsHash(recipients), issuedAt: t)
        let sig = try PqHybrid.hybridSign(secretKey: conn.secretKey, purpose: OrgConnectors.tagProposal, payload: try OrgConnectors.canonicalProposal(proposal))
        com.proposals = [["bundle": [
            "proposal": ["orgId": proposal.orgId, "proposalId": proposal.proposalId, "connectorId": proposal.connectorId, "kind": proposal.kind,
                         "subject": proposal.subject, "rolesHash": proposal.rolesHash, "sealedSha256": proposal.sealedSha256, "issuedAt": NSNumber(value: t)] as [String: Any],
            "roles": OrgAuthorityWire.rolesJSON(roles),
            "recipients": recipients.map { ["recipient": $0.recipient, "kemKeyId": $0.kemKeyId, "sealedHex": $0.sealedHex] },
            "signature": OrgAuthority.hex(sig),
        ] as [String: Any], "decision": NSNull()]]
        await a.load(com.founder)
        let p = try XCTUnwrap(a.proposals.first)
        XCTAssertEqual(p.entry.pseudonym, "Ben Okafor")
        XCTAssertEqual(p.entry.email, "ben@acme.example")
        await a.approveProposal(com.founder, p)
        XCTAssertNotNil(a.inviteLink)
        let d = try XCTUnwrap(com.decisions.first?["decision"] as? [String: Any])
        XCTAssertEqual(d["decision"] as? String, "done")
        let inv = try XCTUnwrap(com.invites.values.first?["invite"] as? [String: Any])
        let invSha = OrgAuthority.sha256Hex(try OrgAuthority.canonicalSeatInvite(orgId: com.orgId, seatId: inv["seatId"] as! String, labelSha256: inv["labelSha256"] as! String,
            rolesHash: inv["rolesHash"] as! String, oarVersion: (inv["oarVersion"] as! NSNumber).int64Value, issuedAt: (inv["issuedAt"] as! NSNumber).int64Value,
            expiresAt: (inv["expiresAt"] as! NSNumber).int64Value))
        XCTAssertEqual(d["refSha256"] as? String, invSha)
        XCTAssertEqual(a.name(com.founder, inv["seatId"] as! String), "Ben Okafor")
        XCTAssertTrue(a.proposals.isEmpty)

        // A proposal whose subject was changed after the connector signed it is not shown.
        var forged = com.proposals[0]["bundle"] as! [String: Any]
        var fp = forged["proposal"] as! [String: Any]
        fp["subject"] = OrgAuthority.randomId(); forged["proposal"] = fp
        com.proposals = [["bundle": forged, "decision": NSNull()]]
        await a.load(com.founder)
        XCTAssertTrue(a.proposals.isEmpty)
    }

    func testAddingAScimConnectorSealsItsSetupToTheServerAndShowsTheTokenOnce() async throws {
        let com = try OrgFakeCom()
        let stk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 4, count: 32))
        com.servers = [["serverDomain": domain, "identityPubKeyHex": OrgAuthority.hex([UInt8](stk.publicKey.rawRepresentation))]]
        let box = try PqHybrid.hybridSealKeygen(seed: [UInt8](repeating: 8, count: 32))
        let boxId = OrgAuthority.kemKeyIdHex(box.publicKey), bt = com.now - 50_000
        let boxMsg = try OrgAuthority.canonicalBoxKem(orgId: com.orgId, serverDomain: domain, kemKeyId: boxId, issuedAt: bt)
        com.boxKems = [["statement": ["orgId": com.orgId, "serverDomain": domain, "kemKeyId": boxId, "issuedAt": NSNumber(value: bt)] as [String: Any],
                        "kemPubHex": OrgAuthority.hex(box.publicKey), "signature": OrgAuthority.hex([UInt8](try stk.signature(for: Data(boxMsg))))]]
        let a = admin(com)
        await a.load(com.founder)
        XCTAssertEqual(a.servers, [domain])
        await a.addScimConnector(com.founder, serverDomain: domain)
        let shown = try XCTUnwrap(a.newConnector)
        XCTAssertEqual(shown.url, "https://\(domain)/scim/v2")
        let posted = try XCTUnwrap(com.connectors.first)
        let c = try OrgConnector.fromWire(posted["connector"])
        XCTAssertEqual(c.serverDomain, domain)
        XCTAssertEqual(try OrgConnectors.connectorKeyId(OrgAuthority.bytes(hex: posted["connectorPubHex"] as! String)!), c.connectorKeyId)
        let setup = posted["setup"] as! [String: Any]
        let (_, plain) = try PqHybrid.hybridOpen(recipientSecretKey: box.secretKey, expectedPurpose: OrgConnectors.tagConnector,
                                                 context: [com.orgId, c.connectorId, domain].map { Array($0.utf8) }, sealed: OrgAuthority.bytes(hex: setup["sealedHex"] as! String)!)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(plain)) as? [String: Any])
        XCTAssertEqual(o["scimTokenSha256"] as? String, OrgAuthority.sha256Hex(Array(shown.token.utf8)))
        XCTAssertEqual(try OrgConnectors.mappingSha256(o["mapping"] as! [String: Any]), c.mappingSha256)
        XCTAssertFalse(String(describing: posted).contains(shown.token))
        a.clearNewConnector()
        XCTAssertNil(a.newConnector)
    }
}


/// Members' slices, a role change carried out from the console, and connector upkeep.
@MainActor
final class OrgDirectoryUpkeepTests: XCTestCase {
    private let umkA = [UInt8](repeating: 7, count: 32)
    private let umkM = [UInt8](repeating: 3, count: 32)
    private let domain = "home.acme.flagship.services"

    private func admin(_ com: OrgFakeCom) -> OrgViewModel {
        let u = umkA
        return OrgViewModel(client: com.client, keys: com.founderKeys, now: { com.now }, umk: { _ in u })
    }

    /// A member admitted through the real join; returns its seat id and its phone's keys.
    private func member(_ com: OrgFakeCom, _ a: OrgViewModel) async throws -> (String, FakeOrgSeatKeys) {
        let seat = OrgAuthority.randomId()
        let key = try com.invite(seatId: seat, roles: [.member], pseudonym: "Mia")
        let mine = FakeOrgSeatKeys()
        let u = umkM
        let j = OrgJoinViewModel(orgId: com.orgId, seatId: seat, keyHex: key, client: com.client, keys: mine, now: { com.now }, umk: { _ in u })
        await j.load(); await j.accept()
        await a.load(com.founder)
        await a.admit(com.founder, try XCTUnwrap(a.pendingJoins.first))
        return (seat, mine)
    }

    private func withServer(_ com: OrgFakeCom) throws {
        let stk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 4, count: 32))
        com.servers = [["serverDomain": domain, "identityPubKeyHex": OrgAuthority.hex([UInt8](stk.publicKey.rawRepresentation))]]
        let box = try PqHybrid.hybridSealKeygen(seed: [UInt8](repeating: 8, count: 32))
        let boxId = OrgAuthority.kemKeyIdHex(box.publicKey), bt = com.now - 50_000
        let msg = try OrgAuthority.canonicalBoxKem(orgId: com.orgId, serverDomain: domain, kemKeyId: boxId, issuedAt: bt)
        com.boxKems = [["statement": ["orgId": com.orgId, "serverDomain": domain, "kemKeyId": boxId, "issuedAt": NSNumber(value: bt)] as [String: Any],
                        "kemPubHex": OrgAuthority.hex(box.publicKey), "signature": OrgAuthority.hex([UInt8](try stk.signature(for: Data(msg))))]]
    }

    private func openSetup(_ com: OrgFakeCom, _ posted: [String: Any]) throws -> [String: Any] {
        let c = try OrgConnector.fromWire(posted["connector"])
        let box = try PqHybrid.hybridSealKeygen(seed: [UInt8](repeating: 8, count: 32))
        let (_, plain) = try PqHybrid.hybridOpen(recipientSecretKey: box.secretKey, expectedPurpose: OrgConnectors.tagConnector,
                                                 context: [com.orgId, c.connectorId, domain].map { Array($0.utf8) },
                                                 sealed: OrgAuthority.bytes(hex: (posted["setup"] as! [String: Any])["sealedHex"] as! String)!)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(plain)) as? [String: Any])
    }

    func testAMemberSeesOnlyThePeopleItSharesWith() async throws {
        let com = try OrgFakeCom()
        let a = admin(com)
        await a.load(com.founder)
        try await a.recordEntry(com.founder, OrgDirectoryEntry(seatId: com.founderSeat, pseudonym: "Fay", email: "fay@acme.example", updatedAt: com.now))
        let (seat, mine) = try await member(com, a)
        await a.load(com.founder)
        let stored = try XCTUnwrap(com.slices[seat])
        XCTAssertFalse(String(describing: stored).contains("Fay"))
        let u = umkM
        let m = OrgViewModel(client: com.client, keys: mine, now: { com.now }, umk: { _ in u })
        let mseat = try XCTUnwrap(mine.seats().first)
        await m.load(mseat)
        XCTAssertFalse(m.isOrgAdmin(mseat))
        let sw = try XCTUnwrap(m.sharedWith)
        XCTAssertEqual(sw.people.map(\.pseudonym), ["Fay"])
        XCTAssertEqual(sw.people.first?.email, "")
        XCTAssertEqual(m.name(mseat, com.founderSeat), "Fay")
        // A slice without an org admin's approval is not shown.
        var forged = stored
        forged["approvals"] = []
        com.slices[seat] = forged
        await m.load(mseat)
        XCTAssertNil(m.sharedWith)
    }

    func testARoleChangeProposalIsCarriedOutWithANewGrant() async throws {
        let com = try OrgFakeCom()
        let a = admin(com)
        await a.load(com.founder)
        let (seat, _) = try await member(com, a)
        let conn = try PqHybrid.hybridSigKeygen(edSeed: [UInt8](repeating: 0x61, count: 32), mldsaSeed: [UInt8](repeating: 0x62, count: 32))
        let connector = OrgConnector(orgId: com.orgId, connectorId: OrgAuthority.randomId(), kind: "scim", serverDomain: domain,
                                     connectorKeyId: try OrgConnectors.connectorKeyId(conn.publicKey), scopes: OrgConnectors.scopes,
                                     mappingSha256: String(repeating: "ab", count: 32), status: "active", issuedAt: com.now - 1000)
        com.connectors = [["connector": OrgConnectors.connectorJSON(connector), "connectorPubHex": OrgAuthority.hex(conn.publicKey), "approvals": []]]
        let kem = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umkA, orgId: com.orgId))
        let pid = OrgAuthority.randomId(), t = com.now - 500
        let body = try OrgDirectory.canonicalBody(OrgDirectoryEntry(seatId: seat, pseudonym: "Mia", source: "scim", updatedAt: t))
        let recipient = "seat:\(com.founderSeat)"
        let sealed = try PqHybrid.hybridSeal(recipientPublicKey: kem.publicKey,
                                             options: HybridSealOptions(purpose: OrgConnectors.tagProposal, senderKeyId: [UInt8](repeating: 0, count: 32), issuedAt: UInt64(t)),
                                             context: [com.orgId, pid, recipient].map { Array($0.utf8) }, plaintext: body)
        let recipients = [(recipient: recipient, kemKeyId: OrgAuthority.kemKeyIdHex(kem.publicKey), sealedHex: OrgAuthority.hex(sealed))]
        let roles: [OrgSeatRole] = [.member, .unlock(servers: [domain])]
        let prop = OrgProposal(orgId: com.orgId, proposalId: pid, connectorId: connector.connectorId, kind: "role-change", subject: seat,
                               rolesHash: try OrgAuthority.rolesHash(roles), sealedSha256: try OrgConnectors.recipientsHash(recipients), issuedAt: t)
        let sig = try PqHybrid.hybridSign(secretKey: conn.secretKey, purpose: OrgConnectors.tagProposal, payload: try OrgConnectors.canonicalProposal(prop))
        com.proposals = [["bundle": [
            "proposal": ["orgId": prop.orgId, "proposalId": pid, "connectorId": prop.connectorId, "kind": prop.kind, "subject": seat, "rolesHash": prop.rolesHash,
                         "sealedSha256": prop.sealedSha256, "issuedAt": NSNumber(value: t)] as [String: Any],
            "roles": OrgAuthorityWire.rolesJSON(roles),
            "recipients": recipients.map { ["recipient": $0.recipient, "kemKeyId": $0.kemKeyId, "sealedHex": $0.sealedHex] },
            "signature": OrgAuthority.hex(sig),
        ] as [String: Any], "decision": NSNull()]]
        await a.load(com.founder)
        let p = try XCTUnwrap(a.proposals.first)
        XCTAssertEqual(p.kind, "role-change")
        let before = com.grants.count
        await a.approveProposal(com.founder, p)
        XCTAssertEqual(com.grants.count, before + 1)
        let snap = try await com.client.snapshot(orgId: com.orgId, genesisHash: com.genesisHash, now: com.now)
        XCTAssertEqual(snap.book.seats[seat]?.roles, roles)
        XCTAssertEqual((com.decisions.last?["decision"] as? [String: Any])?["decision"] as? String, "done")
    }

    func testPauseRotateMappingAndLdap() async throws {
        let com = try OrgFakeCom()
        try withServer(com)
        let a = admin(com)
        await a.load(com.founder)
        await a.addScimConnector(com.founder, serverDomain: domain)
        let first = try XCTUnwrap(com.connectors.last)
        let id = try OrgConnector.fromWire(first["connector"]).connectorId
        XCTAssertNotNil(first["mappingSealed"])
        a.clearNewConnector()
        await a.load(com.founder)

        await a.rotateScimToken(com.founder, id)
        let token = try XCTUnwrap(a.newConnector?.token)
        let rotated = try openSetup(com, try XCTUnwrap(com.connectors.last))
        XCTAssertNil(rotated["connectorSeedsHex"])
        XCTAssertEqual(rotated["scimTokenSha256"] as? String, OrgAuthority.sha256Hex(Array(token.utf8)))

        await a.load(com.founder)
        await a.setConnectorStatus(com.founder, id, status: "paused")
        XCTAssertEqual(try OrgConnector.fromWire(com.connectors.last?["connector"]).status, "paused")

        await a.load(com.founder)
        await a.saveMapping(com.founder, id, rows: [.init(group: "Finance", role: .serverAdmin, target: domain)], defaultMember: false)
        let saved = try XCTUnwrap(com.connectors.last)
        let rec = try OrgConnector.fromWire(saved["connector"])
        let sealedSetup = try openSetup(com, saved)
        let mapping = try XCTUnwrap(sealedSetup["mapping"] as? [String: Any])
        XCTAssertEqual(try OrgConnectors.mappingSha256(mapping), rec.mappingSha256)
        XCTAssertNotNil((mapping["groups"] as? [String: Any])?["Finance"])
        XCTAssertNotNil(saved["mappingSealed"])
        await a.load(com.founder)
        XCTAssertEqual(a.mappingRows(id).rows.map(\.group), ["Finance"])

        var form = OrgViewModel.LdapForm()
        form.url = "ldaps://dc1.acme.example"; form.bindDn = "CN=svc,DC=acme,DC=example"; form.password = "s3cret"; form.baseDn = "DC=acme,DC=example"
        await a.saveLdapConnector(com.founder, serverDomain: domain, form: form)
        let ldap = try XCTUnwrap(com.connectors.last)
        XCTAssertEqual(try OrgConnector.fromWire(ldap["connector"]).kind, "ldap")
        XCTAssertEqual((try openSetup(com, ldap)["ldap"] as? [String: Any])?["bindPassword"] as? String, "s3cret")
        XCTAssertFalse(String(describing: ldap).contains("s3cret"))
    }
}
