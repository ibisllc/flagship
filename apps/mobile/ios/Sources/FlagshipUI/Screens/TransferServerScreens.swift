import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Small inline callout (success/info/danger) — the transfer screens don't need
/// the full toast machinery, just a tinted strip.
private struct TransferCallout: View {
    @Environment(\.colorScheme) private var scheme
    enum Kind { case success, info, danger }
    let kind: Kind
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        let color: Color = kind == .success ? c.success : (kind == .danger ? c.danger : c.primary)
        Text(text)
            .font(FS.font.bodySm())
            .foregroundColor(c.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(FS.space.s3)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
    }
}

/// GIVER: the irreversible "Transfer to another account" flow on server-detail.
/// Type-to-confirm the FQDN, pass the biometric, then show the QR for the
/// acquirer to scan. Mirrors the webapp giver card.
public struct TransferGiverScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: TransferGiverViewModel
    @State private var typed = ""
    private let serverDomain: String

    public init(vm: TransferGiverViewModel, serverDomain: String) {
        _vm = State(initialValue: vm)
        self.serverDomain = serverDomain
    }

    private var confirmed: Bool { typed.lowercased() == serverDomain.lowercased() }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.phase {
                case .idle, .signing, .posting:
                    warning(c)
                case .awaitingClaim, .resealing:
                    qrSection(c)
                case .completed(let newDomain):
                    completed(c, newDomain)
                case .failed(let msg):
                    TransferCallout(kind: .danger, text: msg)
                    warning(c)
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Transfer box")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var working: Bool {
        if case .signing = vm.phase { return true }
        if case .posting = vm.phase { return true }
        return false
    }

    @ViewBuilder private func warning(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Transfer to another account")
                .font(FS.font.h2()).foregroundColor(c.text)
            Text("This hands \(serverDomain) and ALL its contents to another account. You will lose control of it. This cannot be undone.")
                .font(FS.font.body()).foregroundColor(c.textMuted)
            Text("Type the server's address to confirm:")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            TextField(serverDomain, text: $typed)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(FS.space.s3)
                .background(c.surface)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                .accessibilityIdentifier("transfer-confirm-field")
            FSDangerButton(working ? "Working…" : "Transfer this box", block: true) {
                if confirmed && !working { Task { await vm.start() } }
            }
            .opacity(confirmed ? 1 : 0.4)
            .accessibilityIdentifier("transfer-start")
        }
    }

    @ViewBuilder private func qrSection(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Have the new owner scan this")
                .font(FS.font.h3()).foregroundColor(c.text)
            Text("On their phone: Add a server → Take over a transferred box. Keep this screen open until it completes — your phone hands off the disk key after they claim it.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            if let text = vm.qrText {
                HStack { Spacer(); PairingQRView(text: text, size: 240); Spacer() }
            }
            if case .resealing = vm.phase {
                TransferCallout(kind: .info, text: "They claimed it — handing off the disk key…")
            } else {
                ProgressView("Waiting for the new owner…")
            }
        }
        .task {
            while case .awaitingClaim = vm.phase {
                if await vm.pollOnce() { break }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    @ViewBuilder private func completed(_ c: FSColors, _ newDomain: String?) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            TransferCallout(kind: .success, text: "Transfer complete. \(serverDomain) now belongs to the new owner\(newDomain.map { " (now \($0))" } ?? "").")
            Text("It's no longer in your fleet.").font(FS.font.body()).foregroundColor(c.textMuted)
        }
    }
}

/// ACQUIRER: "Take over a transferred box" — scan the giver's QR, then confirm
/// to claim ownership. Mirrors the webapp acquirer entry on the add-server
/// chooser.
public struct TransferAcquirerScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: TransferAcquirerViewModel
    @State private var scanning = true

    public init(vm: TransferAcquirerViewModel) {
        _vm = State(initialValue: vm)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.phase {
                case .idle:
                    scanner(c)
                case .scanned(let domain):
                    confirm(c, domain)
                case .signing, .posting:
                    ProgressView("Claiming the box…")
                case .claimed(let newDomain):
                    TransferCallout(kind: .success, text: "You now own \(newDomain ?? "this box"). It will come online under your account shortly.")
                case .failed(let msg):
                    TransferCallout(kind: .danger, text: msg)
                    FSSecondaryButton("Scan again") { vm.resetForRescan(); scanning = true }
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Take over a box")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder private func scanner(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Point your camera at the transfer code")
                .font(FS.font.h3()).foregroundColor(c.text)
            Text("The current owner shows it from their box's page (Transfer to another account).")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            QRScannerView(
                onScan: { text in if scanning { scanning = false; _ = vm.ingest(text) } },
                validate: { ServerTransferFlow.looksLikeTransferQR($0) }
            )
            .frame(height: 320)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
            .accessibilityIdentifier("transfer-scanner")
        }
    }

    private var claiming: Bool {
        if case .signing = vm.phase { return true }
        if case .posting = vm.phase { return true }
        return false
    }

    @ViewBuilder private func confirm(_ c: FSColors, _ domain: String) -> some View {
        // Take-over is IRREVERSIBLE (ownership change + disk re-seal) ⇒ a SEVERE
        // tiered confirm: danger color + type-the-FQDN + the claim biometric
        // (fired inside vm.confirm()). What you see (domain) is what you sign —
        // the same verified offer bytes drive both the display and the claim.
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Take over this box?").font(FS.font.h2()).foregroundColor(c.text)
            TieredConfirmationSheet(
                severity: .severe,
                title: "You will become the owner of \(domain)",
                message: "You'll own \(domain) and everything on it. The current owner loses control of it. This cannot be undone.",
                confirmPhrase: domain,
                confirmFieldLabel: "Type the box's address to confirm:",
                actionTitle: "Take ownership",
                busy: claiming
            ) {
                Task { await vm.confirm() }
            }
            .accessibilityIdentifier("transfer-claim")
        }
    }
}
