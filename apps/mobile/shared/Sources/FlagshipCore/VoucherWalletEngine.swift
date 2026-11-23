import Foundation
import Security

/// The phone's side of payments (docs/payments-privacy-and-rails.md "As built"): it holds the account's vouchers,
/// syncs them sealed with the account's other devices (like the call hours: compare-and-set, merge on a conflict),
/// and spends them a voucher at a time ahead of need (the trickle) and in overage blocks within the owner's cap.
///
/// Only an admin device with the account key at hand spends; every other device reads the plan. Spending sends the
/// vouchers alone: no device key, read token or cookie goes with them, so `.com` can't tie a spend to a device, and
/// the nullifier it keeps names no account. Background work never prompts: without the key it simply waits.
@MainActor
public final class VoucherWalletEngine {
    public struct Context {
        public var username: String
        public var isAdmin: Bool
        /// The UMK seed if this session holds it (never prompts).
        public var umk: () -> [UInt8]?
        public var device: VoiciDeviceSigner?
        public init(username: String, isAdmin: Bool, umk: @escaping () -> [UInt8]?, device: VoiciDeviceSigner?) {
            self.username = username; self.isAdmin = isAdmin; self.umk = umk; self.device = device
        }
    }

    public let client: any PaymentsComClient
    public var context: Context
    public private(set) var info: PaymentsInfo?
    public private(set) var wallet: VoucherWallet?
    public private(set) var planState: AccountPlanState = .free
    public private(set) var allowance: AccountAllowance?
    /// The last refusal or failure code, for the screen to explain.
    public private(set) var lastError: String?
    private var version: Int64 = 0
    private let defaults: UserDefaults
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    public var random: () -> Double = VoucherWalletEngine.secureRandom

    public init(client: any PaymentsComClient, context: Context, defaults: UserDefaults = .standard) {
        self.client = client
        self.context = context
        self.defaults = defaults
    }

    /// A uniform number in [0, 1) from the system's secure random source.
    nonisolated public static func secureRandom() -> Double {
        var x: UInt64 = 0
        if SecRandomCopyBytes(kSecRandomDefault, 8, &x) != errSecSuccess { x = UInt64.random(in: 0...UInt64.max) }
        return Double(x >> 11) / Double(1 << 53)
    }

    public var config: PaymentsConfig { info?.config ?? .defaults }
    public var balance: Int { wallet?.balance ?? 0 }
    public var canSpend: Bool { context.isAdmin && context.umk() != nil && context.device != nil }

    private var u: String { context.username.lowercased() }
    private var localKey: String { "flagship.payments.wallet.\(u)" }
    private var nextKey: String { "flagship.payments.nextSpendAt.\(u)" }
    private var relayFailuresKey: String { "flagship.payments.relayFailures.\(u)" }
    private var relayRetryKey: String { "flagship.payments.relayRetryAt.\(u)" }
    private var relayReasonKey: String { "flagship.payments.relayReason.\(u)" }
    private var lastDirectKey: String { "flagship.payments.lastDirect.\(u)" }
    private var unsyncedKey: String { "flagship.payments.unsynced.\(u)" }
    /// The voucher keys `.com` served last (public data), so a voucher link is checked with no network call.
    static let knownKeysKey = "flagship.payments.voucherKeys"

    var nextSpendAt: Int64 {
        get { Int64(defaults.double(forKey: nextKey)) }
        set { defaults.set(Double(newValue), forKey: nextKey) }
    }

    /// Spends skipped in a row because every relay failed and the spend couldn't go directly; reset by a relay success.
    public internal(set) var relayFailures: Int {
        get { defaults.integer(forKey: relayFailuresKey) }
        set { defaults.set(newValue, forKey: relayFailuresKey) }
    }
    /// The tick doesn't try the relay again before this (`relayRetryAfterMs`).
    public internal(set) var relayRetryAt: Int64 {
        get { Int64(defaults.double(forKey: relayRetryKey)) }
        set { defaults.set(Double(newValue), forKey: relayRetryKey) }
    }
    /// Why the relay failed last (for a direct spend while it rests).
    var relayReason: String? {
        get { defaults.string(forKey: relayReasonKey) }
        set { defaults.set(newValue, forKey: relayReasonKey) }
    }
    /// The last spend went directly because the relay failed (not `unconfigured`); cleared by a relay success.
    public internal(set) var lastDirectReason: String? {
        get { defaults.string(forKey: lastDirectKey) }
        set { defaults.set(newValue, forKey: lastDirectKey) }
    }

    /// The Plan screen's privacy line, in the order the screens agree on.
    public var spendPrivacy: SpendPrivacy {
        let relays = info?.ohttp.relays ?? []
        if relayFailures > 0, !relays.isEmpty { return .relayWaiting }
        if lastDirectReason != nil { return .wentDirect }
        guard let first = relays.first else { return .noRelay }
        return first.interim ? .interimRelay : .thirdPartyRelay(operator: first.operator)
    }

    // MARK: reading

    /// The numbers, the plan, this month's egress, and the wallet (this device's copy merged with the synced one).
    public func refresh() async {
        guard !u.isEmpty else { return }
        lastError = nil
        do {
            let fresh = try await client.paymentsInfo()
            info = fresh
            rememberKeys(fresh.keys.map(\.key))
            planState = try await client.plan(username: u)
            allowance = try? await client.allowance(username: u)
        } catch let e as PaymentsComError {
            lastError = e.code
        } catch {
            lastError = "network"
        }
        await loadWallet()
        // Vouchers a link added while offline were kept only here: send them now.
        if defaults.bool(forKey: unsyncedKey), let w = wallet, canSpend, await save(w) { defaults.removeObject(forKey: unsyncedKey) }
    }

    private func loadWallet() async {
        guard let umk = context.umk() else { return }
        let key = VoucherWalletSync.deriveKey(umk: umk)
        var mine = localCopy(key: key)
        if let blob = try? await client.wallet(username: u) {
            version = VoucherWalletSync.version(blob)
            if let remote = VoucherWalletSync.open(key: key, blob: blob) {
                mine = mine.map { VoucherWalletSync.merge(local: $0, remote: remote) } ?? remote
            }
        }
        let w = mine ?? .empty(overageCapUnits: config.overage.defaultCapUnits)
        wallet = w
        storeLocal(w, key: key)
    }

    private func localCopy(key: [UInt8]) -> VoucherWallet? {
        guard let text = defaults.string(forKey: localKey), let blob = JSONValue.parse(text) else { return nil }
        return VoucherWalletSync.open(key: key, blob: blob)
    }

    private func storeLocal(_ w: VoucherWallet, key: [UInt8]) {
        guard let sealed = try? VoucherWalletSync.seal(key: key, version: max(1, version), wallet: w),
              let text = try? CanonicalJson.canonicalJson(sealed) else { return }
        defaults.set(text, forKey: localKey)
    }

    /// Forget this device's copy (sign-out, wipe).
    public func forgetLocal() {
        for k in [localKey, nextKey, relayFailuresKey, relayRetryKey, relayReasonKey, lastDirectKey, unsyncedKey] { defaults.removeObject(forKey: k) }
        wallet = nil
    }

    // MARK: writing

    /// Seal and put the wallet with compare-and-set; on a conflict merge the stored one in and try again.
    @discardableResult
    public func save(_ w: VoucherWallet) async -> Bool {
        guard let umk = context.umk(), let device = context.device else { return false }
        let key = VoucherWalletSync.deriveKey(umk: umk)
        var mine = w
        wallet = mine
        storeLocal(mine, key: key)
        for _ in 0..<4 {
            do {
                let sealed = try VoucherWalletSync.seal(key: key, version: version + 1, wallet: mine)
                try await client.putWallet(username: u, sealed: sealed, device: device)
                version += 1
                wallet = mine
                storeLocal(mine, key: key)
                return true
            } catch let e as PaymentsComError where e.code == "version-conflict" {
                version = VoucherWalletSync.version(e.stored)
                if let remote = VoucherWalletSync.open(key: key, blob: e.stored) { mine = VoucherWalletSync.merge(local: mine, remote: remote) }
            } catch let e as PaymentsComError {
                lastError = e.code
                return false
            } catch {
                lastError = "network"
                return false
            }
        }
        return false
    }

    /// Change the owner's settings (plan, auto-pay, overage cap, delayed start), synced at once.
    @discardableResult
    public func updateSettings(_ change: (inout VoucherWalletSettings) -> Void) async -> Bool {
        guard var w = wallet, canSpend else { return false }
        var s = w.settings
        change(&s)
        s.updatedAt = max(now(), w.settings.updatedAt + 1)
        w.settings = s
        return await save(w)
    }

    /// Choose a plan (nil: Free, nothing more is spent). With `delayStart` the first spend waits a random time up to
    /// `activationDelayMaxHours`; otherwise the next tick spends at once.
    @discardableResult
    public func choosePlan(_ plan: PaidPlan?, delayStart: Bool) async -> Bool {
        let t = now()
        let delayMs = Int64((random() * Double(config.activationDelayMaxHours * 3_600_000)).rounded(.down))
        let ok = await updateSettings { s in
            s.plan = plan
            s.delayStart = delayStart
            s.startAt = plan != nil && delayStart ? t + delayMs : 0
        }
        if ok { nextSpendAt = 0; await tick(interactive: true) }
        return ok
    }

    // MARK: spending

    /// One round of automatic spending: the trickle for the chosen plan, then an overage block if one is due.
    /// `interactive`: the owner just chose a plan and waits, so the plan spend may always go directly if the relay fails.
    public func tick(interactive: Bool = false) async {
        guard canSpend, info != nil, let w = wallet, w.settings.autoPay else { return }
        let cfg = config
        let t = now()
        if let plan = w.settings.plan {
            let ahead = VoucherSpending.planAheadMs(cfg, plan: plan, paid: .init(plan: planState.plan, paidUntil: planState.paidUntil), now: t)
            let step = VoucherSpending.trickleStep(.init(
                now: t, enabled: true, balance: Int64(w.balance), aheadMs: ahead, startAt: w.settings.startAt, nextSpendAt: nextSpendAt,
                unitMs: cfg.unitMs(plan), lowWaterMs: cfg.trickle.lowWaterDays * 86_400_000, highWaterMs: cfg.trickle.highWaterDays * 86_400_000,
                maxPerRequest: cfg.maxPerRequest), rand: random())
            nextSpendAt = step.nextSpendAt
            if step.spend > 0 { await spend(plan.rawValue, Int(step.spend), kind: interactive ? .interactive : .trickle, retry: true) }
        }
        if let a = allowance, planState.plan != nil, let w2 = wallet {
            let period = VoucherSpending.overagePeriod(t)
            let spentUnits = w2.overage.period == period ? w2.overage.units : 0
            let due = VoucherSpending.overageStep(.init(
                paid: true, remainingBytes: a.remainingBytes, buyBelowBytes: cfg.overage.buyBelowGb * 1_073_741_824,
                capUnits: w2.settings.overageCapUnits, spentUnits: spentUnits, blockUnits: cfg.overage.blockUnits, balance: Int64(w2.balance)))
            if due { await spend("overage", Int(cfg.overage.blockUnits), kind: .overage, retry: true) }
        }
    }

    /// The relays and the fallback rule for one spend (docs/outbound-proxy.md "Failure handling"): after a relay failure
    /// the tick rests the relay until `relayRetryAt`; the owner's own choice tries it again at once.
    /// Nil while the relay rests and this spend may not go directly: it waits, untried.
    private func route(_ kind: PrivateSpendKind) -> SpendRoute? {
        let lapse = OhttpPrivacy.planLapseInMs(paidUntil: planState.paidUntil, graceMs: config.graceHours * 3_600_000, now: now())
        let resting = kind != .interactive && now() < relayRetryAt && relayFailures > 0
        if resting, !OhttpPrivacy.spendMayGoDirect(kind, lapseInMs: lapse) { return nil }
        return SpendRoute(config: info?.ohttp ?? .empty, skipRelaysReason: resting ? (relayReason ?? "relay-unreachable") : nil) { _ in
            OhttpPrivacy.spendMayGoDirect(kind, lapseInMs: lapse)
        }
    }

    private func noteRelay(_ path: PrivatePath?) {
        switch path {
        case .relay?:
            relayFailures = 0; relayRetryAt = 0; relayReason = nil; lastDirectReason = nil
        case .direct(let reason)?:
            if reason != "unconfigured" { lastDirectReason = reason }
        case nil:
            break
        }
    }

    private func spend(_ what: String, _ n: Int, kind: PrivateSpendKind, retry: Bool) async {
        guard var w = wallet else { return }
        let vs = VoucherWalletSync.take(w, n)
        guard vs.count == n || (what != "overage" && !vs.isEmpty), let route = route(kind) else { return }
        do {
            let r = try await client.redeem(username: u, for: what, vouchers: vs, route: route)
            noteRelay(r.path)
            w = VoucherWalletSync.markSpent(w, vs.map(Vouchers.nullifier))
            if what == "overage" {
                let period = VoucherSpending.overagePeriod(now())
                let before = w.overage.period == period ? w.overage.units : 0
                w.overage = .init(period: period, units: before + Int64(vs.count))
            }
            if let end = r.paidUntil, let plan = PaidPlan(rawValue: what) {
                planState = AccountPlanState(tier: plan == .pro ? "hobby" : "maker", paidUntil: end)
            }
            await save(w)
            if what == "overage" { allowance = try? await client.allowance(username: u) }
        } catch let e as RelayUnavailableError {
            // Not an error to the owner: the spend waits and tries again; the plan's grace covers the wait.
            relayFailures += 1
            relayReason = e.reason
            relayRetryAt = now() + OhttpPrivacy.relayRetryAfterMs(relayFailures)
        } catch let e as PaymentsComError {
            noteRelay(e.path)
            switch e.code {
            case "voucher-spent":
                await save(VoucherWalletSync.markSpent(w, e.spent))
                if retry { await spend(what, n, kind: kind, retry: false) }
            case "bad-voucher":
                if let nf = e.nullifier { await save(VoucherWalletSync.markSpent(w, [nf])) }
            case "plan-paid-ahead":
                break
            default:
                lastError = e.code
            }
        } catch {
            lastError = "network"
        }
    }

    // MARK: bought vouchers

    /// Vouchers a store rail just signed: added to the wallet and saved (compare-and-set, merged on a conflict).
    /// True only once `.com` holds the sealed wallet with them, so the store purchase may be finished.
    @discardableResult
    public func addBought(_ vouchers: [Voucher]) async -> Bool {
        guard canSpend, !vouchers.isEmpty else { return false }
        if wallet == nil { await loadWallet() }
        guard let w = wallet else { return false }
        return await save(VoucherWalletSync.add(w, vouchers))
    }

    // MARK: paying something else (the account rename)

    /// `n` vouchers to pay with, still in the wallet until `markSpent` (nil when the wallet holds fewer).
    public func takeVouchers(_ n: Int) -> [Voucher]? {
        guard let w = wallet, w.balance >= n else { return nil }
        return VoucherWalletSync.take(w, n)
    }

    /// Drop spent vouchers and save.
    @discardableResult
    public func markSpent(_ nullifiers: [String]) async -> Bool {
        guard !nullifiers.isEmpty else { return true }
        if wallet == nil { await loadWallet() }
        guard let w = wallet else { return false }
        return await save(VoucherWalletSync.markSpent(w, nullifiers))
    }

    // MARK: vouchers from a link (docs/anonymous-vouchers.md "Voucher links")

    /// The keys a voucher link is checked against: the ones served now and every one remembered from earlier answers.
    public var knownVoucherKeys: [VoucherPublicKey] {
        var out = info?.keys.map(\.key) ?? []
        if let text = defaults.string(forKey: Self.knownKeysKey), let data = text.data(using: .utf8),
           let saved = try? JSONDecoder().decode([VoucherPublicKey].self, from: data) {
            for k in saved where Vouchers.isUsableKey(k) && !out.contains(where: { $0.keyId == k.keyId }) { out.append(k) }
        }
        return out
    }

    func rememberKeys(_ keys: [VoucherPublicKey]) {
        var all = keys.filter(Vouchers.isUsableKey)
        for k in knownVoucherKeys where !all.contains(where: { $0.keyId == k.keyId }) { all.append(k) }
        if let data = try? JSONEncoder().encode(Array(all.prefix(16))) { defaults.set(String(decoding: data, as: UTF8.self), forKey: Self.knownKeysKey) }
    }

    /// What a voucher link would add, from this device alone (the wallet copy kept here, the keys remembered here).
    /// Nil when this device can't hold the wallet (not an admin device, or the account key isn't at hand).
    public func planLinkImport(_ vouchers: [Voucher]) -> VoucherLink.ImportPlan? {
        guard canSpend, let umk = context.umk() else { return nil }
        let w = wallet ?? localCopy(key: VoucherWalletSync.deriveKey(umk: umk)) ?? .empty(overageCapUnits: config.overage.defaultCapUnits)
        return VoucherLink.planImport(wallet: w, vouchers: vouchers, keys: knownVoucherKeys)
    }

    /// Adds a link's planned vouchers. The sealed copy on this device is written first, so this works offline; the
    /// synced copy follows now if `.com` answers, else at the next refresh. A spend still goes later, through the trickle.
    @discardableResult
    public func addFromLink(_ plan: VoucherLink.ImportPlan) async -> Bool {
        guard canSpend, plan.outcome == .add, !plan.add.isEmpty, let umk = context.umk() else { return false }
        let key = VoucherWalletSync.deriveKey(umk: umk)
        let base = wallet ?? localCopy(key: key) ?? .empty(overageCapUnits: config.overage.defaultCapUnits)
        let next = VoucherWalletSync.add(base, plan.add)
        wallet = next
        storeLocal(next, key: key)
        defaults.set(true, forKey: unsyncedKey)
        if await save(next) { defaults.removeObject(forKey: unsyncedKey) }
        return true
    }

    // MARK: the gym's free test vouchers

    /// Only when `.com` offers them (the gym): `count` vouchers made here, signed blind, unblinded and kept.
    @discardableResult
    public func addTestVouchers(_ count: Int = 30) async -> Bool {
        guard canSpend, let info, info.testIssue, let key = info.issuingKey, let w = wallet else { return false }
        do {
            let reqs = try (0..<count).map { _ in try Vouchers.newRequest(key: key) }
            let sigs = try await client.testIssue(keyId: key.keyId, blinded: reqs.map(\.blinded))
            guard sigs.count == reqs.count else { lastError = "malformed"; return false }
            let vs = try zip(reqs, sigs).map { try Vouchers.finalize(key: key, pending: $0.pending, blindSig: $1) }
            return await save(VoucherWalletSync.add(w, vs))
        } catch let e as PaymentsComError {
            lastError = e.code
        } catch {
            lastError = "malformed"
        }
        return false
    }
}

/// The one privacy line under the plan (the same sentences on every app).
public enum SpendPrivacy: Equatable, Sendable {
    /// The relay is failing and spends wait.
    case relayWaiting
    /// The last spend went straight to Flagship because the relay failed.
    case wentDirect
    case thirdPartyRelay(operator: String)
    case interimRelay
    case noRelay
}
