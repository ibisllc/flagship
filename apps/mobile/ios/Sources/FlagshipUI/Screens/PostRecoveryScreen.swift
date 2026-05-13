import SwiftUI
import FlagshipAPI

/// Settings → Recovery → Re-attach progress.
///
/// Surfaces the daemon's J.3 / J.4 state machine to the user after a
/// successful re-pair. The view polls `/api/screens/post-recovery/status`
/// every two seconds while a swap is in progress, falls back to a
/// per-app summary readout once the reissuance has settled, and shows
/// "no recovery in progress" when the daemon reports a null report.
@MainActor
@Observable
public final class PostRecoveryViewModel {
    public enum Phase: Equatable {
        case loading
        case idle                            // null report — nothing in flight
        case pendingSwap(PendingRePair)      // .com knows about it; grace window
        case complete(ReissuanceReportPayload)
        case failed(String)
    }

    public let client: any ScreensClient
    public private(set) var phase: Phase = .loading
    /// Latest successful snapshot, if any (carries the watcher state
    /// fields the UI shows below the headline phase).
    public private(set) var lastSnapshot: PostRecoverySnapshot?

    private var pollTask: Task<Void, Never>?

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func start() {
        stop()
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                // 2s while pending or recently completed, slower once idle.
                let delay: UInt64 = switch self?.phase {
                case .pendingSwap, .complete: 2_000_000_000
                default: 15_000_000_000
                }
                try? await Task.sleep(nanoseconds: delay)
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    public func refresh() async {
        do {
            let resp = try await client.postRecoveryStatus()
            lastSnapshot = resp.report
            if let report = resp.report {
                if let pending = report.state.lastSeen,
                   pending.objectedAt == nil,
                   report.state.lastSwapTo == nil {
                    phase = .pendingSwap(pending)
                } else if let r = report.lastReissue {
                    phase = .complete(r)
                } else {
                    phase = .idle
                }
            } else {
                phase = .idle
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

public struct PostRecoveryScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: PostRecoveryViewModel

    public init(vm: PostRecoveryViewModel) { self.vm = vm }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Recovery progress")
                    .font(FS.font.h2())
                    .foregroundColor(c.text)
                Text("After a re-pair, your servers re-anchor every app's membership to your new identity. This screen shows what they've finished.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                phaseCard(c: c)

                if case .complete(let report) = vm.phase {
                    appsCard(report: report, c: c)
                    undoCard(report: report, c: c)
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Re-attach progress")
        .navigationBarTitleDisplayMode(.inline)
        .task { vm.start() }
        .onDisappear { vm.stop() }
    }

    @ViewBuilder
    private func phaseCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("STATUS")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                switch vm.phase {
                case .loading:
                    HStack { ProgressView(); Text("Loading…").foregroundColor(c.textMuted) }
                case .idle:
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "checkmark.circle.fill").foregroundColor(c.success)
                        Text("No recovery in progress.").foregroundColor(c.text)
                    }
                case .pendingSwap(let p):
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "clock.fill").foregroundColor(c.primary)
                        Text("Grace window — your old phone has until \(timestamp(p.completesAt)) to object.")
                            .foregroundColor(c.text)
                    }
                case .complete(let r):
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                        Text("Re-anchored \(r.totalRewritten) membership rows across \(r.reattachedCount) app\(r.reattachedCount == 1 ? "" : "s").")
                            .foregroundColor(c.text)
                    }
                case .failed(let msg):
                    ErrorCard(message: msg)
                }
            }
        }
    }

    @ViewBuilder
    private func appsCard(report r: ReissuanceReportPayload, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("PER-APP RESULTS")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                ForEach(r.apps.filter { $0.rewrittenCount > 0 || $0.error != nil }) { app in
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: app.error == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .foregroundColor(app.error == nil ? c.success : c.danger)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(app.slug).foregroundColor(c.text)
                            if let err = app.error {
                                Text(err)
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.danger)
                            } else {
                                Text("\(app.rewrittenCount) row\(app.rewrittenCount == 1 ? "" : "s") re-anchored")
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.textMuted)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func undoCard(report r: ReissuanceReportPayload, c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "info.circle.fill").foregroundColor(c.primary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Undo window")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                    Text("If anything looks wrong, you can undo this re-anchoring until \(timestamp(r.undoWindowExpiresAt)). After that the old identity stops being recoverable.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
        }
    }

    private func timestamp(_ unixMs: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(unixMs) / 1000.0)
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .short
        return fmt.string(from: date)
    }
}
