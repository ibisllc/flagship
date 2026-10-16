import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Gym-only (`-smoke-shares -smoke-share-flows`): answers the `.com`, boot
/// and box routes ServerShareClient calls, so the share screens run their
/// real flows in smoke mode. Every signed order is checked the way the real
/// endpoint checks it (MockOrderSigners): the owner's grant, revoke, offer
/// and start-up copy under the admin root; a co-manager's sign-in, update,
/// start-up push and leave under that share's member key.
///
/// The owner side starts as the demo fixtures do: Sam an active co-manager
/// (Can manage, approves start-ups), Alex an invitation he accepted whose
/// code waits for the owner. The second account holds Garage (manage),
/// Photos (view) and an open invitation to Cabin.
public final class GymShareTransport: ServerShareTransport, @unchecked Sendable {
    public static let alexShareId = String(repeating: "a1", count: 16)
    public static let samShareId = String(repeating: "b2", count: 16)
    /// The STK a demo pod (which has none) offers in a new share.
    public static let stkPubHex = String(repeating: "5c", count: 32)

    private struct ComRow {
        var shareId: String
        var serverDomain: String
        var state: String
        var owner: String?
        var offer: String
        var acceptance: String?
        var expiresAt: Int64
        var unlock: Bool
    }

    private let lock = NSLock()
    private var box: [String: BoxShareSummary] = [:]
    private var com: [String: ComRow] = [:]
    private var sessions: [String: Int] = [:]
    private let now: Int64 = ServerShareClock.nowMs()
    private let irkPub: Data

    public init(ownerDomains: [String]) {
        irkPub = Keystore.gymIRK()?.publicKey.rawRepresentation ?? Data()
        let seed = GymSeams.accountRootSeed ?? Data(repeating: 0x47, count: 32)
        let household = ServiceInvite.deriveHouseholdKey(umkSeed: seed) ?? Data(repeating: 0, count: 32)

        // Sam: active on the box; his start-up copy is not on `.com` yet.
        let samKey = Self.key(0xb2)
        box[Self.samShareId] = BoxShareSummary(
            shareId: Self.samShareId, label: "Sam", level: .manage, unlockAtBoot: true, seeAppData: false,
            memberPubHex: HexUtil.encode(samKey.publicKey.rawRepresentation),
            issuedAt: now - 86_400_000 * 3, sharedAt: now - 86_400_000 * 3, lastSeenAt: now - 3_600_000 * 2)

        // Alex: accepted on `.com`, waiting for the owner to compare the code.
        let alexSecret = Data(repeating: 0xa7, count: 32)
        let alexKey = Self.key(0xa1)
        for domain in ownerDomains.map({ $0.lowercased() }) where !domain.isEmpty {
            com["\(Self.samShareId)|\(domain)"] = ComRow(
                shareId: Self.samShareId, serverDomain: domain, state: "accepted", owner: nil, offer: "",
                acceptance: nil, expiresAt: now + ServerShare.offerTtlMs, unlock: false)
            let accept = ServerShareAccept(serverDomain: domain, shareId: Self.alexShareId,
                                           memberPubHex: HexUtil.encode(alexKey.publicKey.rawRepresentation),
                                           acceptedAt: now - 60_000)
            guard let sig = try? accept.sign(with: alexKey),
                  let linkKey = try? ServerShare.shareLinkKey(alexSecret),
                  let accAad = try? ServerShare.shareAad(ServerShare.aadAcceptance, Self.alexShareId),
                  let ownAad = try? ServerShare.shareAad(ServerShare.aadOwner, Self.alexShareId),
                  let acceptance = try? ServerShare.seal(
                      key: linkKey, aad: accAad,
                      plaintext: ShareAcceptancePayload(accept: accept, signature: HexUtil.encode(sig)).jsonData()),
                  let owner = try? ServerShare.seal(
                      key: household, aad: ownAad,
                      plaintext: ShareOwnerRecord(secretHex: HexUtil.encode(alexSecret), label: "Alex", level: .view,
                                                  unlockAtBoot: false, seeAppData: false).jsonData())
            else { continue }
            com["\(Self.alexShareId)|\(domain)"] = ComRow(
                shareId: Self.alexShareId, serverDomain: domain, state: "accepted", owner: owner, offer: "",
                acceptance: acceptance, expiresAt: now + ServerShare.offerTtlMs, unlock: false)
        }

        // The second account's invitation to Cabin (the demo link).
        let inv = ServerShareDemo.invitation
        if let secret = HexUtil.decode(inv.secretHex), let linkKey = try? ServerShare.shareLinkKey(secret),
           let aad = try? ServerShare.shareAad(ServerShare.aadOffer, inv.shareId),
           let offer = try? ServerShare.seal(key: linkKey, aad: aad, plaintext: inv.offer.jsonData()) {
            com["\(inv.shareId)|member"] = ComRow(shareId: inv.shareId, serverDomain: inv.offer.serverDomain,
                                                  state: "offered", owner: nil, offer: offer, acceptance: nil,
                                                  expiresAt: now + ServerShare.offerTtlMs, unlock: false)
        }

        // The second account signs with its per-share member keys.
        let shareIds = ServerShareDemo.entries().map(\.shareId) + [inv.shareId]
        for id in shareIds {
            if let k = try? ServerShare.deriveShareMemberKey(umkSeed: seed, shareId: id) {
                MockOrderSigners.shared.pinShareKey(k.publicKey, shareId: id)
            }
        }
    }

    static func key(_ b: UInt8) -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: b, count: 32))
    }

    // MARK: Routing

    public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let host = (request.url?.host ?? "").lowercased()
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        do {
            return try route(method, path, host: host, body: body, request: request)
        } catch let e as ServerShareHTTPError {
            return Self.json(e.status, ["error": e.error ?? "refused", "code": e.code ?? ""])
        } catch {
            return Self.json(403, ["error": "invalid signature"])
        }
    }

    private func route(_ method: String, _ path: String, host: String, body: [String: Any],
                       request: URLRequest) throws -> (status: Int, body: Data) {
        let parts = path.split(separator: "/").map(String.init)
        // Box, owner session.
        if path == "/api/screens/shares", method == "GET" {
            let list = lock.withLock { Array(box.values).sorted { $0.issuedAt < $1.issuedAt } }
            return try Self.encode(BoxSharesResponse(shares: list))
        }
        if path == "/api/screens/shares", method == "POST" { return try grant(body, domain: host) }
        if path == "/api/screens/shares/revoke" {
            let r: ServerShareRevoke = try signed(body, "revoke", kind: "share-revoke")
            _ = lock.withLock { box.removeValue(forKey: r.shareId) }
            return Self.json(200, ["ok": true])
        }
        if path.hasPrefix("/api/screens/activity") {
            struct R: Encodable { let entries: [ShareActivityEntry] }
            return try Self.encode(R(entries: ServerShareDemo.activity()))
        }
        // Box, the second account.
        if path == "/api/shares/nonce" { return Self.json(200, ["nonce": ServerShare.randomShareId() + ServerShare.randomShareId()]) }
        if path == "/api/shares/session" { return try session(body) }
        if path == "/api/shares/update" {
            let u: ServerShareUpdate = try memberSigned(body, "update", kind: "share-update")
            return Self.json(200, ["ok": true, "accepted": true, "targetCommit": u.targetCommit])
        }
        if path == "/api/shares/leave" {
            _ = try memberSigned(body, "leave", kind: "share-leave") as ServerShareLeave
            return Self.json(200, ["ok": true])
        }
        // `.com`, the owner.
        if parts.count >= 4, parts[0] == "api", parts[1] == "users", parts[3] == "server-shares" {
            if parts.count == 4 { return try createOffer(body) }
            if parts.count == 5, parts[4] == "list" {
                _ = try signed(body, "list", kind: "share-list", authority: .irk) as ServerShareList
                return listOffers()
            }
            if parts.count == 6, parts[5] == "revoke" {
                let r: ServerShareRevoke = try signed(body, "revoke", kind: "share-revoke")
                lock.withLock {
                    for (k, row) in com where row.shareId == r.shareId { com[k]?.state = "ended" }
                }
                return Self.json(200, ["ok": true])
            }
            if parts.count == 6, parts[5] == "unlock" {
                let u: ServerShareUnlock = try signed(body, "unlock", kind: "share-unlock")
                lock.withLock {
                    for (k, row) in com where row.shareId == u.shareId { com[k]?.unlock = u.sealedSha256 != ServerShare.unlockOff }
                }
                return Self.json(200, ["ok": true])
            }
        }
        if parts.count == 4, parts[0] == "api", parts[1] == "server", parts[3] == "sealed-luks-key" {
            let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: Data(repeating: 0x4b, count: 32),
                                                                recipientEd25519Pub: irkPub)
            return Self.json(200, ["sealedKey": HexUtil.encode(sealed)])
        }
        // `.com`, the second account.
        if parts.count >= 3, parts[0] == "api", parts[1] == "server-shares" {
            let id = parts[2]
            if parts.count == 3 { return getShare(id) }
            switch parts[3] {
            case "accept":
                lock.withLock {
                    for (k, row) in com where row.shareId == id {
                        com[k]?.state = "accepted"
                        com[k]?.acceptance = body["acceptance"] as? String
                    }
                }
                return Self.json(200, ["ok": true])
            case "leave":
                _ = try memberSigned(body, "leave", kind: "share-leave") as ServerShareLeave
                return Self.json(200, ["ok": true])
            case "push":
                _ = try memberSigned(body, "push", kind: "share-push") as ServerSharePush
                return Self.json(200, ["ok": true])
            default: break
            }
        }
        if path == "/api/share-inbox" {
            let op = (body["request"] as? [String: Any])?["op"] as? String
            return op == "list" ? Self.json(200, ["entries": []]) : Self.json(200, ["ok": true])
        }
        return Self.json(404, ["error": "not found"])
    }

    // MARK: Handlers

    private func grant(_ body: [String: Any], domain: String) throws -> (status: Int, body: Data) {
        let g: ServerShareGrant = try signed(body, "grant", kind: "share-grant")
        if let a = body["accept"].flatMap({ ServerShareAccept.parse(jsonObject: $0) }) {
            guard let sigHex = body["acceptSignature"] as? String, let sig = HexUtil.decode(sigHex),
                  let pub = HexUtil.decode(a.memberPubHex), a.verify(signature: sig, publicKey: pub),
                  a.memberPubHex == g.memberPubHex
            else { throw ServerShareHTTPError(status: 403, error: "invalid acceptance", code: nil) }
        }
        lock.withLock {
            let prev = box[g.shareId]
            box[g.shareId] = BoxShareSummary(shareId: g.shareId, label: g.label, level: g.level, unlockAtBoot: g.unlockAtBoot,
                                             seeAppData: g.seeAppData, memberPubHex: g.memberPubHex, issuedAt: g.issuedAt,
                                             sharedAt: prev?.sharedAt ?? g.issuedAt, lastSeenAt: prev?.lastSeenAt)
        }
        return Self.json(200, ["ok": true])
    }

    private func createOffer(_ body: [String: Any]) throws -> (status: Int, body: Data) {
        guard let o = body["offer"].flatMap({ ServerShareOffer.parse(jsonObject: $0) }),
              let sig = body["signature"] as? String
        else { throw ServerShareHTTPError(status: 400, error: "malformed", code: nil) }
        try MockOrderSigners.shared.require(.sensitive, kind: "share-offer", signatureHex: sig, over: try? o.canonicalBytes())
        lock.withLock {
            com["\(o.shareId)|\(o.serverDomain)"] = ComRow(
                shareId: o.shareId, serverDomain: o.serverDomain, state: "offered", owner: body["ownerHex"] as? String,
                offer: body["offerHex"] as? String ?? "", acceptance: nil, expiresAt: o.expiresAt, unlock: false)
        }
        return Self.json(200, ["ok": true])
    }

    private func listOffers() -> (status: Int, body: Data) {
        let rows: [[String: Any]] = lock.withLock {
            com.values.filter { $0.owner != nil || $0.shareId == Self.samShareId }.map { r in
                var d: [String: Any] = ["shareId": r.shareId, "serverDomain": r.serverDomain, "state": r.state,
                                        "expiresAt": r.expiresAt, "unlock": r.unlock]
                if let o = r.owner { d["owner"] = o }
                if let a = r.acceptance { d["acceptance"] = a }
                return d
            }
        }
        return Self.json(200, ["shares": rows])
    }

    private func getShare(_ id: String) -> (status: Int, body: Data) {
        guard let r = lock.withLock({ com.values.first { $0.shareId == id && !$0.offer.isEmpty } }) else {
            return Self.json(404, ["error": "not found"])
        }
        var d: [String: Any] = ["shareId": r.shareId, "serverDomain": r.serverDomain, "state": r.state, "offer": r.offer,
                                "expiresAt": r.expiresAt, "unlock": r.unlock]
        if let a = r.acceptance { d["acceptance"] = a }
        return Self.json(200, d)
    }

    /// The owner confirms a moment after the second account accepts: the
    /// first sign-in after an acceptance answers "not shared yet".
    private func session(_ body: [String: Any]) throws -> (status: Int, body: Data) {
        let s: ServerShareSession = try memberSigned(body, "session", kind: "share-session")
        let first = lock.withLock { () -> Bool in
            let n = sessions[s.shareId, default: 0]
            sessions[s.shareId] = n + 1
            return n == 0
        }
        if first { throw ServerShareHTTPError(status: 403, error: "not-shared", code: "not-shared") }
        let level = s.shareId == ServerShareDemo.invitation.shareId
            ? ServerShareDemo.invitation.offer.level
            : ServerShareDemo.sessions()[s.shareId]?.level ?? .manage
        return try Self.encode(ShareSessionResponse(token: "fss_gym", expiresAt: ServerShareClock.nowMs() + 12 * 3_600_000,
                                                    level: level, unlockAtBoot: false, seeAppData: false))
    }

    // MARK: Signatures

    private func signed<E: ServerShareEnvelope>(_ body: [String: Any], _ key: String, kind: String,
                                                authority: MockOrderSigners.Authority = .sensitive) throws -> E {
        guard let e = body[key].flatMap({ E.parse(jsonObject: $0) }), let sig = body["signature"] as? String else {
            throw ServerShareHTTPError(status: 400, error: "malformed", code: nil)
        }
        try MockOrderSigners.shared.require(authority, kind: kind, signatureHex: sig, over: try? e.canonicalBytes())
        return e
    }

    private func memberSigned<E: ServerShareEnvelope & ShareMemberSigned>(_ body: [String: Any], _ key: String,
                                                                         kind: String) throws -> E {
        guard let e = body[key].flatMap({ E.parse(jsonObject: $0) }), let sig = body["signature"] as? String else {
            throw ServerShareHTTPError(status: 400, error: "malformed", code: nil)
        }
        try MockOrderSigners.shared.requireShare(shareId: e.shareId, kind: kind, signatureHex: sig, over: try? e.canonicalBytes())
        return e
    }

    // MARK: Encoding

    static func json(_ status: Int, _ obj: [String: Any]) -> (status: Int, body: Data) {
        (status, (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8))
    }

    static func encode<T: Encodable>(_ v: T) throws -> (status: Int, body: Data) {
        (200, try JSONEncoder().encode(v))
    }
}

/// The co-manager envelopes name the share they act for.
protocol ShareMemberSigned { var shareId: String { get } }
extension ServerShareSession: ShareMemberSigned {}
extension ServerShareUpdate: ShareMemberSigned {}
extension ServerShareLeave: ShareMemberSigned {}
extension ServerSharePush: ShareMemberSigned {}
