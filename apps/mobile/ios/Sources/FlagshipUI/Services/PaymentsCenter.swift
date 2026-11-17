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
    public static let shared = PaymentsCenter()

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
    /// The engine's clock (tests move it).
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    @ObservationIgnored private var engine: VoucherWalletEngine?
    @ObservationIgnored private var username = ""
    @ObservationIgnored private var contextProvider: (String) -> VoucherWalletEngine.Context
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored public var random: (() -> Double)?

    public init(defaults: UserDefaults = .standard, context: ((String) -> VoucherWalletEngine.Context)? = nil) {
        self.defaults = defaults
        self.contextProvider = context ?? { u in Self.keystoreContext(username: u) }
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
