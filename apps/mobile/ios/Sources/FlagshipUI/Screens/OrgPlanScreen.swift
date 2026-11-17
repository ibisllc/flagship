import SwiftUI
import Flagship
import FlagshipAPI
import FlagshipCore

/// An org's Plan (docs/plans-and-backup-offer.md §3, §6): Business status, seats, and for org admins the org wallet's
/// balance, auto-pay, the seat count it pays for, and App Store packs bought into it. Every seat sees the status.
///
/// App Store 3.1.1: no voucher import and no batch buying here; one line says companies buy batches on the web.
public struct OrgPlanScreen: View {
    @State private var model: OrgPlanModel
    @State private var payments: PaymentsCenter
    @State private var error: String?

    public init(model: OrgPlanModel, payments: PaymentsCenter = .shared) {
        _model = State(initialValue: model)
        _payments = State(initialValue: payments)
    }

    private var cfg: PaymentsConfig { model.config }
    private var now: Int64 { model.now() }

    public var body: some View {
        List {
            statusSection
            seatsSection
            if model.isOrgAdmin && model.hasKey {
                balanceSection
                buySection
            } else {
                Section {
                    Group {
                        if model.isOrgAdmin {
                            Text("Unlock Flagship to see this organization's balance.")
                        } else {
                            Text("Only an organization admin can see the balance or pay for seats.")
                        }
                    }
                    .accessibilityIdentifier("org-plan-read-only")
                }
            }
            Section {
                Text("Companies can buy an invoiced batch on the web.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("org-plan-batch-note")
            }
            if let error {
                Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("org-plan-error") }
            }
        }
        .navigationTitle("Plan")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await reload() }
        .overlay { if model.isLoading && model.plan == nil { ProgressView() } }
    }

    private func reload() async {
        await model.load(interactive: true)
        if payments.shop?.products.isEmpty ?? false { await payments.shop?.loadProducts(model.info) }
        show(model.lastError)
    }

    private func show(_ code: String?) { error = code.map(OrgPlanDisplay.error) }

    // MARK: sections

    private var statusSection: some View {
        Section {
            if let p = model.plan {
                Text(OrgPlanDisplay.status(p, now: now))
                    .accessibilityIdentifier("org-plan-status")
                if p.status == .trial {
                    Text("Paid time starts when the trial ends.")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("org-plan-trial-note")
                }
                if p.status == .lapsed {
                    Text("You can still use every app, remove people and export the org. Adding people, servers or connectors needs a paid plan.")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("org-plan-lapsed")
                }
            }
        } header: {
            Text(model.orgName)
        }
    }

    private var seatsSection: some View {
        Section {
            if let p = model.plan {
                LabeledContent("Seats in use", value: OrgPlanDisplay.seatsInUse(p))
                    .accessibilityIdentifier("org-plan-seats-in-use")
            }
            if model.isOrgAdmin && model.hasKey {
                Stepper(value: Binding(get: { model.seats }, set: { n in
                    Task { if !(await model.setSeats(n)) { show(model.lastError ?? "failed") } }
                }), in: model.minSeats...max(model.minSeats, cfg.business.maxSeats)) {
                    Text("Seats paid for: \(model.seats)")
                }
                .disabled(model.isWorking || !model.canSpend)
                .accessibilityIdentifier("org-plan-seats")
            }
            Text(OrgPlanDisplay.price(cfg, seats: model.seats))
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("org-plan-price")
        } header: {
            Text("Seats")
        }
    }

    private var balanceSection: some View {
        Section {
            LabeledContent("Balance", value: PlanDisplay.dollars(model.balanceUnits, cfg))
                .accessibilityIdentifier("org-plan-balance")
            Text(OrgPlanDisplay.covers(cfg, balance: model.balanceUnits, seats: model.seats))
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("org-plan-months")
            Toggle(isOn: Binding(get: { model.wallet?.settings.autoPay ?? true }, set: { on in
                Task { if !(await model.setAutoPay(on)) { show(model.lastError ?? "failed") } }
            })) {
                Text("Pay automatically")
            }
            .disabled(model.isWorking || !model.canSpend)
            .accessibilityIdentifier("org-plan-auto-pay")
        } header: {
            Text("Organization balance")
        } footer: {
            Text("An admin's phone pays a little at a time, a few days ahead of need. Off: nothing is spent and the plan lapses when its paid time runs out.")
        }
    }

    private var buySection: some View {
        let shop = payments.shop
        let packs = model.canSpend ? (shop?.products ?? []) : []
        return Section {
            ForEach(packs) { pack in
                Button {
                    Task {
                        error = nil
                        _ = await shop?.buy(units: pack.units, orgId: model.orgId)
                        await model.load(interactive: false)
                    }
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
                .disabled(model.isWorking || shop?.phase != VoucherShop.Phase.idle)
                .accessibilityIdentifier("org-plan-pack-\(pack.units)")
            }
            if let o = shop?.outcome {
                Text(o.code == "added" ? OrgPlanDisplay.added(o.units, cfg) : PlanDisplay.shopOutcome(o.code, units: o.units, cfg))
                    .foregroundStyle(o.code == "added" || o.code == "purchase-pending" ? Color.secondary : Color.red)
                    .accessibilityIdentifier(o.code == "added" ? "org-plan-shop-added" : "org-plan-shop-error")
            }
            #if DEBUG
            if GymLaunch.usesMocks, model.canSpend {
                Button("Add $30 of test credit") {
                    Task { if !(await model.addFixtureVouchers(30)) { show(model.lastError ?? "failed") } }
                }
                .disabled(model.isWorking)
                .accessibilityIdentifier("org-plan-add-test")
            }
            #endif
        } header: {
            Text("Buy vouchers for this org")
        } footer: {
            if packs.isEmpty {
                Text("Buying isn't available here yet.")
            } else {
                Text("Paid through the App Store. The vouchers go into this organization's balance, not yours.")
            }
        }
    }
}

/// The section the account's Plan adds: a way to the Plan of each org this phone may pay for.
struct OrgPlanLinksSection: View {
    private let seats = OrgSeatKeys.shared.seats().filter { $0.memberOnly != true }

    var body: some View {
        if !seats.isEmpty {
            Section {
                ForEach(seats) { s in
                    NavigationLink(s.orgName) { OrgPlanScreen(model: OrgPlanModel(seat: s)) }
                        .accessibilityIdentifier("plan-org-\(s.orgName)")
                }
            } header: {
                Text("Buy for an organization")
            } footer: {
                Text("Vouchers bought on an organization's Plan go into its balance and pay for its seats.")
            }
        }
    }
}

/// Plain display rules for the org Plan (unit-tested). Every number comes from the served config.
public enum OrgPlanDisplay {
    static let dayMs: Int64 = 86_400_000

    /// Whole days left, rounded up (a trial ending in 30 hours has 2 days left).
    public static func daysLeft(until end: Int64, now: Int64) -> Int64 { end > now ? (end - now + dayMs - 1) / dayMs : 0 }

    public static func status(_ p: OrgPlanServed, now: Int64) -> String {
        switch p.status {
        case .trial:
            let days = daysLeft(until: p.trialEndsAt, now: now)
            return days <= 1 ? String(localized: "Business, trial: last day") : String(localized: "Business, trial: \(days) days left")
        case .paid: return String(localized: "Business: paid through \(PlanScreen.date(p.paidUntil))")
        case .lapsed: return String(localized: "Business has lapsed")
        }
    }

    public static func seatsInUse(_ p: OrgPlanServed) -> String { String(localized: "\(p.liveSeats) of \(p.seatLimit)") }

    /// "$6 a seat a month: $18 a month".
    public static func price(_ cfg: PaymentsConfig, seats: Int64) -> String {
        let seat = PlanDisplay.dollars(cfg.business.unitsPerSeatMonth, cfg)
        let total = PlanDisplay.dollars(cfg.orgMonthlyUnits(seats), cfg)
        return String(localized: "\(seat) a seat a month: \(total) a month")
    }

    /// About how many months the balance pays for at this seat count.
    public static func covers(_ cfg: PaymentsConfig, balance: Int64, seats: Int64) -> String {
        let months = OrgPlan.monthsCovered(cfg, balance: balance, seats: seats)
        let text = months.formatted(.number.precision(.fractionLength(0...1)))
        return String(localized: "About \(text) months at this seat count")
    }

    public static func added(_ units: Int64, _ cfg: PaymentsConfig) -> String {
        String(localized: "Added \(PlanDisplay.dollars(units, cfg)) to this organization's balance.")
    }

    public static func error(_ code: String) -> String {
        switch code {
        case "org-seats-below-live": return String(localized: "You can't pay for fewer seats than the people the organization already has.")
        case "org-seats": return String(localized: "That seat count isn't allowed. Choose another.")
        case "org-not-found": return String(localized: "Flagship doesn't know this organization.")
        case "org-plan-lapsed": return OrgPlanDisplay.lapsedRefusal
        case "locked": return String(localized: "Unlock Flagship to change this organization's plan.")
        case "wallet-unreadable": return String(localized: "This phone can't open the organization's balance. Another admin can, and it is shared again once they open the Plan.")
        default:
            if code.hasPrefix("org-") { return String(localized: "Only an organization admin can change the organization's balance.") }
            return PlanDisplay.error(code)
        }
    }

    /// The sentence for `org-plan-lapsed` on Invite, add a server and add a connector.
    public static var lapsedRefusal: String { String(localized: "This org's plan has lapsed. Pay for seats on the Plan to add people.") }
}
