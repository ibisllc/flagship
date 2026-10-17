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
            FSSectionLabel("Diagnostics")
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
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
                                .font(FS.font.scaled(11, design: .monospaced))
                                .foregroundColor(c.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 280)
                        .padding(FS.space.s2)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
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
