import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// Diagnostics card on the server-detail screen: fetch + show the box's recent
/// systemd journal. Owner-only (the fetch is IRK-signed behind the biometric)
/// and box-direct — flagshipserver.com never sees the request or the logs.
/// A read, so the lines surface inline in a scrollable monospace block.
///
/// Self-contained like the other server-detail cards: reads the box-direct
/// client + toasts from the environment.
struct JournalCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.lockPowerClient) private var client
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var vm: JournalViewModel?
    @State private var unit = JournalUnits.defaultUnit

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("DIAGNOSTICS")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Read the box's recent system log when a server is online but something isn't working. Only you can — it's signed with your key and never leaves your server.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    if JournalUnits.all.count > 1 {
                        Picker("Unit", selection: $unit) {
                            ForEach(JournalUnits.all, id: \.self) { u in Text(u).tag(u) }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("sd-journal-unit")
                    }
                    FSSecondaryButton(isLoading ? "Fetching…" : "View journal", block: true) {
                        Task { await fetch() }
                    }
                    .disabled(isLoading)
                    .accessibilityIdentifier("sd-journal-fetch")
                    if case .loaded(let u, let lines) = vm?.phase {
                        ScrollView {
                            Text(lines.isEmpty ? "(\(u): journal is empty)" : lines.joined(separator: "\n"))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(c.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 280)
                        .padding(FS.space.s2)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                    }
                }
            }
        }
    }

    private var isLoading: Bool {
        if case .loading = vm?.phase { return true }
        return false
    }

    @MainActor
    private func fetch() async {
        let m = vm ?? JournalViewModel(client: client, serverDomain: serverDomain)
        vm = m
        await m.load(unit: unit, lines: JournalUnits.defaultLines)
        if case .failed(let msg) = m.phase { toasts.error(msg) }
    }
}
