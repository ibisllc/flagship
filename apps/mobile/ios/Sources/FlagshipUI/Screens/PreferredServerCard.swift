import SwiftUI
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// "Set as preferred server" — the owner's per-service-leadership default vote
/// (Phase 6, docs/multi-pod-liveness-session-leadership.md).
///
/// Self-contained, mirroring `BootUnlockCard`: it reads the mailbox client + the
/// `AppState` from the environment so the parent `ServerDetailScreen` stays a
/// dumb state+callbacks view. The action signs the existing `set-leader` vote for
/// THIS box's STK (behind the standard biometric, via `SetPreferredServerViewModel`)
/// and deposits it; on success it marks the pod preferred IMMEDIATELY in the UI
/// (`app.setLeader`), independent of the box-side gossip catch-up.
struct PreferredServerCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var working = false

    private var pod: PodInfo? {
        app.pods.first(where: { $0.fqdn.lowercased() == serverDomain.lowercased() })
    }
    private var isPreferred: Bool {
        guard let pod else { return false }
        return app.leaderPodId == pod.podId
    }
    /// The vote can be cast only once the box has a registered STK.
    private var hasStk: Bool {
        (HexUtil.decode(pod?.identityPubKeyHex ?? "")?.count ?? 0) == 32
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        // Only meaningful with more than one server (a preferred default among
        // peers); and only once the box has a registered identity to vote for.
        if app.pods.filter({ $0.status != .pending }).count > 1, hasStk {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("PREFERRED SERVER")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        if isPreferred {
                            Label("This is your preferred server", systemImage: "star.fill")
                                .font(FS.font.body())
                                .foregroundColor(c.text)
                            Text("New service routes default here when it's the highest-clout live server. You can pick a different one from another server's page.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        } else {
                            Text("Make this the default target for your cloud — votes for it across your boxes so the highest-clout live server leading a service prefers it.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                            FSPrimaryButton(
                                working ? "Setting…" : "Set as preferred server",
                                enabled: !working,
                                block: true
                            ) {
                                Task { await setPreferred() }
                            }
                            .accessibilityIdentifier("sd-set-preferred")
                        }
                    }
                }
            }
        }
    }

    private func setPreferred() async {
        guard let pod, !working else { return }
        working = true
        defer { working = false }
        let vm = SetPreferredServerViewModel(
            username: app.currentUser ?? "",
            serverDomain: serverDomain,
            preferredStkPubHex: pod.identityPubKeyHex,
            mailbox: mailbox
        )
        let ok = await vm.setPreferred()
        if ok {
            // Reflect the choice immediately, independent of gossip catch-up.
            app.setLeader(pod.podId)
            toasts.success("Preferred server set.")
        } else {
            toasts.warning("Couldn't set the preferred server — try again.")
        }
    }
}
