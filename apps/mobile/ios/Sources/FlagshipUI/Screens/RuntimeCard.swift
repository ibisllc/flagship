import SwiftUI
import UIKit
import FlagshipAPI

/// The server page's "Runtime" section (release plan G2): which Node.js the server runs and how it checks out
/// against Node's and Flagship's signatures. Presentation lives in RuntimeVerificationView (shared vectors).
struct RuntimeCard: View {
    @Environment(\.colorScheme) private var scheme
    let view: RuntimeVerificationView

    @State private var showDetails = false
    @State private var showCheck = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Runtime"))
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("Your server runs the official Node.js binary from nodejs.org. Flagship publishes its exact checksum, signed by Flagship's release keys.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    row(String(localized: "Node.js"), c: c) { value(view.version, c: c) }
                    row(String(localized: "Platform"), c: c) { value(view.platform, c: c) }
                    row(String(localized: "Running"), c: c) { value("v" + view.activeVersion, c: c) }
                    row(String(localized: "Flagship signature"), c: c) { pill(view.flagshipStatus) }
                        .accessibilityIdentifier("sd-runtime-flagship")
                    row(String(localized: "Node's signature"), c: c) { pill(view.upstreamStatus) }
                    row(String(localized: "On this server"), c: c) { pill(view.localStatus) }
                        .accessibilityIdentifier("sd-runtime-local")
                    ForEach(Array(view.notes.enumerated()), id: \.offset) { _, n in
                        HStack(alignment: .top, spacing: FS.space.s2) {
                            if n.tone == .bad {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.danger)
                            }
                            Text(n.text)
                                .font(FS.font.bodySm())
                                .foregroundColor(n.tone == .bad ? c.danger : c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    DisclosureGroup(isExpanded: $showDetails) {
                        details(c: c)
                    } label: {
                        Text("Details").font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                    }
                    .accessibilityIdentifier("sd-runtime-details")
                    FSSecondaryButton(String(localized: "Check it yourself"), block: true) { showCheck = true }
                        .accessibilityIdentifier("sd-runtime-check")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sd-runtime")
        .sheet(isPresented: $showCheck) { RuntimeCheckSheet(view: view) }
    }

    @ViewBuilder
    private func details(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            hash(String(localized: "Expected checksum (flagshipserver.com)"), view.expectedChecksum, c: c)
            if let local = view.localExecutableSha256, !local.isEmpty {
                hash(String(localized: "Computed on this server"), local, c: c)
            }
            hash(String(localized: "Expected executable"), view.expectedExecutableSha256, c: c)
            VStack(alignment: .leading, spacing: 2) {
                Text("Official source").font(FS.font.scaled(12)).foregroundColor(c.textMuted)
                if let url = URL(string: view.officialUrl) {
                    Link(view.officialUrl, destination: url).font(FS.font.mono())
                } else {
                    Text(view.officialUrl).font(FS.font.mono()).foregroundColor(c.text).textSelection(.enabled)
                }
            }
        }
        .padding(.top, FS.space.s2)
    }

    private func hash(_ label: String, _ value: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(FS.font.scaled(12)).foregroundColor(c.textMuted)
            Text(value)
                .font(FS.font.mono())
                .foregroundColor(c.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func row<V: View>(_ label: String, c: FSColors, @ViewBuilder trailing: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: FS.space.s3) {
            Text(label).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            Spacer(minLength: FS.space.s2)
            trailing()
        }
    }

    private func value(_ text: String, c: FSColors) -> some View {
        Text(text).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text).multilineTextAlignment(.trailing)
    }

    private func pill(_ p: RuntimeVerificationView.Pill) -> some View {
        FSPill(p.label, kind: Self.kind(p.tone))
    }

    static func kind(_ tone: RuntimeVerificationView.Tone) -> FSPillKind {
        switch tone {
        case .good: return .online
        case .neutral: return .idle
        case .bad: return .offline
        }
    }
}

/// "Check it yourself": the same facts, checked on any computer without this app.
struct RuntimeCheckSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    let view: RuntimeVerificationView

    @State private var copied: Int?

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Text("Run these on any computer to check the same facts without trusting this app.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(view.commands.enumerated()), id: \.offset) { i, cmd in
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            Text(cmd.title).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                            ScrollView(.horizontal) {
                                Text(cmd.text)
                                    .font(FS.font.mono())
                                    .foregroundColor(c.text)
                                    .textSelection(.enabled)
                                    .fixedSize()
                                    .padding(FS.space.s3)
                            }
                            .background(c.surfaceSunken)
                            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
                            FSSecondaryButton(copied == i ? String(localized: "Copied") : String(localized: "Copy")) {
                                UIPasteboard.general.string = cmd.text
                                copied = i
                                Task {
                                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                                    if copied == i { copied = nil }
                                }
                            }
                            .accessibilityIdentifier("sd-runtime-copy-\(i + 1)")
                        }
                    }
                    if let url = URL(string: view.pageUrl) {
                        Link(destination: url) { Text(verbatim: "flagshipserver.com/runtime") }.font(FS.font.bodySm())
                    }
                }
                .padding(FS.space.s6)
            }
            .navigationTitle(String(localized: "Check it yourself"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}
