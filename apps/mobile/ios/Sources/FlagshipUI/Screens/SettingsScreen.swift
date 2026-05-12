import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings tab. Sections:
///   - ACCOUNT — username
///   - SUBSCRIPTION — tier, credits, bandwidth, manage providers
///   - CONTROL DEVICES — phone apps paired to this account (NOT pods)
///                       with an Add control device action
///   - RECOVERY + ABOUT — recovery setup, version/license
///   - Sign out
///
/// The server list intentionally lives only on Home — having it here
/// too was redundant.
public struct SettingsScreen: View {
    @Environment(\.colorScheme) private var scheme
    let username: String
    let tier: LoadingState<TierStatusResponse>
    let controlDevices: LoadingState<[PairedSessionSummary]>
    var onAddControlDevice: () -> Void = {}
    var onRevokeDevice: (PairedSessionSummary) -> Void = { _ in }
    var onSignOut: () -> Void = {}
    var onOpenProviders: () -> Void = {}
    var onOpenRecovery: () -> Void = {}
    var onOpenAbout: () -> Void = {}
    var onRefresh: () async -> Void = {}

    public init(
        username: String,
        tier: LoadingState<TierStatusResponse>,
        controlDevices: LoadingState<[PairedSessionSummary]>,
        onAddControlDevice: @escaping () -> Void = {},
        onRevokeDevice: @escaping (PairedSessionSummary) -> Void = { _ in },
        onSignOut: @escaping () -> Void = {},
        onOpenProviders: @escaping () -> Void = {},
        onOpenRecovery: @escaping () -> Void = {},
        onOpenAbout: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.username = username
        self.tier = tier
        self.controlDevices = controlDevices
        self.onAddControlDevice = onAddControlDevice
        self.onRevokeDevice = onRevokeDevice
        self.onSignOut = onSignOut
        self.onOpenProviders = onOpenProviders
        self.onOpenRecovery = onOpenRecovery
        self.onOpenAbout = onOpenAbout
        self.onRefresh = onRefresh
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text("Settings")
                    .font(.system(size: 32, weight: .medium))
                    .foregroundColor(c.text)
                    .padding(.top, FS.space.s4)

                account(c: c)
                subscription(c: c)
                controlDevicesSection(c: c)
                links(c: c)
                signOut(c: c)
                about(c: c)

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .refreshable { await onRefresh() }
    }

    private func account(c: FSColors) -> some View {
        section("ACCOUNT", c: c) {
            FSCard {
                row(label: "Username", value: username, c: c)
            }
        }
    }

    private func subscription(c: FSColors) -> some View {
        section("SUBSCRIPTION", c: c) {
            switch tier {
            case .idle, .loading:
                ServerCardSkeleton()
            case .failed(let msg):
                ErrorCard(message: msg)
            case .loaded(let t):
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        HStack {
                            Text(t.tier.capitalized)
                                .font(FS.font.h3()).foregroundColor(c.text)
                            Spacer()
                            FSPill(t.tier == "byok" ? "Bring-your-own-key" : t.tier == "promo" ? "Free credits" : "Free", kind: .provisioning)
                        }
                        if let day = t.llmCreditsRemainingDay, let total = t.llmCreditsRemainingTotal {
                            row(label: "Credits today", value: "\(day) remaining", c: c)
                            row(label: "Credits lifetime", value: "\(total) remaining", c: c)
                        }
                        if let usage = t.dispatcherUsageGBmonth, let quota = t.dispatcherFreeQuotaGBmonth {
                            row(label: "Bandwidth", value: String(format: "%.1f GB / %.0f GB", usage, quota), c: c)
                        }
                        FSGhostButton("Manage providers", block: true, action: onOpenProviders)
                    }
                }
            }
        }
    }

    private func controlDevicesSection(c: FSColors) -> some View {
        section("CONTROL DEVICES", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Phones and laptops that can manage this account.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                switch controlDevices {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let sessions):
                    VStack(spacing: FS.space.s3) {
                        ForEach(sessions, id: \.tokenPrefix) { s in
                            controlDeviceRow(s, c: c)
                        }
                    }
                }
                Button(action: onAddControlDevice) {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                        Text("Add control device")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(c.primary)
                        Spacer()
                    }
                    .padding(.horizontal, FS.space.s4)
                    .padding(.vertical, FS.space.s3)
                    .background(c.primary.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: FS.radius.md)
                            .stroke(c.primary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    )
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                }
                .padding(.top, FS.space.s2)
            }
        }
    }

    private func controlDeviceRow(_ s: PairedSessionSummary, c: FSColors) -> some View {
        FSCard {
            HStack {
                Image(systemName: s.current ? "iphone.gen3" : "laptopcomputer")
                    .foregroundColor(s.current ? c.success : c.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.label).foregroundColor(c.text)
                    Text("paired \(relative(ms: s.addedAt))")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Spacer()
                if s.current {
                    FSPill("This device", kind: .online)
                } else {
                    Button("Revoke") { onRevokeDevice(s) }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(c.danger)
                }
            }
        }
    }

    private func links(c: FSColors) -> some View {
        section("RECOVERY", c: c) {
            VStack(spacing: FS.space.s3) {
                linkRow("Recovery setup", subtitle: "If you lose this phone", icon: "key.horizontal.fill", c: c, action: onOpenRecovery)
                linkRow("About Flagship", subtitle: "Version, license, source", icon: "info.circle.fill", c: c, action: onOpenAbout)
            }
        }
    }

    private func signOut(c: FSColors) -> some View {
        FSDangerButton("Sign out", block: true, large: true, action: onSignOut)
            .padding(.top, FS.space.s4)
    }

    private func about(c: FSColors) -> some View {
        Text("Flagship • BUSL-1.1 • Your stuff, on your hardware.")
            .font(FS.font.caption())
            .foregroundColor(c.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, FS.space.s4)
    }

    private func linkRow(_ title: String, subtitle: String, icon: String, c: FSColors, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            FSCard {
                HStack {
                    Image(systemName: icon).foregroundColor(c.primary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).foregroundColor(c.text)
                        Text(subtitle).font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func section<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label).font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
            content()
        }
    }

    private func row(label: String, value: String, mono: Bool = false, c: FSColors) -> some View {
        HStack {
            Text(label).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(mono ? FS.font.mono() : FS.font.body()).foregroundColor(c.text)
        }
    }

    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}
