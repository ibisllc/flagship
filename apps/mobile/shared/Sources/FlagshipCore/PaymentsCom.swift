import Foundation
import FlagshipAPI

/// `.com`'s payment routes (packages/control-plane/src/blindVouchers.ts, docs/payments-privacy-and-rails.md "As built").
/// Codes only come back; the apps write the sentences.
public struct PaymentsComError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    /// A `version-conflict` 409: the stored sealed wallet to merge.
    public var stored: JSONValue?
    /// A `voucher-spent` 409: the nullifiers that were already spent.
    public var spent: [String] = []
    /// A `bad-voucher` 400: the nullifier of the voucher that didn't verify.
    public var nullifier: String?
    /// A `wrong-count` 409 from `paid-issue`: the units the payment bought.
    public var units: Int64?

    public init(status: Int, code: String, stored: JSONValue? = nil, spent: [String] = [], nullifier: String? = nil, units: Int64? = nil) {
        self.status = status; self.code = code; self.stored = stored; self.spent = spent; self.nullifier = nullifier; self.units = units
    }

    static func from(status: Int, data: Data) -> PaymentsComError {
        let v = JSONValue.parse(utf8: Array(data))
        return PaymentsComError(status: status, code: v?["code"]?.string ?? (status == 0 ? "network" : "http-\(status)"), stored: v?["wallet"],
                                spent: (v?["spent"]?.array ?? []).compactMap(\.string), nullifier: v?["nullifier"]?.string, units: v?["units"]?.safeInt)
    }
}

/// What `POST /api/vouchers/paid-issue` signed: the key, one blind signature per blinded request (same order), and the
/// units the payment bought.
public struct PaidIssueResult: Equatable, Sendable {
    public var k: String
    public var sigs: [String]
    public var units: Int64
    public init(k: String, sigs: [String], units: Int64) { self.k = k; self.sigs = sigs; self.units = units }
}

/// What a spend did: how many vouchers bought something, which were spent before, and the plan's new end (plans) or
/// this month's prepaid egress (overage).
public struct VoucherRedeemResult: Equatable, Sendable {
    public var credited: Int64
    public var spent: [String]
    public var paidUntil: Int64?
    public var topUpBytes: Int64?
    public init(credited: Int64, spent: [String], paidUntil: Int64? = nil, topUpBytes: Int64? = nil) {
        self.credited = credited; self.spent = spent; self.paidUntil = paidUntil; self.topUpBytes = topUpBytes
    }
}

/// The account's plan as `.com` attests it (`GET /api/users/<u>/plan-attestation`).
public struct AccountPlanState: Equatable, Sendable {
    public var tier: String
    public var paidUntil: Int64
    public init(tier: String, paidUntil: Int64) { self.tier = tier; self.paidUntil = paidUntil }
    public var plan: PaidPlan? { PaidPlan.ofTier(tier) }
    public static let free = AccountPlanState(tier: "free", paidUntil: 0)
}

/// This month's public egress (`GET /api/users/<u>/allowance`): top-ups included in `quotaBytes`.
public struct AccountAllowance: Equatable, Sendable {
    public var tier: String
    public var usedBytes: Int64
    public var quotaBytes: Int64
    public var remainingBytes: Int64
    public init(tier: String, usedBytes: Int64, quotaBytes: Int64, remainingBytes: Int64) {
        self.tier = tier; self.usedBytes = usedBytes; self.quotaBytes = quotaBytes; self.remainingBytes = remainingBytes
    }
}

public protocol PaymentsComClient: Sendable {
    /// `GET /api/payments/config` (public).
    func paymentsInfo() async throws -> PaymentsInfo
    /// `GET /api/accounts/<u>/voucher-wallet` (read token); nil when none is stored.
    func wallet(username: String) async throws -> JSONValue?
    /// `PUT` with `version` = stored + 1 (device headers); 409 `version-conflict` carries the stored blob.
    func putWallet(username: String, sealed: JSONValue, device: VoiciDeviceSigner) async throws
    /// `POST /api/vouchers/redeem`: no credential and no cookie, by design (anyone may pay anyone's bill).
    func redeem(username: String, for what: String, vouchers: [Voucher]) async throws -> VoucherRedeemResult
    /// `POST /api/vouchers/test-issue` (the gym only): blind signatures for `blinded`.
    func testIssue(keyId: String, blinded: [String]) async throws -> [String]
    /// `POST /api/vouchers/paid-issue`: blind signatures for a store payment (`rail` "apple" with `proof` {"jws"}).
    /// No credential, cookie or device header: the payment is the only thing that authorizes it. Idempotent for the
    /// same payment and the same blinded set.
    func paidIssue(rail: String, proof: JSONValue, keyId: String, blinded: [String]) async throws -> PaidIssueResult
    func plan(username: String) async throws -> AccountPlanState
    func allowance(username: String) async throws -> AccountAllowance
}

public final class LivePaymentsComClient: PaymentsComClient, @unchecked Sendable {
    private let session: URLSession
    private let base: URL
    private let readTokens: (any AccountReadTokenSource)?

    public init(session: URLSession = .shared, base: URL = Endpoints.controlBaseUrl, readTokens: (any AccountReadTokenSource)?) {
        self.session = session
        self.base = base
        self.readTokens = readTokens
    }

    private func request(_ method: String, _ path: String, _ body: JSONValue?, headers: [String: String] = [:]) throws -> URLRequest {
        var r = URLRequest(url: URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)!, timeoutInterval: 20)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = Data(try CanonicalJson.canonicalJson(body).utf8)
        }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    private static func seg(_ s: String) -> String { s.lowercased().addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? s }

    @discardableResult
    private func call(_ r: URLRequest) async throws -> JSONValue? {
        let (data, res) = try await session.gatedData(for: r)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw PaymentsComError.from(status: status, data: data) }
        return data.isEmpty ? nil : JSONValue.parse(utf8: Array(data))
    }

    private func read(_ r: URLRequest, username: String) async throws -> JSONValue? {
        let (data, status) = try await sendAccountRead(r, username: username, tokens: readTokens) { try await self.session.gatedData(for: $0) }
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw PaymentsComError.from(status: status, data: data) }
        return JSONValue.parse(utf8: Array(data))
    }

    public func paymentsInfo() async throws -> PaymentsInfo {
        PaymentsInfo.parse(try await call(try request("GET", "/api/payments/config", nil)))
    }

    public func wallet(username: String) async throws -> JSONValue? {
        try await read(try request("GET", "/api/accounts/\(Self.seg(username))/voucher-wallet", nil), username: username)
    }

    public func putWallet(username: String, sealed: JSONValue, device: VoiciDeviceSigner) async throws {
        let path = "/api/accounts/\(Self.seg(username))/voucher-wallet"
        guard let a = await device("PUT", path) else { throw PaymentsComError(status: 0, code: "no-device-key") }
        try await call(try request("PUT", path, sealed, headers: [
            "x-flagship-device-id": a.deviceId, "x-flagship-device-pub": a.signerPubHex, "x-flagship-request-id": a.requestId,
            "x-flagship-issued-at": String(a.issuedAt), "x-flagship-signature": a.signatureHex,
        ]))
    }

    public func redeem(username: String, for what: String, vouchers: [Voucher]) async throws -> VoucherRedeemResult {
        var r = try request("POST", "/api/vouchers/redeem", ["v": 1, "username": .string(username.lowercased()), "for": .string(what),
                                                               "vouchers": .array(vouchers.map(\.json))])
        // Nothing that names the caller: no cookie, no authorization header.
        r.httpShouldHandleCookies = false
        let v = try await call(r)
        return VoucherRedeemResult(credited: v?["credited"]?.time ?? 0, spent: (v?["spent"]?.array ?? []).compactMap(\.string),
                                   paidUntil: v?["paidUntil"]?.time, topUpBytes: v?["topUpBytes"]?.time)
    }

    public func testIssue(keyId: String, blinded: [String]) async throws -> [String] {
        let v = try await call(try request("POST", "/api/vouchers/test-issue", ["k": .string(keyId), "blinded": .array(blinded.map { .string($0) })]))
        return (v?["sigs"]?.array ?? []).compactMap(\.string)
    }

    public func paidIssue(rail: String, proof: JSONValue, keyId: String, blinded: [String]) async throws -> PaidIssueResult {
        var r = try request("POST", "/api/vouchers/paid-issue", ["v": 1, "rail": .string(rail), "proof": proof, "k": .string(keyId),
                                                                    "blinded": .array(blinded.map { .string($0) })])
        r.timeoutInterval = 45
        r.httpShouldHandleCookies = false
        let v = try await call(r)
        return PaidIssueResult(k: v?["k"]?.string ?? "", sigs: (v?["sigs"]?.array ?? []).compactMap(\.string), units: v?["units"]?.safeInt ?? 0)
    }

    public func plan(username: String) async throws -> AccountPlanState {
        guard let v = try await read(try request("GET", "/api/users/\(Self.seg(username))/plan-attestation", nil), username: username) else { return .free }
        return AccountPlanState(tier: v["tier"]?.string ?? "free", paidUntil: v["paidUntil"]?.time ?? 0)
    }

    public func allowance(username: String) async throws -> AccountAllowance {
        let v = try await read(try request("GET", "/api/users/\(Self.seg(username))/allowance", nil), username: username)
        return AccountAllowance(tier: v?["tier"]?.string ?? "free", usedBytes: v?["usedBytes"]?.time ?? 0, quotaBytes: v?["quotaBytes"]?.time ?? 0,
                                remainingBytes: v?["remainingBytes"]?.time ?? 0)
    }
}
