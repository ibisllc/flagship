import SwiftUI
import FlagshipCore

/// Presented after the WebAuthn-PRF recovery flow successfully
/// unwraps the UMK on this device. The user picks how this fresh
/// device should relate to their other trusted devices:
///
///   - Keep both devices working (no rotation; default).
///   - Replace a lost device (IRK rotation via /re-pair).
///   - Wipe & restart (UMK + passkey rotation; v1.1, dimmed in v1).
///
/// The choice carries different cryptographic blast radii. The
/// scare-warning copy is verbatim from docs/revocation-ui.md so
/// the wording is reviewable in one place.
public struct PostRecoveryChoiceScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var selection: RecoveryChoice = .keepBothDevices

    /// True only in v1.1, when the Wipe & restart code path is
    /// shipped. v1 renders the row dimmed with a "Coming soon"
    /// caption.
    public let wipeAndRestartEnabled: Bool

    /// Fires when the user taps Continue with a valid selection.
    /// Host wires this to the right rotation flow.
    public var onContinue: (RecoveryChoice) -> Void

    public init(
        wipeAndRestartEnabled: Bool = false,
        onContinue: @escaping (RecoveryChoice) -> Void = { _ in }
    ) {
        self.wipeAndRestartEnabled = wipeAndRestartEnabled
        self.onContinue = onContinue
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s8)
                header(c: c)
                VStack(spacing: FS.space.s3) {
                    optionRow(.keepBothDevices, c: c)
                    optionRow(.replaceLostDevice, c: c)
                    optionRow(.wipeAndRestart, c: c)
                }
                Spacer().frame(height: FS.space.s4)
                FSPrimaryButton(
                    continueLabel,
                    enabled: continueEnabled,
                    block: true,
                    large: true
                ) {
                    onContinue(selection)
                }
                .accessibilityIdentifier("post-recovery-continue")
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Welcome back")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var continueLabel: String {
        switch selection {
        case .keepBothDevices:    return "Continue"
        case .replaceLostDevice:  return "Replace device"
        case .wipeAndRestart:     return "Wipe & restart"
        }
    }

    private var continueEnabled: Bool {
        if selection == .wipeAndRestart && !wipeAndRestartEnabled { return false }
        return true
    }

    @ViewBuilder
    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Welcome back to Flagship on this device.")
                .font(FS.font.h2()).foregroundColor(c.text)
            Text("How should this device relate to your other trusted devices?")
                .font(FS.font.body()).foregroundColor(c.textMuted)
        }
    }

    private func optionRow(_ choice: RecoveryChoice, c: FSColors) -> some View {
        let dimmed = choice == .wipeAndRestart && !wipeAndRestartEnabled
        let isSelected = selection == choice
        return Button {
            if !dimmed { selection = choice }
        } label: {
            HStack(alignment: .top, spacing: FS.space.s3) {
                radioGlyph(filled: isSelected, c: c, dimmed: dimmed)
                    .frame(width: 22)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack(spacing: 6) {
                        Text(titleFor(choice))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(dimmed ? c.textMuted : c.text)
                        if let icon = warningIconFor(choice) {
                            Image(systemName: icon).foregroundColor(c.danger).imageScale(.small)
                        }
                        Spacer()
                        if dimmed {
                            Text("Coming soon")
                                .font(FS.font.caption()).foregroundColor(c.textMuted)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(c.surfaceSunken).clipShape(Capsule())
                        }
                    }
                    Text(subtitleFor(choice))
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(FS.space.s4)
            .background(isSelected ? c.primary.opacity(0.06) : c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.md)
                    .stroke(isSelected ? c.primary : c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        }
        .buttonStyle(.plain)
        .disabled(dimmed)
        .accessibilityIdentifier(accessibilityIdFor(choice))
    }

    private func radioGlyph(filled: Bool, c: FSColors, dimmed: Bool) -> some View {
        ZStack {
            Circle()
                .stroke(dimmed ? c.textMuted : (filled ? c.primary : c.border), lineWidth: 2)
                .frame(width: 22, height: 22)
            if filled {
                Circle().fill(c.primary).frame(width: 10, height: 10)
            }
        }
    }

    private func titleFor(_ c: RecoveryChoice) -> String {
        switch c {
        case .keepBothDevices:    return "Keep my other devices working"
        case .replaceLostDevice:  return "Replace a device I lost"
        case .wipeAndRestart:     return "Wipe & restart"
        }
    }

    private func subtitleFor(_ c: RecoveryChoice) -> String {
        switch c {
        case .keepBothDevices:
            return "Default. Both this device and any other devices you've already paired stay logged in."
        case .replaceLostDevice:
            return "Rotates your account's identity. Your servers will treat the lost device as expired within ~5 minutes. Cannot be undone."
        case .wipeAndRestart:
            return "Replaces your UMK and recovery passkey. Even an attacker holding your old device AND your old passkey is locked out. Cannot be undone."
        }
    }

    private func warningIconFor(_ c: RecoveryChoice) -> String? {
        switch c {
        case .keepBothDevices:    return nil
        case .replaceLostDevice:  return "exclamationmark.triangle.fill"
        case .wipeAndRestart:     return "exclamationmark.octagon.fill"
        }
    }

    private func accessibilityIdFor(_ c: RecoveryChoice) -> String {
        switch c {
        case .keepBothDevices:    return "post-recovery-keep-both"
        case .replaceLostDevice:  return "post-recovery-replace-lost"
        case .wipeAndRestart:     return "post-recovery-wipe-restart"
        }
    }
}
