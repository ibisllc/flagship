import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P14 Phase 2 — Settings → Companion requests. Lists the pending
/// unsigned write-requests companions have forwarded; the owner approves
/// (which IRK-signs + dispatches the destination call) or denies. Approve
/// uses the same 1.5s hold-to-confirm gesture as RevokeServerSheet so a
/// fat-finger doesn't trigger an irrevocable write.
public struct CompanionRequestsScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: CompanionRequestsViewModel

    @State private var nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)

    public init(vm: CompanionRequestsViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                content(c: c)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Companion requests")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.refresh() }
        .task {
            if case .idle = vm.state { await vm.load() }
            // Background poll while the inbox is on screen — matches the
            // webapp's 10s pollPending; torn down on disappear.
            vm.startPolling()
        }
        .onDisappear { vm.stopPolling() }
        .task {
            while !Task.isCancelled {
                nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Pending writes from companions")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(c.text)
            Text("A docked browser forwarded these write actions for you to approve. Your phone signs and sends each one — the browser never holds your account key.")
                .font(FS.font.body())
                .foregroundColor(c.textMuted)
        }
        .padding(.top, FS.space.s4)
    }

    @ViewBuilder
    private func content(c: FSColors) -> some View {
        switch vm.state {
        case .idle, .loading:
            FSCard {
                HStack { ProgressView(); Spacer() }
            }
        case .failed(let msg):
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Couldn't load companion requests").foregroundColor(c.danger)
                    Text(msg).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
        case .loaded(let rows):
            if rows.isEmpty {
                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "tray").foregroundColor(c.textMuted)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("No pending requests")
                                .font(FS.font.bodySm()).foregroundColor(c.text)
                            Text("Companions can forward writes here when you've docked a browser.")
                                .font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                    }
                }
            } else {
                VStack(spacing: FS.space.s3) {
                    ForEach(rows) { row in
                        requestCard(row, c: c)
                    }
                }
            }
        }
    }

    private func requestCard(_ row: CompanionPendingWrite, c: FSColors) -> some View {
        let pending = vm.resolvePending.contains(row.requestId)
        let supported = row.kind == "release-server" || row.kind == "revoke-server"
        return FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: iconName(for: row.kind))
                        .foregroundColor(c.primary)
                        .imageScale(.large)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title(for: row))
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(c.text)
                        Text(subtitle(for: row))
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                        Text(relativeQueued(row))
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                    Spacer()
                }
                if !supported {
                    Text("Unsupported request kind — open your browser to handle")
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("companion-req-unsupported-\(row.requestId)")
                }
                if let err = vm.rowError[row.requestId] {
                    Text(err).font(FS.font.caption()).foregroundColor(c.danger)
                }
                HStack(spacing: FS.space.s3) {
                    HoldToApproveButton(
                        label: pending ? "Approving…" : "Hold to approve",
                        enabled: supported && !pending,
                        onConfirm: { Task { await vm.approve(row) } }
                    )
                    .accessibilityIdentifier("companion-req-approve-\(row.requestId)")
                    Button {
                        Task { await vm.deny(row) }
                    } label: {
                        Text(pending ? "Denying…" : "Deny")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .foregroundColor(c.danger)
                            .overlay(
                                RoundedRectangle(cornerRadius: FS.radius.md)
                                    .stroke(c.danger, lineWidth: 1)
                            )
                    }
                    .disabled(pending)
                    .accessibilityIdentifier("companion-req-deny-\(row.requestId)")
                }
            }
        }
    }

    private func iconName(for kind: String) -> String {
        switch kind {
        case "release-server": return "tag.slash"
        case "revoke-server":  return "exclamationmark.octagon"
        default:               return "questionmark.circle"
        }
    }

    private func title(for row: CompanionPendingWrite) -> String {
        let who = row.companionLabel?.isEmpty == false
            ? row.companionLabel!
            : row.companionTokenPrefix
        switch row.kind {
        case "release-server": return "Release server name — from \(who)"
        case "revoke-server":  return "Revoke server — from \(who)"
        default:               return "Request from \(who)"
        }
    }

    private func subtitle(for row: CompanionPendingWrite) -> String {
        switch row.kind {
        case "release-server":
            return string(from: row.intent["serverDomain"]) ?? "(missing serverDomain)"
        case "revoke-server":
            let id = string(from: row.intent["revokedServerId"]) ?? "(missing serverId)"
            let reason = string(from: row.intent["reason"]) ?? "(missing reason)"
            return "\(id) · reason: \(reason)"
        default:
            return row.kind
        }
    }

    private func relativeQueued(_ row: CompanionPendingWrite) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(row.queuedAt) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        let queued = fmt.localizedString(for: date, relativeTo: Date())
        let remainingMs = row.expiresAt - nowMs
        if remainingMs <= 0 { return "queued \(queued) · expired" }
        let mins = remainingMs / 60_000
        if mins >= 1 { return "queued \(queued) · expires in \(mins)m" }
        let secs = max(0, remainingMs / 1000)
        return "queued \(queued) · expires in \(secs)s"
    }

    private func string(from value: AnyCodable?) -> String? {
        guard let v = value?.value else { return nil }
        if let s = v as? String { return s }
        return nil
    }
}

/// 1.5s hold-to-confirm button. Mirrors `RevokeServerSheet`'s pattern —
/// the visible label tracks press progress so the user gets a clear
/// "Hold to confirm" affordance, and a short tap does nothing.
struct HoldToApproveButton: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let enabled: Bool
    let onConfirm: () -> Void

    @State private var holding = false

    static let holdSeconds: Double = 1.5

    var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: {}) {
            Text(holding ? "Hold to confirm…" : label)
                .font(.system(size: 14, weight: .semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .foregroundColor(.white)
                .background(enabled ? c.primary : c.textMuted)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        }
        .disabled(!enabled)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: Self.holdSeconds)
                .onChanged { _ in holding = true }
                .onEnded { _ in
                    holding = false
                    if enabled { onConfirm() }
                }
        )
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onEnded { _ in holding = false }
        )
    }
}
