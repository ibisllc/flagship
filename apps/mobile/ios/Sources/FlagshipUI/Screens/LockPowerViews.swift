import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// Two manual buttons on the server-detail screen: lock-and-turn-off and
/// lock-and-restart (the "Lock and " prefix drops on a non-LUKS box). Each:
/// a minimal "Are you sure?" confirm → biometric (inside the VM signer) →
/// signed `power-off` order → box-direct POST. The card then reflects the
/// powering-off / restarting state.
///
/// Self-contained like the other server-detail cards: reads its dependencies
/// (the box-direct lock/power client, toasts) from the environment.
struct LockPowerCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.lockPowerClient) private var client
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    private let diskStore = DiskEncryptionStore()
    private let lockStore = BootLockStateStore()
    @State private var vm: LockPowerViewModel?
    @State private var confirming: PowerMode?
    @State private var lockedKnown: Bool?
    @State private var lockPending = false

    private var isLuks: Bool { diskStore.isLuks(for: serverDomain) }

    private func label(_ mode: PowerMode) -> String {
        switch (mode, isLuks) {
        case (.off, true):      return String(localized: "Lock and turn off")
        case (.off, false):     return String(localized: "Turn off")
        case (.restart, true):  return String(localized: "Lock and restart")
        case (.restart, false): return String(localized: "Restart")
        }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Power"))
            FSCard {
                switch vm?.phase {
                case .sent(let mode):
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Label(
                            mode == .off ? "Powering off…" : "Restarting…",
                            systemImage: mode == .off ? "power" : "arrow.clockwise"
                        )
                        .font(FS.font.body())
                        .foregroundColor(c.text)
                        if let s = vm?.summary, !s.isEmpty {
                            Text(s).font(FS.font.caption()).foregroundColor(c.textMuted)
                                .accessibilityIdentifier("sd-lock-summary")
                        }
                    }
                case .lockUnconfirmed(let message):
                    // A restart was NOT sent: it could not be locked at the boot service.
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text(message).font(FS.font.body()).foregroundColor(c.text)
                            .accessibilityIdentifier("sd-lock-unconfirmed")
                        FSSecondaryButton("Shut down", block: true) {
                            Task { await vm?.shutDownInstead(); refreshLockState() }
                        }
                        .accessibilityIdentifier("sd-shutdown-instead")
                        FSSecondaryButton("Keep running", block: true) { vm = nil }
                    }
                default:
                    VStack(spacing: FS.space.s2) {
                        FSSecondaryButton(label(.off), block: true) { confirming = .off }
                            .accessibilityIdentifier("sd-power-off")
                        FSSecondaryButton(label(.restart), block: true) { confirming = .restart }
                            .accessibilityIdentifier("sd-power-restart")
                    }
                    .disabled(isBusy)
                    if isLuks { lockStateRow(c) }
                }
            }
        }
        .onAppear { refreshLockState() }
        .alert(item: $confirming) { mode in
            // Minimal confirm — no explanatory paragraph (spec: minimal copy).
            Alert(
                title: Text("\(label(mode))?"),
                primaryButton: .destructive(Text(label(mode))) {
                    Task { await fire(mode) }
                },
                secondaryButton: .cancel()
            )
        }
    }

    private func refreshLockState() {
        lockedKnown = lockStore.lastKnownSuspended(serverDomain)
        lockPending = lockStore.pending().contains(serverDomain.lowercased())
    }

    /// What this phone last confirmed about the lock, and the way back. The remote lock is
    /// retried from here when the boot service hadn't confirmed it.
    @ViewBuilder
    private func lockStateRow(_ c: FSColors) -> some View {
        if lockedKnown == true {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Locked: this server can't unlock itself. It will ask you to approve its next start. This lock stops the boot service from handing out the unlock key. It cannot take back a key or data already copied from a running server, and a server running changed software can ignore it.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    .accessibilityIdentifier("sd-lock-state")
                FSSecondaryButton("Resume (allow auto-unlock again)", block: true) {
                    Task {
                        let m = viewModel()
                        let r = await m.resume()
                        if case .confirmed? = r { toasts.success("Resumed. Turn auto-unlock back on if you want it.") }
                        else { toasts.error("Couldn't resume right now. Try again.") }
                        refreshLockState()
                    }
                }
                .accessibilityIdentifier("sd-lock-resume")
            }
        }
        if lockPending {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Remote lock pending: the boot service hasn't confirmed it yet.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSSecondaryButton("Retry the remote lock", block: true) {
                    Task {
                        let r = await viewModel().retryPendingLock()
                        if case .confirmed? = r { toasts.success("Locked at the boot service.") }
                        else { toasts.error("Still couldn't reach the boot service.") }
                        refreshLockState()
                    }
                }
                .accessibilityIdentifier("sd-lock-retry")
            }
        }
    }

    private func viewModel() -> LockPowerViewModel {
        if let vm { return vm }
        let m = LockPowerViewModel(
            client: client, serverDomain: serverDomain,
            bootLock: isLuks ? BootLock(client: mailbox) : nil
        )
        vm = m
        return m
    }

    private var isBusy: Bool {
        switch vm?.phase {
        case .signing, .posting: return true
        default: return false
        }
    }

    @MainActor
    private func fire(_ mode: PowerMode) async {
        let m = viewModel()
        await m.run(mode: mode)
        if case .failed(let msg) = m.phase {
            toasts.error(msg)
        }
        refreshLockState()
    }
}

extension PowerMode: @retroactive Identifiable {
    public var id: String { rawValue }
}

/// Entry card on the server-detail screen that links into the dead-man
/// settings screen. Shows the current on/off state at a glance.
struct DeadManCard: View {
    @Environment(\.colorScheme) private var scheme

    let serverDomain: String
    let serverName: String

    private let store = DeadManStore()
    @State private var enabled = false
    @State private var open = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Lock-down"))
            Button { open = true } label: {
                FSCard {
                    HStack {
                        Image(systemName: enabled ? "lock.fill" : "lock.open")
                            .foregroundColor(enabled ? c.accent : c.textMuted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Auto lock-down")
                                .font(FS.font.body())
                                .foregroundColor(c.text)
                            Text(enabled ? String(localized: "On — affirm to keep unlocked") : "Off")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sd-deadman-open")
        }
        .onAppear { enabled = store.isEnabled(for: serverDomain) }
        .navigationDestination(isPresented: $open) {
            DeadManScreen(serverDomain: serverDomain, serverName: serverName)
        }
    }
}

/// Dead-man heartbeat-lock settings + affirmation screen.
///
/// - A toggle to enable/disable (signs `SetDeadManPolicy`).
/// - A window picker (24h / 8h / 1h / 15m) + a "Tighten now" one-tap that
///   drops the window to 15m for a high-risk moment.
/// - A lockout-action picker (turn off [default] / restart).
/// - When enabled, the current lease state (time remaining) + a manual,
///   biometric-gated "Keep <server> unlocked" affirmation.
struct DeadManScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.lockPowerClient) private var client
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.secretMailboxClient) private var mailbox

    let serverDomain: String
    let serverName: String

    @State private var vm: DeadManViewModel?
    @State private var nowTick = Date()
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                if let vm {
                    enableSection(vm: vm, c: c)
                    if vm.enabled {
                        windowSection(vm: vm, c: c)
                        lockoutSection(vm: vm, c: c)
                        leaseSection(vm: vm, c: c)
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Auto lock-down")
        .navigationBarTitleDisplayMode(.inline)
        .onReceive(ticker) { nowTick = $0 }
        .onAppear {
            if vm == nil {
                vm = DeadManViewModel(
                    client: client, serverDomain: serverDomain, serverName: serverName,
                    bootLock: DiskEncryptionStore().isLuks(for: serverDomain) ? BootLock(client: mailbox) : nil
                )
            }
        }
    }

    private var isBusy: Bool {
        switch vm?.phase {
        case .savingPolicy, .affirming: return true
        default: return false
        }
    }

    @ViewBuilder
    private func enableSection(vm: DeadManViewModel, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Toggle(isOn: Binding(
                    get: { vm.enabled },
                    set: { on in Task { await save(enabled: on, window: vm.window, lockout: vm.lockoutMode) } }
                )) {
                    Text("Auto lock-down").font(FS.font.body()).foregroundColor(c.text)
                }
                .disabled(isBusy)
                .accessibilityIdentifier("deadman-toggle")
                Text("If you don't affirm in time, this server locks itself — it powers off (or restarts) and needs your phone to come back.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func windowSection(vm: DeadManViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Window"))
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Picker("Window", selection: Binding(
                        get: { vm.window },
                        set: { w in Task { await save(enabled: true, window: w, lockout: vm.lockoutMode) } }
                    )) {
                        ForEach(DeadManStore.WindowPreset.allCases, id: \.self) { p in
                            Text(p.label).tag(p)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(isBusy)
                    .accessibilityIdentifier("deadman-window-picker")

                    FSDangerButton(String(localized: "Tighten now (15 min)"), block: true) {
                        Task { await save(enabled: true, window: .min15, lockout: vm.lockoutMode) }
                    }
                    .disabled(isBusy)
                    .accessibilityIdentifier("deadman-tighten")
                }
            }
        }
    }

    @ViewBuilder
    private func lockoutSection(vm: DeadManViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "On lapse"))
            FSCard {
                Picker("On lapse", selection: Binding(
                    get: { vm.lockoutMode },
                    set: { m in Task { await save(enabled: true, window: vm.window, lockout: m) } }
                )) {
                    Text("Turn off").tag(PowerMode.off)
                    Text("Restart").tag(PowerMode.restart)
                }
                .pickerStyle(.segmented)
                .disabled(isBusy)
                .accessibilityIdentifier("deadman-lockout-picker")
            }
        }
    }

    @ViewBuilder
    private func leaseSection(vm: DeadManViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Stay unlocked"))
            FSCard {
                // `nowTick` is read here so the countdown re-renders each
                // second; the value itself is unused.
                let _ = nowTick
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    if let remaining = vm.leaseRemainingMs() {
                        Text(remaining > 0 ? String(localized: "Locks in \(formatRemaining(remaining))") : "Window lapsed — affirm now")
                            .font(FS.font.scaled(17, weight: .semibold))
                            .foregroundColor(remaining > 0 ? c.text : c.danger)
                    } else {
                        Text("Not affirmed yet — affirm to start the window.")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                    }
                    FSPrimaryButton(
                        vm.phase == .affirming ? String(localized: "Affirming…") : String(localized: "Keep \(serverName) unlocked"),
                        enabled: !isBusy,
                        block: true,
                        large: true
                    ) {
                        Task { await affirm() }
                    }
                    .accessibilityIdentifier("deadman-affirm")
                }
            }
        }
    }

    private func formatRemaining(_ ms: Int64) -> String {
        let total = Int(ms / 1000)
        let h = total / 3600
        let m = (total % 3600) / 60
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m" }
        return "\(total % 60)s"
    }

    @MainActor
    private func save(enabled: Bool, window: DeadManStore.WindowPreset, lockout: PowerMode) async {
        guard let vm else { return }
        await vm.applyPolicy(enabled: enabled, window: window, lockoutMode: lockout)
        switch vm.phase {
        case .failed(let msg): toasts.error(msg)
        default:
            if enabled { toasts.success(String(localized: "Lock-down on. Affirm to keep \(serverName) unlocked.")) }
            else { toasts.success(String(localized: "Lock-down off.")) }
        }
    }

    @MainActor
    private func affirm() async {
        guard let vm else { return }
        await vm.affirm()
        switch vm.phase {
        case .failed(let msg): toasts.error(msg)
        default: toasts.success(String(localized: "\(serverName) stays unlocked."))
        }
    }
}
