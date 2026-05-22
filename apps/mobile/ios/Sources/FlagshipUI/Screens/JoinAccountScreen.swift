import SwiftUI
import Flagship
import FlagshipCore

/// Phase 3b — INCOMING side of cross-device QR pairing (the collaborator
/// joining a business account). Two entry shapes share this screen:
///   - in-app scanner ("Scan a pairing code"): `joinUrl == nil`, the
///     screen shows the camera until a `/join` QR is read;
///   - deeplink / universal link: `joinUrl` is pre-filled and the screen
///     connects immediately.
///
/// SAFEGUARDS: the scan surface is blanked under screen capture + the
/// session is invalidated on screenshot (`captureProtected`); a clear
/// "you're joining <account> as a quarantined device" warning is shown;
/// the relay session is single-use + short-lived.
public struct JoinAccountScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    let vm: JoinAccountViewModel
    /// Pre-filled when entered via a deeplink/universal link.
    let initialJoinUrl: String?
    /// Mock seam bridge — see JoinAccountViewModel.connect. Production
    /// passes nil.
    let provideRawPubkeyToRelay: ((Data) -> Void)?
    /// Called once the join completes so the host adds the new profile.
    let onJoined: (JoinAccountViewModel.AdmittedProfile) -> Void

    @State private var scanError: String?

    public init(
        vm: JoinAccountViewModel,
        initialJoinUrl: String? = nil,
        provideRawPubkeyToRelay: ((Data) -> Void)? = nil,
        onJoined: @escaping (JoinAccountViewModel.AdmittedProfile) -> Void
    ) {
        self.vm = vm
        self.initialJoinUrl = initialJoinUrl
        self.provideRawPubkeyToRelay = provideRawPubkeyToRelay
        self.onJoined = onJoined
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                content(c)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Join an account")
        .navigationBarTitleDisplayMode(.inline)
        .captureProtected { vm.invalidate(reason: "We cancelled this for your security because a screenshot was taken. Scan the admin's code again to join.") }
        .task {
            if let url = initialJoinUrl {
                await vm.connect(joinUrl: url, provideRawPubkeyToRelay: provideRawPubkeyToRelay)
            }
        }
        .onChange(of: joinedKey) { _, _ in
            if case .joined = vm.phase, let p = vm.admittedProfile {
                onJoined(p)
            }
        }
        .onDisappear { Task { await vm.cancel() } }
    }

    /// Stable key so `.onChange` fires exactly once when we land on
    /// `.joined`.
    private var joinedKey: String {
        if case .joined(let acct, _) = vm.phase { return "joined:\(acct)" }
        return "pending"
    }

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        switch vm.phase {
        case .idle:
            // In-app scanner entry: no pre-filled URL → show the camera.
            scannerCard(c)
        case .connecting:
            statusCard(c, system: "antenna.radiowaves.left.and.right", title: "Connecting…", detail: "Setting up a secure channel with the admin's device.")
        case .awaitingBundle(let matchCode):
            confirmCard(c, matchCode: matchCode)
        case .admitting:
            statusCard(c, system: "lock.shield", title: "Joining…", detail: "Verifying the admin's authorization and installing your account key.")
        case .joined(let account, let quarantineUntil):
            joinedCard(c, account: account, quarantineUntil: quarantineUntil)
        case .failed(let msg):
            statusCard(c, system: "xmark.octagon", title: "Couldn't join", detail: msg)
            FSSecondaryButton("Try again", block: true) { dismiss() }
        case .invalidated(let msg):
            statusCard(c, system: "eye.slash", title: "Cancelled", detail: msg)
            FSSecondaryButton("Close", block: true) { dismiss() }
        }
    }

    // MARK: - Scanner

    private func scannerCard(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "qrcode.viewfinder").foregroundColor(c.primary)
                    Text("Point your camera at the pairing code on the admin's \"Add a device\" screen.")
                        .font(FS.font.bodySm()).foregroundColor(c.text)
                }
            }
            QRScannerView(
                onScan: { raw in
                    Task { await vm.connect(joinUrl: raw, provideRawPubkeyToRelay: provideRawPubkeyToRelay) }
                },
                onError: { msg in scanError = msg },
                validate: { raw in (try? PairingQr.parseJoinUrl(raw)) != nil }
            )
            .frame(height: 320)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
            if let scanError {
                Text(scanError).font(FS.font.caption()).foregroundColor(c.danger)
            }
        }
    }

    // MARK: - SAS confirm (read-only on the incoming side)

    private func confirmCard(_ c: FSColors, matchCode: String) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Confirm with the admin")
                    .font(FS.font.h4()).foregroundColor(c.text)
                Text("These six digits should match the admin's screen. The admin taps \"Confirm\" once they do.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Text(QrRelay.formatMatchCode(matchCode))
                    .font(.system(size: 34, weight: .semibold, design: .monospaced))
                    .tracking(6)
                    .foregroundColor(c.text)
                    .frame(maxWidth: .infinity)
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("Waiting for the admin to confirm…")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
        }
    }

    // MARK: - Joined + quarantine countdown (safeguard #3)

    private func joinedCard(_ c: FSColors, account: String, quarantineUntil: Int64?) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                        Text("Joined \(account)").font(FS.font.h4()).foregroundColor(c.text)
                    }
                    Text("This device is now a peer on the account.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "clock.badge.exclamationmark").foregroundColor(c.warning)
                    VStack(alignment: .leading, spacing: FS.space.s1) {
                        Text("Under review for \(Self.quarantineCopy(quarantineUntil))")
                            .font(FS.font.h4()).foregroundColor(c.text)
                        Text("As a newly-added device you can't remove other devices or get admin access yet. The account owner is asked to review new devices during this window.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                }
            }
            FSPrimaryButton("Continue", block: true) { dismiss() }
        }
    }

    private func statusCard(_ c: FSColors, system: String, title: String, detail: String) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: system).foregroundColor(c.primary)
                    Text(title).font(FS.font.h4()).foregroundColor(c.text)
                }
                Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        }
    }

    /// Human "N days" copy for the quarantine deadline. Defaults to the
    /// 14-day window when no deadline was returned.
    static func quarantineCopy(_ until: Int64?, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
        guard let until, until > now else { return "14 days" }
        let days = Int((Double(until - now) / 86_400_000.0).rounded(.up))
        return days <= 1 ? "1 day" : "\(days) days"
    }
}
