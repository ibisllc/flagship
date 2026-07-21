import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Small inline callout (success/info/danger) — mirrors the transfer screen's
/// tinted strip.
private struct ReplaceCallout: View {
    @Environment(\.colorScheme) private var scheme
    enum Kind { case success, info, danger, warning }
    let kind: Kind
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        let color: Color = {
            switch kind {
            case .success: return c.success
            case .danger: return c.danger
            case .warning: return c.warning
            case .info: return c.primary
            }
        }()
        Text(text)
            .font(FS.font.bodySm())
            .foregroundColor(c.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(FS.space.s3)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
    }
}

/// "Replace this server" — the graceful-decommission owner flow
/// (docs/server-replacement-graceful-decommission.md). Pre-flight backup gate →
/// disposition picker → mint + sign + deposit → progress → completion that
/// points at the existing create-server flow for the replacement.
public struct ReplaceServerScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: ReplaceServerViewModel
    @State private var typed = ""
    @State private var disposition: ReplaceServerFlow.Disposition = .wipeAfterHandoff
    @State private var started = false
    private let serverFqdn: String

    public init(vm: ReplaceServerViewModel, serverFqdn: String) {
        _vm = State(initialValue: vm)
        self.serverFqdn = serverFqdn
    }

    private var confirmed: Bool { typed.lowercased() == serverFqdn.lowercased() }

    private var working: Bool {
        switch vm.phase {
        case .signing, .posting: return true
        default: return false
        }
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.phase {
                case .checkingBackup:
                    ProgressView("Checking this server's backup…")
                case .backupGate:
                    backupGate(c)
                case .ready:
                    picker(c, gated: false)
                case .signing, .posting:
                    ProgressView("Replacing this server…")
                case .completed(let d):
                    completed(c, d)
                case .failed(let msg):
                    ReplaceCallout(kind: .danger, text: msg)
                    if vm.backupMissing { backupGate(c) } else { picker(c, gated: false) }
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Replace server")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !started { started = true; await vm.preflight() }
        }
    }

    // MARK: - Backup pre-flight gate (HARD)

    @ViewBuilder private func backupGate(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("This server has no backup")
                .font(FS.font.h2()).foregroundColor(c.text)
            ReplaceCallout(
                kind: .warning,
                text: "Replacing \(serverFqdn) retires the box and powers it off. With no peer-backup enrolled, its data has nowhere to go — replacing it will LOSE everything on it."
            )
            Text("Set up backup first (recommended), or — if you accept losing this server's data — replace it now with an immediate wipe.")
                .font(FS.font.body()).foregroundColor(c.textMuted)

            Text("To replace anyway, type the server's address to confirm:")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            confirmField(c)

            FSDangerButton(working ? "Working…" : "Wipe now & replace (lose data)", block: true) {
                if confirmed && !working { Task { await vm.replace(disposition: .wipeNow) } }
            }
            .opacity(confirmed ? 1 : 0.4)
            .accessibilityIdentifier("replace-wipe-now-accept-loss")
        }
    }

    // MARK: - Disposition picker (backup present)

    @ViewBuilder private func picker(_ c: FSColors, gated: Bool) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Replace this server")
                .font(FS.font.h2()).foregroundColor(c.text)
            Text("This retires \(serverFqdn): it flushes a final backup, releases its address, and powers off — so a replacement box can take over the same name cleanly. Choose what happens to its disk.")
                .font(FS.font.body()).foregroundColor(c.textMuted)

            Text("DISK")
                .font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            dispositionRow(c, .wipeAfterHandoff, "Wipe after hand-off (recommended)",
                           "Keeps the old disk as a safety net until the replacement proves a good restore, then scrubs it.")
            dispositionRow(c, .keep, "Keep the disk",
                           "Powers off with data intact — a local fallback copy. The box could be powered on again (it self-retires if so).")
            dispositionRow(c, .wipeNow, "Wipe now",
                           "Flushes the backup, then wipes immediately. The backup becomes the only copy — irreversible.")

            if disposition == .wipeNow {
                ReplaceCallout(kind: .danger, text: "Wipe now is irreversible: once it wipes, the backup is the sole copy. If that final flush fails, the data is gone.")
            }

            Text("Type the server's address to confirm:")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            confirmField(c)

            FSDangerButton(working ? "Working…" : "Replace this server", block: true) {
                if confirmed && !working { Task { await vm.replace(disposition: disposition) } }
            }
            .opacity(confirmed ? 1 : 0.4)
            .accessibilityIdentifier("replace-start")
        }
    }

    @ViewBuilder private func dispositionRow(_ c: FSColors, _ d: ReplaceServerFlow.Disposition, _ title: String, _ detail: String) -> some View {
        Button {
            disposition = d
        } label: {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: disposition == d ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(disposition == d ? c.primary : c.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(FS.font.body()).foregroundColor(c.text)
                    Text(detail).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(FS.space.s3)
            .background(c.surface)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("replace-disposition-\(d.rawValue)")
    }

    @ViewBuilder private func confirmField(_ c: FSColors) -> some View {
        TextField(serverFqdn, text: $typed)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(FS.space.s3)
            .background(c.surface)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
            .accessibilityIdentifier("replace-confirm-field")
    }

    // MARK: - Completion

    @ViewBuilder private func completed(_ c: FSColors, _ d: ReplaceServerFlow.Disposition) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            ReplaceCallout(kind: .success, text: "\(serverFqdn) is being retired. It'll flush its final backup, release its address, and power off.")
            Text("It's been removed from your fleet here, so it won't ask to unlock again. There may be a brief gap while the old box hands off and the new one takes over.")
                .font(FS.font.body()).foregroundColor(c.textMuted)
            Text("Next: create the replacement server (same name) from “Add a server” on Home — burn it, and it restores from the final backup.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
    }
}
