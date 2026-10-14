import XCTest
import CryptoKit
@testable import FlagshipUI
import FlagshipAPI
import FlagshipCore

/// docs/share-a-server.md §9 on iOS, end to end against an in-memory `.com`,
/// boot gate and box that check every signature the way the real ones do.
final class FakeShareBackend: ServerShareTransport, @unchecked Sendable {
    struct Row {
        var serverDomain: String
        var tokenHash: String
        var offerHex: String
        var ownerHex: String
        var acceptHex: String?
        var ended: String?
        var expiresAt: Int64
        var unlock: (memberPubHex: String, sealed: String)?
    }

    struct Call: Equatable {
        let method: String
        let host: String
        let path: String
    }

    let lock = NSLock()
    let domain: String
    let ownerSensitivePub: Data
    let ownerAccountPub: Data
    let stk: Curve25519.Signing.PrivateKey
    let ownerToken = "owner-token"
    var rows: [String: Row] = [:]
    var inbox: [String: [(entryId: String, ct: String)]] = [:]
    var grants: [String: (grant: ServerShareGrant, sig: String)] = [:]
    var endedOnBox: Set<String> = []
    var nonces: Set<String> = []
    var sessions: [String: String] = [:]
    var sealedLuksForOwner: String?
    var pendingBoot: [[String: Any]] = []
    var bootResponses: [[String: Any]] = []
    var calls: [Call] = []
    var lastGrantBody: [String: Any]?

    init(domain: String, ownerSensitivePub: Data, ownerAccountPub: Data, stk: Curve25519.Signing.PrivateKey) {
        self.domain = domain
        self.ownerSensitivePub = ownerSensitivePub
        self.ownerAccountPub = ownerAccountPub
        self.stk = stk
    }

    func client() -> ServerShareClient {
        ServerShareClient(com: self, box: self,
                          apex: { URL(string: "https://com.test")! },
                          boot: { URL(string: "https://boot.test")! },
                          boxBase: { URL(string: "https://\($0)") })
    }

    func send(_ r: URLRequest) async throws -> (status: Int, body: Data) {
        lock.lock()
        defer { lock.unlock() }
        let url = r.url!
        let path = url.path
        let method = r.httpMethod ?? "GET"
        calls.append(Call(method: method, host: url.host!, path: path))
        let body = r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        let out: (Int, Any)
        switch url.host! {
        case "com.test": out = com(method, path, url, body, r)
        case "boot.test": out = boot(method, path, body, r)
        case domain: out = box(method, path, body, r)
        default: out = (404, ["error": "no host"])
        }
        return (out.0, try JSONSerialization.data(withJSONObject: out.1))
    }

    private func hex(_ v: Any?) -> Data? { (v as? String).flatMap { HexUtil.decode($0) } }

    private func verify<E: ServerShareEnvelope>(_ e: E, _ sig: Any?, _ pub: Data) -> Bool {
        guard let s = hex(sig) else { return false }
        return e.verify(signature: s, publicKey: pub)
    }

    private func com(_ m: String, _ p: String, _ url: URL, _ b: [String: Any], _ r: URLRequest) -> (Int, Any) {
        let parts = p.split(separator: "/").map(String.init)
        let token = r.value(forHTTPHeaderField: ServerShareClient.shareTokenHeader)
        func tokenOk(_ row: Row) -> Bool {
            guard let token, let h = try? ServerShare.shareTokenHash(token) else { return false }
            return h == row.tokenHash
        }
        if m == "POST", p.hasSuffix("/server-shares"), parts.count == 4 {
            guard let offer = ServerShareOffer.parse(jsonObject: b["offer"] as Any),
                  verify(offer, b["signature"], ownerSensitivePub),
                  let offerHex = b["offerHex"] as? String, let ownerHex = b["ownerHex"] as? String,
                  ServerShare.shareSha256Hex(offerHex) == offer.offerSha256,
                  ServerShare.shareSha256Hex(ownerHex) == offer.ownerSha256
            else { return (403, ["error": "invalid signature"]) }
            rows[offer.shareId] = Row(serverDomain: offer.serverDomain, tokenHash: offer.tokenHash, offerHex: offerHex,
                                      ownerHex: ownerHex, expiresAt: offer.expiresAt)
            return (200, ["ok": true])
        }
        if m == "POST", p.hasSuffix("/server-shares/list") {
            guard let list = ServerShareList.parse(jsonObject: b["list"] as Any), verify(list, b["signature"], ownerAccountPub)
            else { return (403, ["error": "invalid signature"]) }
            return (200, ["shares": rows.map { id, row -> [String: Any] in
                [
                    "shareId": id, "serverDomain": row.serverDomain,
                    "state": row.ended != nil ? "ended" : (row.acceptHex != nil ? "accepted" : "offered"),
                    "owner": row.ownerHex, "acceptance": row.acceptHex as Any? ?? NSNull(),
                    "expiresAt": row.expiresAt, "unlock": row.unlock != nil,
                ]
            }])
        }
        if m == "POST", parts.count == 6, parts[1] == "users", parts[5] == "revoke" {
            guard let rv = ServerShareRevoke.parse(jsonObject: b["revoke"] as Any), verify(rv, b["signature"], ownerSensitivePub)
            else { return (403, ["error": "invalid signature"]) }
            guard rows[parts[4]] != nil else { return (404, ["error": "no such share"]) }
            rows[parts[4]]!.ended = "revoke"
            rows[parts[4]]!.unlock = nil
            return (200, ["ok": true])
        }
        if m == "POST", parts.count == 6, parts[1] == "users", parts[5] == "unlock" {
            guard let u = ServerShareUnlock.parse(jsonObject: b["unlock"] as Any), verify(u, b["signature"], ownerSensitivePub)
            else { return (403, ["error": "invalid signature"]) }
            if u.sealedSha256 == ServerShare.unlockOff {
                rows[parts[4]]?.unlock = nil
            } else {
                guard let sealed = b["sealedKey"] as? String, ServerShare.shareSha256Hex(sealed) == u.sealedSha256
                else { return (403, ["error": "sealed copy is not the one that was signed"]) }
                rows[parts[4]]?.unlock = (u.memberPubHex, sealed)
            }
            return (200, ["ok": true])
        }
        if parts.count >= 3, parts[1] == "server-shares" {
            let id = parts[2]
            guard let row = rows[id], tokenOk(row) else { return (404, ["error": "no such share"]) }
            if m == "GET" {
                return (200, ["shareId": id, "serverDomain": row.serverDomain,
                              "state": row.ended != nil ? "ended" : (row.acceptHex != nil ? "accepted" : "offered"),
                              "offer": row.offerHex, "acceptance": row.acceptHex as Any? ?? NSNull(),
                              "expiresAt": row.expiresAt, "unlock": row.unlock != nil])
            }
            if parts.last == "accept" {
                if row.acceptHex != nil { return (409, ["error": "this link was already used"]) }
                rows[id]!.acceptHex = b["acceptance"] as? String
                return (200, ["ok": true])
            }
            if parts.last == "leave" {
                guard let l = ServerShareLeave.parse(jsonObject: b["leave"] as Any),
                      let pub = HexUtil.decode(l.memberPubHex), verify(l, b["signature"], pub)
                else { return (403, ["error": "invalid signature"]) }
                rows[id]!.ended = "leave"
                rows[id]!.unlock = nil
                return (200, ["ok": true])
            }
        }
        if m == "POST", p == "/api/share-inbox" {
            guard let req = ShareInboxRequest.parse(jsonObject: b["request"] as Any),
                  let pub = HexUtil.decode(req.inboxPubHex), verify(req, b["signature"], pub)
            else { return (403, ["error": "invalid signature"]) }
            switch req.op {
            case .list:
                return (200, ["entries": (inbox[req.inboxPubHex] ?? []).map { ["entryId": $0.entryId, "ct": $0.ct, "createdAt": 1] }])
            case .delete:
                inbox[req.inboxPubHex]?.removeAll { $0.entryId == req.entryId }
                return (200, ["ok": true])
            case .put:
                guard let ct = b["ct"] as? String, ServerShare.shareSha256Hex(ct) == req.ctSha256 else { return (403, ["error": "bad ct"]) }
                inbox[req.inboxPubHex, default: []].append((req.entryId, ct))
                return (200, ["ok": true])
            }
        }
        if m == "GET", p == "/api/server/\(domain)/sealed-luks-key" {
            guard let s = sealedLuksForOwner else { return (404, ["error": "none"]) }
            return (200, ["serverDomain": domain, "sealedKey": s, "sealedAt": 1])
        }
        return (404, ["error": "no route"])
    }

    /// The gate: a share-role header signed by the key holding a boot copy.
    private func shareAuth(_ r: URLRequest, method: String, path: String) -> String? {
        guard let h = r.value(forHTTPHeaderField: "authorization"), h.hasPrefix("\(BootAuth.scheme) ") else { return nil }
        var b64 = String(h.dropFirst(BootAuth.scheme.count + 1)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let d = Data(base64Encoded: b64),
              let e = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              e["role"] as? String == "share", e["method"] as? String == method, e["path"] as? String == path,
              let pubHex = e["pubKeyHex"] as? String, let nonceHex = e["nonceHex"] as? String,
              let issuedAt = (e["issuedAt"] as? NSNumber)?.int64Value, let sd = e["serverDomain"] as? String,
              let sig = hex(e["signatureHex"]), let pubData = HexUtil.decode(pubHex),
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: pubData)
        else { return nil }
        let canon = BootAuth.canonicalBytes(role: "share", serverDomain: sd, method: method, path: path,
                                            pubKeyHex: pubHex, nonceHex: nonceHex, issuedAt: issuedAt)
        guard pub.isValidSignature(sig, for: canon),
              rows.values.contains(where: { $0.ended == nil && $0.unlock?.memberPubHex == pubHex })
        else { return nil }
        return pubHex
    }

    private func boot(_ m: String, _ p: String, _ b: [String: Any], _ r: URLRequest) -> (Int, Any) {
        guard let member = shareAuth(r, method: m, path: p) else { return (403, ["error": "this share can't unlock this server"]) }
        if m == "GET", p == ServerShareClient.bootPendingPath(domain) { return (200, ["requests": pendingBoot]) }
        if m == "GET", p == ServerShareClient.bootKeyPath(domain) {
            let copy = rows.values.first { $0.unlock?.memberPubHex == member }!.unlock!.sealed
            return (200, ["sealedKey": copy])
        }
        if m == "POST", p == ServerShareClient.bootResponsePath {
            bootResponses.append(b["response"] as? [String: Any] ?? [:])
            return (200, ["ok": true])
        }
        return (404, ["error": "no route"])
    }

    private func box(_ m: String, _ p: String, _ b: [String: Any], _ r: URLRequest) -> (Int, Any) {
        let session = r.value(forHTTPHeaderField: ServerShareClient.sessionHeader)
        if p.hasPrefix("/api/screens/") {
            guard session == ownerToken else { return (403, ["error": "owner-only", "code": "owner-only"]) }
            if m == "GET", p == "/api/screens/shares" {
                return (200, ["shares": grants.values.map { g -> [String: Any] in
                    ["shareId": g.grant.shareId, "label": g.grant.label, "level": g.grant.level.rawValue,
                     "unlockAtBoot": g.grant.unlockAtBoot, "seeAppData": g.grant.seeAppData,
                     "memberPubHex": g.grant.memberPubHex, "issuedAt": g.grant.issuedAt, "lastSeenAt": 5]
                }, "ended": endedOnBox.map { ["shareId": $0, "label": "x", "endedAt": 1, "reason": "revoked"] }])
            }
            if m == "POST", p == "/api/screens/shares" {
                lastGrantBody = b
                guard let g = ServerShareGrant.parse(jsonObject: b["grant"] as Any), verify(g, b["signature"], ownerSensitivePub),
                      g.serverDomain == domain
                else { return (403, ["error": "invalid signature"]) }
                if endedOnBox.contains(g.shareId) { return (410, ["error": "share-ended"]) }
                if let held = grants[g.shareId] {
                    guard held.grant.memberPubHex == g.memberPubHex, g.issuedAt > held.grant.issuedAt
                    else { return (409, ["error": "a newer grant is already applied"]) }
                } else {
                    guard let a = ServerShareAccept.parse(jsonObject: b["accept"] as Any),
                          let pub = HexUtil.decode(a.memberPubHex), verify(a, b["acceptSignature"], pub),
                          a.memberPubHex == g.memberPubHex, a.shareId == g.shareId
                    else { return (400, ["error": "the first grant needs the acceptance"]) }
                }
                grants[g.shareId] = (g, b["signature"] as! String)
                return (200, ["ok": true])
            }
            if m == "POST", p == "/api/screens/shares/revoke" {
                guard let rv = ServerShareRevoke.parse(jsonObject: b["revoke"] as Any), verify(rv, b["signature"], ownerSensitivePub)
                else { return (403, ["error": "invalid signature"]) }
                grants[rv.shareId] = nil
                endedOnBox.insert(rv.shareId)
                sessions = sessions.filter { $0.value != rv.shareId }
                return (200, ["ok": true])
            }
            if m == "GET", p == "/api/screens/activity" {
                return (200, ["entries": [["ts": 1, "actor": ["kind": "share", "shareId": "x", "label": "Sam"], "action": "share.signed-in", "ok": true]]])
            }
        }
        if m == "GET", p == "/api/shares/nonce" {
            let n = HexUtil.encode(BootAuth.randomNonce())
            nonces.insert(n)
            return (200, ["nonce": n])
        }
        if m == "POST", p == "/api/shares/session" {
            guard let s = ServerShareSession.parse(jsonObject: b["session"] as Any),
                  let pub = HexUtil.decode(s.memberPubHex), verify(s, b["signature"], pub), nonces.remove(s.nonceHex) != nil
            else { return (403, ["error": "invalid signature"]) }
            if endedOnBox.contains(s.shareId) { return (403, ["error": "share-ended", "code": "share-ended"]) }
            guard let held = grants[s.shareId], held.grant.memberPubHex == s.memberPubHex
            else { return (403, ["error": "not-shared", "code": "not-shared"]) }
            let token = "fss_" + HexUtil.encode(BootAuth.randomNonce())
            sessions[token] = s.shareId
            return (200, ["token": token, "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 43_200_000,
                          "level": held.grant.level.rawValue, "unlockAtBoot": held.grant.unlockAtBoot,
                          "seeAppData": held.grant.seeAppData])
        }
        if m == "POST", p == "/api/shares/leave" {
            guard let l = ServerShareLeave.parse(jsonObject: b["leave"] as Any),
                  let pub = HexUtil.decode(l.memberPubHex), verify(l, b["signature"], pub)
            else { return (403, ["error": "invalid signature"]) }
            guard let held = grants[l.shareId] else { return (200, ["ok": true, "alreadyEnded": true]) }
            guard held.grant.memberPubHex == l.memberPubHex else { return (403, ["error": "not this share's key"]) }
            grants[l.shareId] = nil
            endedOnBox.insert(l.shareId)
            return (200, ["ok": true])
        }
        return (404, ["error": "no route"])
    }

    func didCall(_ method: String, _ host: String, _ pathSuffix: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return calls.contains { $0.method == method && $0.host == host && $0.path.hasSuffix(pathSuffix) }
    }
}

final class ServerShareFlowTests: XCTestCase {
    let domain = "home.alice.flagship.services"
    let ownerSensitive = Curve25519.Signing.PrivateKey()
    let ownerIrk = Curve25519.Signing.PrivateKey()
    let stk = Curve25519.Signing.PrivateKey()
    let ownerUmk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let memberUmk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let diskKey = Data((0..<64).map { _ in UInt8.random(in: 0...255) })

    var backend: FakeShareBackend!
    var owner: ServerShareOwnerFlow!
    var member: ServerShareMemberFlow!

    override func setUp() {
        backend = FakeShareBackend(domain: domain, ownerSensitivePub: ownerSensitive.publicKey.rawRepresentation,
                                   ownerAccountPub: ownerIrk.publicKey.rawRepresentation, stk: stk)
        backend.sealedLuksForOwner = HexUtil.encode(try! SecretSeal.sealForEd25519Recipient(
            plaintext: diskKey, recipientEd25519Pub: ownerIrk.publicKey.rawRepresentation))
        let sensitive = ownerSensitive
        let irk = ownerIrk
        let household = ServiceInvite.deriveHouseholdKey(umkSeed: ownerUmk)!
        owner = ServerShareOwnerFlow(
            client: backend.client(), username: "alice",
            keys: ShareOwnerKeys(sensitive: { _ in sensitive }, account: { irk }, household: { household },
                                 diskKeySeeds: { _ in [irk.rawRepresentation] }),
            apexOrigin: { "https://flagshipserver.com" })
        let seed = memberUmk
        member = ServerShareMemberFlow(client: backend.client(), umkSeed: { _ in seed })
    }

    private var stkHex: String { HexUtil.encode(stk.publicKey.rawRepresentation) }
    private func create(_ draft: ShareDraft = ShareDraft(label: "Sam", level: .manage, unlockAtBoot: false, seeAppData: true)) async throws -> (CreatedShare, ServerShare.LinkParts) {
        let created = try await owner.create(serverDomain: domain, serverName: "Home", stkPubHex: stkHex, draft: draft)
        let parts = try XCTUnwrap(ServerShare.parseShareLink(created.link))
        return (created, parts)
    }

    /// Share → accept → SAS on both phones → confirm → sign in.
    private func shareAndConfirm(_ draft: ShareDraft = ShareDraft(label: "Sam", level: .manage, unlockAtBoot: false, seeAppData: true)) async throws -> (OwnerShareRow, AcceptedShare) {
        let (_, parts) = try await create(draft)
        let inv = try await member.open(shareId: parts.shareId, secretHex: parts.secretHex)
        let accepted = try await member.accept(inv)
        let snap = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        let row = try XCTUnwrap(snap.rows.first { $0.shareId == parts.shareId })
        XCTAssertEqual(row.status, .awaitingConfirm(sas: accepted.sas))
        try await owner.confirm(row, serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        let after = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        return (try XCTUnwrap(after.rows.first { $0.shareId == parts.shareId }), accepted)
    }

    func test_shareLink_openAcceptConfirm_signIn() async throws {
        let (created, parts) = try await create()
        XCTAssertTrue(created.link.hasPrefix("https://flagshipserver.com/share#s=\(parts.shareId)&k="))

        let inv = try await member.open(shareId: parts.shareId, secretHex: parts.secretHex)
        XCTAssertEqual(inv.offer.serverDomain, domain)
        XCTAssertEqual(inv.offer.serverName, "Home")
        XCTAssertEqual(inv.offer.stkPubHex, stkHex)
        XCTAssertEqual(inv.offer.level, .manage)
        XCTAssertTrue(inv.offer.seeAppData)
        XCTAssertEqual(inv.ownerName, "alice")

        let pending = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        guard case .offered(let link, _) = pending.rows.first?.status else { return XCTFail("expected an offered row") }
        XCTAssertEqual(link, created.link)
        XCTAssertEqual(pending.rows.first?.label, "Sam")

        let accepted = try await member.accept(inv)
        XCTAssertEqual(accepted.sas.count, 7)
        do {
            _ = try await member.signIn(accepted.entry)
            XCTFail("signed in before the owner confirmed")
        } catch ServerShareFlowError.notConfirmedYet {}

        let snap = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        let row = try XCTUnwrap(snap.rows.first)
        XCTAssertEqual(row.status, .awaitingConfirm(sas: accepted.sas), "both phones show the same code")

        try await owner.confirm(row, serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        let body = try XCTUnwrap(backend.lastGrantBody)
        let grant = try XCTUnwrap(ServerShareGrant.parse(jsonObject: body["grant"] as Any))
        let expectedMember = try ServerShare.deriveShareMemberKey(umkSeed: memberUmk, shareId: parts.shareId)
        XCTAssertEqual(grant.memberPubHex, HexUtil.encode(expectedMember.publicKey.rawRepresentation))
        XCTAssertEqual(grant.label, "Sam")
        XCTAssertEqual(grant.level, .manage)
        XCTAssertTrue(grant.seeAppData)
        XCTAssertFalse(grant.unlockAtBoot)
        XCTAssertTrue(grant.verify(signature: HexUtil.decode(body["signature"] as! String)!,
                                   publicKey: ownerSensitive.publicKey.rawRepresentation))
        XCTAssertNotNil(ServerShareAccept.parse(jsonObject: body["accept"] as Any))
        XCTAssertEqual((body["acceptSignature"] as? String)?.count, 128)

        let session = try await member.signIn(accepted.entry)
        XCTAssertTrue(session.token.hasPrefix("fss_"))
        XCTAssertEqual(session.level, .manage)

        let active = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        XCTAssertEqual(active.rows.map(\.status), [.active])

        let inbox = try await member.inbox()
        XCTAssertEqual(inbox.map(\.shareId), [parts.shareId])
        XCTAssertEqual(inbox.first?.serverName, "Home")
    }

    func test_ownerSees_invalidAcceptance_whenTamperedForAnotherServer() async throws {
        let (_, parts) = try await create()
        let secret = HexUtil.decode(parts.secretHex)!
        let thief = Curve25519.Signing.PrivateKey()
        let accept = ServerShareAccept(serverDomain: "other.alice.flagship.services", shareId: parts.shareId,
                                       memberPubHex: HexUtil.encode(thief.publicKey.rawRepresentation), acceptedAt: 1)
        let payload = ShareAcceptancePayload(accept: accept, signature: HexUtil.encode(try accept.sign(with: thief)))
        backend.rows[parts.shareId]?.acceptHex = try ServerShare.seal(
            key: ServerShare.shareLinkKey(secret), aad: ServerShare.shareAad(ServerShare.aadAcceptance, parts.shareId),
            plaintext: payload.jsonData())
        let snap = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        XCTAssertEqual(snap.rows.first?.status, .acceptanceInvalid)
    }

    func test_secondAccept_bySomeoneElse_isLinkUsed_butMyOwnRetryIsFine() async throws {
        let (_, parts) = try await create()
        let inv = try await member.open(shareId: parts.shareId, secretHex: parts.secretHex)
        let first = try await member.accept(inv)
        let again = try await member.accept(inv)
        XCTAssertEqual(first.sas, again.sas)

        let otherSeed = Data(repeating: 3, count: 32)
        let other = ServerShareMemberFlow(client: backend.client(), umkSeed: { _ in otherSeed })
        do {
            _ = try await other.accept(inv)
            XCTFail("a second account took the link")
        } catch ServerShareFlowError.linkUsed {}
    }

    func test_remove_hitsBoxAndCom_andEndsTheSession() async throws {
        let (row, accepted) = try await shareAndConfirm()
        XCTAssertEqual(row.status, .active)
        try await owner.end(row, serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        XCTAssertTrue(backend.didCall("POST", domain, "/api/screens/shares/revoke"))
        XCTAssertTrue(backend.didCall("POST", "com.test", "/server-shares/\(row.shareId)/revoke"))
        do {
            _ = try await member.signIn(accepted.entry)
            XCTFail("signed in after removal")
        } catch ServerShareFlowError.shareEnded {}
    }

    func test_cancelPendingOffer_isComOnly() async throws {
        let (_, parts) = try await create()
        let snap = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        let row = try XCTUnwrap(snap.rows.first { $0.shareId == parts.shareId })
        try await owner.end(row, serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        XCTAssertTrue(backend.didCall("POST", "com.test", "/server-shares/\(parts.shareId)/revoke"))
        XCTAssertFalse(backend.didCall("POST", domain, "/api/screens/shares/revoke"))
        let after = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        XCTAssertTrue(after.rows.isEmpty)
        do {
            _ = try await member.open(shareId: parts.shareId, secretHex: parts.secretHex)
            XCTFail("opened a cancelled link")
        } catch ServerShareFlowError.shareEnded {}
    }

    func test_change_resignsWithLaterIssuedAt() async throws {
        let (row, _) = try await shareAndConfirm()
        let before = try XCTUnwrap(backend.grants[row.shareId]?.grant)
        try await owner.change(row, level: .view, unlockAtBoot: false, seeAppData: false,
                               serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        let after = try XCTUnwrap(backend.grants[row.shareId]?.grant)
        XCTAssertEqual(after.level, .view)
        XCTAssertFalse(after.seeAppData)
        XCTAssertGreaterThan(after.issuedAt, before.issuedAt)
        XCTAssertEqual(after.memberPubHex, before.memberPubHex)
        XCTAssertNil(ServerShareAccept.parse(jsonObject: backend.lastGrantBody?["accept"] as Any))
    }

    func test_leave_hitsBoxComAndInbox() async throws {
        let (_, accepted) = try await shareAndConfirm()
        try await member.leave(accepted.entry)
        XCTAssertTrue(backend.didCall("POST", domain, "/api/shares/leave"))
        XCTAssertTrue(backend.didCall("POST", "com.test", "/api/server-shares/\(accepted.entry.shareId)/leave"))
        XCTAssertNil(backend.grants[accepted.entry.shareId])
        let inbox = try await member.inbox()
        XCTAssertTrue(inbox.isEmpty)
    }

    func test_unlockAtBoot_depositsCopy_andMemberApprovesStartup() async throws {
        let (row, accepted) = try await shareAndConfirm(ShareDraft(label: "Sam", level: .view, unlockAtBoot: true, seeAppData: false))
        XCTAssertEqual(row.startupKeyOnFile, true)
        let copy = try XCTUnwrap(backend.rows[row.shareId]?.unlock)
        let memberKey = try ServerShare.deriveShareMemberKey(umkSeed: memberUmk, shareId: row.shareId)
        XCTAssertEqual(copy.memberPubHex, HexUtil.encode(memberKey.publicKey.rawRepresentation))
        XCTAssertEqual(try SecretSeal.openWithEd25519Seed(blob: HexUtil.decode(copy.sealed)!,
                                                          recipientEd25519Seed: memberKey.rawRepresentation), diskKey)

        let nonce = BootAuth.randomNonce()
        let request = SecretRequest(serverDomain: domain, stkPub: stk.publicKey.rawRepresentation, purpose: .unlockKey,
                                    nonce: nonce, issuedAt: 7)
        backend.pendingBoot = [[
            "request": ["serverDomain": domain, "stkPub": stkHex, "purpose": "unlock-key", "nonce": HexUtil.encode(nonce), "issuedAt": 7],
            "signature": HexUtil.encode(try stk.signature(for: request.canonicalBytes())),
        ]]
        let pinned = try await member.pinnedStk(accepted.entry)
        XCTAssertEqual(pinned, stkHex)
        let startups = try await member.pendingStartups(accepted.entry, stkPubHex: pinned)
        XCTAssertEqual(startups.count, 1)
        try await member.approveStartup(accepted.entry, startup: try XCTUnwrap(startups.first), stkPubHex: pinned)
        let resp = try XCTUnwrap(backend.bootResponses.first)
        XCTAssertEqual(resp["purpose"] as? String, "unlock-key")
        XCTAssertEqual(resp["requestNonceHex"] as? String, HexUtil.encode(nonce))
        let opened = try SecretSeal.openWithEd25519Seed(blob: HexUtil.decode(resp["sealed"] as! String)!,
                                                        recipientEd25519Seed: stk.rawRepresentation)
        XCTAssertEqual(opened.suffix(diskKey.count), diskKey, "the box gets its own disk key, sealed for its STK")

        try await owner.change(row, level: .view, unlockAtBoot: false, seeAppData: false,
                               serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        XCTAssertNil(backend.rows[row.shareId]?.unlock, "turning it off withdraws the copy")
    }

    func test_startupApproval_refusesAnotherStk() async throws {
        let (_, accepted) = try await shareAndConfirm(ShareDraft(label: "Sam", level: .view, unlockAtBoot: true, seeAppData: false))
        let rogue = Curve25519.Signing.PrivateKey()
        let nonce = BootAuth.randomNonce()
        func row(_ signer: Curve25519.Signing.PrivateKey, stkPub: Data) throws -> ShareBootPending {
            let r = SecretRequest(serverDomain: domain, stkPub: stkPub, purpose: .unlockKey, nonce: nonce, issuedAt: 1)
            let json: [String: Any] = [
                "request": ["serverDomain": domain, "stkPub": HexUtil.encode(stkPub), "purpose": "unlock-key",
                            "nonce": HexUtil.encode(nonce), "issuedAt": 1],
                "signature": HexUtil.encode(try signer.signature(for: r.canonicalBytes())),
            ]
            return try JSONDecoder().decode(ShareBootPending.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let swapped = try row(rogue, stkPub: rogue.publicKey.rawRepresentation)
        let forged = try row(rogue, stkPub: stk.publicKey.rawRepresentation)
        let genuine = try row(stk, stkPub: stk.publicKey.rawRepresentation)
        XCTAssertTrue(ServerShareMemberFlow.verifiedStartups([swapped, forged], serverDomain: domain, stkPubHex: stkHex, now: 0).isEmpty)
        XCTAssertEqual(ServerShareMemberFlow.verifiedStartups([swapped, genuine], serverDomain: domain, stkPubHex: stkHex, now: 0).count, 1)

        let rogueStartup = VerifiedShareStartup(request: SecretRequest(serverDomain: domain, stkPub: rogue.publicKey.rawRepresentation,
                                                                       purpose: .unlockKey, nonce: nonce, issuedAt: 1), expiresAt: nil)
        do {
            try await member.approveStartup(accepted.entry, startup: rogueStartup, stkPubHex: stkHex)
            XCTFail("approved a start-up for another STK")
        } catch ServerShareFlowError.startupNotFromServer {}
        XCTAssertTrue(backend.bootResponses.isEmpty)
    }

    func test_create_refusesBadLabel_andUnknownStk() async throws {
        do {
            _ = try await owner.create(serverDomain: domain, serverName: "Home", stkPubHex: stkHex, draft: ShareDraft(label: "a|b"))
            XCTFail("accepted a label with |")
        } catch ServerShareFlowError.badLabel {}
        do {
            _ = try await owner.create(serverDomain: domain, serverName: "Home", stkPubHex: "", draft: ShareDraft(label: "Sam"))
            XCTFail("shared a server with no known identity")
        } catch ServerShareFlowError.unknownServerIdentity {}
    }

    func test_shareHeader_isCanonicalAndVerifies() throws {
        let key = Curve25519.Signing.PrivateKey()
        let nonce = Data(repeating: 1, count: 32)
        let h = try BootAuth.shareHeader(serverDomain: domain, method: "get", path: "/api/boot/share/key/\(domain)",
                                         memberKey: key, now: 42, nonce: nonce)
        XCTAssertTrue(h.hasPrefix("Flagship-Boot-v1 "))
        var b64 = String(h.dropFirst(17)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let env = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(Data(base64Encoded: b64))) as? [String: Any])
        XCTAssertEqual(env["role"] as? String, "share")
        XCTAssertEqual(env["method"] as? String, "GET")
        let pubHex = HexUtil.encode(key.publicKey.rawRepresentation)
        let canon = "flagship/boot-auth/v1|share|\(domain)|GET|/api/boot/share/key/\(domain)|\(pubHex)|\(HexUtil.encode(nonce))|42"
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(env["signatureHex"] as! String)!, for: Data(canon.utf8)))
    }

    // MARK: - Links

    func test_deepLink_parsesShareLinks() {
        let s = String(repeating: "ab", count: 16)
        let k = String(repeating: "cd", count: 32)
        XCTAssertEqual(DeepLink.parse(URL(string: "https://flagshipserver.com/share#s=\(s)&k=\(k)")!),
                       .shareServer(shareId: s, secretHex: k))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://www.flagshipserver.com/share#s=\(s)&k=\(k)")!),
                       .shareServer(shareId: s, secretHex: k))
        XCTAssertEqual(DeepLink.parse(URL(string: "flagship://share?s=\(s)&k=\(k)")!),
                       .shareServer(shareId: s, secretHex: k))
        XCTAssertEqual(DeepLink.parsePastedString("  flagship://share?s=\(s)&k=\(k.uppercased())\n"),
                       .shareServer(shareId: s, secretHex: k))
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/share#s=\(s)")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/share?s=\(s)&k=\(k)")!), "the secret must ride the fragment")
        XCTAssertNil(DeepLink.parse(URL(string: "https://evil.example/share#s=\(s)&k=\(k)")!))
        XCTAssertNil(DeepLink.parse(URL(string: "flagship://share?s=xyz&k=\(k)")!))
    }

    /// The phone camera opens `https://flagshipserver.com/share#s=…&k=…` as a
    /// universal link (AASA lists `/share`): the app gets a browsing-web user
    /// activity, parses it, and the shell puts it on the Home tab, which
    /// opens the accept screen with the link filled in. On a cold start the
    /// link waits in the linker until the shell reads it; while the app is
    /// open a second scan replaces the waiting one.
    @MainActor
    func test_cameraScannedShareLink_opensAcceptShare_fromColdStartAndWhileOpen() throws {
        let s = String(repeating: "ab", count: 16)
        let k = String(repeating: "cd", count: 32)
        let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
        activity.webpageURL = URL(string: "https://flagshipserver.com/share#s=\(s)&k=\(k)")
        let link = try XCTUnwrap(DeepLink.parse(try XCTUnwrap(activity.webpageURL)))
        XCTAssertEqual(link, .shareServer(shareId: s, secretHex: k))

        // Cold start: enqueued before any tab exists, still waiting after.
        let linker = DeepLinker()
        linker.enqueue(link)
        XCTAssertEqual(linker.pending, link)
        XCTAssertEqual(RootShell.tab(for: link, selected: .settings), .home)
        XCTAssertEqual(HomeTab.route(for: link), .acceptShare(shareId: s, secretHex: k))

        // While open, from another tab: the newer scan wins and lands on Home.
        let s2 = String(repeating: "ef", count: 16)
        let again = try XCTUnwrap(DeepLink.parse(URL(string: "https://flagshipserver.com/share#s=\(s2)&k=\(k)")!))
        linker.enqueue(again)
        XCTAssertEqual(linker.pending, .shareServer(shareId: s2, secretHex: k))
        XCTAssertEqual(RootShell.tab(for: again, selected: .apps), .home)
        XCTAssertEqual(HomeTab.route(for: again), .acceptShare(shareId: s2, secretHex: k))
        XCTAssertEqual(linker.consume(), again)
        XCTAssertNil(linker.pending)
    }

    // MARK: - View models

    @MainActor
    func test_sharedWithMeStore_loadsSignsInAndForgetsEndedShares() async throws {
        let (row, _) = try await shareAndConfirm()
        let store = SharedWithMeStore(flow: member, keysUnlocked: { false },
                                      makeScreensClient: { _, _ in MockScreensClient() })
        await store.load(allowAuth: false)
        XCTAssertTrue(store.items.isEmpty, "no Face ID on a quiet load")
        await store.load(allowAuth: true)
        XCTAssertEqual(store.rows.map(\.level), [.manage])
        XCTAssertEqual(store.rows.first?.owner, "alice")
        XCTAssertEqual(store.rows.first?.name, "Home")

        try await owner.end(row, serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        do {
            _ = try await store.session(for: row.shareId, forceNew: true)
            XCTFail("still signed in")
        } catch ServerShareFlowError.shareEnded {}
        XCTAssertTrue(store.items.isEmpty)
        let inbox = try await member.inbox()
        XCTAssertTrue(inbox.isEmpty, "an ended share leaves the inbox")
    }

    @MainActor
    func test_acceptModel_showsCode_thenDoneOnceConfirmed() async throws {
        let (_, parts) = try await create()
        let store = SharedWithMeStore(flow: member, keysUnlocked: { true }, makeScreensClient: { _, _ in MockScreensClient() })
        let model = ShareAcceptModel(store: store, flow: member, pollEvery: .milliseconds(20))
        let bad = await model.open(text: "not a link")
        XCTAssertFalse(bad)
        let good = await model.open(text: "flagship://share?s=\(parts.shareId)&k=\(parts.secretHex)")
        XCTAssertTrue(good)
        guard case .invitation = model.phase else { return XCTFail("\(model.phase)") }
        await model.accept()
        guard case .code(let accepted, let ownerName) = model.phase else { return XCTFail("\(model.phase)") }
        XCTAssertEqual(ownerName, "alice")
        XCTAssertEqual(store.rows.first?.waitingForOwner, true)

        let waiter = Task { await model.waitForConfirmation() }
        let snap = try await owner.load(serverDomain: domain, ownerToken: backend.ownerToken, readInvitations: true)
        let row = try XCTUnwrap(snap.rows.first)
        XCTAssertEqual(row.status, .awaitingConfirm(sas: accepted.sas))
        try await owner.confirm(row, serverDomain: domain, serverName: "Home", ownerToken: backend.ownerToken)
        await waiter.value
        XCTAssertEqual(model.phase, .done(accepted.entry))
        XCTAssertEqual(store.rows.first?.level, .manage)
    }

    @MainActor
    func test_ownerCardModel_readsInvitationsOnlyWhenAllowed() async throws {
        _ = try await create()
        let card = ShareServerCardModel(serverDomain: domain, serverName: "Home", stkPubHex: stkHex, flow: owner,
                                        ownerToken: { "owner-token" }, keysUnlocked: { false })
        await card.load()
        XCTAssertEqual(card.rows.count, 0)
        XCTAssertFalse(card.invitationsRead)
        await card.load(allowAuth: true)
        XCTAssertEqual(card.rows.first?.label, "Sam")
        await card.loadActivity()
        XCTAssertEqual(card.activity.value.map { $0.map(ServerShareCopy.activityLine) }, ["Sam · opened the server"])
    }
}
