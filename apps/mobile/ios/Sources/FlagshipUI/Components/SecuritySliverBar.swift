import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The persistent security sliver: one row per issue, grown to fit, never merged or truncated. A waiting
/// publisher key gets its own card with both fingerprints, the continuity status and the two choices.
public struct SecuritySliverBar: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app

    @State private var vm: SecuritySliverViewModel?

    public init() {}

    public var body: some View {
        Group {
            if app.isUnlocked, let vm, !vm.lines.isEmpty || vm.lostHistory {
                let c = FSColors.scheme(scheme)
                ScrollView {
                    VStack(spacing: FS.space.s2) {
                        if vm.lostHistory {
                            Text(SliverWords.lostHistory)
                                .font(FS.font.bodySm())
                                .padding(FS.space.s3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(c.warning.opacity(0.15))
                        }
                        ForEach(vm.lines) { line in row(line, vm: vm, c: c) }
                        if let e = vm.error {
                            Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                        }
                    }
                }
                .frame(maxHeight: 280)
                .accessibilityIdentifier("security-sliver")
            }
        }
        .task(id: app.isUnlocked) {
            guard app.isUnlocked else { return }
            let model = vm ?? SecuritySliverViewModel(client: client)
            vm = model
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }

    @ViewBuilder
    private func row(_ l: SliverLine, vm: SecuritySliverViewModel, c: FSColors) -> some View {
        let tint = (l.severity == "critical" || l.severity == "high") ? c.warning : c.accent
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(tint).frame(width: 4)
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Text(SliverWords.severityLabel(l.severity)).font(FS.font.bodySm().weight(.semibold))
                    Text(l.target).font(FS.font.bodySm().weight(.semibold))
                    Text(l.isActive ? "Active" : "Resolved").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
                Text(l.summary).font(FS.font.body()).fixedSize(horizontal: false, vertical: true)
                let deadline = SliverWords.remaining(l.remainingMs)
                if !deadline.isEmpty || (l.isActive && l.action != nil) {
                    Text([deadline, l.isActive ? (l.action ?? "") : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
                if l.kind == "publisher-key", l.isActive, let w = vm.waiting[l.target] {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("Old key \(w.oldFingerprint) → new key \(w.newFingerprint)").font(FS.font.bodySm().weight(.semibold))
                        Text(w.continuity == "valid-chain" ? SliverWords.chain : SliverWords.noChain).font(FS.font.bodySm())
                        Text(SliverWords.warning).font(FS.font.bodySm())
                        FSPrimaryButton(SliverWords.trust, block: true) { Task { await vm.trust(serviceId: l.target) } }
                            .accessibilityIdentifier("sliver-trust-\(l.target)")
                        FSSecondaryButton(SliverWords.reject, block: true) { Task { await vm.reject(serviceId: l.target) } }
                            .accessibilityIdentifier("sliver-reject-\(l.target)")
                    }
                }
            }
            .padding(FS.space.s3)
            Spacer(minLength: 0)
        }
        .background(c.surface)
        .opacity(l.isActive ? 1 : 0.7)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sliver-row-\(l.issueKey)")
    }
}
