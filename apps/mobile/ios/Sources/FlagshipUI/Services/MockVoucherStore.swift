#if DEBUG
import Foundation
import FlagshipCore

/// The mock gym's and the unit tests' stand-in for StoreKit: packs priced at their voucher count in dollars, purchases
/// that succeed at once with an unsigned JWS (`MockPaymentsComClient.fakeJws`), and a record of what was finished.
public final class MockVoucherStore: VoucherStoreSource, @unchecked Sendable {
    private let lock = NSLock()
    private var next = 1000
    private var open: [String: ShopTransaction] = [:]
    private var continuation: AsyncStream<ShopTransaction>.Continuation?
    public private(set) var finished: [String] = []
    /// Every purchase call, in order (product ids).
    public private(set) var purchases: [String] = []
    /// What the next purchase answers instead of buying.
    public var nextOutcome: String?
    /// Called when a transaction is finished (tests check the order of events).
    public var onFinish: ((String) -> Void)?

    public init() {}

    private func locked<T>(_ f: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return f() }

    public func products(_ ids: [String]) async throws -> [ShopProduct] {
        ids.compactMap { id in
            VoucherProducts.units(productId: id).map { ShopProduct(id: id, displayPrice: Decimal($0).formatted(.currency(code: "USD"))) }
        }
    }

    /// A transaction of ours the store holds unfinished (a purchase made before a crash, or approved later).
    @discardableResult
    public func add(productId: String, quantity: Int = 1, verified: Bool = true, revoked: Bool = false) -> ShopTransaction {
        let t: ShopTransaction = locked {
            next += 1
            let id = String(next)
            let t = ShopTransaction(id: id, productId: productId, quantity: quantity,
                                    jws: MockPaymentsComClient.fakeJws(transactionId: id, productId: productId, quantity: quantity),
                                    verified: verified, revoked: revoked, finish: { [weak self] in self?.finish(id) })
            open[id] = t
            return t
        }
        return t
    }

    /// Deliver a transaction through `updates`.
    public func push(_ t: ShopTransaction) { _ = locked { continuation?.yield(t) } }

    private func finish(_ id: String) {
        let cb: ((String) -> Void)? = locked {
            open[id] = nil
            finished.append(id)
            return onFinish
        }
        cb?(id)
    }

    public func isOpen(_ id: String) -> Bool { locked { open[id] != nil } }

    public func purchase(_ productId: String) async throws -> ShopPurchaseOutcome {
        let outcome: String? = locked {
            purchases.append(productId)
            defer { nextOutcome = nil }
            return nextOutcome
        }
        switch outcome {
        case "cancelled": return .cancelled
        case "pending": return .pending
        case "failed": throw CancellationError()
        default: return .purchased(add(productId: productId))
        }
    }

    public func unfinished() async -> [ShopTransaction] { locked { open.values.sorted { $0.id < $1.id } } }

    public func updates() -> AsyncStream<ShopTransaction> {
        AsyncStream { cont in locked { continuation = cont } }
    }
}
#endif
