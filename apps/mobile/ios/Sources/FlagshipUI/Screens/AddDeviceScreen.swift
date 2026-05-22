import SwiftUI
import Flagship
import FlagshipCore

/// Phase 3b — ADMIN side of cross-device QR pairing. Settings → Devices
/// → Add device. Shows a pairing QR (a `/join` universal link), runs the
/// admin relay role via `AddDeviceViewModel`, and walks the admin
/// through: show QR → device connects → confirm the SAS match → seal +
/// send the UMK bundle.
///
/// SAFEGUARDS: the QR is blanked under screen capture + the session is
/// invalidated on screenshot (`captureProtected`); a prominent risk
/// warning is always on screen; the underlying session has a 90s TTL.
public struct AddDeviceScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    let vm: AddDeviceViewModel

    public init(vm: AddDeviceViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                riskWarning(c)
                content(c)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Add a device")
        .navigationBarTitleDisplayMode(.inline)
        .captureProtected { vm.invalidate(reason: "We hid this code because a screenshot was taken. Start again to add a device.") }
        .task { await vm.start() }
        .onDisappear { Task { await vm.cancel() } }
    }

    // MARK: - Risk warning (safeguard #2)

    private func riskWarning(_ c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(c.warning)
                VStack(alignment: .leading, spacing: FS.space.s1) {
                    Text("This shares your account keys")
                        .font(FS.font.h4()).foregroundColor(c.text)
                    Text("Anyone who scans this code can join your account. Only add a device for a person you trust. The code is for one device and expires shortly.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
        }
    }

    // MARK: - Phase content

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        switch vm.phase {
        case .waitingForDevice(let qrUrl):
            qrCard(c, qrUrl: qrUrl, waiting: true, matchCode: nil)
        case .confirmMatch(let qrUrl, let matchCode, let gateExpired):
            qrCard(c, qrUrl: qrUrl, waiting: false, matchCode: matchCode)
            confirmCard(c, matchCode: matchCode, gateExpired: gateExpired)
        case .admitting:
            statusCard(c, system: "lock.shield", title: "Sharing your account key…", detail: "Hold on — sending the keys securely to the new device.")
        case .admitted:
            statusCard(c, system: "checkmark.seal.fill", title: "Device added", detail: "The new device joined as a peer and is under a 14-day review window. You'll be reminded to check your trusted devices.")
            FSPrimaryButton("Done", block: true) { dismiss() }
        case .failed(let msg):
            statusCard(c, system: "xmark.octagon", title: "Couldn't add the device", detail: msg)
            FSSecondaryButton("Try again", block: true) { Task { await vm.start() } }
        case .invalidated(let msg):
            statusCard(c, system: "eye.slash", title: "Pairing cancelled", detail: msg)
            FSSecondaryButton("Start again", block: true) { Task { await vm.start() } }
        }
    }

    private func qrCard(_ c: FSColors, qrUrl: String, waiting: Bool, matchCode: String?) -> some View {
        FSCard(padding: FS.space.s8) {
            VStack(spacing: FS.space.s4) {
                PairingQRView(text: qrUrl, size: 220)
                if waiting {
                    HStack(spacing: FS.space.s2) {
                        ProgressView()
                        Text("Waiting for the other device to scan…")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                } else {
                    Text("Scanned — now compare the codes.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func confirmCard(_ c: FSColors, matchCode: String, gateExpired: Bool) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Check the codes match")
                    .font(FS.font.h4()).foregroundColor(c.text)
                Text("Both screens should show the same six digits. If they don't, stop — someone may be in the middle.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Text(QrRelay.formatMatchCode(matchCode))
                    .font(.system(size: 34, weight: .semibold, design: .monospaced))
                    .tracking(6)
                    .foregroundColor(c.text)
                    .frame(maxWidth: .infinity)
                FSPrimaryButton("Confirm codes match", enabled: gateExpired, block: true) {
                    Task { await vm.confirmMatch() }
                }
            }
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
}
