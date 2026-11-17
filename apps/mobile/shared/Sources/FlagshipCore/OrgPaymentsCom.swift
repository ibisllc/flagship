import Foundation
import FlagshipAPI

/// `GET /api/orgs/<orgId>/plan` (public): the org's Business terms and the served prices.
public struct OrgPlanServed: Equatable, Sendable {
    public var orgId: String
    public var status: OrgPlanStatus
    public var seatLimit: Int64
    public var paidSeats: Int64
    public var paidUntil: Int64
    public var trialEndsAt: Int64
    public var coveredUntil: Int64
    public var liveSeats: Int64
    public var unitsPerSeatMonth: Int64
    public var minSeats: Int64
    public var maxSeats: Int64
    public var unitUsd: Int64

    public init(orgId: String, status: OrgPlanStatus, seatLimit: Int64, paidSeats: Int64, paidUntil: Int64, trialEndsAt: Int64, coveredUntil: Int64,
                liveSeats: Int64, unitsPerSeatMonth: Int64, minSeats: Int64, maxSeats: Int64, unitUsd: Int64) {
        self.orgId = orgId; self.status = status; self.seatLimit = seatLimit; self.paidSeats = paidSeats; self.paidUntil = paidUntil
        self.trialEndsAt = trialEndsAt; self.coveredUntil = coveredUntil; self.liveSeats = liveSeats; self.unitsPerSeatMonth = unitsPerSeatMonth
        self.minSeats = minSeats; self.maxSeats = maxSeats; self.unitUsd = unitUsd
    }

    /// The trial's seat count is not served on its own: the seat limit during the trial is the larger of the two.
    public var terms: OrgPlanTerms { OrgPlanTerms(trialEndsAt: trialEndsAt, trialSeats: seatLimit, paidSeats: paidSeats, paidUntil: paidUntil) }

    /// The served numbers win over the config's (`.com` prices the plan).
    public func config(_ base: PaymentsConfig) -> PaymentsConfig {
        var c = base
        if unitsPerSeatMonth > 0 { c.business.unitsPerSeatMonth = unitsPerSeatMonth }
        if minSeats > 0, maxSeats >= minSeats { c.business.minSeats = minSeats; c.business.maxSeats = maxSeats }
        if unitUsd > 0 { c.unitUsd = unitUsd }
        return c
    }

    public static func parse(_ v: JSONValue?, base: PaymentsConfig = .defaults) -> OrgPlanServed? {
        guard let o = v?.object, let orgId = o["orgId"]?.string, let status = o["status"]?.string.flatMap(OrgPlanStatus.init(rawValue:)) else { return nil }
        let p = o["price"], b = base.business
        return OrgPlanServed(orgId: orgId, status: status, seatLimit: o["seatLimit"]?.time ?? 0, paidSeats: o["paidSeats"]?.time ?? 0,
                             paidUntil: o["paidUntil"]?.time ?? 0, trialEndsAt: o["trialEndsAt"]?.time ?? 0, coveredUntil: o["coveredUntil"]?.time ?? 0,
                             liveSeats: o["liveSeats"]?.time ?? 0, unitsPerSeatMonth: p?["unitsPerSeatMonth"]?.time ?? b.unitsPerSeatMonth,
                             minSeats: p?["minSeats"]?.time ?? b.minSeats, maxSeats: p?["maxSeats"]?.time ?? b.maxSeats, unitUsd: p?["unitUsd"]?.time ?? base.unitUsd)
    }
}

/// What an org spend did.
public struct OrgRedeemResult: Equatable, Sendable {
    public var credited: Int64
    public var spent: [String]
    public var seats: Int64?
    public var paidUntil: Int64?
    public var status: OrgPlanStatus?
    public var path: PrivatePath?
    public init(credited: Int64, spent: [String], seats: Int64? = nil, paidUntil: Int64? = nil, status: OrgPlanStatus? = nil, path: PrivatePath? = nil) {
        self.credited = credited; self.spent = spent; self.seats = seats; self.paidUntil = paidUntil; self.status = status; self.path = path
    }
}

/// `.com`'s org payment routes (docs/plans-and-backup-offer.md §6). Spends and exchanges carry no credential and go
/// through the private relays like the personal wallet's; the wallet write carries one org admin's approval.
public protocol OrgPaymentsComClient: Sendable {
    func paymentsInfo() async throws -> PaymentsInfo
    /// `GET /api/orgs/<orgId>/plan`.
    func orgPlan(orgId: String) async throws -> OrgPlanServed
    /// `GET /api/orgs/<orgId>/voucher-wallet`; nil on 404.
    func orgWallet(orgId: String) async throws -> JSONValue?
    /// `PUT` `{blob, write, approvals}`; 409 `version-conflict` carries the stored blob as `stored`.
    func putOrgWallet(orgId: String, blob: SealedOrgVoucherWallet, write: OrgWalletWrite, approval: JSONValue) async throws
    /// `POST /api/vouchers/redeem` for an org: `what` is "business" (with `seats`) or "overage".
    func redeemOrg(orgId: String, for what: String, seats: Int64?, vouchers: [Voucher], route: SpendRoute) async throws -> OrgRedeemResult
    /// `POST /api/vouchers/exchange`: spends `vouchers` and signs `blinded` (same count) under key `keyId`.
    func exchange(keyId: String, vouchers: [Voucher], blinded: [String], route: SpendRoute) async throws -> PaidIssueResult
    /// `POST /api/vouchers/paid-issue`, as the personal client sends it (a store purchase meant for the org wallet).
    func paidIssue(rail: String, proof: JSONValue, keyId: String, blinded: [String]) async throws -> PaidIssueResult
}

extension OrgPaymentsComClient {
    static func redeemOrgBody(orgId: String, for what: String, seats: Int64?, vouchers: [Voucher]) throws -> [UInt8] {
        var body: [String: JSONValue] = ["v": 1, "org": .string(orgId), "for": .string(what), "vouchers": .array(vouchers.map(\.json))]
        if what == "business", let seats { body["seats"] = .int(seats) }
        return Array(try CanonicalJson.canonicalJson(.object(body)).utf8)
    }

    static func exchangeBody(keyId: String, vouchers: [Voucher], blinded: [String]) throws -> [UInt8] {
        Array(try CanonicalJson.canonicalJson(["v": 1, "k": .string(keyId), "vouchers": .array(vouchers.map(\.json)),
                                               "blinded": .array(blinded.map { .string($0) })]).utf8)
    }

    static func orgRedeemResult(_ v: JSONValue?, path: PrivatePath?) -> OrgRedeemResult {
        OrgRedeemResult(credited: v?["credited"]?.time ?? 0, spent: (v?["spent"]?.array ?? []).compactMap(\.string), seats: v?["seats"]?.time,
                        paidUntil: v?["paidUntil"]?.time, status: v?["status"]?.string.flatMap(OrgPlanStatus.init(rawValue:)), path: path)
    }
}

public final class LiveOrgPaymentsComClient: OrgPaymentsComClient, @unchecked Sendable {
    private let session: URLSession
    private let base: URL
    private let payments: LivePaymentsComClient

    public init(session: URLSession = .shared, base: URL = Endpoints.controlBaseUrl) {
        self.session = session
        self.base = base
        self.payments = LivePaymentsComClient(session: session, base: base, readTokens: nil)
    }

    private func url(_ path: String) -> URL { URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)! }

    private static func seg(_ orgId: String) -> String { orgId.filter { $0.isHexDigit }.lowercased() }

    private func call(_ method: String, _ path: String, _ body: JSONValue? = nil, notFoundIsNil: Bool = false) async throws -> JSONValue? {
        var r = URLRequest(url: url(path), timeoutInterval: 20)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.httpShouldHandleCookies = false
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = Data(try CanonicalJson.canonicalJson(body).utf8)
        }
        let (data, res) = try await session.gatedData(for: r)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404, notFoundIsNil { return nil }
        guard (200..<300).contains(status) else { throw PaymentsComError.from(status: status, data: data) }
        return data.isEmpty ? nil : JSONValue.parse(utf8: Array(data))
    }

    /// One private request (OHTTP when configured): no cookie, no authorization header.
    private func privatePost(_ path: String, body: [UInt8], route: SpendRoute) async throws -> (JSONValue?, PrivatePath?) {
        let session = self.session
        let res = try await OhttpClient.send(
            url: url(path), method: "POST", headers: [("content-type", "application/json")], body: body,
            config: route.config, timeout: 20, mayGoDirect: route.mayGoDirect, transport: { r in
                let (data, response) = try await session.gatedData(for: r)
                let http = response as? HTTPURLResponse
                return (http?.statusCode ?? 0, http?.value(forHTTPHeaderField: "content-type"), Array(data))
            }, skipRelaysReason: route.skipRelaysReason)
        guard (200..<300).contains(res.status) else {
            var e = PaymentsComError.from(status: res.status, data: Data(res.body))
            e.path = res.path
            throw e
        }
        return (res.body.isEmpty ? nil : JSONValue.parse(utf8: res.body), res.path)
    }

    public func paymentsInfo() async throws -> PaymentsInfo { try await payments.paymentsInfo() }

    public func paidIssue(rail: String, proof: JSONValue, keyId: String, blinded: [String]) async throws -> PaidIssueResult {
        try await payments.paidIssue(rail: rail, proof: proof, keyId: keyId, blinded: blinded)
    }

    public func orgPlan(orgId: String) async throws -> OrgPlanServed {
        guard let p = OrgPlanServed.parse(try await call("GET", "/api/orgs/\(Self.seg(orgId))/plan")) else { throw PaymentsComError(status: 0, code: "malformed") }
        return p
    }

    public func orgWallet(orgId: String) async throws -> JSONValue? {
        try await call("GET", "/api/orgs/\(Self.seg(orgId))/voucher-wallet", notFoundIsNil: true)
    }

    public func putOrgWallet(orgId: String, blob: SealedOrgVoucherWallet, write: OrgWalletWrite, approval: JSONValue) async throws {
        _ = try await call("PUT", "/api/orgs/\(Self.seg(orgId))/voucher-wallet", ["blob": blob.json, "write": write.json, "approvals": [approval]])
    }

    public func redeemOrg(orgId: String, for what: String, seats: Int64?, vouchers: [Voucher], route: SpendRoute) async throws -> OrgRedeemResult {
        let (v, path) = try await privatePost("/api/vouchers/redeem", body: try Self.redeemOrgBody(orgId: orgId, for: what, seats: seats, vouchers: vouchers), route: route)
        return Self.orgRedeemResult(v, path: path)
    }

    public func exchange(keyId: String, vouchers: [Voucher], blinded: [String], route: SpendRoute) async throws -> PaidIssueResult {
        let (v, _) = try await privatePost("/api/vouchers/exchange", body: try Self.exchangeBody(keyId: keyId, vouchers: vouchers, blinded: blinded), route: route)
        let sigs = (v?["sigs"]?.array ?? []).compactMap(\.string)
        return PaidIssueResult(k: v?["k"]?.string ?? "", sigs: sigs, units: Int64(sigs.count))
    }
}
