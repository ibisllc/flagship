import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings → "Open secured sessions" (docs/service-access-gating.md,
/// "Web-experience gating"). Lists the browser QR-login sessions THIS phone has
/// authorized; each row shows the site URL, the browser, when it started, and a
/// last-known online/offline pill, with a debounced Refresh and a Stop.
public struct SecuredSessionsScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: SecuredSessionsViewModel
    @State private var stopTarget: SecuredSession?

    public init(vm: SecuredSessionsViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Sites you've signed a browser into from this phone. They stay open for a while, then expire on their own. Stop one anytime.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                if vm.sessions.isEmpty {
                    emptyCard(c: c)
                } else {
                    ForEach(vm.sessions) { session in
                        sessionRow(session, c: c)
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Secured sessions")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { vm.load() }
        .confirmationDialog(
            "Stop this session?",
            isPresented: Binding(
                get: { stopTarget != nil },
                set: { if !$0 { stopTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: stopTarget
        ) { target in
            Button("Stop session", role: .destructive) {
                Task { await vm.stop(target); stopTarget = nil }
            }
            Button("Cancel", role: .cancel) { stopTarget = nil }
        } message: { _ in
            Text("The browser will be signed out and will have to authorize again to view the site.")
        }
    }

    @ViewBuilder
    private func emptyCard(c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "globe").foregroundColor(c.textMuted)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No open sessions").font(FS.font.bodySm()).foregroundColor(c.text)
                    Text("When you authorize a browser to open a restricted site, it shows up here.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
        }
        .accessibilityIdentifier("secured-sessions-empty")
    }

    @ViewBuilder
    private func sessionRow(_ session: SecuredSession, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "globe").foregroundColor(c.primary).imageScale(.large)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayUrl(session))
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(c.text)
                            .lineLimit(1).truncationMode(.middle)
                        Text(session.browserAgent.isEmpty ? "Unknown browser" : session.browserAgent)
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .lineLimit(1).truncationMode(.tail)
                        Text("started \(relative(ms: session.startedAt))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Spacer()
                    statusPill(session)
                }
                if vm.recentlyChecked.contains(session.secretId) {
                    Text("Checked recently — try again in a minute.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("secured-session-recently-checked-\(session.secretId)")
                }
                HStack(spacing: FS.space.s3) {
                    Button {
                        Task { await vm.refresh(session) }
                    } label: {
                        HStack(spacing: 4) {
                            if vm.refreshing.contains(session.secretId) {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                            Text("Refresh").font(FS.font.bodySm())
                        }
                        .foregroundColor(vm.canRefresh(session) ? c.primary : c.textMuted)
                    }
                    .disabled(!vm.canRefresh(session) || vm.refreshing.contains(session.secretId))
                    .accessibilityIdentifier("secured-session-refresh-\(session.secretId)")
                    Spacer()
                    Button("Stop") { stopTarget = session }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("secured-session-stop-\(session.secretId)")
                }
            }
        }
        .accessibilityIdentifier("secured-session-row-\(session.secretId)")
    }

    @ViewBuilder
    private func statusPill(_ session: SecuredSession) -> some View {
        switch vm.statuses[session.secretId] {
        case .some(.online):
            FSPill("Online", kind: .online)
        case .some(.offline):
            FSPill("Offline", kind: .offline)
        case .none:
            FSPill("Tap refresh", kind: .idle)
        }
    }

    private func displayUrl(_ session: SecuredSession) -> String {
        session.serviceUrl.replacingOccurrences(of: "https://", with: "")
    }

    private func relative(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms)
    }
}
