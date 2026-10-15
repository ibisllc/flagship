import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Visitor-side knock-authorize screen (docs/service-access-gating.md,
/// "Web-experience gating"). Reached from an `https://flagshipserver.com/access#…` link (the
/// box's knock page / QR) or a pasted "Process URL". Shows "Open <app> on
/// <server>?" with Open / Cancel; Open signs the authorization behind the
/// biometric gate (global AID on our own servers, the invite's contact AID on a
/// friend's; see KnockAuthorizeViewModel) and POSTs it to the box. On success
/// the browser is signed in and the user is told to return to it.
public struct KnockAuthorizeScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.serviceAccessClient) private var client
    @Environment(\.securedSessionStore) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(AppState.self) private var app
    @Environment(\.secretMailboxClient) private var mailbox

    private let serverDomain: String
    private let svc: String
    private let serviceRef: String
    private let pageId: String
    private let onDone: () -> Void

    @State private var vm: KnockAuthorizeViewModel?

    public init(
        serverDomain: String,
        svc: String,
        serviceRef: String,
        pageId: String,
        onDone: @escaping () -> Void = {}
    ) {
        self.serverDomain = serverDomain
        self.svc = svc
        self.serviceRef = serviceRef
        self.pageId = pageId
        self.onDone = onDone
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm?.phase {
                case .some(.authorized):
                    authorizedCard(c: c)
                default:
                    authorizeCard(c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Open app")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil {
                vm = KnockAuthorizeViewModel(
                    client: client,
                    store: store,
                    serverDomain: serverDomain,
                    svc: svc,
                    serviceRef: serviceRef,
                    pageId: pageId,
                    ownServers: app.pods.map(\.fqdn),
                    refreshOwnServers: { [app, mailbox] in
                        // A cold start from a deep link may not have loaded the
                        // server list yet: one `/pods` read, no biometric.
                        guard let user = app.currentUser, !user.isEmpty,
                              let dir = try? await mailbox.fetchPods(username: user)
                        else { return app.pods.map(\.fqdn) }
                        return app.pods.map(\.fqdn) + dir.pods.map(\.serverDomain)
                    })
            }
        }
    }

    /// The site label, e.g. `notes.home.alice.flagship.services` — derived the
    /// same way the VM persists it (drops the scheme for the headline).
    private var siteLabel: String {
        let url = SecuredSession.serviceUrl(svc: svc, serverDomain: serverDomain)
        return url.replacingOccurrences(of: "https://", with: "")
    }

    @ViewBuilder
    private func authorizeCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                    .accessibilityIdentifier("knock-authorize-title")
                Text(siteLabel)
                    .font(FS.font.mono())
                    .foregroundColor(c.text)
                    .accessibilityIdentifier("knock-authorize-site")
                Text("This signs the browser at \(siteLabel) in as you. Only do this for a browser you opened yourself.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton(isAuthorizing ? "Signing in…" : "Open", block: true, large: true) {
                    Task { await authorize() }
                }
                .disabled(isAuthorizing)
                .accessibilityIdentifier("knock-authorize-btn")
                FSSecondaryButton("Cancel", block: true) { onDone() }
                    .disabled(isAuthorizing)
                    .accessibilityIdentifier("knock-authorize-cancel")
                if case .some(.failed(let msg)) = vm?.phase {
                    Text(msg)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("knock-authorize-error")
                }
            }
        }
    }

    @ViewBuilder
    private func authorizedCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Label("Signed in", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Go back to the browser: it opens \(svc.isEmpty ? "the app" : svc) on its own. You can refresh or stop this session anytime from Settings → Open secured sessions.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton("Done", block: true, large: true) { onDone() }
                    .accessibilityIdentifier("knock-authorize-done")
            }
        }
    }

    private var title: String {
        KnockAuthorizeViewModel.title(svc: svc, serverDomain: serverDomain)
    }

    private var isAuthorizing: Bool {
        if case .some(.authorizing) = vm?.phase { return true }
        return false
    }

    @MainActor
    private func authorize() async {
        guard let vm else { return }
        await vm.authorize()
        if case .failed(let msg) = vm.phase { toasts.error(msg) }
    }
}
