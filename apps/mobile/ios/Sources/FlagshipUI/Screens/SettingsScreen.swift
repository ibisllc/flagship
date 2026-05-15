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
    @State private var disconnectTarget: TrustedDevice?
    @State private var disconnectMessage: String?
    /// Drives the v1 "Wipe & restart — coming soon" info sheet. The
    /// menu entry stays visible (rather than hidden) so users
    /// understand the option exists and is being designed; tapping
    /// it opens an explainer instead of running the ceremony.
    @State private var showWipeComingSoon = false
    let username: String
    let tier: LoadingState<TierStatusResponse>
    let controlDevices: LoadingState<[PairedSessionSummary]>
    /// Peer-class devices on this user's account (push-token holders).
    /// The new "Trusted devices" section. Empty list renders an
    /// explainer; .failed renders an error card.
    let trustedDevices: LoadingState<[TrustedDevice]>
    var onDisconnectTrustedDevice: (TrustedDevice) async -> Bool = { _ in false }
    let showDeveloper: Bool
    var onAddControlDevice: () -> Void = {}
    var onRevokeDevice: (PairedSessionSummary) -> Void = { _ in }
    var onSignOut: () -> Void = {}
    var onOpenProviders: () -> Void = {}
    var onOpenRecovery: () -> Void = {}
    var onOpenAbout: () -> Void = {}
    var onOpenDeveloper: () -> Void = {}
    var onRefresh: () async -> Void = {}

    public init(
        username: String,
        tier: LoadingState<TierStatusResponse>,
        controlDevices: LoadingState<[PairedSessionSummary]>,
        trustedDevices: LoadingState<[TrustedDevice]> = .loaded([]),
        showDeveloper: Bool = false,
        onAddControlDevice: @escaping () -> Void = {},
        onRevokeDevice: @escaping (PairedSessionSummary) -> Void = { _ in },
        onDisconnectTrustedDevice: @escaping (TrustedDevice) async -> Bool = { _ in false },
        onSignOut: @escaping () -> Void = {},
        onOpenProviders: @escaping () -> Void = {},
        onOpenRecovery: @escaping () -> Void = {},
        onOpenAbout: @escaping () -> Void = {},
        onOpenDeveloper: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.username = username
        self.tier = tier
        self.controlDevices = controlDevices
        self.trustedDevices = trustedDevices
        self.onDisconnectTrustedDevice = onDisconnectTrustedDevice
        self.showDeveloper = showDeveloper
        self.onAddControlDevice = onAddControlDevice
        self.onRevokeDevice = onRevokeDevice
        self.onSignOut = onSignOut
        self.onOpenProviders = onOpenProviders
        self.onOpenRecovery = onOpenRecovery
        self.onOpenAbout = onOpenAbout
        self.onOpenDeveloper = onOpenDeveloper
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
                trustedDevicesSection(c: c)
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
        .confirmationDialog(
            disconnectTarget.map { "Disconnect \($0.label)?" } ?? "Disconnect device?",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: disconnectTarget
        ) { target in
            Button("Disconnect \(target.label)", role: .destructive) {
                Task {
                    let success = await onDisconnectTrustedDevice(target)
                    if !success {
                        disconnectMessage = "Couldn't disconnect — check your connection and try again."
                    }
                    disconnectTarget = nil
                }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: { target in
            Text("We'll stop sending alerts to \(target.label). It can sign back in with your passkey.")
        }
        .alert(
            "Disconnect failed",
            isPresented: Binding(
                get: { disconnectMessage != nil },
                set: { if !$0 { disconnectMessage = nil } }
            )
        ) {
            Button("OK") { disconnectMessage = nil }
        } message: {
            Text(disconnectMessage ?? "")
        }
        .sheet(isPresented: $showWipeComingSoon) {
            WipeComingSoonSheet { showWipeComingSoon = false }
        }
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

    private func trustedDevicesSection(c: FSColors) -> some View {
        section("TRUSTED DEVICES", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Phones and tablets that hold your account keys.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                switch trustedDevices {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let devices):
                    if devices.isEmpty {
                        FSCard {
                            HStack(alignment: .top, spacing: FS.space.s2) {
                                Image(systemName: "iphone").foregroundColor(c.textMuted)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Just this device").font(FS.font.bodySm()).foregroundColor(c.text)
                                    Text("Sign in on another phone or tablet to add a trusted device.")
                                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                                }
                            }
                        }
                    } else {
                        VStack(spacing: FS.space.s3) {
                            ForEach(devices) { d in
                                trustedDeviceRow(d, c: c)
                            }
                        }
                    }
                }
            }
        }
    }

    /// One row per peer device. Carries the Disconnect / Replace
    /// (B7) actions via a contextual Menu on iOS — feels native
    /// versus a button stack and keeps the row visually clean.
    private func trustedDeviceRow(_ d: TrustedDevice, c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: platformIcon(d.platform))
                    .foregroundColor(c.primary)
                    .imageScale(.large)
                VStack(alignment: .leading, spacing: 2) {
                    Text(d.label).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                    HStack(spacing: 4) {
                        Text(platformDisplay(d.platform))
                        Text("·").foregroundColor(c.textMuted)
                        Text("added \(relative(ms: d.addedAt))")
                    }
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    if d.lastSeenAt > d.addedAt {
                        Text("last seen \(relative(ms: d.lastSeenAt))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                Spacer()
                Menu {
                    Button(role: .destructive) {
                        disconnectTarget = d
                    } label: {
                        Label("Disconnect", systemImage: "wifi.slash")
                    }
                    // Replace lives in B7; the menu entry slot is here
                    // already so the UX shape doesn't shift between
                    // commits.
                    Button {
                        // intentionally no-op until B7
                    } label: {
                        Label("Replace device", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(true)
                    Divider()
                    // Wipe & restart lives behind a v1.1 flag (E2/E3).
                    // The menu entry is visible-but-disabled in v1 so
                    // the user can see the option exists; tapping it
                    // opens the "Coming soon" explainer rather than
                    // running the ceremony.
                    Button(role: .destructive) {
                        showWipeComingSoon = true
                    } label: {
                        Label("Wipe & restart…", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundColor(c.textMuted)
                        .imageScale(.large)
                }
                .accessibilityIdentifier("trusted-device-menu-\(d.tokenPrefix)")
            }
        }
    }

    private func platformIcon(_ raw: String) -> String {
        switch raw {
        case "apns":    return "iphone"
        case "fcm":     return "antenna.radiowaves.left.and.right"
        case "webpush": return "globe"
        default:        return "questionmark.circle"
        }
    }

    private func platformDisplay(_ raw: String) -> String {
        switch raw {
        case "apns":    return "iPhone / iPad"
        case "fcm":     return "Android"
        case "webpush": return "Web"
        default:        return raw
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
                if showDeveloper {
                    linkRow("Developer", subtitle: "Mock/live toggle, latency knob", icon: "hammer.fill", c: c, action: onOpenDeveloper)
                }
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

/// "Coming soon" explainer for the v1 Wipe & restart entry. Visible
/// (rather than hidden) so users can see the v1.1 option exists and
/// is being designed. The actual ceremony lands as E2/E3 on iOS.
struct WipeComingSoonSheet: View {
    @Environment(\.colorScheme) private var scheme
    let onClose: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack {
                Image(systemName: "trash.circle.fill")
                    .imageScale(.large)
                    .foregroundColor(c.danger)
                Text("Wipe & restart")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Spacer()
            }
            Text("Coming in v1.1.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            Text("This rotates your account's identity and recovery passkey in one shot — every other device gets disconnected and you re-pair each one fresh. Pods stay running, apps stay installed.")
                .foregroundColor(c.text)
            Text("For v1 you can still Disconnect a single device, and Replace device will land alongside the Keystore-rotation primitives. The full Wipe ceremony needs the new-IRK + new-UMK + new-passkey generation paths exercised end-to-end before we ship it.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            FSPrimaryButton("Got it", block: true, action: onClose)
        }
        .padding(FS.space.s6)
        .background(c.bg)
        .presentationDetents([.medium])
    }
}
