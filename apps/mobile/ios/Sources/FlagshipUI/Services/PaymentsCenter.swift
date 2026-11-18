import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The app's payments state (docs/payments-privacy-and-rails.md "As built"): the voucher wallet engine for the signed-in
/// account, mirrored for SwiftUI. The app refreshes it and lets it spend when it comes to the foreground; the Plan
/// screen does the same when it opens. Spending needs this device to be an admin device with the account key at hand;
/// without it nothing is spent and nothing prompts.
@MainActor
@Observable
public final class PaymentsCenter {
    public static let shared = PaymentsCenter(store: StoreKitVoucherStore(), vault: KeychainShopVault())

    public private(set) var info: PaymentsInfo?
    public private(set) var wallet: VoucherWallet?
    public private(set) var planState: AccountPlanState = .free
    public private(set) var allowance: AccountAllowance?
    public private(set) var lastError: String?
    public private(set) var isLoading = false
    public private(set) var isWorking = false
    public private(set) var canSpend = false
    public private(set) var isAdmin = false
    public private(set) var hasKey = false
    /// The privacy line under the plan (relay, interim relay, none, or waiting on a failing relay).
    public private(set) var spendPrivacy: SpendPrivacy = .noRelay
    /// The engine's clock (tests move it).
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    @ObservationIgnored private var engine: VoucherWalletEngine?
    @ObservationIgnored private var username = ""
    @ObservationIgnored private var contextProvider: (String) -> VoucherWalletEngine.Context
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored public var random: (() -> Double)?
    /// The in-app shop (StoreKit); nil where no store is wired (unit tests of the plan alone).
    public private(set) var shop: VoucherShop?

    public init(defaults: UserDefaults = .standard, context: ((String) -> VoucherWalletEngine.Context)? = nil,
                store: (any VoucherStoreSource)? = nil, vault: (any ShopVault)? = nil) {
        self.defaults = defaults
        self.contextProvider = context ?? { u in Self.keystoreContext(username: u) }
        if let store { setShop(store: store, vault: vault ?? KeychainShopVault()) }
    }

    /// Replace the purchase source (the mock gym's stand-in for StoreKit).
    public func setShop(store: any VoucherStoreSource, vault: any ShopVault) {
        shop?.stopListening()
        let s = VoucherShop(store: store, vault: vault) { [weak self] in self?.fresh() }
        s.now = { [weak self] in self?.now() ?? Int64(Date().timeIntervalSince1970 * 1000) }
        s.onChange = { [weak self] in self?.mirror() }
        shop = s
        if engine != nil { s.startListening() }
    }

    /// Admin status, the UMK and the device signer from this session's keys (never prompts).
    static func keystoreContext(username: String) -> VoucherWalletEngine.Context {
        let deviceId = Self.deviceId
        return .init(
            username: username,
            isAdmin: Keystore.hasAdminRoot,
            umk: { Keystore.messagesUMKIfCached().map(Array.init) },
            device: {
                let key = Keystore.sessionAccountDeviceKey(accountId: username, deviceId: deviceId)
                    ?? Keystore.messagesUMKIfCached().flatMap { try? AccountMetadata.deriveAccountDeviceKey(umk: $0, accountId: username, deviceId: deviceId) }
                return key.map { MessagesStore.deviceSigner(username: username, deviceId: deviceId, key: $0) }
            }())
    }

    @ObservationIgnored static var deviceId = "device"

    /// Called when the account (or this device) is known, and again on a switch or sign-out.
    public func configure(client: any PaymentsComClient, username: String?, deviceId: String?) {
        let u = (username ?? "").lowercased()
        if let d = deviceId, !d.isEmpty { Self.deviceId = d }
        if u == self.username, engine?.client as AnyObject? === client as AnyObject? { return }
        self.username = u
        info = nil; wallet = nil; planState = .free; allowance = nil; lastError = nil
        engine = u.isEmpty ? nil : VoucherWalletEngine(client: client, context: contextProvider(u), defaults: defaults)
        if let engine {
            engine.now = { [weak self] in self?.now() ?? Int64(Date().timeIntervalSince1970 * 1000) }
            if let random { engine.random = random }
            shop?.startListening()
        }
        mirror()
    }

    private func mirror() {
        info = engine?.info
        wallet = engine?.wallet
        planState = engine?.planState ?? .free
        allowance = engine?.allowance
        lastError = engine?.lastError
        canSpend = engine?.canSpend ?? false
        isAdmin = engine?.context.isAdmin ?? false
        hasKey = engine?.context.umk() != nil
        spendPrivacy = engine?.spendPrivacy ?? .noRelay
    }

    private func fresh() -> VoucherWalletEngine? {
        guard let engine, !username.isEmpty else { return nil }
        engine.context = contextProvider(username)
        return engine
    }

    /// Read everything, then let the trickle and overage spend what is due.
    public func refreshAndTick() async {
        guard let e = fresh(), !isLoading else { return }
        isLoading = true
        await e.refresh()
        await e.tick()
        isLoading = false
        mirror()
        if let shop {
            await shop.loadProducts(info)
            await shop.resumeUnfinished()
            mirror()
        }
    }

    /// Buy a pack through the store; the vouchers land in the wallet before the purchase is finished.
    @discardableResult
    public func buy(units: Int64) async -> Bool {
        guard let shop, fresh() != nil else { return false }
        isWorking = true
        let ok = await shop.buy(units: units)
        isWorking = false
        mirror()
        return ok
    }

    private func run(_ f: (VoucherWalletEngine) async -> Bool) async -> Bool {
        guard let e = fresh() else { return false }
        isWorking = true
        let ok = await f(e)
        isWorking = false
        mirror()
        return ok
    }

    @discardableResult
    public func choosePlan(_ plan: PaidPlan?, delayStart: Bool) async -> Bool { await run { await $0.choosePlan(plan, delayStart: delayStart) } }

    @discardableResult
    public func setAutoPay(_ on: Bool) async -> Bool {
        await run { e in
            let ok = await e.updateSettings { $0.autoPay = on }
            if ok, on { await e.tick() }
            return ok
        }
    }

    @discardableResult
    public func setOverageCap(_ units: Int64) async -> Bool { await run { await $0.updateSettings { $0.overageCapUnits = max(0, units) } } }

    @discardableResult
    public func addTestVouchers() async -> Bool { await run { await $0.addTestVouchers(30) } }

    // MARK: vouchers from a link (docs/anonymous-vouchers.md "Voucher links")

    /// What an opened voucher link would do, decided on this device with no network call: the wallet copy and the
    /// voucher keys kept here. Nothing is added until `addVoucherLink`.
    /// True once an account is configured (the app does it right after an unlock).
    public var isConfigured: Bool { engine != nil }

    public func reviewVoucherLink(_ link: String) -> VoucherLink.Decision {
        let e = fresh()
        return VoucherLink.decide(link: link, signedIn: e != nil) { e?.planLinkImport($0) }
    }

    /// Adds what `reviewVoucherLink` planned. Works offline: the sealed copy on this phone is written first and synced
    /// when `.com` answers. The vouchers are spent later by the trickle, like any other.
    @discardableResult
    public func addVoucherLink(_ plan: VoucherLink.ImportPlan) async -> Bool { await run { await $0.addFromLink(plan) } }

    /// Sign-out / wipe: nothing of the wallet stays on this device.
    public func forget() {
        engine?.forgetLocal()
        engine = nil
        username = ""
        mirror()
    }

    // MARK: what the screen shows

    public var config: PaymentsConfig { info?.config ?? .defaults }
    public var balanceUnits: Int64 { Int64(wallet?.balance ?? 0) }
    public var chosenPlan: PaidPlan? { wallet?.settings.plan }
    /// Choosing a paid plan spends at once (unless delayed), so it asks for Face ID.
    public func needsBiometric(choosing plan: PaidPlan?, delayStart: Bool) -> Bool { plan != nil && !delayStart && plan != chosenPlan }
}

/// Plain display rules for the Plan screen (unit-tested).
public enum PlanDisplay {
    /// Dollars, no cents ("$30").
    public static func dollars(_ units: Int64, _ cfg: PaymentsConfig) -> String {
        Decimal(units * cfg.unitUsd).formatted(.currency(code: "USD").precision(.fractionLength(0)))
    }

    public static func planName(_ plan: PaidPlan?) -> String {
        switch plan {
        case .pro?: return String(localized: "Pro")
        case .proMax?: return String(localized: "Pro Max")
        case nil: return String(localized: "Free")
        }
    }

    /// Whole days left on the plan, nil when it is not paid.
    public static func daysLeft(_ state: AccountPlanState, now: Int64) -> Int64? {
        guard state.plan != nil, state.paidUntil > now else { return nil }
        return (state.paidUntil - now) / 86_400_000
    }

    /// The overage limits the stepper offers: 0 to the maximum in block steps.
    public static func capChoices(_ cfg: PaymentsConfig) -> [Int64] {
        let step = max(1, cfg.overage.blockUnits)
        return Array(stride(from: Int64(0), through: cfg.overage.maxCapUnits, by: Int(step)))
    }

    /// GB the cap buys.
    public static func capGb(_ units: Int64, _ cfg: PaymentsConfig) -> Int64 {
        cfg.overage.blockUnits > 0 ? (units / cfg.overage.blockUnits) * cfg.overage.blockGb : 0
    }

    /// The privacy line under the plan. Neutral words: a failing relay never breaks a payment.
    public static func privacyLine(_ p: SpendPrivacy) -> String {
        switch p {
        case .relayWaiting:
            return String(localized: "The private relay isn't answering. Payments wait and try again; your plan stays active meanwhile.")
        case .wentDirect:
            return String(localized: "The private relay wasn't answering, so the last payment went straight to Flagship.")
        case .thirdPartyRelay(let op):
            return String(localized: "Payments go through \(op)'s private relay, so Flagship doesn't see your network address when you pay.")
        case .interimRelay:
            return String(localized: "Payments go through a private relay that Flagship runs for now. It keeps your address out of the payment logs, but it isn't an independent operator yet.")
        case .noRelay:
            return String(localized: "Flagship can see your network address when you pay. It keeps none of it.")
        }
    }

    /// The sentence for what a store purchase did (`VoucherShop.outcome`), nil when there is nothing to say.
    public static func shopOutcome(_ code: String, units: Int64, _ cfg: PaymentsConfig) -> String {
        let amount = dollars(units, cfg)
        switch code {
        case "added": return String(localized: "Added \(amount) to your balance.")
        case "purchase-pending": return String(localized: "Waiting for the purchase to be approved. It's added to your balance once it is.")
        case "device-cap":
            return String(localized: "This device can buy up to \(dollars(VoucherShop.capUnits, cfg)) of credit in 30 days. Try a smaller amount or try again later.")
        case "store-failed": return String(localized: "The App Store couldn't complete the purchase. Try again.")
        case "payment-unverified": return String(localized: "The App Store couldn't verify this purchase, so nothing was added.")
        case "payment-invalid": return String(localized: "Flagship couldn't confirm this purchase with the App Store, so nothing was added. If you were charged, you can ask Apple for a refund.")
        case "payment-unpaid": return String(localized: "The App Store hasn't confirmed the payment yet. Your purchase is kept and added to your balance once it has.")
        case "payment-refunded": return String(localized: "This purchase was refunded, so nothing was added.")
        case "payment-used": return String(localized: "This purchase was already added to a balance, maybe on another device.")
        case "rail-off": return String(localized: "Buying in the app isn't available right now.")
        case "no-device-key", "forbidden": return error(code)
        // no-key, rail-unreachable, network, malformed, too-many, wrong-count: the transaction stays unfinished.
        default: return String(localized: "Couldn't add your purchase of \(amount) yet. It's kept, and Flagship adds it to your balance later.")
        }
    }

    /// The sentence for a refusal or failure code.
    public static func error(_ code: String) -> String {
        switch code {
        case "network": return String(localized: "Couldn't reach Flagship. Check your connection and try again.")
        case "issue-off": return String(localized: "Test vouchers aren't available here.")
        case "too-many": return String(localized: "That's more than one request can carry. Try again with less.")
        case "overage-needs-plan": return String(localized: "Extra traffic needs Pro or Pro Max.")
        case "no-device-key", "forbidden": return String(localized: "This device can't change the plan. Unlock Flagship on an admin device.")
        default: return String(localized: "Something went wrong. Try again.")
        }
    }
}
