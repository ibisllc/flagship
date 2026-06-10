import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Detail page for a pod whose InstallBlob has been delivered but whose
/// box hasn't finished provisioning. Shows a **live provisioning-status
/// timeline** driven by `GET /api/order/<serial>/status` (polled ~every
/// 3s) so the user watches real install progress (Booting → … → live)
/// instead of a bare "pending" spinner. The pod card on Home shows a
/// Pending pill until the server transitions to .online (handled by
/// PendingPodWatcher on the separate install-events channel).
public struct PendingServerScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.secretMailboxClient) private var mailbox
    let pod: PodInfo
    /// Account username — required only for the serial-less directory
    /// fallback (a pod surfaced from `/pods` on a non-creating device
    /// carries no auth-code serial, so progress rides the unauthenticated
    /// directory's `pending[].phase` instead of the per-order endpoint).
    let username: String?
    var onCancelOrder: () -> Void = {}

    @State private var timeline: ProvisionTimelineViewModel?

    public init(pod: PodInfo, username: String? = nil, onCancelOrder: @escaping () -> Void = {}) {
        self.pod = pod
        self.username = username
        self.onCancelOrder = onCancelOrder
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Spacer().frame(height: FS.space.s4)
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(pod.name).font(FS.font.h2()).foregroundColor(c.text)
                    if let desc = pod.description, !desc.isEmpty {
                        Text(desc).font(FS.font.body()).foregroundColor(c.textMuted)
                            .lineLimit(1).truncationMode(.tail)
                    }
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        FSPill(pillLabel, kind: pillKind)
                        Text(headline)
                            .font(FS.font.body())
                            .foregroundColor(c.text)
                        ProvisionTimelineView(status: timeline?.status)
                            .padding(.top, FS.space.s1)
                    }
                }

                if let domain = timeline?.status?.serverDomain, !domain.isEmpty {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            Text("ADDRESS")
                                .font(.system(size: 12, weight: .semibold))
                                .tracking(1)
                                .foregroundColor(c.textMuted)
                            Text(domain)
                                .font(FS.font.mono())
                                .foregroundColor(c.text)
                                .textSelection(.enabled)
                        }
                    }
                    .accessibilityIdentifier("pending-server-domain")
                }

                Link(destination: URL(string: "https://flagshipserver.com/docs/install")!) {
                    HStack {
                        Image(systemName: "book.fill")
                        Text("How to flash + boot")
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(c.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, FS.space.s3)
                }

                FSDangerButton("Cancel order", block: true, large: true, action: onCancelOrder)
                    .accessibilityIdentifier("pending-cancel-order-button")

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Pending")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: pod.pendingAuthCodeSerial) { startTimeline() }
        .onDisappear { timeline?.stop() }
    }

    // MARK: - Copy

    private var pillLabel: String {
        switch timeline?.status?.phase {
        case .error: return "Failed"
        case .live:  return "Live"
        default:     return "Pending"
        }
    }

    private var pillKind: FSPillKind {
        switch timeline?.status?.phase {
        case .error: return .offline
        case .live:  return .online
        default:     return .provisioning
        }
    }

    private var headline: String {
        switch timeline?.status?.phase {
        case .error:
            return "The install hit a problem. You can cancel and try again."
        case .live:
            return "Your server finished provisioning and is coming online."
        case .none:
            return "Your boot disk should have started downloading at flagshipserver.com. Flash it, boot any box, and progress will appear here as it phones home."
        default:
            return "Your box is provisioning. This usually takes a few minutes."
        }
    }

    // MARK: - Polling

    private func startTimeline() {
        timeline?.stop()
        let vm: ProvisionTimelineViewModel
        if let serial = pod.pendingAuthCodeSerial, !serial.isEmpty {
            vm = ProvisionTimelineViewModel(serial: serial, server: server)
        } else if let username, !username.isEmpty, !pod.fqdn.isEmpty {
            // Serial-less pod (surfaced from the directory — this device
            // didn't mint the order): list-level progress from the
            // unauthenticated `/pods` `pending[].phase`, flipping live
            // when the fqdn registers.
            let mailbox = self.mailbox
            vm = ProvisionTimelineViewModel(
                username: username,
                fqdn: pod.fqdn,
                fetchDirectory: { user in try? await mailbox.fetchPods(username: user) }
            )
        } else {
            timeline = nil
            return
        }
        // Mirror each canonical poll result onto the Watch timeline (the
        // App wires InstallProgressBridge.onStatus → WatchTimelinePublisher).
        let podName = pod.name
        vm.onStatus = { status in
            InstallProgressBridge.shared.onStatus?(status, podName)
        }
        timeline = vm
        vm.start()
    }
}
