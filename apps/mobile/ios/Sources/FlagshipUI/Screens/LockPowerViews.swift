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
                            mode == .off ? String(localized: "Powering off…") : "Restarting…",
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
                        FSSecondaryButton(String(localized: "Shut down"), block: true) {
                            Task { await vm?.shutDownInstead(); refreshLockState() }
                        }
                        .accessibilityIdentifier("sd-shutdown-instead")
                        FSSecondaryButton(String(localized: "Keep running"), block: true) { vm = nil }
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
                FSSecondaryButton(String(localized: "Resume (allow auto-unlock again)"), block: true) {
                    Task {
                        let m = viewModel()
                        let r = await m.resume()
                        if case .confirmed? = r { toasts.success("Resumed. Turn auto-unlock back on if you want it.") }
                        else { toasts.error(String(localized: "Couldn't resume right now. Try again.")) }
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
                FSSecondaryButton(String(localized: "Retry the remote lock"), block: true) {
                    Task {
                        let r = await viewModel().retryPendingLock()
                        if case .confirmed? = r { toasts.success("Locked at the boot service.") }
                        else { toasts.error(String(localized: "Still couldn't reach the boot service.")) }
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
