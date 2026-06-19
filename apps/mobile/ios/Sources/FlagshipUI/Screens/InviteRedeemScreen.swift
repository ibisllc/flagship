import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Friend-side redeem screen (docs/service-access-gating.md, "## v2 hardening").
/// Reached from a `https://<server>/invite#k=<secret>&a=<authorAID>[&iid=…]`
/// deep-link. An "Accept this invite" CTA that AID-signs the redeem with the
/// friend's PER-AUTHOR contact AID against the box, then a confirmation. For a
/// MANUAL-approve invite the box returns {pending} and the screen shows the REPLY
/// link/QR the friend sends back for the owner to finalize.
public struct InviteRedeemScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.serviceAccessClient) private var client
    @Environment(ToastCenter.self) private var toasts

    private let serverDomain: String
    private let secretHex: String
    private let authorAidHex: String?
    private let inviteId: String?
    private let onOpenService: (String) -> Void
    private let onDone: () -> Void

    @State private var vm: InviteRedeemViewModel?

    public init(
        serverDomain: String,
        secretHex: String,
        authorAidHex: String? = nil,
        inviteId: String? = nil,
        onOpenService: @escaping (String) -> Void = { _ in },
        onDone: @escaping () -> Void = {}
    ) {
        self.serverDomain = serverDomain
        self.secretHex = secretHex
        self.authorAidHex = authorAidHex
        self.inviteId = inviteId
        self.onOpenService = onOpenService
        self.onDone = onDone
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm?.phase {
                case .some(.done(let serviceRef, let firstBind)):
                    doneCard(c: c, serviceRef: serviceRef, firstBind: firstBind)
                case .some(.pendingApproval(let serviceRef, let replyLink)):
                    pendingCard(c: c, serviceRef: serviceRef, replyLink: replyLink)
                default:
                    acceptCard(c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Accept invite")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil {
                vm = InviteRedeemViewModel(
                    client: client, serverDomain: serverDomain, secretHex: secretHex,
                    authorAidHex: authorAidHex, inviteId: inviteId)
            }
        }
    }

    @ViewBuilder
    private func acceptCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("You've been invited")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("This grants your account access to a restricted service on \(serverDomain). The owner sees only a private label they assign you — your username and domain are never shared.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton(isRedeeming ? "Accepting…" : "Accept & get access", block: true, large: true) {
                    Task { await accept() }
                }
                .disabled(isRedeeming)
                .accessibilityIdentifier("invite-redeem-accept")
                if case .some(.failed(let msg)) = vm?.phase {
                    Text(msg)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("invite-redeem-error")
                }
            }
        }
    }

    @ViewBuilder
    private func doneCard(c: FSColors, serviceRef: String, firstBind: Bool) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Label("You're in", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Your account now has access to \(serviceRef.isEmpty ? "the service" : serviceRef).\(firstBind ? "" : " (You already had access — this link is linked to your account.)")")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton("Open it", block: true, large: true) {
                    onOpenService(serverDomain)
                }
                .accessibilityIdentifier("invite-redeem-open")
                FSSecondaryButton("Go to Flagship", block: true) { onDone() }
                    .accessibilityIdentifier("invite-redeem-home")
            }
        }
    }

    /// MANUAL-approve — the friend must send the reply back to the owner.
    @ViewBuilder
    private func pendingCard(c: FSColors, serviceRef: String, replyLink: String) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Label("One more step", systemImage: "paperplane.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("This invite needs the owner's approval. Send this reply back to them through the same channel they sent you the invite — they'll approve it and you'll be in.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                InviteShareCard(
                    title: "Your approval reply",
                    subtitle: "Send it back to the person who invited you.",
                    link: replyLink,
                    idPrefix: "invite-redeem-reply")
                FSSecondaryButton("Done", block: true) { onDone() }
                    .accessibilityIdentifier("invite-redeem-pending-done")
            }
        }
        .accessibilityIdentifier("invite-redeem-pending")
    }

    private var isRedeeming: Bool {
        if case .some(.redeeming) = vm?.phase { return true }
        return false
    }

    @MainActor
    private func accept() async {
        guard let vm else { return }
        await vm.redeem()
        if case .failed(let msg) = vm.phase { toasts.error(msg) }
    }
}
