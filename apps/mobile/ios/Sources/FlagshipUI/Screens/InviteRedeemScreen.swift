import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Friend-side redeem screen (docs/service-access-gating.md). Reached from a
/// `https://<server>.<user>/invite#<secret>` deep-link. Mirrors the webapp
/// `views/invite-redeem.js`: an "Accept this invite" CTA that AID-signs the
/// redeem against the box, then a confirmation. The friend proves control of
/// their STABLE AID (UMK-derived) so access follows their account across IRK
/// rotations / device changes.
public struct InviteRedeemScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.serviceAccessClient) private var client
    @Environment(ToastCenter.self) private var toasts

    private let serverDomain: String
    private let secretHex: String
    private let onOpenService: (String) -> Void
    private let onDone: () -> Void

    @State private var vm: InviteRedeemViewModel?

    public init(
        serverDomain: String,
        secretHex: String,
        onOpenService: @escaping (String) -> Void = { _ in },
        onDone: @escaping () -> Void = {}
    ) {
        self.serverDomain = serverDomain
        self.secretHex = secretHex
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
        .task { if vm == nil { vm = InviteRedeemViewModel(client: client, serverDomain: serverDomain, secretHex: secretHex) } }
    }

    @ViewBuilder
    private func acceptCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("You've been invited")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("This grants your account access to a restricted service on \(serverDomain). Your account identity is recorded so the owner can manage access; nothing else about you is shared.")
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
