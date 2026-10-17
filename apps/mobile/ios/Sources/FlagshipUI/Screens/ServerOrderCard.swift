import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Where this server stands in the owner's order (docs/server-order.md), and
/// "Make leader" to move it to the top. Reads the same `AppState` order as
/// Home, so back on Home the server is already first.
struct ServerOrderCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.podScreensClients) private var podClients
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var working = false

    private var ranked: [PodInfo] {
        app.pods.filter { $0.status != .pending && !$0.isRevoked }
    }
    private var pod: PodInfo? {
        ranked.first(where: { $0.fqdn.lowercased() == serverDomain.lowercased() })
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        if ranked.count > 1, let pod, let position = ranked.firstIndex(where: { $0.podId == pod.podId }) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSSectionLabel("Server order")
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        if app.leaderPodId == pod.podId && pod.status == .online {
                            Label("This server leads", systemImage: "flag.fill")
                                .font(FS.font.body())
                                .foregroundColor(c.text)
                                .accessibilityIdentifier("sd-is-leader")
                            if !app.holdsServerOrder(pod.podId) {
                                Text("Waiting for it to confirm the new order.")
                                    .font(FS.font.caption())
                                    .foregroundColor(c.textMuted)
                                    .accessibilityIdentifier("sd-leader-pending")
                            }
                        } else {
                            Text(Self.successionLine(above: ranked.prefix(position).map(\.name)))
                                .font(FS.font.body())
                                .foregroundColor(c.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if position > 0 && AdminOrderGate.allows(app) {
                            FSPrimaryButton(working ? "Saving…" : "Make leader", enabled: !working, block: true) {
                                Task { await makeLeader(pod) }
                            }
                            .accessibilityIdentifier("sd-make-leader")
                        }
                    }
                }
            }
        }
    }

    /// Where a server stands, from position alone (no numbers): who it
    /// takes over from.
    static func successionLine(above: [String]) -> String {
        switch above.count {
        case 0: return "First in line to lead"
        case 1: return "Takes over while \(above[0]) is down"
        default:
            return "Takes over while \(above.dropLast().joined(separator: ", ")) and \(above.last!) are down"
        }
    }

    private func makeLeader(_ pod: PodInfo) async {
        guard !working else { return }
        working = true
        defer { working = false }
        switch await ServerOrderSaver(app: app, mailbox: mailbox, clients: podClients).makeLeader(podId: pod.podId) {
        case .saved, .local:
            toasts.success("\(pod.name) is now first in your order.")
        case .superseded:
            toasts.warning("Another device changed the order. Pull down on Home to see it.")
        case .failed(let reason):
            toasts.warning(reason)
        }
    }
}
