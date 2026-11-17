import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings → Plan (docs/payments-privacy-and-rails.md "As built"): the plan and its time left, the balance in round
/// dollars, the plan choice, auto-pay with an optional random start, the monthly limit for extra traffic, and the
/// packs on sale through the App Store (in-app purchase only: no other way to buy is named here). The phone holds the balance and pays a little at a time, ahead of need.
///
/// App Store 3.1.1: no code field, QR scan or file import for vouchers here, ever.
public struct PlanScreen: View {
    @State private var center: PaymentsCenter
    @State private var delayStart = false
    @State private var error: String?
    private let gate: (String) async -> Bool

    /// `gate` asks for Face ID (or the device passcode) before a spend the owner starts; true to go ahead.
    public init(center: PaymentsCenter = .shared, gate: @escaping (String) async -> Bool) {
        _center = State(initialValue: center)
        self.gate = gate
    }

    private var cfg: PaymentsConfig { center.config }
    private var now: Int64 { center.now() }

    public var body: some View {
        List {
            statusSection
            if center.isAdmin && center.hasKey {
                chooseSection
                autoPaySection
                overageSection
            } else {
                Section {
                    Group {
                        if center.isAdmin {
                            Text("Unlock Flagship to see and change your plan.")
                        } else {
                            Text("Only an admin device of this account can change the plan or spend the balance.")
                        }
                    }
                    .accessibilityIdentifier("plan-read-only")
                }
            }
            buySection
            if let error {
                Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("plan-error") }
            }
        }
        .navigationTitle("Plan")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await center.refreshAndTick() }
        .task {
            await center.refreshAndTick()
            delayStart = center.wallet?.settings.delayStart ?? false
            show(center.lastError)
        }
        .overlay { if center.isLoading && center.info == nil { ProgressView() } }
    }

    private func show(_ code: String?) { error = code.map(PlanDisplay.error) }

    // MARK: sections

    private var statusSection: some View {
        Section {
            LabeledContent("Plan", value: PlanDisplay.planName(center.planState.plan))
                .accessibilityIdentifier("plan-current")
            if let days = PlanDisplay.daysLeft(center.planState, now: now) {
                LabeledContent("Paid until", value: Self.date(center.planState.paidUntil))
                    .accessibilityIdentifier("plan-paid-until")
                LabeledContent("Days left", value: "\(days)")
            }
            if center.hasKey {
                LabeledContent("Balance", value: PlanDisplay.dollars(center.balanceUnits, cfg))
                    .accessibilityIdentifier("plan-balance")
                if let plan = center.chosenPlan ?? center.planState.plan {
                    let months = VoucherSpending.monthsOfPlan(cfg, plan: plan, balance: center.balanceUnits)
                    Text("Months of \(PlanDisplay.planName(plan)) your balance pays for: \(months)")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("plan-months")
                }
                if let w = center.wallet, w.settings.plan != nil, w.settings.startAt > now {
                    Text("Starts by \(Self.dateTime(w.settings.startAt)).")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("plan-starts-by")
                }
                if center.chosenPlan != nil, center.balanceUnits == 0 {
                    Text("Your balance is empty, so your plan isn't renewed. Your servers keep working on Free.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("Your phone pays a little at a time, a few days ahead of need. A payment can't be linked to the purchase that paid for it.")
        }
    }

    private var chooseSection: some View {
        Section {
            planRow(nil, price: PlanDisplay.dollars(0, cfg), detail: String(localized: "25 GB of traffic a month, then slowed"))
            planRow(.pro, price: PlanDisplay.dollars(cfg.pro.unitsPerMonth, cfg),
                    detail: String(localized: "\(cfg.pro.includedGb) GB of traffic a month"))
            planRow(.proMax, price: PlanDisplay.dollars(cfg.proMax.unitsPerMonth, cfg),
                    detail: String(localized: "\(cfg.proMax.includedGb) GB of traffic a month"))
            Toggle(isOn: $delayStart) {
                Text("Start at a random time in the next \(cfg.activationDelayMaxHours) hours")
            }
            .accessibilityIdentifier("plan-delay-start")
        } header: {
            Text("Choose a plan")
        } footer: {
            Text("Starting at a random time makes it harder to tell that a purchase and an upgrade belong together.")
        }
    }

    private func planRow(_ plan: PaidPlan?, price: String, detail: String) -> some View {
        let selected = center.chosenPlan == plan
        return Button {
            Task { await choose(plan) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(PlanDisplay.planName(plan)).foregroundStyle(.primary)
                    Text(detail).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                Text(plan == nil ? price : String(localized: "\(price) a month")).foregroundStyle(.secondary)
                if selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .disabled(center.isWorking || selected)
        .accessibilityIdentifier("plan-choose-\(plan?.rawValue ?? "free")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func choose(_ plan: PaidPlan?) async {
        error = nil
        if center.needsBiometric(choosing: plan, delayStart: delayStart) {
            guard await gate(String(localized: "Start paying for your plan")) else { return }
        }
        let ok = await center.choosePlan(plan, delayStart: delayStart)
        if !ok { show(center.lastError ?? "failed") } else { show(center.lastError) }
    }

    private var autoPaySection: some View {
        Section {
            Toggle(isOn: Binding(get: { center.wallet?.settings.autoPay ?? true }, set: { on in
                Task { if !(await center.setAutoPay(on)) { show(center.lastError ?? "failed") } }
            })) {
                Text("Pay automatically")
            }
            .accessibilityIdentifier("plan-auto-pay")
        } footer: {
            Text("Off: nothing is spent and your plan ends when its paid time runs out.")
        }
    }

    private var overageSection: some View {
        let choices = PlanDisplay.capChoices(cfg)
        let cap = center.wallet?.settings.overageCapUnits ?? cfg.overage.defaultCapUnits
        let idx = choices.firstIndex(of: cap) ?? 0
        return Section {
            Stepper(value: Binding(get: { idx }, set: { i in
                let units = choices[max(0, min(choices.count - 1, i))]
                Task { if !(await center.setOverageCap(units)) { show(center.lastError ?? "failed") } }
            }), in: 0...max(0, choices.count - 1)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Monthly limit: \(PlanDisplay.dollars(cap, cfg))")
                    Text("Up to \(PlanDisplay.capGb(cap, cfg)) GB more traffic").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("plan-overage-cap")
            .disabled(center.isWorking)
            if let w = center.wallet, w.overage.period == VoucherSpending.overagePeriod(now), w.overage.units > 0 {
                Text("Spent on extra traffic this month: \(PlanDisplay.dollars(w.overage.units, cfg))")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Extra traffic")
        } footer: {
            Text("Past your plan's traffic, your phone buys \(cfg.overage.blockGb) GB for \(PlanDisplay.dollars(cfg.overage.blockUnits, cfg)) at a time, up to this limit. Past it your servers are slowed, never cut off.")
        }
    }

    private var buySection: some View {
        let shop = center.shop
        let packs = center.canSpend ? (shop?.products ?? []) : []
        return Section {
            ForEach(packs) { pack in
                Button {
                    Task { await center.buy(units: pack.units) }
                } label: {
                    HStack {
                        Text(PlanDisplay.dollars(pack.units, cfg)).foregroundStyle(.primary)
                        Spacer()
                        if shop?.phase == VoucherShop.Phase.buying(pack.units) {
                            ProgressView()
                        } else {
                            Text(pack.product.displayPrice).foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(center.isWorking || shop?.phase != VoucherShop.Phase.idle)
                .accessibilityIdentifier("plan-pack-\(pack.units)")
            }
            if shop?.phase == VoucherShop.Phase.delivering {
                HStack {
                    ProgressView()
                    Text("Adding your purchase to your balance…").foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("plan-shop-delivering")
            }
            if let o = shop?.outcome {
                Text(PlanDisplay.shopOutcome(o.code, units: o.units, cfg))
                    .foregroundStyle(o.code == "added" || o.code == "purchase-pending" ? Color.secondary : Color.red)
                    .accessibilityIdentifier(o.code == "added" ? "plan-shop-added" : "plan-shop-error")
            }
            if center.info?.testIssue == true, center.canSpend {
                Button("Add $30 of test credit") {
                    Task { if !(await center.addTestVouchers()) { show(center.lastError ?? "failed") } }
                }
                .disabled(center.isWorking)
                .accessibilityIdentifier("plan-add-test")
            }
        } header: {
            Text("Add to your balance")
        } footer: {
            if packs.isEmpty {
                Text("Buying isn't available here yet.")
            } else {
                Text("Paid through the App Store.")
            }
        }
    }

    static func date(_ ms: Int64) -> String { Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .omitted) }
    static func dateTime(_ ms: Int64) -> String { Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened) }
}
