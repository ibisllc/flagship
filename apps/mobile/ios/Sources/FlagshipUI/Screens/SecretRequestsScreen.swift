import SwiftUI
import CryptoKit
import FlagshipCore
import FlagshipAPI
import Flagship

/// Phone-as-unlock-endpoint approval surface.
///
/// Opened by the `secret-request` push ("your box is finishing setup —
/// open to approve") and from a manual "pending setup" entry. On open it
/// fetches the account's pending mailbox requests, RE-VERIFIES each one
/// against the box's STK as independently resolved from the directory, and
/// shows the box's device-info for a one-tap "Yes, this is my box" confirm.
///
/// On confirm the coordinator unseals/re-seals the LUKS key (unlock-key) or
/// IRK-signs the entitlement carrier (entitlement) and posts the reply back
/// through `.com`. The box picks it up on its poll.
struct SecretRequestsContainer: View {
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.colorScheme) private var scheme

    @State private var state: LoadingState<[SecretRequestCoordinator.VerifiedRequest]> = .idle
    @State private var inFlightId: String?
    private let bootUnlock = BootUnlockStore()

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Your box is finishing setup. Confirm it's yours to release its boot secret — only your phone can.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                switch state {
                case .idle, .loading:
                    ForEach(0..<2) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let requests):
                    if requests.isEmpty {
                        FSCard { Text("No box is waiting for approval right now.").foregroundColor(c.textMuted) }
                    } else {
                        ForEach(requests) { req in
                            SecretRequestCard(
                                request: req,
                                isInFlight: inFlightId == req.id,
                                onApprove: { await approve(req) }
                            )
                        }
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Approve box")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { if case .idle = state { await reload() } }
    }

    private func makeCoordinator() -> SecretRequestCoordinator? {
        guard let username = app.currentUser else { return nil }
        return SecretRequestCoordinator(
            mailbox: mailbox,
            username: username,
            irkProvider: {
                try await Keystore.deriveIRK(reason: "Approve your box's boot secret")
            },
            unsealSeedProvider: { serverDomain in
                // The installer seals the LUKS key against one of the
                // phone's Ed25519 keys. Try the per-server BAK first
                // (deterministically derivable from the UMK), then the
                // IRK — whichever it was sealed against opens it.
                var seeds: [Data] = []
                if let bak = try? await Keystore.deriveBAK(
                    serverId: serverDomain,
                    reason: "Unseal the disk key for \(serverDomain)"
                ) {
                    seeds.append(bak.rawRepresentation)
                }
                if let irk = try? await Keystore.deriveIRK(reason: "Unseal the disk key") {
                    seeds.append(irk.rawRepresentation)
                }
                return seeds
            }
        )
    }

    private func reload() async {
        guard let coord = makeCoordinator() else {
            state = .failed("Sign in to approve a box.")
            return
        }
        state = .loading
        do {
            let verified = try await coord.fetchVerifiedRequests()
            state = .loaded(verified)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func approve(_ req: SecretRequestCoordinator.VerifiedRequest) async {
        guard let coord = makeCoordinator() else { return }
        inFlightId = req.id
        defer { inFlightId = nil }
        do {
            // "auto" servers (the default) also get a box-sealed lease so future
            // boots self-unlock without the phone. The returned lease id is the
            // kill-switch handle — persist it per-server. ("approve" servers
            // deposit nothing; the box asks again every boot.)
            let depositLease = bootUnlock.effectiveMode(for: req.serverDomain) == .auto
            let leaseId = try await coord.confirmAndRespond(req, depositAutoLease: depositLease)
            if let leaseId { bootUnlock.setLeaseId(leaseId, for: req.serverDomain) }
            toasts.success("Approved \(req.serverDomain). Your box will pick it up.")
            await reload()
        } catch {
            toasts.error("Approval failed: \(error.localizedDescription)")
        }
    }
}

/// One pending request card: device-info backstop + one-tap confirm.
private struct SecretRequestCard: View {
    @Environment(\.colorScheme) private var scheme
    let request: SecretRequestCoordinator.VerifiedRequest
    let isInFlight: Bool
    let onApprove: () async -> Void

    private var purposeLabel: String {
        switch request.purpose {
        case .unlockKey:    return "Unlock its encrypted disk"
        case .entitlement:  return "Authorize it to serve your account"
        case .none:         return "Boot secret"
        }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(request.serverDomain).font(FS.font.mono()).foregroundColor(c.text)
                Text(purposeLabel).font(FS.font.caption()).foregroundColor(c.textMuted)

                if let info = request.deviceInfo {
                    VStack(alignment: .leading, spacing: 2) {
                        if let ip = info.ip { infoRow("IP", ip, c) }
                        if let region = info.region { infoRow("Region", region, c) }
                        if let os = info.os { infoRow("OS", os, c) }
                        if let host = info.hostname { infoRow("Host", host, c) }
                    }
                    .padding(.top, FS.space.s1)
                }

                Text("Is this the machine in front of you? Only approve if you recognise it.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .padding(.top, FS.space.s1)

                FSPrimaryButton(
                    isInFlight ? "Signing…" : "Yes, this is my box",
                    enabled: !isInFlight,
                    block: true,
                    large: true
                ) {
                    Task { await onApprove() }
                }
                .padding(.top, FS.space.s2)
            }
        }
    }

    private func infoRow(_ label: String, _ value: String, _ c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted).frame(width: 56, alignment: .leading)
            Text(value).font(FS.font.mono()).foregroundColor(c.text)
        }
    }
}
