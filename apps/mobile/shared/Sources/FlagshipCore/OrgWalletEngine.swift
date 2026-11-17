import Foundation

/// An org admin's side of the Business plan (docs/plans-and-backup-offer.md §3, §6): it reads the org's plan, opens the
/// org's voucher wallet with the ring's `wallet` key, keeps it synced (compare-and-set, merged on a conflict, every
/// write approved by this org admin), and spends a voucher at a time ahead of need (`OrgPlan.trickleStep`).
///
/// Every seat reads the plan; only an org admin holding the wallet key sees the balance or spends. A spend sends the
/// vouchers alone, through the private relays, so `.com` can't tie it to a device. Background work never prompts:
/// without the key or a signer it simply waits.
@MainActor
public final class OrgWalletEngine {
    public struct Context {
        public var orgId: String
        public var isOrgAdmin: Bool
        /// Every `wallet` ring key this seat can open, by ring version (empty: none yet, or the session is locked).
        public var ringKeys: () -> [Int64: [UInt8]]
        /// This seat's admin key can sign now (the session is unlocked), without prompting.
        public var canApprove: () -> Bool
        /// One org admin's approval (`flagship/org-approval/v1`, wire form) over `order`; nil while locked.
        public var approve: ([UInt8]) -> JSONValue?
        public init(orgId: String, isOrgAdmin: Bool, ringKeys: @escaping () -> [Int64: [UInt8]], canApprove: @escaping () -> Bool,
                    approve: @escaping ([UInt8]) -> JSONValue?) {
            self.orgId = orgId; self.isOrgAdmin = isOrgAdmin; self.ringKeys = ringKeys; self.canApprove = canApprove; self.approve = approve
        }
    }

    public let client: any OrgPaymentsComClient
    public var context: Context
    public private(set) var info: PaymentsInfo?
    public private(set) var plan: OrgPlanServed?
    public private(set) var wallet: OrgVoucherWallet?
    /// The last refusal or failure code, for the screen to explain.
    public private(set) var lastError: String?
    /// The stored wallet is sealed under an older ring version: its vouchers are exchanged before it is sealed again.
    public private(set) var needsRekey = false
    private var version: Int64 = 0
    private var storedKeyVersion: Int64 = 0
    private let defaults: UserDefaults
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    public var random: () -> Double = VoucherWalletEngine.secureRandom

    public init(client: any OrgPaymentsComClient, context: Context, defaults: UserDefaults = .standard) {
        self.client = client
        self.context = context
        self.defaults = defaults
    }

    /// The config with `.com`'s served Business prices.
    public var config: PaymentsConfig { plan.map { $0.config(info?.config ?? .defaults) } ?? info?.config ?? .defaults }
    public var balance: Int { wallet?.balance ?? 0 }
    private var newest: (version: Int64, key: [UInt8])? {
        let keys = context.ringKeys()
        guard let v = keys.keys.max(), let k = keys[v] else { return nil }
        return (v, k)
    }
    public var hasKey: Bool { context.isOrgAdmin && newest != nil }
    public var canSpend: Bool { hasKey && context.canApprove() }
    /// The fewest seats the wallet may pay for: the plan's minimum, or more when more people already hold seats.
    public var minSeats: Int64 { max(config.business.minSeats, plan?.liveSeats ?? 0) }

    private var orgId: String { context.orgId }
    private var nextKey: String { "flagship.payments.org.nextSpendAt.\(orgId)" }

    var nextSpendAt: Int64 {
        get { Int64(defaults.double(forKey: nextKey)) }
        set { defaults.set(Double(newValue), forKey: nextKey) }
    }

    private func walletKey(_ ringVersion: Int64) -> [UInt8]? {
        context.ringKeys()[ringVersion].flatMap { try? OrgWalletSync.deriveKey(ringKey: $0, orgId: orgId) }
    }

    // MARK: reading

    /// The numbers, the org's plan and, for an org admin with the key, the wallet.
    public func refresh() async {
        lastError = nil
        do {
            info = try await client.paymentsInfo()
            plan = try await client.orgPlan(orgId: orgId)
        } catch let e as PaymentsComError {
            lastError = e.code
        } catch {
            lastError = "network"
        }
        await loadWallet()
    }

    private func loadWallet() async {
        guard hasKey else { return }
        do {
            let blob = try await client.orgWallet(orgId: orgId)
            adopt(blob)
        } catch let e as PaymentsComError {
            lastError = e.code
        } catch {
            lastError = "network"
        }
    }

    /// Takes the stored blob: its version for the next write, its vouchers merged into what this phone holds.
    private func adopt(_ blob: JSONValue?) {
        guard let blob, let s = OrgWalletSync.parseSealed(blob) else {
            if wallet == nil { wallet = .empty(seats: minSeats, overageCapUnits: config.overage.defaultCapUnits) }
            return
        }
        version = s.version
        storedKeyVersion = s.keyVersion
        guard let key = walletKey(s.keyVersion), let remote = OrgWalletSync.open(key: key, orgId: orgId, sealed: s) else {
            lastError = "wallet-unreadable"
            return
        }
        wallet = wallet.map { OrgWalletSync.merge(local: $0, remote: remote) } ?? remote
        needsRekey = (newest?.version ?? 0) > s.keyVersion
    }

    // MARK: writing

    /// Seal under the newest ring key and store with compare-and-set; on a conflict merge the stored one and retry.
    @discardableResult
    public func save(_ w: OrgVoucherWallet) async -> Bool {
        guard let (kv, ring) = newest, let key = try? OrgWalletSync.deriveKey(ringKey: ring, orgId: orgId) else { lastError = "locked"; return false }
        var mine = w
        wallet = mine
        for _ in 0..<4 {
            do {
                let blob = try OrgWalletSync.seal(key: key, orgId: orgId, keyVersion: kv, version: version + 1, wallet: mine)
                let write = OrgWalletSync.writeFor(orgId: orgId, blob: blob, issuedAt: now())
                guard let approval = context.approve(try OrgWalletSync.canonicalWrite(write)) else { lastError = "locked"; return false }
                try await client.putOrgWallet(orgId: orgId, blob: blob, write: write, approval: approval)
                version = blob.version
                storedKeyVersion = kv
                needsRekey = false
                wallet = mine
                return true
            } catch let e as PaymentsComError where e.code == "version-conflict" {
                guard let s = OrgWalletSync.parseSealed(e.stored) else { lastError = e.code; return false }
                version = s.version
                if let k = walletKey(s.keyVersion), let remote = OrgWalletSync.open(key: k, orgId: orgId, sealed: s) {
                    mine = OrgWalletSync.merge(local: mine, remote: remote)
                }
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

    @discardableResult
    public func updateSettings(_ change: (inout OrgWalletSettings) -> Void) async -> Bool {
        guard var w = wallet, canSpend else { return false }
        var s = w.settings
        change(&s)
        s.updatedAt = max(now(), w.settings.updatedAt + 1)
        w.settings = s
        return await save(w)
    }

    /// The seat count the wallet pays for, kept inside the served range and never below the live seats.
    @discardableResult
    public func setSeats(_ seats: Int64) async -> Bool {
        let n = min(config.business.maxSeats, max(minSeats, seats))
        let ok = await updateSettings { $0.seats = n }
        if ok { await tick(interactive: true) }
        return ok
    }

    @discardableResult
    public func setAutoPay(_ on: Bool) async -> Bool {
        let ok = await updateSettings { $0.autoPay = on }
        if ok, on { await tick() }
        return ok
    }

    /// Vouchers a store rail just signed, into the org wallet. True only once `.com` holds the sealed wallet with them.
    @discardableResult
    public func addBought(_ vouchers: [Voucher]) async -> Bool {
        guard canSpend, !vouchers.isEmpty else { return false }
        if wallet == nil { await loadWallet() }
        guard let w = wallet else { return false }
        return await save(OrgWalletSync.add(w, vouchers))
    }

    // MARK: spending

    private func route(_ kind: PrivateSpendKind) -> SpendRoute {
        let covered = plan?.coveredUntil ?? 0
        let lapse: Int64? = covered > 0 ? covered + config.graceHours * 3_600_000 - now() : nil
        return SpendRoute(config: info?.ohttp ?? .empty) { _ in OhttpPrivacy.spendMayGoDirect(kind, lapseInMs: lapse) }
    }

    /// One round of the org trickle. `interactive`: an admin just changed something and waits.
    public func tick(interactive: Bool = false) async {
        if needsRekey { await rekey() }
        guard canSpend, info != nil, let p = plan, let w = wallet, w.settings.autoPay else { return }
        let cfg = config
        let seats = max(minSeats, w.settings.seats)
        let step = OrgPlan.trickleStep(cfg, .init(now: now(), enabled: true, balance: Int64(w.balance), terms: p.terms, seats: seats,
                                                  nextSpendAt: nextSpendAt), rand: random())
        nextSpendAt = step.nextSpendAt
        if step.spend > 0 { await spend(Int(step.spend), seats: seats, kind: interactive ? .interactive : .trickle, retry: true) }
    }

    private func spend(_ n: Int, seats: Int64, kind: PrivateSpendKind, retry: Bool) async {
        guard var w = wallet else { return }
        let vs = OrgWalletSync.take(w, n)
        guard !vs.isEmpty else { return }
        do {
            let r = try await client.redeemOrg(orgId: orgId, for: "business", seats: seats, vouchers: vs, route: route(kind))
            w = OrgWalletSync.markSpent(w, vs.map(Vouchers.nullifier))
            if var p = plan {
                if let end = r.paidUntil { p.paidUntil = end; p.coveredUntil = max(p.trialEndsAt, end) }
                if let s = r.seats { p.paidSeats = s }
                if let st = r.status { p.status = st }
                plan = p
            }
            await save(w)
        } catch is RelayUnavailableError {
            return
        } catch let e as PaymentsComError {
            switch e.code {
            case "voucher-spent":
                await save(OrgWalletSync.markSpent(w, e.spent))
                if retry { await spend(n, seats: seats, kind: kind, retry: false) }
            case "bad-voucher":
                if let nf = e.nullifier { await save(OrgWalletSync.markSpent(w, [nf])) }
            case "plan-paid-ahead":
                break
            default:
                lastError = e.code
            }
        } catch {
            lastError = "network"
        }
    }

    // MARK: after a `wallet` key rotation

    /// Vouchers are bearer tokens: an admin who left could have copied the unspent ones. Every voucher the old key
    /// could read is exchanged for a fresh one, then the wallet is sealed under the newest key.
    @discardableResult
    public func rekey() async -> Bool {
        guard canSpend, let start = wallet, let key = info?.issuingKey else { return false }
        let per = max(1, Int(config.maxPerRequest))
        var old = start.vouchers
        while !old.isEmpty {
            guard var w = wallet else { return false }
            let chunk = Array(old.prefix(per))
            old.removeFirst(chunk.count)
            do {
                let reqs = try chunk.map { _ in try Vouchers.newRequest(key: key) }
                let r = try await client.exchange(keyId: key.keyId, vouchers: chunk, blinded: reqs.map(\.blinded), route: route(.interactive))
                guard r.sigs.count == reqs.count else { lastError = "malformed"; return false }
                let fresh = try zip(reqs, r.sigs).map { try Vouchers.finalize(key: key, pending: $0.pending, blindSig: $1) }
                w = OrgWalletSync.add(OrgWalletSync.markSpent(w, chunk.map(Vouchers.nullifier)), fresh)
            } catch let e as PaymentsComError where e.code == "voucher-spent" && !e.spent.isEmpty {
                w = OrgWalletSync.markSpent(w, e.spent)
                let rest = chunk.filter { !e.spent.contains(Vouchers.nullifier($0)) }
                guard rest.count < chunk.count else { lastError = e.code; return false }
                old += rest
            } catch let e as PaymentsComError {
                lastError = e.code
                return false
            } catch {
                lastError = "network"
                return false
            }
            // Saved after every exchange: the old vouchers are spent, so the fresh ones must not live only in memory.
            guard await save(w) else { return false }
        }
        if needsRekey, let w = wallet { return await save(w) }
        return true
    }
}
