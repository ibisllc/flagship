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
            "admins": r.admins.map { ["seatId": $0.seatId, "kind": $0.kind.rawValue, "binding": $0.binding.jsonObject] as [String: Any] },
            "bylaws": ["overturnSeats": r.bylaws.overturnSeats.map { $0 as Any } ?? "*", "overturnK": r.bylaws.overturnK, "vetoK": r.bylaws.vetoK] as [String: Any],
            "founderSeatId": r.founderSeatId, "kGov": r.kGov, "kGrant": r.kGrant, "kDestroy": r.kDestroy, "kSite": r.kSite,
            "issuedAt": NSNumber(value: r.issuedAt),
        ]
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
}

public struct OrgCeremony: Identifiable {
    public let sha256: String
    public let order: String
    public let payload: [String: Any]
    public let approvals: [OrgApproval]
    public var id: String { sha256 }
    /// The purpose tag of the order (`flagship/<purpose>/v1`).
    public var purpose: String { String(order.split(separator: "|").first ?? "") }
}

public struct OrgClientError: Error, Equatable, CustomStringConvertible {
    public let status: Int
    public let code: String
    public var description: String { code.isEmpty ? "http \(status)" : code }
}

public final class OrgClient: @unchecked Sendable {
    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = Endpoints.controlBaseUrl) {
        self.urlSession = urlSession; self.baseUrl = baseUrl
    }

    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
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
    public func snapshot(orgId: String, genesisHash: String, now: Int64) async throws -> OrgSnapshot {
        let a = try await call("GET", "/api/orgs/\(orgId)/authority")
        let s = try await call("GET", "/api/orgs/\(orgId)/seats")
        let c = try await call("GET", "/api/orgs/\(orgId)/ceremonies")
        let entries = try ((a["entries"] as? [Any]) ?? []).map { try OrgAuthorityWire.entry($0) }
        let freezes = try ((a["freezes"] as? [Any]) ?? []).map { try OrgAuthorityWire.freeze($0) }
        let overturns = try ((a["overturns"] as? [Any]) ?? []).map { try OrgAuthorityWire.overturn($0) }
        let vetoes = try ((a["vetoes"] as? [Any]) ?? []).map { try OrgAuthorityWire.veto($0) }
        let state = try OrgAuthority.verifyChain(entries, genesisHash: genesisHash, now: now, freezes: freezes, overturns: overturns, vetoes: vetoes)
        let grants = ((s["grants"] as? [Any]) ?? []).compactMap { try? OrgAuthorityWire.grantBundle($0) }
        let revokes = ((s["revokes"] as? [Any]) ?? []).compactMap { try? OrgAuthorityWire.revokeBundle($0) }
        let book = OrgAuthority.buildSeatBook(state, grants: grants, revokes: revokes, freezes: freezes, overturns: overturns, now: now)
        let ceremonies: [OrgCeremony] = ((c["ceremonies"] as? [[String: Any]]) ?? []).compactMap { o in
            guard let sha = o["sha256"] as? String, let order = o["order"] as? String,
                  let approvals = try? OrgAuthorityWire.approvals(o["approvals"]) else { return nil }
            return OrgCeremony(sha256: sha, order: order, payload: (o["payload"] as? [String: Any]) ?? [:], approvals: approvals)
        }
        return OrgSnapshot(name: ((a["org"] as? [String: Any])?["name"] as? String) ?? "", state: state, book: book, freezes: freezes, ceremonies: ceremonies)
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

    public func createInvite(orgId: String, body: [String: Any]) async throws {
        _ = try await call("POST", "/api/orgs/\(orgId)/invites", body)
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
