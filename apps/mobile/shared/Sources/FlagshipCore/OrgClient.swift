import Foundation
import FlagshipAPI

/// The `.com` org routes (docs/enterprise-accounts.md §6, §7; `packages/control-plane/src/orgs.ts`)
/// and the JSON shapes they take. Every object the phone sends is built and signed here; every
/// object it reads is re-verified (`OrgAuthority.verifyChain`, `buildSeatBook`) before the UI uses it.
public enum OrgJSON {
    public static func binding(_ b: PqKeyBindingWire) -> [String: Any] { b.jsonObject }

    public static func record(_ r: OrgAuthorityRecord) -> [String: Any] {
        [
            "orgId": r.orgId, "version": NSNumber(value: r.version), "prevHash": r.prevHash,
            "admins": r.admins.map { a -> [String: Any] in
                var o: [String: Any] = ["seatId": a.seatId, "kind": a.kind.rawValue, "binding": a.binding.jsonObject]
                if a.custody == .browser { o["custody"] = "browser" }
                return o
            },
            "bylaws": bylaws(r.bylaws),
            "founderSeatId": r.founderSeatId, "kGov": r.kGov, "kGrant": r.kGrant, "kDestroy": r.kDestroy, "kSite": r.kSite,
            "issuedAt": NSNumber(value: r.issuedAt),
        ]
    }

    static func bylaws(_ b: OrgBylaws) -> [String: Any] {
        var o: [String: Any] = ["overturnSeats": b.overturnSeats.map { $0 as Any } ?? "*", "overturnK": b.overturnK, "vetoK": b.vetoK]
        if b.hardwareAdmins { o["adminCustody"] = "hardware" }
        if !b.quorumHardware { o["quorumHardware"] = false }
        return o
    }

    public static func entry(_ e: OrgAuthorityEntry) -> [String: Any] {
        var o: [String: Any] = ["record": record(e.record), "via": e.via, "approvals": e.approvals.map(\.jsonObject)]
        if let n = e.notice {
            o["notice"] = ["body": ["orgId": n.body.orgId, "oarVersion": NSNumber(value: n.body.oarVersion), "kind": n.body.kind,
                                    "nextRecordSha256": n.body.nextRecordSha256, "effectiveAt": NSNumber(value: n.body.effectiveAt),
                                    "issuedAt": NSNumber(value: n.body.issuedAt)] as [String: Any],
                           "approvals": n.approvals.map(\.jsonObject)]
        }
        if let v = e.overturnOf { o["overturnOf"] = NSNumber(value: v) }
        return o
    }

    public static func freeze(_ f: OrgSigned<OrgSeatFreeze>) -> [String: Any] {
        ["body": ["orgId": f.body.orgId, "seatId": f.body.seatId, "untilMs": NSNumber(value: f.body.untilMs),
                  "oarVersion": NSNumber(value: f.body.oarVersion), "issuedAt": NSNumber(value: f.body.issuedAt)] as [String: Any],
         "approvals": f.approvals.map(\.jsonObject)]
    }

    public static func overturn(_ o: OrgSigned<OrgOverturn>) -> [String: Any] {
        ["body": ["orgId": o.body.orgId, "freezeSha256": o.body.freezeSha256, "oarVersion": NSNumber(value: o.body.oarVersion),
                  "issuedAt": NSNumber(value: o.body.issuedAt)] as [String: Any],
         "approvals": o.approvals.map(\.jsonObject)]
    }
}

/// What `.com` holds for an org, verified on this phone.
public struct OrgSnapshot {
    public let name: String
    public let state: OrgAuthorityState
    public let book: OrgSeatBook
    public let freezes: [OrgSigned<OrgSeatFreeze>]
    public let ceremonies: [OrgCeremony]
    /// The seat objects as served (verified into `book`): who left and what their grants allowed.
    public var grants: [OrgSeatGrantBundle] = []
    public var revokes: [OrgSeatRevokeBundle] = []
}

/// A person who accepted an invitation and waits for an admin to compare the code and admit them.
public struct OrgPendingJoin: Identifiable {
    public let seatId: String
    public let invite: [String: Any]
    public let roles: [Any]
    public let accept: [String: Any]
    public let memberBinding: PqKeyBindingWire
    public let adminBinding: PqKeyBindingWire?
    public var id: String { seatId }
    /// The 6-digit code both phones show (`flagship/org-seat-sas/v1`).
    public var sas: String? {
        guard let inv = accept["inviteSha256"] as? String, let m = accept["memberKeyId"] as? String else { return nil }
        return try? OrgAuthority.seatSas(inviteSha256: inv, memberKeyId: m, adminKeyId: (accept["adminKeyId"] as? String) ?? "")
    }
}

public struct OrgCeremony: Identifiable {
    public let sha256: String
    public let order: String
    public let payload: [String: Any]
    public let approvals: [OrgApproval]
    /// When `.com` opened it, on its own clock: a delayed change's waiting period counts from here.
    public var openedAt: Int64? = nil
    public var id: String { sha256 }
    /// The purpose tag of the order (`flagship/<purpose>/v1`).
    public var purpose: String { String(order.split(separator: "|").first ?? "") }
    public var isDelayedChange: Bool { purpose == OrgAuthority.tagDelayedChange }
}

public struct OrgClientError: Error, Equatable, CustomStringConvertible {
    public let status: Int
    public let code: String
    public var description: String { code.isEmpty ? "http \(status)" : code }
}

public final class OrgClient: @unchecked Sendable {
    private let urlSession: URLSession
    private let baseUrl: URL

    public typealias Transport = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> (status: Int, json: [String: Any])
    /// A transport that also sees the request's extra headers (the invite-key read proof).
    public typealias HeaderTransport = (_ method: String, _ path: String, _ body: [String: Any]?, _ headers: [String: String]) async throws -> (status: Int, json: [String: Any])
    private let transport: HeaderTransport?

    private let readTokens: OrgReadTokens
    private let clock: () -> Int64

    public init(urlSession: URLSession = .shared, baseUrl: URL = Endpoints.controlBaseUrl, readTokens: OrgReadTokens = .shared,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.urlSession = urlSession; self.baseUrl = baseUrl; self.transport = nil; self.readTokens = readTokens; self.clock = now
    }

    /// Tests: answer every call from `transport` (a fake `.com`).
    public init(transport: @escaping Transport, readTokens: OrgReadTokens = OrgReadTokens(), now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.urlSession = .shared; self.baseUrl = Endpoints.controlBaseUrl; self.transport = { m, p, b, _ in try await transport(m, p, b) }
        self.readTokens = readTokens; self.clock = now
    }

    /// Tests: as `init(transport:)`, with the request's extra headers.
    public init(headerTransport: @escaping HeaderTransport, readTokens: OrgReadTokens = OrgReadTokens(), now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.urlSession = .shared; self.baseUrl = Endpoints.controlBaseUrl; self.transport = headerTransport
        self.readTokens = readTokens; self.clock = now
    }

    private func send(_ method: String, _ path: String, _ body: [String: Any]?, _ headers: [String: String]) async throws -> (status: Int, json: [String: Any]) {
        if let transport { return try await transport(method, path, body, headers) }
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (status, json)
    }

    /// Every org GET but the plan and the invite offer carries the org read token (docs/account-read-token.md
    /// "Org routes"); a 401 mints it again once.
    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        let orgId = method == "GET" ? OrgReadToken.gatedOrg(path: path) : nil
        let mint: OrgReadTokens.Post = { [self] p, b in try await send("POST", p, b, [:]) }
        func withToken(_ t: String?) -> [String: String] {
            var h = headers
            if let t { h["authorization"] = "Bearer \(t)" }
            return h
        }
        var token: String? = nil
        if let orgId { token = await readTokens.token(orgId: orgId, fresh: false, now: clock(), post: mint) }
        var (status, json) = try await send(method, path, body, withToken(token))
        if let orgId, token != nil, status == 401, let again = await readTokens.token(orgId: orgId, fresh: true, now: clock(), post: mint) {
            (status, json) = try await send(method, path, body, withToken(again))
        }
        guard (200..<300).contains(status) else {
            throw OrgClientError(status: status, code: (json["code"] as? String) ?? (json["error"] as? String) ?? "")
        }
        return json
    }

    public func create(name: String, genesis: OrgAuthorityEntry) async throws -> String {
        let r = try await call("POST", "/api/orgs", ["name": name, "entry": OrgJSON.entry(genesis)])
        return (r["genesisHash"] as? String) ?? ""
    }

    /// Fetches and verifies the org from the genesis hash this phone pinned when it joined or created it.
    /// The chain as `GET /authority` (or the invite offer's `authority`) serves it, verified from `genesisHash`.
    public static func verifyServedChain(_ a: [String: Any], genesisHash: String, now: Int64) throws -> (OrgAuthorityState, [OrgSigned<OrgSeatFreeze>], [OrgSigned<OrgOverturn>]) {
        let entries = try ((a["entries"] as? [Any]) ?? []).map { try OrgAuthorityWire.entry($0) }
        let freezes = try ((a["freezes"] as? [Any]) ?? []).map { try OrgAuthorityWire.freeze($0) }
        let overturns = try ((a["overturns"] as? [Any]) ?? []).map { try OrgAuthorityWire.overturn($0) }
        let vetoes = try ((a["vetoes"] as? [Any]) ?? []).map { try OrgAuthorityWire.veto($0) }
        let state = try OrgAuthority.verifyChain(entries, genesisHash: genesisHash, now: now, freezes: freezes, overturns: overturns, vetoes: vetoes,
                                                 noticeOpenedAt: OrgAuthorityWire.noticeOpenedAt(a["noticeOpenedAt"]))
        return (state, freezes, overturns)
    }

    public func snapshot(orgId: String, genesisHash: String, now: Int64) async throws -> OrgSnapshot {
        let a = try await call("GET", "/api/orgs/\(orgId)/authority")
        let s = try await call("GET", "/api/orgs/\(orgId)/seats")
        let c = try await call("GET", "/api/orgs/\(orgId)/ceremonies")
        let (state, freezes, overturns) = try Self.verifyServedChain(a, genesisHash: genesisHash, now: now)
        let grants = ((s["grants"] as? [Any]) ?? []).compactMap { try? OrgAuthorityWire.grantBundle($0) }
        let revokes = ((s["revokes"] as? [Any]) ?? []).compactMap { try? OrgAuthorityWire.revokeBundle($0) }
        let book = OrgAuthority.buildSeatBook(state, grants: grants, revokes: revokes, freezes: freezes, overturns: overturns, now: now)
        let ceremonies: [OrgCeremony] = ((c["ceremonies"] as? [[String: Any]]) ?? []).compactMap { o in
            guard let sha = o["sha256"] as? String, let order = o["order"] as? String,
                  let approvals = try? OrgAuthorityWire.approvals(o["approvals"]) else { return nil }
            return OrgCeremony(sha256: sha, order: order, payload: (o["payload"] as? [String: Any]) ?? [:], approvals: approvals,
                               openedAt: OrgAuthority.i64(o["openedAt"]))
        }
        return OrgSnapshot(name: ((a["org"] as? [String: Any])?["name"] as? String) ?? "", state: state, book: book, freezes: freezes, ceremonies: ceremonies,
                           grants: grants, revokes: revokes)
    }

    public func openCeremony(orgId: String, order: String, payload: [String: Any], approval: OrgApproval) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/ceremonies", ["order": order, "payload": payload, "approvals": [approval.jsonObject]])
    }

    public func approve(orgId: String, sha256: String, approval: OrgApproval) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/ceremonies/\(sha256)/approvals", ["approval": approval.jsonObject])
    }

    public func freeze(orgId: String, _ f: OrgSigned<OrgSeatFreeze>) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/freezes", OrgJSON.freeze(f))
    }

    public func overturn(orgId: String, _ o: OrgSigned<OrgOverturn>) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/overturns", OrgJSON.overturn(o))
    }

    /// The invitation behind a link: the invite, its roles and the offer sealed under the offer key. `.com` serves it
    /// only with a fresh invite-key signature (`inviteSecret` comes from the link key); without one it reads as no invite.
    public func inviteOffer(orgId: String, seatId: String, inviteSecret: [UInt8], now: Int64) async throws -> [String: Any] {
        let sig = try OrgAuthority.inviteReadSignature(secret: inviteSecret, orgId: orgId, seatId: seatId, issuedAt: now)
        return try await call("GET", "/api/orgs/\(orgId)/invites/\(seatId)", headers: ["x-flagship-issued-at": String(now), "x-flagship-signature": sig])
    }

    /// Withdraws an invitation nobody was admitted on (one org admin's approval of the withdraw order).
    public func withdrawInvite(orgId: String, seatId: String, oarVersion: Int64, issuedAt: Int64, approval: OrgApproval) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/invites/\(seatId)/withdraw", [
            "withdraw": ["orgId": orgId, "seatId": seatId, "oarVersion": NSNumber(value: oarVersion), "issuedAt": NSNumber(value: issuedAt)] as [String: Any],
            "approvals": [approval.jsonObject],
        ])
    }

    /// Invitations nobody has accepted yet (an admin may withdraw them): seat ids.
    public func pendingInvites(orgId: String) async throws -> [String] {
        let s = try await call("GET", "/api/orgs/\(orgId)/seats")
        let granted = Set(((s["grants"] as? [[String: Any]]) ?? []).compactMap { ($0["grant"] as? [String: Any])?["seatId"] as? String })
        let accepted = Set(((s["accepts"] as? [[String: Any]]) ?? []).compactMap { ($0["accept"] as? [String: Any])?["seatId"] as? String })
        return ((s["invites"] as? [[String: Any]]) ?? []).compactMap { ($0["invite"] as? [String: Any])?["seatId"] as? String }
            .filter { !granted.contains($0) && !accepted.contains($0) }
    }

    /// The person's acceptance, signed with their seat member key.
    public func accept(orgId: String, seatId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/invites/\(seatId)/accept", body)
    }

    /// Invitations and acceptances not yet granted (the admin's "compare the code, then admit" list).
    public func pendingJoins(orgId: String) async throws -> [OrgPendingJoin] {
        let s = try await call("GET", "/api/orgs/\(orgId)/seats")
        let granted = Set(((s["grants"] as? [[String: Any]]) ?? []).compactMap { ($0["grant"] as? [String: Any])?["seatId"] as? String })
        let invites = Dictionary(((s["invites"] as? [[String: Any]]) ?? []).compactMap { i -> (String, [String: Any])? in
            guard let inv = i["invite"] as? [String: Any], let id = inv["seatId"] as? String else { return nil }
            return (id, i)
        }, uniquingKeysWith: { a, _ in a })
        return ((s["accepts"] as? [[String: Any]]) ?? []).compactMap { a in
            guard let acc = a["accept"] as? [String: Any], let seatId = acc["seatId"] as? String, !granted.contains(seatId),
                  let inv = invites[seatId], let invite = inv["invite"] as? [String: Any],
                  // Only an accept the invite key signed is offered: whoever accepted held the invitation link.
                  OrgAuthority.verifyInviteAccept(invite: invite, accept: acc, signature: a["inviteSignature"] as? String),
                  let member = try? PqTrust.pqKeyBindingFromWire(a["memberBinding"]) else { return nil }
            let admin = (a["adminBinding"] as? [String: Any]).flatMap { try? PqTrust.pqKeyBindingFromWire($0) }
            return OrgPendingJoin(seatId: seatId, invite: invite, roles: (inv["roles"] as? [Any]) ?? [], accept: acc, memberBinding: member, adminBinding: admin)
        }
    }

    /// Key-ring versions and KEM keys (`GET /keys`) and the org's servers, verified into a rotation plan on this phone.
    public func rotationPlan(_ snap: OrgSnapshot, now: Int64) async throws -> OrgRotationPlan {
        let k = try await call("GET", "/api/orgs/\(snap.state.orgId)/keys")
        let s = try await call("GET", "/api/orgs/\(snap.state.orgId)/servers")
        return OrgRotation.planFromServed(snap.state, snap.book, keys: k, servers: s, revokes: snap.revokes, grants: snap.grants, now: now)
    }

    public func postKeyRing(orgId: String, _ b: OrgKeyRingBundle) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/keys", b.json)
    }

    public func postSeatKem(orgId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/seat-kems", body)
    }

    public func grant(orgId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/seats", body)
    }

    public func createInvite(orgId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/invites", body)
    }

    /// The org's sealed directory entries (docs/org-directory.md §2); only the directory key opens them.
    public func directory(orgId: String) async throws -> [OrgDirectorySealed] {
        let r = try await call("GET", "/api/orgs/\(orgId)/directory")
        return ((r["entries"] as? [Any]) ?? []).compactMap { try? OrgDirectorySealed.fromWire($0) }
    }

    /// Directory connectors (newest record each) and their proposals with any decision.
    public func connectors(orgId: String) async throws -> [[String: Any]] {
        ((try await call("GET", "/api/orgs/\(orgId)/connectors"))["connectors"] as? [[String: Any]]) ?? []
    }

    public func postConnector(orgId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/connectors", body)
    }

    public func proposals(orgId: String) async throws -> [[String: Any]] {
        ((try await call("GET", "/api/orgs/\(orgId)/proposals"))["proposals"] as? [[String: Any]]) ?? []
    }

    public func decideProposal(orgId: String, decision: [String: Any], approval: OrgApproval) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/proposals/decisions", ["decision": decision, "approvals": [approval.jsonObject]])
    }

    /// Members' sealed slices of the directory, each with the org admin's approval.
    public func directorySlices(orgId: String) async throws -> [[String: Any]] {
        ((try await call("GET", "/api/orgs/\(orgId)/directory/slices"))["slices"] as? [[String: Any]]) ?? []
    }

    public func putDirectorySlice(orgId: String, slice: OrgDirectorySlice, approval: OrgApproval) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/directory/slices", ["slice": slice.json, "approvals": [approval.jsonObject]])
    }

    public func revoke(orgId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/revokes", body)
    }

    /// Stores one sealed entry, approved by this org admin over its write form.
    public func putDirectory(orgId: String, entry: OrgDirectorySealed, approval: OrgApproval) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/directory", ["entry": entry.json, "approvals": [approval.jsonObject]])
    }
}

extension OrgAuthority {
    /// A one-admin org's genesis: the founder alone, thresholds at their floor, the bylaws' set = every admin by majority.
    public static func genesis(orgId: String, founderSeatId: String, founderBinding: PqKeyBindingWire, issuedAt: Int64) -> OrgAuthorityRecord {
        OrgAuthorityRecord(orgId: orgId, version: 0, prevHash: genesisPrev,
                           admins: [OrgAdminEntry(seatId: founderSeatId, kind: .admin, binding: founderBinding)],
                           bylaws: OrgBylaws(overturnSeats: nil, overturnK: 0, vetoK: 1), founderSeatId: founderSeatId,
                           kGov: 1, kGrant: 1, kDestroy: 1, kSite: 1, issuedAt: issuedAt)
    }

    /// Who must approve to overturn a freeze of `seatId` under `r` (the bylaws' set without the frozen seat), and how many.
    public static func overturnSigners(_ r: OrgAuthorityRecord, frozenSeat seatId: String) -> (seats: [String], needed: Int) {
        (overturnSet(r).filter { $0 != seatId }, overturnThreshold(r))
    }

    /// The freeze of `seatId` in force at `now`, if any.
    public static func activeFreeze(_ book: OrgSeatBook, seatId: String, now: Int64) -> OrgVerifiedFreeze? {
        book.freezes.first { $0.seatId == seatId && $0.issuedAt <= now && now < $0.untilMs }
    }

    /// A random 16-byte id (org or seat), lowercase hex.
    public static func randomId() -> String { PqBin.hex(PqBin.random(16)) }
}
