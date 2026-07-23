import SwiftUI
import FlagshipAPI
import FlagshipCore

/// v1.2 Phase 4 — Settings → Account security. Surfaces the
/// account-type badge ("Single-device" vs "Multi-device + 2FA") +
/// the entry point into the four-step enrollment sheet.
///
/// The screen is intentionally lightweight. The heavy lifting lives
/// in AccountSecurityEnableSheet — this is just the badge + toggle.
public struct AccountSecurityScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var showEnableSheet = false
    @State private var showDisableSheet = false
    @State private var disableCode: String = ""
    @State private var watchVM: WatchDelegateViewModel?
    @State private var rotateVM: RotateAdminRootViewModel?
    @State private var showRotateConfirm = false
    @State private var reEscrowPassphrase = ""
    @Bindable var viewModel: AccountSecurityViewModel

    public init(viewModel: AccountSecurityViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text("Manage recovery protection and account-level security.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, FS.space.s4)

                badge(c: c)
                explainer(c: c)
                actions(c: c)

                if let watchVM {
                    watchSection(c: c, vm: watchVM)
                }

                if let rotateVM, rotateVM.canRotate {
                    rotateAdminSection(c: c, vm: rotateVM)
                }

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Account security")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if watchVM == nil { watchVM = viewModel.makeWatchDelegateViewModel() }
            if rotateVM == nil { rotateVM = viewModel.makeRotateAdminRootViewModel() }
            await viewModel.load()
            await watchVM?.load()
        }
        .alert(
            "Rotate your admin key?",
            isPresented: $showRotateConfirm
        ) {
            Button("Rotate admin key", role: .destructive) {
                Task { await rotateVM?.rotate() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Use this only if a device may be lost or stolen. It replaces your admin key everywhere and REMOVES admin from every other device — they'll need to recover to regain it. This can't be undone.")
        }
        .sheet(isPresented: $showEnableSheet) {
            AccountSecurityEnableSheet(viewModel: viewModel) {
                showEnableSheet = false
                Task { await viewModel.load() }
            }
        }
        .alert(
            "Disable multi-device + 2FA?",
            isPresented: $showDisableSheet
        ) {
            TextField("6-digit code or recovery code", text: $disableCode)
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
            Button("Disable", role: .destructive) {
                Task {
                    await viewModel.disableEnrollment(code: disableCode)
                    disableCode = ""
                    showDisableSheet = false
                }
            }
            Button("Cancel", role: .cancel) {
                disableCode = ""
                showDisableSheet = false
            }
        } message: {
            Text("Drops your TOTP secret + recovery codes. The account goes back to single-device + 3-day recovery grace. Refused while other trusted devices exist.")
        }
    }

    @ViewBuilder
    private func badge(c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: viewModel.isMultiDevice ? "checkmark.shield.fill" : "shield.lefthalf.filled")
                    .imageScale(.large)
                    .foregroundColor(viewModel.isMultiDevice ? c.success : c.primary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(viewModel.isMultiDevice ? "Multi-device + 2FA" : "Single-device account")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(c.text)
                        .accessibilityIdentifier("account-security-badge")
                    Text(viewModel.isMultiDevice
                         ? "Account recovery requires a 6-digit TOTP code (or a recovery code) plus a 24-hour grace window."
                         : "Account recovery uses a 3-day waiting period during which your other devices can object.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func explainer(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(viewModel.isMultiDevice ? "Currently enabled" : "Why enable this?")
                .font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            Text(viewModel.isMultiDevice
                 ? "Your TOTP secret was generated on this device on \(formattedDate(viewModel.totpEnrolledAt)). Store your recovery codes somewhere safe — they're the only way back in if your authenticator app is lost."
                 : "A second factor outside Apple's iCloud Keychain. If your iCloud password is ever compromised, the attacker still needs a live 6-digit code from your authenticator app to take over your account.")
                .font(FS.font.bodySm())
                .foregroundColor(c.text)
        }
    }

    @ViewBuilder
    private func actions(c: FSColors) -> some View {
        VStack(spacing: FS.space.s3) {
            if viewModel.isMultiDevice {
                FSDangerButton("Disable multi-device + 2FA", block: true) {
                    showDisableSheet = true
                }
                .accessibilityIdentifier("account-security-disable-btn")
            } else {
                FSPrimaryButton("Enable multi-device + 2FA", block: true, large: true) {
                    showEnableSheet = true
                }
                .accessibilityIdentifier("account-security-enable-btn")
            }
            if case .failed(let msg) = viewModel.phase {
                Text(msg)
                    .font(FS.font.caption())
                    .foregroundColor(c.danger)
                    .accessibilityIdentifier("account-security-failed-msg")
            }
        }
    }

    /// "Quick approve from Apple Watch" — the opt-in watch-delegate toggle
    /// (docs/watch-delegate-key-design.md §4). Default-OFF. Flipping it on
    /// mints a boot-approval-only delegate key (one Face ID); off revokes it.
    @ViewBuilder
    private func watchSection(c: FSColors, vm: WatchDelegateViewModel) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Toggle(isOn: Binding(
                    get: { vm.isEnabled },
                    set: { want in
                        Task { want ? await vm.enable() : await vm.disable() }
                    }
                )) {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "applewatch")
                            .foregroundColor(c.primary)
                        Text("Quick approve from Apple Watch")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(c.text)
                    }
                }
                .accessibilityIdentifier("watch-delegate-toggle")
                .disabled(vm.phase == .enabling || vm.phase == .disabling)

                Text("Approve a server boot from your Watch without unlocking your iPhone. Other actions — revoke server, wipe & restart, replace device — always require Face ID. Off by default.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)

                if vm.isEnabled, let exp = vm.expiresAt {
                    Text("Active — renews by \(formattedDate(exp))")
                        .font(FS.font.caption())
                        .foregroundColor(c.success)
                }
                if case .failed(let msg) = vm.phase {
                    Text(msg)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("watch-delegate-failed-msg")
                }
            }
        }
    }

    /// Slice D §5 — "Rotate admin key" (a device-may-be-compromised remedy).
    /// Shown ONLY on a device that holds the admin master root. Rotating mints
    /// a fresh root, signs an `old → new` proof under the old root, publishes
    /// it, and re-seals the new root here — which revokes admin from every
    /// OTHER device (they hold the old root). When recovery is enrolled, an
    /// inline follow-up step (`reEscrowStep`) re-wraps the NEW root under the
    /// existing recovery credential.
    @ViewBuilder
    private func rotateAdminSection(c: FSColors, vm: RotateAdminRootViewModel) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "key.horizontal.fill").foregroundColor(c.danger)
                    Text("Rotate admin key")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(c.text)
                }
                Text("If a device might be lost or stolen, rotate your admin key. It becomes the only admin key; every other device loses admin until it recovers.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)

                switch vm.phase {
                case .rotating:
                    HStack(spacing: FS.space.s2) {
                        ProgressView()
                        Text("Rotating…").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                case .rotated:
                    Text("Admin key rotated. Other devices must recover to regain admin.")
                        .font(FS.font.caption())
                        .foregroundColor(c.success)
                        .accessibilityIdentifier("rotate-admin-done-msg")
                    if vm.didSkipRecoveryUpdate {
                        Text("Your recovery backup still holds your old admin key. Re-run recovery setup to fix this.")
                            .font(FS.font.caption())
                            .foregroundColor(c.warning)
                            .accessibilityIdentifier("rotate-admin-reescrow-skipped-msg")
                    }
                case .rotatedNeedsRecoveryUpdate:
                    reEscrowStep(c: c, vm: vm)
                case .failed(let msg):
                    Text(msg)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("rotate-admin-failed-msg")
                default:
                    EmptyView()
                }

                FSDangerButton("Rotate admin key", block: true) {
                    showRotateConfirm = true
                }
                .accessibilityIdentifier("rotate-admin-btn")
                .disabled(vm.phase == .rotating || awaitingReEscrow(vm) || vm.isUpdatingRecoveryBackup)
            }
        }
    }

    private func awaitingReEscrow(_ vm: RotateAdminRootViewModel) -> Bool {
        if case .rotatedNeedsRecoveryUpdate = vm.phase { return true }
        return false
    }

    /// Slice D §5.3 (D-3) — inline post-rotation step: the recovery envelope
    /// still wraps the OLD admin root, so the user re-derives the wrap key
    /// (recovery passphrase + WebAuthn PRF) to re-escrow the NEW one. Skipping
    /// is allowed — the rotation is already done — but leaves recovery
    /// restoring a dead admin key until recovery setup is re-run.
    @ViewBuilder
    private func reEscrowStep(c: FSColors, vm: RotateAdminRootViewModel) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Your admin key changed. Enter your recovery passphrase to update your recovery backup — otherwise recovery would restore the OLD admin key.")
                .font(FS.font.caption())
                .foregroundColor(c.text)

            SecureField("Recovery passphrase", text: $reEscrowPassphrase)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.vertical, 10)
                .padding(.horizontal, 12)
                .background(c.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.md)
                        .stroke(c.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                .accessibilityIdentifier("rotate-admin-reescrow-passphrase")

            if let err = vm.recoveryUpdateError {
                Text(err)
                    .font(FS.font.caption())
                    .foregroundColor(c.danger)
                    .accessibilityIdentifier("rotate-admin-reescrow-error")
            }
            if vm.isUpdatingRecoveryBackup {
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("Updating recovery backup…")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }

            FSPrimaryButton(
                "Update recovery backup",
                enabled: !reEscrowPassphrase.isEmpty && !vm.isUpdatingRecoveryBackup,
                block: true
            ) {
                Task {
                    await vm.updateRecoveryBackup(passphrase: reEscrowPassphrase)
                    if case .rotated = vm.phase { reEscrowPassphrase = "" }
                }
            }
            .accessibilityIdentifier("rotate-admin-reescrow-btn")

            FSGhostButton("Skip for now", block: true) {
                vm.skipRecoveryUpdate()
                reEscrowPassphrase = ""
            }
            .accessibilityIdentifier("rotate-admin-reescrow-skip")
        }
    }

    private func formattedDate(_ ms: Int64?) -> String {
        guard let ms else { return "an unknown date" }
        return Date.flagshipFormatted(epochMs: ms)
    }
}

/// v1.2 Phase 4 — four-step enrollment sheet. Step indices follow
/// the spec literally:
///
///   1. Explainer + Continue.
///   2. POST /enroll-begin → render QR + show base32 secret.
///   3. User enters sample 6-digit code → POST /enroll-confirm.
///   4. Recovery-codes display gated behind "I've saved these".
///
/// On success the host re-loads the parent screen so the badge
/// flips from "Single-device" to "Multi-device + 2FA".
struct AccountSecurityEnableSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var viewModel: AccountSecurityViewModel
    @State private var sampleCode: String = ""
    @State private var savedRecoveryCodes = false
    var onClose: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    switch viewModel.phase {
                    case .idle, .beginning:
                        step1(c: c)
                    case .staged(let s):
                        step2(c: c, staged: s)
                    case .confirming:
                        step3Pending(c: c)
                    case .confirmed(let result):
                        step4(c: c, codes: result.recoveryCodes)
                    case .failed(let msg):
                        failedRow(c: c, message: msg)
                    case .disabling, .disabled:
                        // Not reachable from the enable sheet — the
                        // disable flow lives on the parent screen.
                        EmptyView()
                    }
                }
                .padding(FS.space.s6)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle("Enable multi-device + 2FA")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onClose() }
                        .disabled(viewModel.isMidEnrollment && !savedRecoveryCodes && !viewModel.canCloseEarly)
                }
            }
        }
    }

    @ViewBuilder
    private func step1(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Step 1 of 4")
                .font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            Text("You'll need an authenticator app like 1Password, Google Authenticator, or Authy. We'll show a QR code and a manual key — scan or paste either one.")
                .foregroundColor(c.text)
            Text("After 2FA is on, account recovery becomes a 24-hour grace window that requires your 6-digit code (or a recovery code) instead of the 3-day waiting period.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            FSPrimaryButton("Continue", block: true, large: true) {
                Task { await viewModel.beginEnrollment() }
            }
            .accessibilityIdentifier("account-security-step1-continue")
            if case .beginning = viewModel.phase {
                ProgressView().padding(.top, FS.space.s2)
            }
        }
    }

    @ViewBuilder
    private func step2(c: FSColors, staged: AccountSecurityViewModel.StagedSecret) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Step 2 of 4 — scan or paste")
                .font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                if let image = pngImage(fromBase64: staged.qrPngBase64) {
                    image
                        .resizable()
                        .interpolation(.none)
                        .scaledToFit()
                        .frame(width: 200, height: 200)
                        .accessibilityIdentifier("account-security-qr")
                } else {
                    // QR generation failed on the Worker side — surface
                    // the otpauth URL as a tappable alternative.
                    Text(staged.otpauthUrl)
                        .font(FS.font.mono())
                        .foregroundColor(c.text)
                        .textSelection(.enabled)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Or paste this manual key:")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                Text(staged.secret)
                    .font(FS.font.mono())
                    .foregroundColor(c.text)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("account-security-manual-secret")
            }
            Text("Step 3 — enter the 6-digit code your authenticator shows.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            TextField("123456", text: $sampleCode)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.system(size: 22, weight: .medium, design: .monospaced))
                .multilineTextAlignment(.center)
                .padding(.vertical, 12)
                .background(c.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.md)
                        .stroke(c.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                .accessibilityIdentifier("account-security-sample-code")
            FSPrimaryButton(
                "Verify code",
                enabled: sampleCode.trimmingCharacters(in: .whitespaces).count == 6,
                block: true,
                large: true
            ) {
                Task { await viewModel.confirmEnrollment(sampleCode: sampleCode) }
            }
            .accessibilityIdentifier("account-security-verify-btn")
        }
    }

    @ViewBuilder
    private func step3Pending(c: FSColors) -> some View {
        VStack(alignment: .center, spacing: FS.space.s4) {
            ProgressView()
            Text("Verifying your code…").foregroundColor(c.textMuted)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func step4(c: FSColors, codes: [String]) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundColor(c.success)
                Text("Step 4 of 4 — save your recovery codes")
                    .font(.system(size: 14, weight: .semibold)).foregroundColor(c.text)
            }
            Text("Print these or store them in a password manager. Each code works once if you lose your authenticator. They're the ONLY way back in.")
                .foregroundColor(c.text)
            FSCard {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(codes.enumerated()), id: \.offset) { _, code in
                        Text(code)
                            .font(FS.font.mono())
                            .foregroundColor(c.text)
                            .textSelection(.enabled)
                    }
                }
                .accessibilityIdentifier("account-security-recovery-codes")
            }
            Toggle(isOn: $savedRecoveryCodes) {
                Text("I've saved these somewhere safe")
                    .foregroundColor(c.text)
            }
            .accessibilityIdentifier("account-security-saved-toggle")
            FSPrimaryButton(
                "Done",
                enabled: savedRecoveryCodes,
                block: true,
                large: true
            ) {
                viewModel.dismissEnrollment()
                onClose()
            }
            .accessibilityIdentifier("account-security-done-btn")
        }
    }

    @ViewBuilder
    private func failedRow(c: FSColors, message: String) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.danger)
                Text("Something went wrong")
                    .font(.system(size: 14, weight: .semibold)).foregroundColor(c.danger)
            }
            Text(message).foregroundColor(c.text)
                .accessibilityIdentifier("account-security-failed-msg")
            FSSecondaryButton("Start over", block: true) {
                viewModel.dismissEnrollment()
                sampleCode = ""
            }
            FSGhostButton("Close", block: true) {
                viewModel.dismissEnrollment()
                onClose()
            }
        }
    }

    /// Decode the base64 PNG returned by the Worker. Returns nil on
    /// a decode failure; the caller falls back to rendering the
    /// otpauth URL as plain text so manual entry still works.
    private func pngImage(fromBase64 base64: String) -> Image? {
        guard let data = Data(base64Encoded: base64), let ui = UIImage(data: data) else {
            return nil
        }
        return Image(uiImage: ui)
    }
}

extension AccountSecurityViewModel {
    /// True iff the user is mid-enrollment AND closing now would lose
    /// the recovery codes. Used by the sheet's toolbar Close button
    /// to gate dismissal until the codes are saved.
    var isMidEnrollment: Bool {
        switch phase {
        case .staged, .confirming, .confirmed: return true
        default: return false
        }
    }

    /// Only step-2 (staged) can be cancelled cleanly without losing
    /// state; step-4 (confirmed-but-codes-not-saved) MUST gate.
    var canCloseEarly: Bool {
        if case .confirmed = phase { return false }
        return true
    }
}
