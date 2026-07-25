import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Phone side of the desktop-initiated remote ceremony.
public struct CompanionDockScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: CompanionDockViewModel
    let initialApprovalLink: String?

    @State private var pendingRevoke: CompanionSummary?
    @State private var nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    @State private var pastedLink = ""
    @State private var showScanner = false
    @State private var scanError: String?

    public init(vm: CompanionDockViewModel, initialApprovalLink: String? = nil) {
        self.vm = vm
        self.initialApprovalLink = initialApprovalLink
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text("Open \(Endpoints.remoteHost) on your computer, then approve its pairing code here.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                pairingCard(c: c)
                approvalCard(c: c)
                activeList(c: c)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Remote")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.state { await vm.load() }
            if let initialApprovalLink {
                pastedLink = initialApprovalLink
                _ = vm.stageApproval(link: initialApprovalLink)
            }
        }
        .task {
            while !Task.isCancelled {
                nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        .sheet(isPresented: $showScanner) {
            CompanionDockScannerSheet(
                onScan: { raw in
                    pastedLink = raw
                    if vm.stageApproval(link: raw) {
                        showScanner = false
                    }
                },
                onError: { scanError = $0 },
                onPasteInstead: { showScanner = false }
            )
        }
        .confirmationDialog(
            pendingRevoke.map { "Disconnect \(displayLabel(for: $0))?" } ?? "Disconnect this browser?",
            isPresented: Binding(
                get: { pendingRevoke != nil },
                set: { if !$0 { pendingRevoke = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingRevoke
        ) { target in
            Button("Disconnect", role: .destructive) {
                Task {
                    await vm.revoke(tokenPrefix: target.tokenPrefix)
                    pendingRevoke = nil
                }
            }
            Button("Cancel", role: .cancel) { pendingRevoke = nil }
        } message: { _ in
            Text("The browser session will end immediately. It can reconnect any time with a fresh QR.")
        }
    }

    private func pairingCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Connect a browser")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(c.text)
                FSPrimaryButton("Scan pairing QR", block: true) {
                    scanError = nil
                    showScanner = true
                }
                .accessibilityIdentifier("companion-dock-scan")
                TextField("Paste pairing link", text: $pastedLink, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(2...4)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("companion-dock-link")
                FSSecondaryButton("Use pasted link", block: true) {
                    _ = vm.stageApproval(link: pastedLink)
                }
                .disabled(pastedLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let scanError {
                    Text(scanError)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                }
            }
        }
    }

    @ViewBuilder
    private func approvalCard(c: FSColors) -> some View {
        if let approval = vm.stagedApproval {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("Approve this browser?")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(c.text)
                    Text(approval.serverDomain)
                        .font(FS.font.mono())
                        .foregroundColor(c.textMuted)
                        .textSelection(.enabled)
                    Text("It will receive a keyless remote session for four hours. Protected actions still require approval from this phone.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    FSPrimaryButton(vm.approvalPending ? "Approving…" : "Approve", enabled: !vm.approvalPending, block: true) {
                        Task { await vm.approve() }
                    }
                    .accessibilityIdentifier("companion-dock-approve")
                    FSGhostButton("Cancel", block: true) { vm.clearApproval() }
                }
            }
        }
        if vm.approvalComplete {
            FSCard {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "checkmark.circle.fill").foregroundColor(c.success)
                    Text("Browser connected").font(FS.font.bodySm()).foregroundColor(c.text)
                }
            }
        }
        if let error = vm.approvalError {
            Text(error)
                .font(FS.font.caption())
                .foregroundColor(c.danger)
                .accessibilityIdentifier("companion-dock-approval-error")
        }
    }

    @ViewBuilder
    private func activeList(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("CONNECTED BROWSERS")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            switch vm.state {
            case .idle, .loading:
                FSCard {
                    HStack { ProgressView(); Spacer() }
                }
            case .failed(let msg):
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("Couldn't load connected browsers").foregroundColor(c.danger)
                        Text(msg).font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
            case .loaded(let list):
                if list.companions.isEmpty {
                    FSCard {
                        HStack(alignment: .top, spacing: FS.space.s2) {
                            Image(systemName: "laptopcomputer").foregroundColor(c.textMuted)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("No browsers connected").font(FS.font.bodySm()).foregroundColor(c.text)
                                Text("Open \(Endpoints.remoteHost) on a computer to add one.")
                                    .font(FS.font.caption())
                                    .foregroundColor(c.textMuted)
                            }
                        }
                    }
                } else {
                    VStack(spacing: FS.space.s3) {
                        ForEach(list.companions) { companion in
                            companionRow(companion, c: c)
                        }
                    }
                }
            }
        }
    }

    private func companionRow(_ companion: CompanionSummary, c: FSColors) -> some View {
        let pending = vm.revokePending.contains(companion.tokenPrefix)
        return FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: "laptopcomputer")
                    .foregroundColor(c.primary)
                    .imageScale(.large)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayLabel(for: companion))
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(c.text)
                    Text("last seen \(relative(ms: companion.lastSeenMs))")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    Text(expiresLabel(for: companion))
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("companion-expires-\(companion.tokenPrefix)")
                }
                Spacer()
                Button {
                    pendingRevoke = companion
                } label: {
                    if pending {
                        ProgressView()
                    } else {
                        Text("Revoke")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(c.danger)
                    }
                }
                .disabled(pending)
                .accessibilityIdentifier("companion-revoke-\(companion.tokenPrefix)")
            }
        }
    }

    private func displayLabel(for c: CompanionSummary) -> String {
        return "Session \(c.tokenPrefix)"
    }

    private func expiresLabel(for c: CompanionSummary) -> String {
        let remaining = c.expiresAt - nowMs
        if remaining <= 0 { return "expired" }
        let mins = remaining / 60_000
        if mins >= 60 {
            let hours = mins / 60
            let leftover = mins % 60
            if leftover == 0 { return "expires in \(hours)h" }
            return "expires in \(hours)h \(leftover)m"
        }
        if mins >= 1 { return "expires in \(mins)m" }
        let secs = max(0, remaining / 1000)
        return "expires in \(secs)s"
    }

    private func relative(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms)
    }
}

private struct CompanionDockScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onScan: (String) -> Void
    let onError: (String) -> Void
    let onPasteInstead: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: FS.space.s4) {
                QRScannerView(
                    onScan: onScan,
                    onError: onError,
                    validate: { CompanionDockApprovalLink.parse($0) != nil }
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                Button("Paste link instead") {
                    onPasteInstead()
                    dismiss()
                }
            }
            .padding(FS.space.s4)
            .navigationTitle("Scan pairing QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
