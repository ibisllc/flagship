import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipCore
import FlagshipAPI

/// One org's Business plan on this phone (docs/plans-and-backup-offer.md §3, §6): the plan every seat reads, and for an
/// org admin the org wallet, opened with the newest `wallet` key ring version sealed to this seat. The first org
/// admin who opens the Plan makes version 1. Background runs never prompt and never post a key ring.
@MainActor
@Observable
public final class OrgPlanModel {
    public let orgId: String
    public let orgName: String
    public private(set) var plan: OrgPlanServed?
    public private(set) var wallet: OrgVoucherWallet?
    public private(set) var info: PaymentsInfo?
    public private(set) var isOrgAdmin = false
    public private(set) var hasKey = false
    public private(set) var canSpend = false
    public private(set) var isLoading = false
    public private(set) var isWorking = false
    public private(set) var lastError: String?

    @ObservationIgnored private let seat: OrgSeatKeys.Seat?
    @ObservationIgnored private let orgClient: OrgClient?
    @ObservationIgnored private let keys: OrgSeatKeys
    @ObservationIgnored private let umk: (String) async throws -> [UInt8]
    @ObservationIgnored private let cachedUmk: () -> [UInt8]?
    @ObservationIgnored public var now: () -> Int64
    @ObservationIgnored private var snapshot: OrgSnapshot?
    @ObservationIgnored private var ringKeys: [Int64: [UInt8]] = [:]
    @ObservationIgnored private var fixedApproval = false
    @ObservationIgnored public private(set) var engine: OrgWalletEngine!

    public init(seat: OrgSeatKeys.Seat, payments: any OrgPaymentsComClient = LiveOrgPaymentsComClient(), orgClient: OrgClient = OrgClient(),
                keys: OrgSeatKeys = .shared, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                umk: @escaping (String) async throws -> [UInt8] = { reason in try await Keystore.currentUMK(reason: reason).withUnsafeBytes { Array($0) } },
                cachedUmk: @escaping () -> [UInt8]? = { Keystore.messagesUMKIfCached().map(Array.init) },
                defaults: UserDefaults = .standard) {
        self.orgId = seat.orgId; self.orgName = seat.orgName; self.seat = seat; self.orgClient = orgClient; self.keys = keys
        self.now = now; self.umk = umk; self.cachedUmk = cachedUmk
        makeEngine(payments, defaults: defaults)
    }

    #if DEBUG
    /// The mock gym's org: no key ring, a fixed wallet key, approvals that sign nothing.
    init(fixtureOrgId orgId: String, orgName: String, isOrgAdmin: Bool, payments: any OrgPaymentsComClient, now: @escaping () -> Int64) {
        self.orgId = orgId; self.orgName = orgName; self.seat = nil; self.orgClient = nil; self.keys = .shared
        self.now = now; self.umk = { _ in [] }; self.cachedUmk = { nil }
        self.isOrgAdmin = isOrgAdmin
        self.fixedApproval = true
        if isOrgAdmin { ringKeys = [1: [UInt8](repeating: 0x5a, count: 32)] }
        makeEngine(payments, defaults: .standard)
    }

    private static var gym: OrgPlanModel?

    /// `-smoke-org-plan trial|paid|lapsed` (`-smoke-org-member`: a seat that isn't an org admin): Settings →
    /// Organizations opens the Plan of a mock org with four people, on a mock `.com` that starts empty.
    public static func gymFixture(args: [String] = ProcessInfo.processInfo.arguments) -> OrgPlanModel? {
        guard GymLaunch.usesMocks, let i = args.firstIndex(of: "-smoke-org-plan"), args.indices.contains(i + 1),
              let state = OrgPlanStatus(rawValue: args[i + 1]) else { return nil }
        if let gym { return gym }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let orgId = String(repeating: "0f", count: 16)
        let com = MockOrgPaymentsComClient()
        com.seed(orgId: orgId, state: state, liveSeats: 4, now: now)
        let m = OrgPlanModel(fixtureOrgId: orgId, orgName: "acme", isOrgAdmin: !args.contains("-smoke-org-member"), payments: com,
                             now: { Int64(Date().timeIntervalSince1970 * 1000) })
        gym = m
        return m
    }
    #endif

    private func makeEngine(_ payments: any OrgPaymentsComClient, defaults: UserDefaults) {
        engine = OrgWalletEngine(client: payments, context: .init(
            orgId: orgId, isOrgAdmin: isOrgAdmin,
            ringKeys: { [weak self] in self?.ringKeys ?? [:] },
            canApprove: { [weak self] in self?.canApproveNow() ?? false },
            approve: { [weak self] order in self?.approval(order) }), defaults: defaults)
        engine.now = { [weak self] in self?.now() ?? Int64(Date().timeIntervalSince1970 * 1000) }
    }

    private func canApproveNow() -> Bool {
        if fixedApproval { return true }
        guard let seat else { return false }
        return keys.canSign(seat)
    }

    /// This org admin's approval of `order`, in the wire form `.com` takes.
    private func approval(_ order: [UInt8]) -> JSONValue? {
        if fixedApproval { return ["orderSha256": .string(CanonicalJson.sha256Hex(order))] }
        guard let seat, let s = snapshot, let a = try? signApproval(seat, s, order) else { return nil }
        return JSONValue(any: a.jsonObject)
    }

    private func signApproval(_ seat: OrgSeatKeys.Seat, _ s: OrgSnapshot, _ order: [UInt8]) throws -> OrgApproval {
        let t = now()
        return try OrgAuthority.signApproval(orgId: seat.orgId, oarVersion: s.state.current.version, order: order, seatId: seat.seatId,
                                             adminKeyId: seat.keyId, issuedAt: t, notAfter: t + OrgAuthority.day) { p, m in
            guard let sig = keys.sign(seat, purpose: p, payload: m) else { throw OrgAuthorityError("locked") }
            return sig
        }
    }

    private func mirror() {
        plan = engine.plan
        wallet = engine.wallet
        info = engine.info
        hasKey = engine.hasKey
        canSpend = engine.canSpend
        lastError = engine.lastError
    }

    // MARK: loading

    /// Reads the plan; an org admin also opens the wallet. `interactive`: the admin opened the Plan, so the phone may
    /// ask for Face ID and may make the wallet key's first version.
    public func load(interactive: Bool) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false; mirror() }
        if let seat, let orgClient {
            do {
                let s = try await orgClient.snapshot(orgId: seat.orgId, genesisHash: seat.genesisHash, now: now())
                snapshot = s
                isOrgAdmin = s.state.current.admins.contains { $0.seatId == seat.seatId && $0.kind == .admin }
                engine.context.isOrgAdmin = isOrgAdmin
                if isOrgAdmin { await openWalletKey(seat, s, orgClient, interactive: interactive) }
            } catch {
                snapshot = nil
            }
        }
        await engine.refresh()
        await engine.tick()
        if engine.hasKey { OrgVoucherSinks.register(orgId: orgId, engine: engine) }
    }

    /// The newest `wallet` ring versions this seat can open, made first when the org has none.
    private func openWalletKey(_ seat: OrgSeatKeys.Seat, _ s: OrgSnapshot, _ orgClient: OrgClient, interactive: Bool) async {
        var secret: [UInt8]?
        do {
            var u: [UInt8]
            if interactive { u = try await umk(String(localized: "Open this organization's plan")) } else {
                guard let c = cachedUmk() else { return }
                u = c
            }
            defer { for i in u.indices { u[i] = 0 } }
            let kp = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: u, orgId: seat.orgId))
            secret = kp.secretKey
            var p = try await orgClient.rotationPlan(s, now: now())
            if interactive, p.ctx.kems["seat:\(seat.seatId)"]?.kemKeyId != OrgAuthority.kemKeyIdHex(kp.publicKey) {
                try await publishSeatKem(seat, kp.publicKey, orgClient)
                p = try await orgClient.rotationPlan(s, now: now())
            }
            if interactive, (p.chains[OrgRotation.chainId(.wallet, "*")] ?? []).isEmpty {
                var key = SymmetricKey(size: .bits256).withUnsafeBytes { Array($0) }
                defer { for i in key.indices { key[i] = 0 } }
                let b = try OrgRotation.rotate(p, kind: .wallet, scope: "*", issuedAt: now(), key: key) { order, _ in try signApproval(seat, s, order) }
                try await orgClient.postKeyRing(orgId: seat.orgId, b)
                p = try await orgClient.rotationPlan(s, now: now())
            }
            var out: [Int64: [UInt8]] = [:]
            for b in p.chains[OrgRotation.chainId(.wallet, "*")] ?? [] {
                if let k = try? OrgAuthority.openKeyRing(b.ring, recipients: b.recipients, recipient: "seat:\(seat.seatId)", kemSecret: kp.secretKey) {
                    out[b.ring.version] = k
                }
            }
            ringKeys = out
        } catch {}
        if var s = secret { for i in s.indices { s[i] = 0 } }
    }

    private func publishSeatKem(_ seat: OrgSeatKeys.Seat, _ kemPub: [UInt8], _ orgClient: OrgClient) async throws {
        let t = now()
        let kemKeyId = OrgAuthority.kemKeyIdHex(kemPub)
        let msg = try OrgAuthority.canonicalSeatKem(orgId: seat.orgId, seatId: seat.seatId, kemKeyId: kemKeyId, issuedAt: t)
        guard let sig = keys.sign(seat, purpose: OrgAuthority.tagSeatKem, payload: msg) else { throw OrgAuthorityError("locked") }
        try await orgClient.postSeatKem(orgId: seat.orgId, body: [
            "statement": ["orgId": seat.orgId, "seatId": seat.seatId, "kemKeyId": kemKeyId, "issuedAt": NSNumber(value: t)] as [String: Any],
            "kemPubHex": OrgAuthority.hex(kemPub),
            "signature": OrgAuthority.hex(sig),
        ])
    }

    // MARK: actions

    private func run(_ f: () async -> Bool) async -> Bool {
        isWorking = true
        let ok = await f()
        isWorking = false
        mirror()
        return ok
    }

    @discardableResult
    public func setSeats(_ seats: Int64) async -> Bool { await run { await engine.setSeats(seats) } }

    @discardableResult
    public func setAutoPay(_ on: Bool) async -> Bool { await run { await engine.setAutoPay(on) } }

    #if DEBUG
    /// The gym: vouchers straight into the org wallet, as a store purchase would add them.
    @discardableResult
    func addFixtureVouchers(_ n: Int) async -> Bool {
        guard let m = engine.client as? MockOrgPaymentsComClient, let vs = try? m.payments.makeVouchers(n) else { return false }
        return await run {
            guard await engine.addBought(vs) else { return false }
            await engine.tick(interactive: true)
            return true
        }
    }
    #endif

    // MARK: what the screen shows

    public var config: PaymentsConfig { engine.config }
    public var balanceUnits: Int64 { Int64(wallet?.balance ?? 0) }
    public var seats: Int64 { max(engine.minSeats, wallet?.settings.seats ?? engine.minSeats) }
    public var minSeats: Int64 { engine.minSeats }
}

/// Where a store purchase meant for an org goes: that org's wallet engine, while this phone has it open.
@MainActor
public enum OrgVoucherSinks {
    private static var engines: [String: OrgWalletEngine] = [:]

    public static func register(orgId: String, engine: OrgWalletEngine) { engines[orgId] = engine }

    public static func engine(_ orgId: String) -> OrgWalletEngine? { engines[orgId] }

    public static func forgetAll() { engines = [:] }
}

/// The org trickle, beside the personal one: every org this phone is an admin of pays a little at a time, ahead of
/// need. It runs only with the account key already at hand and never prompts.
@MainActor
public enum OrgPlanTrickle {
    private static var models: [String: OrgPlanModel] = [:]

    public static func runAll(keys: OrgSeatKeys = .shared) async {
        for seat in keys.seats() where seat.memberOnly != true {
            let m = models[seat.id] ?? OrgPlanModel(seat: seat, keys: keys)
            models[seat.id] = m
            await m.load(interactive: false)
        }
    }

    public static func forget() {
        models = [:]
        OrgVoucherSinks.forgetAll()
    }
}
