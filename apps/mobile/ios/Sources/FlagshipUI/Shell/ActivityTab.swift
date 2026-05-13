import SwiftUI
import FlagshipCore
import FlagshipAPI
import Flagship

public struct ActivityTab: View {
    @Environment(\.screensClient) private var client
    @State private var path: [ActivityRoute] = []
    @State private var vm: ActivityViewModel?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: ActivityRoute.self) { route in
                    switch route {
                    case .unlockApprovals: UnlockApprovalsContainer()
                    case .installProgress(let serial): InstallProgressStub(serial: serial)
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                ActivityScreen(
                    state: vm.state,
                    onApproveUnlock: { _ in path.append(.unlockApprovals) },
                    onRefresh: { await vm.load() }
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil { vm = ActivityViewModel(client: client) }
            if case .idle = vm?.state { await vm?.load() }
        }
    }
}

struct UnlockApprovalsContainer: View {
    @Environment(\.screensClient) private var client
    @Environment(ToastCenter.self) private var toasts
    @State private var state: LoadingState<[PendingUnlockApproval]> = .idle
    @State private var inFlightRequestId: String?

    var body: some View {
        ScrollView {
            VStack(spacing: FS.space.s3) {
                switch state {
                case .idle, .loading:
                    ForEach(0..<2) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let approvals):
                    if approvals.isEmpty {
                        FSCard { Text("No pending approvals.") }
                    } else {
                        ForEach(approvals, id: \.requestId) { r in
                            ApprovalCard(
                                approval: r,
                                isInFlight: inFlightRequestId == r.requestId,
                                onApprove: { await approve(r) }
                            )
                        }
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async {
        state = .loading
        do {
            let r = try await client.unlockApprovalsPending()
            state = .loaded(r.pending)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Sign the BootApproval canonical bytes with the BAK derived from
    /// the phone-held UMK, then ship the envelope through the
    /// approveUnlock endpoint. On success the request disappears from
    /// the list on the next reload.
    private func approve(_ r: PendingUnlockApproval) async {
        inFlightRequestId = r.requestId
        defer { inFlightRequestId = nil }
        do {
            let bak = try await Keystore.deriveBAK(
                serverId: r.serverFqdn,
                reason: "Authorize unlock of \(r.serverFqdn)"
            )
            let claim = BootApproval(
                requestId: r.requestId,
                serverFqdn: r.serverFqdn,
                requestedAt: r.requestedAt,
                approvedAt: Int64(Date().timeIntervalSince1970 * 1000)
            )
            let signed = try claim.sign(with: bak)
            try await client.approveUnlock(
                requestId: r.requestId,
                body: UnlockApprovalApproveRequest(
                    signature: signed.signatureHex,
                    envelope: signed.envelopeBase64
                )
            )
            toasts.success("Unlock approved for \(r.serverFqdn).")
            await reload()
        } catch {
            toasts.error("Approval failed: \(error.localizedDescription)")
        }
    }
}

private struct ApprovalCard: View {
    @Environment(\.colorScheme) private var scheme
    let approval: PendingUnlockApproval
    let isInFlight: Bool
    let onApprove: () async -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(approval.serverFqdn).font(FS.font.mono()).foregroundColor(c.text)
                if let ip = approval.ip {
                    Text("from \(ip)").font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                FSPrimaryButton(
                    isInFlight ? "Signing…" : "Approve with Face ID",
                    enabled: !isInFlight,
                    block: true,
                    large: true
                ) {
                    Task { await onApprove() }
                }
            }
        }
    }
}

struct InstallProgressStub: View {
    let serial: String
    var body: some View {
        VStack(spacing: FS.space.s4) {
            ProgressView()
            Text("Watching \(serial)…").font(FS.font.mono())
        }
        .padding(FS.space.s8)
        .navigationTitle("Provisioning")
        .navigationBarTitleDisplayMode(.inline)
    }
}
