import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P6 — per-app collaborator-invite manage screen. Mirrors the
/// canonical webapp `views/invite-manage.js`:
///   - pending invites list (revoke per row)
///   - active access list (revoke per row)
///   - "+ Issue invite" entry that pushes the issue screen
///   - labels resolved client-side from the local label-book
public struct InviteManageScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: InviteManageViewModel
    private let appUrlForShare: String
    private let appLabel: String
    private let onIssueTapped: () -> Void
    @State private var pendingRevoke: PendingRevoke?

    /// A revoke awaiting the confirm step. Carries the copy to show and the
    /// closure to run so both list rows share one confirmation dialog.
    private struct PendingRevoke: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        let run: () async -> Void
    }

    public init(
        vm: InviteManageViewModel,
        appLabel: String,
        appUrlForShare: String,
        onIssueTapped: @escaping () -> Void
    ) {
        _vm = State(initialValue: vm)
        self.appLabel = appLabel
        self.appUrlForShare = appUrlForShare
        self.onIssueTapped = onIssueTapped
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                headerCard(c: c)
                issueButton(c: c)
                switch vm.state {
                case .idle, .loading:
                    ServerCardSkeleton()
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let snap):
                    pendingSection(snap.pending, c: c)
                    accessSection(snap.access, c: c)
                }
                if let outcome = vm.lastRevokeOutcome {
                    Text(outcome)
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Collaborators")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.state { await vm.load() }
        }
        .confirmationDialog(
            pendingRevoke?.title ?? "",
            isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let pr = pendingRevoke { Task { await pr.run() } }
                pendingRevoke = nil
            }
            Button("Cancel", role: .cancel) { pendingRevoke = nil }
        } message: {
            Text(pendingRevoke?.message ?? "")
        }
    }

    private func headerCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(appLabel)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Invite collaborators by sharing a link. Names you type stay on this device — the server only sees the random handle.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    private func issueButton(c: FSColors) -> some View {
        Button(action: onIssueTapped) {
            FSCard {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                    Text("Issue invite").foregroundColor(c.text)
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("invite-manage-issue-btn")
    }

    @ViewBuilder
    private func pendingSection(_ pending: [AppInvitePendingSummary], c: FSColors) -> some View {
        sectionHeader("PENDING INVITES", c: c)
        if pending.isEmpty {
            placeholderCard("No pending invites yet.", c: c)
        } else {
            VStack(spacing: FS.space.s3) {
                ForEach(pending) { inv in
                    pendingRow(inv, c: c)
                }
            }
        }
    }

    @ViewBuilder
    private func accessSection(_ access: [AppInviteAccessSummary], c: FSColors) -> some View {
        sectionHeader("ACTIVE ACCESS", c: c)
        if access.isEmpty {
            placeholderCard("No active access yet.", c: c)
        } else {
            VStack(spacing: FS.space.s3) {
                ForEach(access) { row in
                    accessRow(row, c: c)
                }
            }
        }
    }

    private func pendingRow(_ inv: AppInvitePendingSummary, c: FSColors) -> some View {
        let labelText = vm.label(for: inv.opaqueTag)?.displayName ?? "unknown"
        return FSCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(labelText)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(c.text)
                    HStack(spacing: 6) {
                        Text("role: \(inv.role)")
                        Text("·").foregroundColor(c.textMuted)
                        Text("expires \(fmtDate(inv.expiresAt))")
                    }
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    Text("tag \(String(inv.opaqueTag.prefix(12)))…")
                        .font(FS.font.mono())
                        .foregroundColor(c.textMuted)
                }
                Spacer()
                FSDangerButton("Revoke") {
                    let inviteId = inv.inviteId
                    let tag = inv.opaqueTag
                    pendingRevoke = PendingRevoke(
                        title: "Revoke this invite?",
                        message: "The invite link stops working immediately.",
                        run: { await vm.revokeInvite(inviteId: inviteId, opaqueTagHex: tag) }
                    )
                }
                .disabled(vm.revokePending)
                .accessibilityIdentifier("invite-manage-revoke-invite-\(inv.inviteId)")
            }
        }
    }

    private func accessRow(_ row: AppInviteAccessSummary, c: FSColors) -> some View {
        let labelText = vm.label(for: row.opaqueTag)?.displayName ?? "unknown"
        return FSCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(labelText)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(c.text)
                    HStack(spacing: 6) {
                        Text("role: \(row.role)")
                        Text("·").foregroundColor(c.textMuted)
                        Text("since \(fmtDate(row.grantedAt))")
                    }
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    Text("IRK \(String(row.irkPubHex.prefix(12)))…")
                        .font(FS.font.mono())
                        .foregroundColor(c.textMuted)
                }
                Spacer()
                FSDangerButton("Revoke") {
                    let irk = row.irkPubHex
                    let tag = row.opaqueTag
                    pendingRevoke = PendingRevoke(
                        title: "Revoke this access?",
                        message: "This collaborator loses access immediately.",
                        run: { await vm.revokeAccess(irkPubKey: irk, opaqueTagHex: tag) }
                    )
                }
                .disabled(vm.revokePending)
                .accessibilityIdentifier("invite-manage-revoke-access-\(row.irkPubHex.prefix(12))")
            }
        }
    }

    private func sectionHeader(_ title: String, c: FSColors) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .tracking(1)
            .foregroundColor(c.textMuted)
    }

    private func placeholderCard(_ text: String, c: FSColors) -> some View {
        FSCard { Text(text).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
    }

    private func fmtDate(_ ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms, includeTime: true)
    }

    /// Pass-through for the share URL the issue screen builds.
    public var resolvedAppUrlForShare: String { appUrlForShare }
}
