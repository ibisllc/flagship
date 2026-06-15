import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P7 — dedicated tier-status / subscription screen. Mirrors the
/// canonical webapp `views/tier-status.js`: a tier badge, LLM credits
/// (today + lifetime), dispatcher usage with a progress bar (usage vs
/// free quota), the custom-domains list, and the reserved-names list.
public struct TierStatusScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: TierStatusViewModel

    public init(vm: TierStatusViewModel) {
        _vm = State(initialValue: vm)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                switch vm.state {
                case .idle, .loading:
                    ForEach(0..<2, id: \.self) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let t):
                    tierCard(t, c: c)
                    llmSection(t, c: c)
                    dispatcherSection(t, c: c)
                    customDomainsSection(t, c: c)
                    reservedNamesSection(t, c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Tier & usage")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.state { await vm.load() }
        }
    }

    // MARK: - Sections (1:1 with tier-status.js)

    private func tierCard(_ t: TierStatusResponse, c: FSColors) -> some View {
        FSCard {
            HStack {
                Text("Tier").foregroundColor(c.textMuted)
                Spacer()
                FSPill(tierLabel(t.tier), kind: t.tier == "free" ? .idle : .online)
                    .accessibilityIdentifier("tier-status-badge")
            }
        }
    }

    @ViewBuilder
    private func llmSection(_ t: TierStatusResponse, c: FSColors) -> some View {
        sectionHeader("LLM credits", c: c)
        FSCard {
            VStack(spacing: FS.space.s2) {
                if let day = t.llmCreditsRemainingDay {
                    row("today remaining", grouped(day), c: c)
                } else {
                    row("today", "— (BYOK or promo not in use)", c: c)
                }
                if let total = t.llmCreditsRemainingTotal {
                    row("lifetime remaining", grouped(total), c: c)
                }
            }
        }
    }

    @ViewBuilder
    private func dispatcherSection(_ t: TierStatusResponse, c: FSColors) -> some View {
        sectionHeader("Dispatcher relay", c: c)
        FSCard {
            if let used = t.dispatcherUsageGBmonth {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack {
                        Text("this month").foregroundColor(c.textMuted)
                        Spacer()
                        Text(dispatcherValue(used: used, quota: t.dispatcherFreeQuotaGBmonth))
                            .foregroundColor(c.text)
                    }
                    progressBar(
                        percent: TierStatusViewModel.usagePercent(
                            used: used, quota: t.dispatcherFreeQuotaGBmonth
                        ),
                        c: c
                    )
                }
            } else {
                row("usage", "—", c: c)
            }
        }
    }

    @ViewBuilder
    private func customDomainsSection(_ t: TierStatusResponse, c: FSColors) -> some View {
        sectionHeader("Custom domains", c: c)
        if t.customDomains.isEmpty {
            placeholderCard("none — your default subdomain is forever-free", c: c)
        } else {
            ForEach(t.customDomains, id: \.self) { d in
                FSCard { Text(d).font(FS.font.mono()).foregroundColor(c.text) }
            }
        }
    }

    @ViewBuilder
    private func reservedNamesSection(_ t: TierStatusResponse, c: FSColors) -> some View {
        sectionHeader("Reserved names", c: c)
        if t.reservedNames.isEmpty {
            placeholderCard("none — your username is FCFS-free", c: c)
        } else {
            ForEach(t.reservedNames, id: \.self) { n in
                FSCard { Text(n).font(FS.font.mono()).foregroundColor(c.text) }
            }
        }
    }

    // MARK: - Bits

    private func tierLabel(_ tier: String) -> String {
        switch tier {
        case "free":  return "free"
        case "promo": return "promo"
        case "byok":  return "BYOK"
        default:      return tier
        }
    }

    private func dispatcherValue(used: Double, quota: Double?) -> String {
        let usedStr = String(format: "%.2f GB", used)
        if let quota {
            return "\(usedStr) / \(String(format: "%.0f", quota)) GB free"
        }
        return "\(usedStr) / —"
    }

    private func grouped(_ n: Int64) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    private func progressBar(percent: Int, c: FSColors) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(c.surfaceSunken)
                Capsule().fill(c.primary)
                    .frame(width: geo.size.width * CGFloat(percent) / 100)
            }
        }
        .frame(height: 8)
        .accessibilityIdentifier("tier-status-dispatcher-progress")
    }

    private func sectionHeader(_ title: String, c: FSColors) -> some View {
        Text(title).font(FS.font.h3()).foregroundColor(c.text)
    }

    private func placeholderCard(_ text: String, c: FSColors) -> some View {
        FSCard { Text(text).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
    }

    private func row(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack {
            Text(label).foregroundColor(c.textMuted)
            Spacer()
            Text(value).foregroundColor(c.text)
        }
    }
}
