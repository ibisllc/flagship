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
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    private let diskStore = DiskEncryptionStore()
    @State private var vm: LockPowerViewModel?
    @State private var confirming: PowerMode?

    private var isLuks: Bool { diskStore.isLuks(for: serverDomain) }

    private func label(_ mode: PowerMode) -> String {
        switch (mode, isLuks) {
        case (.off, true):      return "Lock and turn off"
        case (.off, false):     return "Turn off"
        case (.restart, true):  return "Lock and restart"
        case (.restart, false): return "Restart"
        }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("POWER")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                switch vm?.phase {
                case .sent(let mode):
                    Label(
                        mode == .off ? "Powering off…" : "Restarting…",
                        systemImage: mode == .off ? "power" : "arrow.clockwise"
                    )
                    .font(FS.font.body())
                    .foregroundColor(c.text)
                default:
                    VStack(spacing: FS.space.s2) {
                        FSSecondaryButton(label(.off), block: true) { confirming = .off }
                            .accessibilityIdentifier("sd-power-off")
                        FSSecondaryButton(label(.restart), block: true) { confirming = .restart }
                            .accessibilityIdentifier("sd-power-restart")
                    }
                    .disabled(isBusy)
                }
            }
        }
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

    private var isBusy: Bool {
        switch vm?.phase {
        case .signing, .posting: return true
        default: return false
        }
    }

    @MainActor
    private func fire(_ mode: PowerMode) async {
        let m = vm ?? LockPowerViewModel(client: client, serverDomain: serverDomain)
        vm = m
        await m.run(mode: mode)
        if case .failed(let msg) = m.phase {
            toasts.error(msg)
        }
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
            Text("LOCK-DOWN")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            Button { open = true } label: {
                FSCard {
                    HStack {
                        Image(systemName: enabled ? "lock.fill" : "lock.open")
                            .foregroundColor(enabled ? c.primary : c.textMuted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Auto lock-down")
                                .font(FS.font.body())
                                .foregroundColor(c.text)
                            Text(enabled ? "On — affirm to keep unlocked" : "Off")
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
                vm = DeadManViewModel(client: client, serverDomain: serverDomain, serverName: serverName)
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
                Text("If you don't affirm in time, this box locks itself — it powers off (or restarts) and needs your phone to come back.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func windowSection(vm: DeadManViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("WINDOW").font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
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

                    FSDangerButton("Tighten now (15 min)", block: true) {
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
            Text("ON LAPSE").font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
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
            Text("STAY UNLOCKED").font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
            FSCard {
                // `nowTick` is read here so the countdown re-renders each
                // second; the value itself is unused.
                let _ = nowTick
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    if let remaining = vm.leaseRemainingMs() {
                        Text(remaining > 0 ? "Locks in \(formatRemaining(remaining))" : "Window lapsed — affirm now")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(remaining > 0 ? c.text : c.danger)
                    } else {
                        Text("Not affirmed yet — affirm to start the window.")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                    }
                    FSPrimaryButton(
                        vm.phase == .affirming ? "Affirming…" : "Keep \(serverName) unlocked",
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
            if enabled { toasts.success("Lock-down on. Affirm to keep \(serverName) unlocked.") }
            else { toasts.success("Lock-down off.") }
        }
    }

    @MainActor
    private func affirm() async {
        guard let vm else { return }
        await vm.affirm()
        switch vm.phase {
        case .failed(let msg): toasts.error(msg)
        default: toasts.success("\(serverName) stays unlocked.")
        }
    }
}
