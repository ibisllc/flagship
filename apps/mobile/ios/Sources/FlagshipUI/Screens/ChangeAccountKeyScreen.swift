import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "Change your account key" (docs/account-key-rotation.md §5): what changes, who has to be added again, then
/// the one button. Opened from Remove from account → "Yes, or I'm not sure".
public struct ChangeAccountKeyScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: RotateAccountKeyViewModel
    let onClose: () -> Void
    let onSetUpRecovery: () -> Void

    public init(vm: RotateAccountKeyViewModel, onClose: @escaping () -> Void, onSetUpRecovery: @escaping () -> Void) {
        self.vm = vm; self.onClose = onClose; self.onSetUpRecovery = onSetUpRecovery
    }

    public static let title = String(localized: "Change your account key")
    public static let othersKeepWorking = String(localized: "Your other devices keep working. They get the new key the next time they open Flagship.")
    public static let serversSwitch = String(localized: "Your servers switch to the new key by themselves. Nothing needs pairing again.")
    public static let addAgainHeader = String(localized: "These devices must be added again:")
    public static let browsersApprove = String(localized: "Browsers signed in to your servers will need to be approved again.")
    public static let recoveryAgain = String(localized: "Set up cloud recovery again afterwards.")
    public static let oldBackups = String(localized: "Old backups still open with the old key, and so do copies on the removed device.")
    public static let confirm = String(localized: "Change account key")
    public static let changing = String(localized: "Changing the account key…")
    public static let changed = String(localized: "Account key changed")

    public var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    content(c)
                }
                .padding(FS.space.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle(Self.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if vm.phase != .rotating { Button("Cancel") { onClose() }.accessibilityIdentifier("change-key-cancel") }
                }
            }
        }
        .interactiveDismissDisabled(vm.phase == .rotating)
        .task { if vm.phase == .preparing { await vm.prepare() } }
        .accessibilityIdentifier("change-account-key-screen")
    }

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        switch vm.phase {
        case .preparing:
            ProgressView().frame(maxWidth: .infinity)
        case .unavailable(let line):
            if !line.isEmpty { Text(line).font(FS.font.body()).accessibilityIdentifier("change-key-unavailable") }
            FSSecondaryButton(String(localized: "Close"), block: true) { onClose() }
        case .ready, .rotating, .failed:
            if let s = vm.summary { summary(c, s) }
            if case .failed(let line) = vm.phase {
                Text(line).font(FS.font.bodySm()).foregroundColor(c.danger).accessibilityIdentifier("change-key-failed")
            }
            if vm.phase == .rotating {
                HStack(spacing: FS.space.s2) { ProgressView(); Text(Self.changing).font(FS.font.body()) }
            } else if vm.phase == .ready {
                FSPrimaryButton(Self.confirm, block: true) { Task { await vm.rotate() } }
                    .accessibilityIdentifier("change-key-confirm")
                FSSecondaryButton(String(localized: "Cancel"), block: true) { onClose() }
            } else {
                FSSecondaryButton(String(localized: "Close"), block: true) { onClose() }
            }
        case .done(let setUpRecovery):
            Text(Self.changed).font(FS.font.h2()).accessibilityIdentifier("change-key-done")
            Text(Self.othersKeepWorking).font(FS.font.body())
            if setUpRecovery {
                Text(AccountKeyRotationCenter.recoveryOffLine).font(FS.font.body())
                FSPrimaryButton(String(localized: "Set up cloud recovery"), block: true) { onSetUpRecovery() }
                    .accessibilityIdentifier("change-key-setup-recovery")
            }
            FSSecondaryButton(String(localized: "Done"), block: true) { onClose() }
        }
    }

    @ViewBuilder
    private func summary(_ c: FSColors, _ s: RotateAccountKeyViewModel.Summary) -> some View {
        if s.adminKeyChangesFirst {
            Text(RotateAccountKeyViewModel.adminFirstLine(s.removedName)).font(FS.font.body().weight(.semibold))
        }
        bullet(Self.othersKeepWorking)
        bullet(Self.serversSwitch)
        if !s.excluded.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s1) {
                Text(Self.addAgainHeader).font(FS.font.body())
                ForEach(s.excluded) { row in
                    Text(row.line).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("change-key-excluded-\(row.deviceId)")
                }
            }
        }
        bullet(Self.browsersApprove)
        if s.hasRecovery { bullet(Self.recoveryAgain) }
        bullet(Self.oldBackups)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: FS.space.s2) {
            Text("•").font(FS.font.body())
            Text(text).font(FS.font.body()).fixedSize(horizontal: false, vertical: true)
        }
    }
}
