import Foundation
import Observation
import StoreKit
import Flagship
import FlagshipAPI
import FlagshipCore

// The in-app voucher shop (docs/payments-privacy-and-rails.md §11, "Apple"): StoreKit 2 consumables that buy $1 blind
// vouchers. A purchase buys the right to N blind signatures, never an account link: no `appAccountToken` and no other
// purchase option names the account. The phone makes the N requests, keeps them in the Keychain under the transaction
// id, asks `.com` to sign (the JWS is the only proof), unblinds, saves the wallet, and only then finishes the
// transaction. Anything that fails before the save leaves the transaction unfinished, to be resumed later with the
// same requests.

/// One store transaction, as the shop needs it.
public struct ShopTransaction: Sendable {
    public var id: String
    public var productId: String
    public var quantity: Int
    /// The signed transaction (`VerificationResult.jwsRepresentation`), the proof `.com` checks.
    public var jws: String
    /// StoreKit verified the signature on the device.
    public var verified: Bool
    /// Apple refunded or revoked it.
    public var revoked: Bool
    public var finish: @Sendable () async -> Void

    public init(id: String, productId: String, quantity: Int, jws: String, verified: Bool, revoked: Bool = false,
                finish: @escaping @Sendable () async -> Void) {
        self.id = id; self.productId = productId; self.quantity = quantity; self.jws = jws; self.verified = verified
        self.revoked = revoked; self.finish = finish
    }
}

/// A pack as the store sells it, with the store's own price text.
public struct ShopProduct: Equatable, Sendable {
    public var id: String
    public var displayPrice: String
    public init(id: String, displayPrice: String) { self.id = id; self.displayPrice = displayPrice }
}

public enum ShopPurchaseOutcome: Sendable {
    case purchased(ShopTransaction)
    /// Ask to Buy or a payment the store is still checking: it arrives later through `updates`.
    case pending
    case cancelled
}

/// Where purchases come from: StoreKit in the app, a fake in tests and the mock gym.
public protocol VoucherStoreSource: Sendable {
    func products(_ ids: [String]) async throws -> [ShopProduct]
    func purchase(_ productId: String) async throws -> ShopPurchaseOutcome
    /// Our consumables not finished yet.
    func unfinished() async -> [ShopTransaction]
    /// Transactions that arrive outside a purchase call (Ask to Buy approved, a purchase interrupted earlier).
    func updates() -> AsyncStream<ShopTransaction>
}

/// StoreKit 2.
public final class StoreKitVoucherStore: VoucherStoreSource, @unchecked Sendable {
    private let lock = NSLock()
    private var cache: [String: Product] = [:]

    public init() {}

    public func products(_ ids: [String]) async throws -> [ShopProduct] {
        let found = try await Product.products(for: ids).filter { $0.type == .consumable }
        lock.lock(); for p in found { cache[p.id] = p }; lock.unlock()
        return found.map { ShopProduct(id: $0.id, displayPrice: $0.displayPrice) }
    }

    public func purchase(_ productId: String) async throws -> ShopPurchaseOutcome {
        lock.lock(); let cached = cache[productId]; lock.unlock()
        let found: Product?
        if let cached { found = cached } else { found = try await Product.products(for: [productId]).first }
        guard let product = found else { throw StoreKitError.notAvailableInStorefront }
        // No purchase options: an appAccountToken (or any other option) would tie the payment to the account.
        switch try await product.purchase() {
        case .success(let result): return .purchased(Self.wrap(result))
        case .pending: return .pending
        case .userCancelled: return .cancelled
        @unknown default: return .cancelled
        }
    }

    static func wrap(_ result: VerificationResult<Transaction>) -> ShopTransaction {
        let t: Transaction, verified: Bool
        switch result {
        case .verified(let x): t = x; verified = true
        case .unverified(let x, _): t = x; verified = false
        }
        return ShopTransaction(id: String(t.id), productId: t.productID, quantity: t.purchasedQuantity, jws: result.jwsRepresentation,
                               verified: verified, revoked: t.revocationDate != nil, finish: { await t.finish() })
    }

    static func ours(_ result: VerificationResult<Transaction>) -> Bool {
        let t = result.unsafePayloadValue
        return t.productType == .consumable && VoucherProducts.units(productId: t.productID) != nil
    }

    public func unfinished() async -> [ShopTransaction] {
        var out: [ShopTransaction] = []
        for await result in Transaction.unfinished where Self.ours(result) { out.append(Self.wrap(result)) }
        return out
    }

    public func updates() -> AsyncStream<ShopTransaction> {
        AsyncStream { cont in
            let task = Task {
                for await result in Transaction.updates where Self.ours(result) { cont.yield(Self.wrap(result)) }
                cont.finish()
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}

/// One blind request kept until its signature is back: the secret half and what was sent.
public struct ShopPendingRequest: Codable, Equatable, Sendable {
    public var pending: PendingVoucher
    public var blinded: String
    public init(pending: PendingVoucher, blinded: String) { self.pending = pending; self.blinded = blinded }
}

/// This device's store purchases, units and day only (the per-device cap).
public struct ShopPurchaseRecord: Codable, Equatable, Sendable {
    public var units: Int64
    public var day: Int64
    public init(units: Int64, day: Int64) { self.units = units; self.day = day }
}

/// Where the shop keeps requests in flight and the purchase log.
public protocol ShopVault: AnyObject {
    func pending(_ transactionId: String) -> [ShopPendingRequest]?
    func setPending(_ transactionId: String, _ requests: [ShopPendingRequest]?)
    func purchases() -> [ShopPurchaseRecord]
    func setPurchases(_ records: [ShopPurchaseRecord])
}

/// The Keychain, device-local: kept across a reinstall, never synced, no account name in it.
public final class KeychainShopVault: ShopVault {
    public init() {}

    private static func slot(_ tx: String) -> String { "pending.\(tx.filter { $0.isASCII && ($0.isLetter || $0.isNumber) })" }

    public func pending(_ transactionId: String) -> [ShopPendingRequest]? {
        Keystore.shopItem(Self.slot(transactionId)).flatMap { try? JSONDecoder().decode([ShopPendingRequest].self, from: $0) }
    }

    public func setPending(_ transactionId: String, _ requests: [ShopPendingRequest]?) {
        Keystore.setShopItem(Self.slot(transactionId), requests.flatMap { try? JSONEncoder().encode($0) })
    }

    public func purchases() -> [ShopPurchaseRecord] {
        Keystore.shopItem("purchases").flatMap { try? JSONDecoder().decode([ShopPurchaseRecord].self, from: $0) } ?? []
    }

    public func setPurchases(_ records: [ShopPurchaseRecord]) {
        Keystore.setShopItem("purchases", records.isEmpty ? nil : try? JSONEncoder().encode(records))
    }
}

/// Tests and the mock gym.
public final class MemoryShopVault: ShopVault {
    public var pendingByTransaction: [String: [ShopPendingRequest]] = [:]
    public var records: [ShopPurchaseRecord] = []
    public init() {}
    public func pending(_ transactionId: String) -> [ShopPendingRequest]? { pendingByTransaction[transactionId] }
    public func setPending(_ transactionId: String, _ requests: [ShopPendingRequest]?) { pendingByTransaction[transactionId] = requests }
    public func purchases() -> [ShopPurchaseRecord] { records }
    public func setPurchases(_ records: [ShopPurchaseRecord]) { self.records = records }
}

/// A pack on sale: its voucher count and the store's product.
public struct ShopPack: Equatable, Sendable, Identifiable {
    public var units: Int64
    public var product: ShopProduct
    public var id: Int64 { units }
}

@MainActor
@Observable
public final class VoucherShop {
    public enum Phase: Equatable { case idle, buying(Int64), delivering }

    /// Packs on sale (`rails.apple` and StoreKit returned them), smallest first.
    public private(set) var products: [ShopPack] = []
    public private(set) var phase: Phase = .idle
    /// The last outcome: a success or waiting sentence's code, or a refusal code, with the units it concerns.
    public private(set) var outcome: (code: String, units: Int64)?

    /// The most store vouchers one device buys in `capWindowMs` (docs §11 "Refunds without an account").
    nonisolated public static let capUnits: Int64 = 240
    nonisolated public static let capWindowMs: Int64 = 30 * 86_400_000

    @ObservationIgnored public let store: any VoucherStoreSource
    @ObservationIgnored let vault: any ShopVault
    @ObservationIgnored private let engine: () -> VoucherWalletEngine?
    @ObservationIgnored public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    @ObservationIgnored public var onChange: (() -> Void)?
    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private var listener: Task<Void, Never>?

    public init(store: any VoucherStoreSource, vault: any ShopVault, engine: @escaping () -> VoucherWalletEngine?) {
        self.store = store
        self.vault = vault
        self.engine = engine
    }

    // MARK: products

    /// The packs StoreKit sells, when `.com` says the Apple rail is on.
    public func loadProducts(_ info: PaymentsInfo?) async {
        guard let info, info.rails.apple else { products = []; return }
        let wanted = info.products.sorted { $0.units < $1.units }
        guard let found = try? await store.products(wanted.map(\.productId)) else { products = []; return }
        products = wanted.compactMap { w in found.first(where: { $0.id == w.productId }).map { ShopPack(units: w.units, product: $0) } }
    }

    // MARK: the per-device cap

    private func recentPurchases() -> [ShopPurchaseRecord] {
        let since = now() - Self.capWindowMs
        return vault.purchases().filter { $0.day >= since - 86_400_000 }
    }

    /// Store vouchers this device bought in the last 30 days.
    public var boughtRecently: Int64 { recentPurchases().reduce(0) { $0 + $1.units } }

    public func wouldPassCap(_ units: Int64) -> Bool { boughtRecently + units > Self.capUnits }

    private func log(_ units: Int64) {
        let day = (now() / 86_400_000) * 86_400_000
        vault.setPurchases(recentPurchases() + [ShopPurchaseRecord(units: units, day: day)])
    }

    // MARK: buying

    private func done(_ code: String, _ units: Int64) -> Bool {
        outcome = (code, units)
        onChange?()
        return code == "added"
    }

    public func clearOutcome() { outcome = nil }

    /// Buy a pack and add its vouchers to the wallet. Admin devices only. With `orgId` the vouchers go into that org's
    /// wallet instead (this phone must be an org admin holding the org's wallet key).
    @discardableResult
    public func buy(units: Int64, orgId: String? = nil) async -> Bool {
        outcome = nil
        guard phase == .idle else { return false }
        let info: PaymentsInfo?
        if let orgId {
            guard let o = OrgVoucherSinks.engine(orgId), o.canSpend else { return done("no-device-key", units) }
            info = o.info
        } else {
            guard let e = engine(), e.canSpend else { return done("no-device-key", units) }
            info = e.info
        }
        guard let product = products.first(where: { $0.units == units })?.product else { return done("rail-off", units) }
        guard !wouldPassCap(units) else { return done("device-cap", units) }
        guard info?.issuingKey != nil else { return done("no-key", units) }
        phase = .buying(units)
        let result: ShopPurchaseOutcome
        do {
            result = try await store.purchase(product.id)
        } catch {
            phase = .idle
            return done("store-failed", units)
        }
        switch result {
        case .cancelled:
            phase = .idle
            return false
        case .pending:
            log(units)
            phase = .idle
            return done("purchase-pending", units)
        case .purchased(let t):
            log(units * Int64(max(1, t.quantity)))
            if let orgId { setOrgDestination(t.id, orgId) }
            phase = .idle
            return await deliver(t)
        }
    }

    // MARK: org destinations

    @ObservationIgnored public var destinations: UserDefaults = .standard

    private static func destinationKey(_ tx: String) -> String { "flagship.shop.orgDestination.\(tx.filter { $0.isASCII && ($0.isLetter || $0.isNumber) })" }

    /// The org a purchase was bought for (nil: the account's own wallet). Kept until the purchase is finished.
    public func orgDestination(_ transactionId: String) -> String? { destinations.string(forKey: Self.destinationKey(transactionId)) }

    private func setOrgDestination(_ transactionId: String, _ orgId: String?) {
        destinations.set(orgId, forKey: Self.destinationKey(transactionId))
    }

    /// Deliver every unfinished purchase of ours (app start, Plan opened).
    public func resumeUnfinished() async {
        for t in await store.unfinished() { await deliver(t) }
    }

    /// Follow `Transaction.updates` for as long as the app runs.
    public func startListening() {
        guard listener == nil else { return }
        let stream = store.updates()
        listener = Task { [weak self] in
            for await t in stream { await self?.deliver(t) }
        }
    }

    public func stopListening() { listener?.cancel(); listener = nil }

    /// Ask `.com` to sign for one transaction, keep the vouchers, then finish it. Returns true once it is finished
    /// with the vouchers in the saved wallet.
    @discardableResult
    public func deliver(_ t: ShopTransaction) async -> Bool {
        let dest = orgDestination(t.id)
        let org = dest.flatMap { OrgVoucherSinks.engine($0) }
        let e = engine()
        guard !inFlight.contains(t.id) else { return false }
        if dest != nil {
            // Bought for an org: it waits until this phone has that org's wallet open.
            guard let org, org.canSpend else { return false }
        } else {
            guard let e, e.canSpend else { return false }
            if e.info == nil { await e.refresh() }
        }
        guard let info = dest != nil ? org?.info : e?.info, let pack = info.units(productId: t.productId) else { return false }
        let units = pack * Int64(max(1, t.quantity))
        inFlight.insert(t.id)
        defer { inFlight.remove(t.id) }
        guard t.verified else { return done("payment-unverified", units) }
        if t.revoked {
            await t.finish()
            vault.setPending(t.id, nil)
            setOrgDestination(t.id, nil)
            return done("payment-refunded", units)
        }
        phase = .delivering
        defer { phase = .idle }
        var requests = vault.pending(t.id) ?? []
        if requests.count != Int(units) || requests.contains(where: { info.key($0.pending.k) == nil || $0.pending.k != requests.first?.pending.k }) {
            guard let key = info.issuingKey else { return done("no-key", units) }
            do {
                requests = try (0..<units).map { _ in
                    let r = try Vouchers.newRequest(key: key)
                    return ShopPendingRequest(pending: r.pending, blinded: r.blinded)
                }
            } catch {
                return done("malformed", units)
            }
            vault.setPending(t.id, requests)
        }
        guard let keyId = requests.first?.pending.k, let key = info.key(keyId) else { return done("no-key", units) }
        let signed: PaidIssueResult
        do {
            let proof: JSONValue = ["jws": .string(t.jws)]
            if let org {
                signed = try await org.client.paidIssue(rail: "apple", proof: proof, keyId: keyId, blinded: requests.map(\.blinded))
            } else {
                signed = try await e!.client.paidIssue(rail: "apple", proof: proof, keyId: keyId, blinded: requests.map(\.blinded))
            }
        } catch let err as PaymentsComError {
            if err.code == "payment-refunded" {
                await t.finish()
                vault.setPending(t.id, nil)
                setOrgDestination(t.id, nil)
            }
            return done(err.code, units)
        } catch {
            return done("network", units)
        }
        guard signed.sigs.count == requests.count, signed.k.isEmpty || signed.k == keyId else { return done("malformed", units) }
        let vouchers: [Voucher]
        do {
            vouchers = try zip(requests, signed.sigs).map { try Vouchers.finalize(key: key, pending: $0.pending, blindSig: $1) }
        } catch {
            return done("malformed", units)
        }
        if let org {
            guard await org.addBought(vouchers) else { return done(org.lastError ?? "network", units) }
        } else {
            guard await e!.addBought(vouchers) else { return done(e!.lastError ?? "network", units) }
        }
        await t.finish()
        vault.setPending(t.id, nil)
        setOrgDestination(t.id, nil)
        return done("added", units)
    }
}
