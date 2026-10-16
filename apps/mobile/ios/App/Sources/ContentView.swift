import SwiftUI
import UIKit
import Flagship
import FlagshipCore
import FlagshipAPI
import FlagshipUI

struct ContentView: View {
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @Environment(ToastCenter.self) private var toasts
    @Environment(ActiveOperationsCenter.self) private var operations
    @Environment(TrustCenter.self) private var trust
    @Environment(DeveloperSettings.self) private var dev
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.sessionStore) private var sessionStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var pendingWatchers: PendingPodWatcherRegistry?
    /// #91 — foreground long-poll for AI-chat alerts → local notification +
    /// operations sliver. Lazily built once a pod is paired; gated on
    /// paired+unlocked so nothing surfaces over the lock.
    @State private var aiChatPoller: AiChatAlertPoller?
    /// The single app-scope live-update canal — ONE `/stream` long-poll that
    /// feeds AppState (pods + Box Request Inbox). Lazily built; foreground-only
    /// via `scenePhase` + paired+unlocked, started/stopped at the shell so it
    /// spans every tab (home / install checklist / server-detail).
    @State private var liveSync: LiveSyncCoordinator?
    /// "<App> wants to reach <host>" sheets, asked of every managed box on
    /// foreground, on a `generic` push and on each box's events socket.
    @State private var accessAlerts: AppAccessAlertCenter?
    /// Settings → Privacy → "Push notifications": the registration on `.com`
    /// and every box's access-alert setting follow it.
    @State private var pushPrefs: PushPreferenceSync?
    @Environment(PrivacySettings.self) private var privacy
    @Environment(\.screensClient) private var screensClient

    var body: some View {
        ZStack {
            if app.isPaired {
                RootShell(initialDestination: smokeInitialDestination ?? .home)
                    // Bind the real Keystore-IRK signer for SetServiceEnv
                    // envelopes (the default is a 128-zero placeholder the
                    // daemon rejects).
                    .environment(\.vibeCodeEnvelopeSigner, keystoreVibeCodeEnvelopeSigner())
            } else {
                Color.clear
            }
            Toaster()
        }
        // One sheet for the whole queue: the next request replaces the answered
        // one in place. Keyed on the item, SwiftUI re-presented the sheet per
        // request and the closing sheet's onDisappear reported the NEXT id, so
        // the second waiting request was snoozed for a day without being shown.
        // `set(false)` comes only from the owner swiping the sheet away.
        .sheet(isPresented: Binding(
            get: { app.isPaired && app.isUnlocked && privacy.pushNotificationsEnabled && accessAlerts?.current != nil },
            set: { shown in
                if !shown, let center = accessAlerts, let id = center.current?.id { center.dismissed(id: id) }
            }
        )) {
            if let accessAlerts {
                AppAccessAlertSheet(center: accessAlerts)
            }
        }
        .fullScreenCover(isPresented: Binding(
            get: { !app.isPaired },
            set: { _ in /* read-only — onboarding sets paired itself */ }
        )) {
            OnboardingFlow()
                .environment(app)
                .environment(linker)
                .environment(toasts)
                .environment(trust)
        }
        .onChange(of: app.isPaired) { _, paired in
            if paired { Task { await registerPush() } }
            // Signing out ends the authenticated session — drop the cached UMK.
            else { Keystore.clearSessionKeyCache() }
            PodStatusPublisher(app: app).publish()
            syncPendingWatchers()
            syncAiChatPoller()
            syncLiveSync()
            operations.syncDeployOperations(pods: app.isPaired ? app.pods : [])
            syncPodSession()
            syncAccessAlerts()
        }
        .onChange(of: app.isUnlocked) { _, unlocked in
            // Trust-the-session model: the unwrapped UMK lives in memory only
            // while the app is unlocked. The instant it re-locks (background
            // relock or an explicit lock), drop the cached key so the next
            // session re-authenticates once — the biometric still gates each
            // session, it just no longer fires again mid-session. This is what
            // stops the "random Face ID on the Home screen" the periodic
            // deposit refresh used to trigger.
            if !unlocked { Keystore.clearSessionKeyCache() }
            syncAccessAlerts()
        }
        .onChange(of: privacy.pushNotificationsEnabled) { _, _ in
            syncAccessAlerts()
            let prefs = pushPrefs
            Task { await prefs?.changed() }
        }
        .onChange(of: scenePhase) { _, _ in
            // Foreground-only: pause the live-update canal when the app leaves
            // .active (background/inactive), resume on return. The coordinator's
            // own isActive gate also folds in paired+unlocked.
            syncLiveSync()
            syncAccessAlerts()
        }
        .onChange(of: app.pods) { _, _ in
            PodStatusPublisher(app: app).publish()
            syncPendingWatchers()
            operations.syncDeployOperations(pods: app.isPaired ? app.pods : [])
            // A `/pods`-reconciled server flips to .online here (not via the
            // pairing flow), so this is the moment its base URL must be set.
            syncPodSession()
        }
        .onChange(of: app.currentPodId) { _, _ in
            // Switching the selected server repoints the screens client.
            syncPodSession()
        }
        .onChange(of: app.boxRequestInbox) { _, _ in
            // A box started or stopped waiting for its unlock: the watch
            // lists it without the Approvals screen having been opened.
            WatchSecurityAlertsPublisher.shared.updateFromApp(app)
        }
        .onChange(of: app.leaderPodId) { _, _ in
            PodStatusPublisher(app: app).publish()
            // The leader is the default server (docs/app-placement.md §1).
            syncPodSession()
        }
        .task {
            PodStatusPublisher(app: app).publish()
            syncPendingWatchers()
            syncAiChatPoller()
            syncLiveSync()
            syncAccessAlerts()
            operations.syncDeployOperations(pods: app.isPaired ? app.pods : [])
            // Cold-launch restore: point the screens client at the
            // already-selected online server before the first load.
            syncPodSession()
            await runTrustCheck()
        }
    }

    /// Run the maintainer-trust check against `.com` and feed the verdict to
    /// the `TrustCenter`. Live-client only (the Mock control server is for
    /// dev/demo and has no blessing to verify); a network/parse failure is a
    /// NON-verdict and leaves the center untouched (never bricks offline).
    @MainActor
    private func runTrustCheck() async {
        guard dev.useLiveClient else { return }
        switch await TrustChecker().check() {
        case .trusted:                 trust.markTrusted()
        case .untrusted(let failure):  trust.markUntrusted([failure])
        case .noVerdict:               trust.markNoVerdict()
        }
    }

    /// Repoint the live screens client's `podBaseUrl` at the currently
    /// selected online server (or clear it when there's none / it's pending
    /// / we've signed out). See `PodSessionSync`. The store write is async;
    /// `app.currentPod` is read synchronously on the main actor first so the
    /// detached write captures a value, not the AppState.
    @MainActor
    private func syncPodSession() {
        // Anchor on a LIVE pod (`sessionPod`), not `currentPod` — the latter
        // defaults to the leader = oldest pod, which may be a dead zombie that
        // would null the base URL and brick the box surface for every pod.
        let app = self.app
        let store = sessionStore
        Task { @MainActor in
            // Which boxes this device holds a session for decides whether the
            // leader can be the current server.
            let ids = Set(await store.podTokenIds())
            if app.sessionPodIds != ids { app.sessionPodIds = ids }
            let pod = app.isPaired ? app.sessionPod : nil
            await PodSessionSync.sync(currentPod: pod, store: store)
        }
    }

    /// Lazily build + lifecycle the single live-update canal. Foreground-only:
    /// started when `scenePhase == .active` AND the user is paired; stopped
    /// otherwise. The coordinator long-polls `/stream` and feeds AppState (pods
    /// + Box Request Inbox), so the per-screen watchers no longer need their own
    /// fetch timers. App-scope (built here at the shell), so it spans every tab.
    @MainActor
    private func syncLiveSync() {
        if liveSync == nil {
            let app = self.app
            let mailbox = self.mailbox
            liveSync = LiveSyncCoordinator(
                app: app,
                mailbox: mailbox,
                isActive: { [weak app] in (app?.isPaired ?? false) && (app?.isUnlocked ?? false) },
                makeReconciler: { fetch in
                    // Same reconcile path Home uses: surface registered/pending
                    // pods, drop ghosts, and run the secret-free SWK deposit for
                    // newly-registered boxes (idempotent, best-effort).
                    let swkDeposit: SwkDepositCoordinator? = (app.currentUser.map {
                        SwkDepositCoordinator(username: $0, mailbox: mailbox)
                    })
                    let trust = self.trust
                    return PendingServerReconciler(
                        app: app,
                        fetchPods: fetch,
                        onRegistered: { fqdn, identityPubKeyHex in
                            await swkDeposit?.depositIfNeeded(serverDomain: fqdn, identityPubKeyHex: identityPubKeyHex)
                        },
                        // Per-cert relay-trust aggregation (maintainer-trust Layer 3):
                        // verify each box's STK-signed box-trust-status and aggregate
                        // the untrusted ones BY failing relay cert-hash into the red
                        // sliver — one line + one override per DISTINCT authority. A
                        // warning + override source; it never gates `.com` I/O.
                        onDirectory: { pods in
                            trust.setRelayFailures(RelayTrustAggregator.aggregate(pods: pods))
                        }
                    )
                }
            )
        }
        let shouldRun = app.isPaired && scenePhase == .active
        if shouldRun { liveSync?.start() } else { liveSync?.stop() }
    }

    /// Every box this device manages, each with a client over its own paired
    /// session (the mock client alone in demo mode).
    @MainActor
    private func managedBoxes() -> @MainActor () async -> [AppAccessAlertCenter.Box] {
        let app = self.app
        let store = self.sessionStore
        let dev = self.dev
        let mock = self.screensClient
        let pinned = BoxPinnedURLSession.make(pinFor: { CertPinRegistry.shared.pinFor(host: $0) })
        return {
            guard dev.useLiveClient else {
                guard let domain = await mock.boxDomain() ?? app.sessionPod?.fqdn else { return [] }
                return [AppAccessAlertCenter.Box(serverDomain: domain, client: mock)]
            }
            var out: [AppAccessAlertCenter.Box] = []
            for pod in app.pods where pod.status != .pending && !pod.fqdn.isEmpty {
                guard let token = await store.sessionToken(forPodId: PodInfo.podId(forFqdn: pod.fqdn)),
                      !token.isEmpty else { continue }
                let client = LiveScreensClient(
                    urlSession: pinned,
                    store: PodScopedSessionStore(baseUrl: CompanionTicketURL.podBaseUrl(forFqdn: pod.fqdn),
                                                 token: token))
                out.append(AppAccessAlertCenter.Box(serverDomain: pod.fqdn, client: client))
            }
            return out
        }
    }

    /// Build the access-alert center once; while the app is in front, paired,
    /// unlocked and on an admin device (a restricted profile can't sign, and
    /// an admin-pinned box takes access answers from the admin root only),
    /// ask every managed box for waiting requests and listen on its events
    /// socket; otherwise stop listening. With push notifications off it shows
    /// no sheet. Also brings each box's access-alert setting and the `.com`
    /// push registration in line with the switch.
    @MainActor
    private func syncAccessAlerts() {
        let privacy = self.privacy
        if accessAlerts == nil {
            let app = self.app
            let center = AppAccessAlertCenter(
                boxes: managedBoxes(),
                isActive: { [weak app] in
                    guard let app else { return false }
                    return app.isPaired && app.isUnlocked && !app.isRestrictedDevice && AdminOrderGate.allows(app)
                },
                alertsEnabled: { privacy.pushNotificationsEnabled && !GymSeams.suppressAccessAlerts }
            )
            center.observeEvents()
            accessAlerts = center
        }
        if pushPrefs == nil {
            let registrar: @MainActor () -> PushRegistrar? = {
                (UIApplication.shared.delegate as? AppDelegate)?.pushRegistrar
            }
            pushPrefs = PushPreferenceSync(
                boxes: managedBoxes(),
                isEnabled: { privacy.pushNotificationsEnabled },
                registration: .init(
                    registerAPNs: { await Self.requestPushToken(privacy) },
                    unregisterAPNs: { UIApplication.shared.unregisterForRemoteNotifications() },
                    unregisterServer: { _ = await registrar()?.unregister() },
                    isRegistered: {
                        registrar()?.isRegistered == true || UIApplication.shared.isRegisteredForRemoteNotifications
                    }
                )
            )
        }
        guard let center = accessAlerts else { return }
        let inFront = app.isPaired && app.isUnlocked && scenePhase == .active
        if inFront, let prefs = pushPrefs {
            Task { await prefs.resync() }
        }
        if inFront && !app.isRestrictedDevice && AdminOrderGate.allows(app) && privacy.pushNotificationsEnabled {
            Task {
                await center.refresh()
                await center.startListening()
            }
        } else {
            center.stopListening()
            if !privacy.pushNotificationsEnabled { Task { await center.refresh() } }
        }
    }

    /// Lazily wire the registry on first use, then re-sync on every
    /// pod-list change. Watchers are idempotent: a sync after the
    /// list is unchanged is a no-op.
    @MainActor
    private func syncPendingWatchers() {
        if pendingWatchers == nil {
            pendingWatchers = PendingPodWatcherRegistry(app: app, server: serverClient)
        }
        pendingWatchers?.sync()
    }

    /// #91 — lazily build + start the AI-chat alert poller on first paint after
    /// pairing. Live-client only: the mock/demo client has no real box to drain
    /// `/api/phone/alerts` from. The poller self-gates on paired+unlocked, so
    /// it drains only while the app is usable (mirrors the sliver's
    /// hide-under-lock). The notifier routes through the App-scope
    /// `PushNotifications` so a tap deep-links to the chat, exactly like a real
    /// Web-Push wake.
    @MainActor
    private func syncAiChatPoller() {
        guard dev.useLiveClient else { return }
        if aiChatPoller == nil {
            let pinned = BoxPinnedURLSession.make(pinFor: { CertPinRegistry.shared.pinFor(host: $0) })
            let client = LivePhoneAlertClient(urlSession: pinned, store: sessionStore)
            let poller = AiChatAlertPoller(
                operations: operations,
                client: client,
                isActive: { [weak app] in (app?.isPaired ?? false) && (app?.isUnlocked ?? false) },
                notify: { sessionId, request, server in
                    guard let delegate = UIApplication.shared.delegate as? AppDelegate,
                          let push = delegate.push else { return }
                    push.notifyAiChatNeedsYou(
                        sessionId: sessionId,
                        isEnvVar: request == .requestEnvVar,
                        server: server
                    )
                }
            )
            aiChatPoller = poller
            poller.start()
        }
    }

    /// Lazy push registration — only after the user has a paired pod
    /// to receive notifications on. Re-enters every time we transition
    /// from unpaired → paired (post-recovery, fresh signup, etc.).
    ///
    /// The PushNotifications instance + PushRegistrar are owned by the
    /// App scope (see FlagshipApp.body), so the device-token callback
    /// can route through to .com regardless of which view triggered
    /// `registerForRemoteNotifications`.
    /// Smoke-test plumbing: launch with `-smoke-tab <home|apps|activity|settings>`
    /// to land on a specific tab on first paint. Production builds never
    /// pass this arg, so the optional stays nil and `.home` is used.
    private var smokeInitialDestination: RootDestination? {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-smoke-mode"),
              let idx = args.firstIndex(of: "-smoke-tab"),
              idx + 1 < args.count
        else { return nil }
        switch args[idx + 1] {
        case "home":     return .home
        case "apps":     return .apps
        case "activity": return .activity
        case "settings": return .settings
        default:         return nil
        }
    }

    private func registerPush() async {
        await Self.requestPushToken(privacy)
    }

    /// Ask iOS for a push token (its arrival registers it with `.com`), unless
    /// the owner switched push notifications off.
    @MainActor
    private static func requestPushToken(_ privacy: PrivacySettings) async {
        guard privacy.pushNotificationsEnabled,
              let delegate = UIApplication.shared.delegate as? AppDelegate,
              let push = delegate.push else { return }
        if await push.requestAuthorization() {
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}
