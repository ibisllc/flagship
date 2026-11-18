import SwiftUI
import FlagshipCore

/// "Load into Flagship": vouchers bought elsewhere (the web shop) arrive as `https://<apex>/app/vouchers#v=…`
/// (docs/anonymous-vouchers.md "Voucher links"). The screen checks them on this phone alone, asks once, and adds
/// them to the account's wallet; nothing is sent until the wallet syncs, and they are spent later by the trickle.
///
/// App Review 3.1.3(b) (multiplatform services): the app only accepts vouchers acquired elsewhere, and the same packs
/// are sold here as in-app purchases. It never links or points to the web shop, has no code field and scans nothing.
public struct VoucherLinkScreen: View {
    @Environment(\.colorScheme) private var scheme
    let link: String
    let center: PaymentsCenter
    let onDone: () -> Void

    enum Phase: Equatable {
        case checking
        case confirm(VoucherLink.ImportPlan, part: Int, parts: Int)
        case refused(VoucherLink.Refusal)
        case added(Int64)
    }

    @State private var phase: Phase = .checking
    @State private var busy = false

    public init(link: String, center: PaymentsCenter, onDone: @escaping () -> Void) {
        self.link = link; self.center = center; self.onDone = onDone
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        List {
            switch phase {
            case .checking:
                Section { ProgressView().frame(maxWidth: .infinity) }
            case let .confirm(plan, part, parts):
                Section {
                    Text(Self.title(count: plan.add.count, center.config))
                        .font(FS.font.body()).foregroundColor(c.text)
                        .accessibilityIdentifier("voucher-link-title")
                    if parts > 1 {
                        Text("This is link \(part) of \(parts) from the same purchase.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    ForEach(Self.skipLines(plan), id: \.self) { line in
                        Text(line).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    Text("Nothing is sent when you add them. They are spent later, a little at a time, like any other voucher.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
                Section {
                    Button("Add") { Task { await add(plan) } }
                        .disabled(busy)
                        .accessibilityIdentifier("voucher-link-add")
                    Button("Cancel", role: .cancel) { onDone() }
                        .disabled(busy)
                        .accessibilityIdentifier("voucher-link-cancel")
                }
            case .refused(let why):
                Section {
                    Text(Self.sentence(why)).font(FS.font.body()).foregroundColor(c.text)
                        .accessibilityIdentifier("voucher-link-refused")
                }
            case .added(let units):
                Section {
                    Text("Added \(PlanDisplay.dollars(units, center.config)) to your balance.")
                        .font(FS.font.body()).foregroundColor(c.text)
                        .accessibilityIdentifier("voucher-link-added")
                }
            }
        }
        .navigationTitle("Vouchers")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { onDone() }.accessibilityIdentifier("voucher-link-done") } }
        .task {
            guard phase == .checking else { return }
            // The app configures payments for the account just after an unlock; give it a moment.
            for _ in 0..<20 where !center.isConfigured { try? await Task.sleep(nanoseconds: 150_000_000) }
            switch center.reviewVoucherLink(link) {
            case let .confirm(plan, part, parts): phase = .confirm(plan, part: part, parts: parts)
            case .refuse(let why): phase = .refused(why)
            }
        }
    }

    private func add(_ plan: VoucherLink.ImportPlan) async {
        busy = true
        let ok = await center.addVoucherLink(plan)
        busy = false
        phase = ok ? .added(Int64(plan.add.count)) : .refused(.notAdmin)
    }

    static func title(count: Int, _ cfg: PaymentsConfig) -> String {
        let amount = PlanDisplay.dollars(Int64(count), cfg)
        return count == 1
            ? String(localized: "Add 1 voucher (\(amount)) to this account's wallet?")
            : String(localized: "Add \(count) vouchers (\(amount)) to this account's wallet?")
    }

    static func skipLines(_ p: VoucherLink.ImportPlan) -> [String] {
        var out: [String] = []
        if p.duplicate > 0 { out.append(String(localized: "Already in this wallet: \(p.duplicate)")) }
        if p.spent > 0 { out.append(String(localized: "Already spent: \(p.spent)")) }
        if p.invalid > 0 { out.append(String(localized: "Not signed by Flagship, left out: \(p.invalid)")) }
        if p.unknownKey > 0 { out.append(String(localized: "Signed with a key this device doesn't know yet, left out: \(p.unknownKey)")) }
        return out
    }

    /// One sentence per refusal; the webapp and Android say the same.
    public static func sentence(_ why: VoucherLink.Refusal) -> String {
        switch why {
        case .damaged: return String(localized: "This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file.")
        case .newer: return String(localized: "This voucher link needs a newer version of Flagship. Update the app, then open the link again.")
        case .already: return String(localized: "These vouchers are already in this wallet. Nothing was added.")
        case .spent: return String(localized: "These vouchers were already spent. Nothing was added.")
        case .invalid: return String(localized: "These vouchers aren't signed by Flagship. Nothing was added.")
        case .unknownKey: return String(localized: "This device doesn't know the key these vouchers were signed with yet. Open Settings, Plan once while online, then open the link again.")
        case .full: return String(localized: "This wallet can hold 500 vouchers. Spend some first, then open the link again.")
        case .notAdmin: return String(localized: "Only an admin device of this account can add vouchers. Open the link on one.")
        case .signedOut: return String(localized: "Sign in to your account first, then open the link again.")
        }
    }
}
