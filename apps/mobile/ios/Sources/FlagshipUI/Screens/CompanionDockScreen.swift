import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P14 — "Dock a browser". Settings entry that mints a 60-second pairing
/// ticket and renders it as a QR a desktop browser scans to become a
/// 4-hour read-only companion of the user's account. The phone owns
/// mint + list + revoke; the browser owns the redeem leg.
public struct CompanionDockScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: CompanionDockViewModel
    let podBaseUrl: String?
    let username: String

    @State private var labelDraft: String = ""
    @State private var pendingRevoke: CompanionSummary?
    @State private var nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)

    public init(vm: CompanionDockViewModel, podBaseUrl: String?, username: String) {
        self.vm = vm
        self.podBaseUrl = podBaseUrl
        self.username = username
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                mintCard(c: c)
                activeList(c: c)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Dock a browser")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.state { await vm.load() }
        }
        .task {
            while !Task.isCancelled {
                nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        .sheet(
            isPresented: Binding(
                get: { vm.mintedTicket != nil },
                set: { if !$0 { vm.dismissMintedTicket() } }
            )
        ) {
            if let ticket = vm.mintedTicket {
                CompanionTicketSheet(
                    ticket: ticket,
                    podBaseUrl: podBaseUrl ?? "",
                    username: username,
                    onClose: { vm.dismissMintedTicket() }
                )
            }
        }
        .confirmationDialog(
            pendingRevoke.map { "Disconnect \(displayLabel(for: $0))?" } ?? "Disconnect companion?",
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
            Text("The browser session will end immediately. It can be re-paired any time with a fresh QR.")
        }
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Dock a browser")
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(c.text)
            Text("Show the QR below on your phone and scan it from a desktop browser. The browser becomes a read-only companion of this account for 4 hours.")
                .font(FS.font.body())
                .foregroundColor(c.textMuted)
        }
        .padding(.top, FS.space.s4)
    }

    private func mintCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Mint a pairing QR")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(c.text)
                TextField("Label (optional, e.g. \"My laptop\")", text: $labelDraft)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("companion-dock-label")
                if let mintError = vm.mintError {
                    Text(mintError)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                }
                FSPrimaryButton("Mint pairing QR", block: true) {
                    Task {
                        await vm.mint(label: labelDraft)
                        if vm.mintedTicket != nil { labelDraft = "" }
                    }
                }
                .accessibilityIdentifier("companion-dock-mint")
                Text("The QR expires in 60 seconds. After scanning, the browser stays a companion for 4 hours.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func activeList(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("ACTIVE COMPANIONS")
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
                        Text("Couldn't load companions").foregroundColor(c.danger)
                        Text(msg).font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
            case .loaded(let list):
                if list.companions.isEmpty {
                    FSCard {
                        HStack(alignment: .top, spacing: FS.space.s2) {
                            Image(systemName: "laptopcomputer").foregroundColor(c.textMuted)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("No browsers docked").font(FS.font.bodySm()).foregroundColor(c.text)
                                Text("Mint a pairing QR to add one.")
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
        if let label = c.label, !label.isEmpty { return label }
        return c.tokenPrefix
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

/// Sheet body shown when a fresh ticket has been minted. Renders the QR
/// + a manual link fallback + a 60-second countdown.
struct CompanionTicketSheet: View {
    @Environment(\.colorScheme) private var scheme
    let ticket: CompanionMintTicketResponse
    let podBaseUrl: String
    let username: String
    let onClose: () -> Void

    @State private var nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack {
                Image(systemName: "qrcode")
                    .imageScale(.large)
                    .foregroundColor(c.primary)
                Text("Scan to dock")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(c.textMuted)
                        .imageScale(.large)
                }
                .accessibilityIdentifier("companion-ticket-close")
            }
            Text("Open a desktop browser and scan this QR. After it scans, the browser becomes a read-only companion for 4 hours.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            if let urlString = qrUrl {
                VStack(spacing: FS.space.s3) {
                    PairingQRView(text: urlString, size: 240)
                        .accessibilityIdentifier("companion-ticket-qr")
                    Text(countdownLabel)
                        .font(FS.font.caption())
                        .foregroundColor(remainingMs <= 10_000 ? c.danger : c.textMuted)
                        .accessibilityIdentifier("companion-ticket-countdown")
                }
                .frame(maxWidth: .infinity)
            } else {
                Text("Couldn't build the pairing URL. Make sure you're signed in to a pod.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.danger)
            }
            FSPrimaryButton("Done", block: true, action: onClose)
        }
        .padding(FS.space.s6)
        .background(c.bg)
        .presentationDetents([.medium, .large])
        .task {
            while !Task.isCancelled {
                nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    private var qrUrl: String? {
        guard !podBaseUrl.isEmpty else { return nil }
        return CompanionTicketURL.build(
            ticketId: ticket.ticketId,
            ticketSecret: ticket.ticketSecret,
            podBaseUrl: podBaseUrl,
            username: username
        )
    }

    private var remainingMs: Int64 { max(0, ticket.expiresAt - nowMs) }

    private var countdownLabel: String {
        let secs = remainingMs / 1000
        if remainingMs <= 0 { return "Expired — mint a new one" }
        return "Expires in \(secs)s"
    }
}
