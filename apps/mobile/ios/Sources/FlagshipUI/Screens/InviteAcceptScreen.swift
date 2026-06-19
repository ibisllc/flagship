import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Author-side MANUAL-approve finalize screen (docs/service-access-gating.md,
/// "## v2 hardening", tier 2). Reached from a consumer's reply deeplink
/// `flagship://invite-accept?…`. The author taps "Approve" → the box fetches the
/// owner's signed create from `.com` by inviteId + verifies the consumer's
/// contact-AID signature, then binds the contact AID. Works from ANY of the
/// author's devices (no local create cache).
public struct InviteAcceptScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.serviceAccessClient) private var client
    @Environment(ToastCenter.self) private var toasts

    private let serverDomain: String
    private let inviteId: String
    private let serviceRef: String
    private let contactAidHex: String
    private let acceptSigHex: String
    private let acceptedAt: Int64
    private let username: String
    private let onDone: () -> Void

    @State private var vm: InviteAcceptViewModel?

    public init(
        serverDomain: String,
        inviteId: String,
        serviceRef: String,
        contactAidHex: String,
        acceptSigHex: String,
        acceptedAt: Int64,
        username: String,
        onDone: @escaping () -> Void = {}
    ) {
        self.serverDomain = serverDomain
        self.inviteId = inviteId
        self.serviceRef = serviceRef
        self.contactAidHex = contactAidHex
        self.acceptSigHex = acceptSigHex
        self.acceptedAt = acceptedAt
        self.username = username
        self.onDone = onDone
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm?.phase {
                case .some(.done(let serviceRef)):
                    doneCard(c: c, serviceRef: serviceRef)
                default:
                    approveCard(c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Approve access")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil {
                vm = InviteAcceptViewModel(
                    client: client, serverDomain: serverDomain, inviteId: inviteId,
                    serviceRef: serviceRef, contactAidHex: contactAidHex,
                    acceptSigHex: acceptSigHex, acceptedAt: acceptedAt)
            }
        }
    }

    @ViewBuilder
    private func approveCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Approve this person")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("You sent an invite to \(serviceRef.isEmpty ? "a service" : serviceRef) and they accepted. Approving binds their access. (You won't see their username — only the label you gave them.)")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton(isSubmitting ? "Approving…" : "Approve", block: true, large: true) {
                    Task { await approve() }
                }
                .disabled(isSubmitting)
                .accessibilityIdentifier("invite-accept-approve")
                if case .some(.failed(let msg)) = vm?.phase {
                    Text(msg)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("invite-accept-error")
                }
            }
        }
    }

    @ViewBuilder
    private func doneCard(c: FSColors, serviceRef: String) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Label("Approved", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("They now have access to \(serviceRef.isEmpty ? "the service" : serviceRef).")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton("Done", block: true, large: true) { onDone() }
                    .accessibilityIdentifier("invite-accept-done")
            }
        }
    }

    private var isSubmitting: Bool {
        if case .some(.submitting) = vm?.phase { return true }
        return false
    }

    @MainActor
    private func approve() async {
        guard let vm else { return }
        await vm.finalize()
        if case .failed(let msg) = vm.phase { toasts.error(msg) }
        else if case .done = vm.phase { toasts.success("Approved.") }
    }
}
