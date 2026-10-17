package com.flagshipserver.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.fragment.app.FragmentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Surface
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass as MaterialWindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.EncryptedSessionStore
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.LiveBuildClient
import com.flagshipserver.app.api.LiveScreensClient
import com.flagshipserver.app.api.LiveSecretMailboxClient
import com.flagshipserver.app.api.LiveServerTransferClient
import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.core.LocalServerTransferClient
import com.flagshipserver.app.api.LiveFlagshipServerClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.DeepLinker
import com.flagshipserver.app.core.LiveQrRelayClient
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalPrivacySettings
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.core.LocalBuildClient
import com.flagshipserver.app.core.LocalQrRelayClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.flagshipserver.app.core.LocalTrustCenter
import com.flagshipserver.app.core.TrustCenter
import com.flagshipserver.app.core.TrustChecker
import com.flagshipserver.app.core.TrustGatedTransport
import com.flagshipserver.app.ui.components.GlobalTrustBar
import com.flagshipserver.app.core.PrivacySettings
import com.flagshipserver.app.core.ThemeMode
import com.flagshipserver.app.core.QrRelayClient
import com.flagshipserver.app.core.ToastCenter
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.Keystore
import androidx.lifecycle.lifecycleScope
import com.flagshipserver.app.push.FlagshipFcmService
import com.flagshipserver.app.push.PushHolder
import com.flagshipserver.app.push.PushRegistrar
import com.flagshipserver.app.push.SecretRequestBridge
import com.flagshipserver.app.ui.components.GlobalOperationsBar
import com.flagshipserver.app.ui.components.Toaster
import com.flagshipserver.app.ui.onboarding.OnboardingFlow
import com.flagshipserver.app.ui.shell.RootShell
import com.flagshipserver.app.ui.shell.WindowWidthSizeClass
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FlagshipTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class MainActivity : FragmentActivity() {

    private lateinit var deepLinker: DeepLinker
    private lateinit var appState: AppState
    private lateinit var biometric: BiometricAuthority

    /** GYM smoke-mode (§10 Phase-5) — the tab the shell should open on when
     *  launched with `flagship.smokeTab`. Null in production / a normal launch
     *  ⇒ RootShell defaults to Home. */
    private var smokeInitialTab: com.flagshipserver.app.core.RootDestination? = null
    /** The mock clients of a debug gym run; null everywhere else (always in release). */
    private var gymMocks: com.flagshipserver.app.core.GymMocks? = null

    /** The activity is visible; internet-access requests are fetched only then. */
    private val foreground = MutableStateFlow(false)

    /** Phone-sized screens portrait-only, tablet-sized left to the system.
     *  Re-run on every configuration change so a foldable picks up the right
     *  rule when it opens or closes, whether or not the activity is recreated. */
    private fun applyOrientationPolicy(config: android.content.res.Configuration = resources.configuration) {
        val wanted = com.flagshipserver.app.core.OrientationPolicy.requestedOrientation(
            config.smallestScreenWidthDp,
        )
        if (requestedOrientation != wanted) requestedOrientation = wanted
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applyOrientationPolicy(newConfig)
    }

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        applyOrientationPolicy()
        // FIRST: a debug build's launch overrides (the gym's backend apex),
        // BEFORE the clients below read Endpoints. A release build has none.
        com.flagshipserver.app.core.Variant.applyLaunchOverrides(intent)
        Keystore.attach(applicationContext)
        FlagshipFcmService.ensureChannel(applicationContext)
        biometric = BiometricAuthority(this)
        BiometricAuthority.set(biometric)

        val privacy = PrivacySettings.fromContext(applicationContext)
        appState = AppState(
            requireBiometricAtLaunch = privacy.requireBiometricAtLaunch.value,
        )
        // Restore a previously paired session: if the Keystore still holds
        // a UMK seed (a real identity that survives process death) and we
        // know which cloud was active, land on the gated shell instead of
        // forcing a fresh sign-in every launch. The AppState constructor
        // already left the biometric latch armed, so a restored session
        // opens behind the lock screen. Skipped when the user opted into a
        // full passphrase sign-in every open. Demo/mock never store a seed.
        if (!privacy.requirePassphraseAtLaunch.value) {
            Keystore.activeProfile()?.let { activeCloud ->
                if (Keystore.hasUmkSeed()) appState.restorePersistedSession(activeCloud)
            }
        }
        // App lock (device bug M12): a cold start of a signed-in device with
        // "Lock with biometrics" on opens locked. Logged (no account data) so
        // a report of the app opening unlocked can be traced.
        runCatching {
            android.util.Log.i(
                com.flagshipserver.app.core.ErrorLog.TAG,
                "launch: lockOn=${privacy.requireBiometricAtLaunch.value} " +
                    "passphraseOn=${privacy.requirePassphraseAtLaunch.value} " +
                    "restored=${appState.isPaired.value} unlocked=${appState.isUnlocked.value}",
            )
        }
        val sessionStore = EncryptedSessionStore.create(applicationContext)
        appState.onSignedOut = { sessionStore.setDemoSession(null) }
        if (!appState.isPaired.value && !Keystore.hasUmkSeed()) {
            sessionStore.demoSession()?.let { demo ->
                com.flagshipserver.app.core.DemoAccount.activate(
                    appState,
                    demo.username,
                    demoServer = demo.server,
                )
            }
        }
        val toasts = ToastCenter()
        // App-wide "active operations" registry feeding the global teal sliver.
        // Deploy ops are kept in sync from the pod list in AppRoot; build ops
        // are registered by the build lifecycle (BuildGitViewModel).
        val operations = ActiveOperationsCenter()
        // App-wide maintainer-trust verdict + failing-cert registry feeding the
        // red persistent trust sliver + the `.com` backend short-circuit.
        val trustCenter = TrustCenter()
        deepLinker = DeepLinker()

        // GYM launch (§10 Phase-5), debug builds only (src/debug Variant): seed
        // the gym's state, land on the requested tab and, unless the run keeps
        // the live clients, swap in the mocks. A release build has no gym code,
        // so an intent can never seed fixtures there.
        com.flagshipserver.app.core.Variant.gymLaunch(applicationContext, intent, appState, operations, trustCenter)?.let { gym ->
            smokeInitialTab = gym.initialTab
            gymMocks = gym.mocks
        }
        val mocks = gymMocks
        val useLive = mocks == null

        // The leader becomes the current server only when this device can
        // talk to it (docs/app-placement.md §1). A gym run on mocks needs no session.
        appState.hasSession = { podId ->
            !useLive || sessionStore.sessionToken(forPodId = podId) != null
        }
        AiKeyStore.attach(applicationContext)
        com.flagshipserver.app.core.SecuredSessionStore.attach(applicationContext)
        com.flagshipserver.app.core.InviteOwners.attach(applicationContext)
        val okHttp = buildOkHttp()
        // LAN-direct probes are only valid for the network they ran on.
        getSystemService(android.net.ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) =
                    com.flagshipserver.app.core.LanDirectRegistry.shared.onNetworkChanged()
                override fun onLost(network: android.net.Network) =
                    com.flagshipserver.app.core.LanDirectRegistry.shared.onNetworkChanged()
            },
        )

        // Identity / security plane: the real flagshipserver.com (identity
        // claims, login/resolve, recovery, device admit/replace/wipe, TOTP,
        // audit, revoke, peer-backup, tier).
        // Maintainer-trust short-circuit: the live `.com` transport refuses to
        // send when the control server is positively untrusted (and the owner
        // hasn't overridden). UNKNOWN/TRUSTED + any network-error no-verdict
        // all let traffic through (we never brick on the absence of a verdict).
        val liveFlagshipServer = LiveFlagshipServerClient(
            TrustGatedTransport(OkHttpJsonTransport(okHttp)) { trustCenter.isServerTrusted },
        )

        val liveScreens = LiveScreensClient(client = okHttp, store = sessionStore)
        // #91 — drains the box's phone-pollable AlertInbox (GET /api/phone/alerts)
        // for AI-chat-needs-you events. Shares the box-pinned OkHttp + session
        // store with the screens client. The poller is built + started in
        // setContent (where the live/session pivot + operations center are in
        // scope), mirroring the deploy-sync LaunchedEffect.
        val livePhoneAlerts = com.flagshipserver.app.api.LivePhoneAlertClient(
            client = okHttp,
            store = sessionStore,
        )
        val appContext = applicationContext
        val liveBuild = LiveBuildClient(client = okHttp, store = sessionStore)
        val liveRelay = LiveQrRelayClient(client = okHttp)
        // Accepting a share asks `.com` about this account's own admin key (docs/share-a-server.md §5.1).
        val liveShares = com.flagshipserver.app.viewmodels.ServerShareRuntime.live(
            okHttp,
            appContext,
            account = {
                appState.currentUser.value?.let {
                    com.flagshipserver.app.core.ShareAccount(it, com.flagshipserver.app.core.AppState.isDemoAccount(appState.activeProfile, appState.pods.value))
                }
            },
        ) { trustCenter.isServerTrusted }
        val liveTransfer = LiveServerTransferClient(OkHttpJsonTransport(okHttp))
        // A′ pinning — every live /pods fetch reconciles the cert-pin
        // registry under STKs derived from THIS device's UMK. Live-only by
        // construction (the mock never invokes the observer), so demo/mock
        // sessions can never install pins; without a UMK there is nothing
        // to verify against, so no pins either.
        val liveMailbox = LiveSecretMailboxClient(
            OkHttpJsonTransport(okHttp),
            onPods = { response ->
                if (Keystore.hasUmkSeed()) {
                    val umkSeed = Keystore.currentUmkSeed()
                    com.flagshipserver.app.core.CertPinRegistry.shared.update(response.pods, umkSeed)
                    // LAN-direct: refresh the active box's signed LAN hint,
                    // bound to the pin just verified (docs/lan-direct.md).
                    val box = sessionStore.podBaseUrl.value
                        ?.let { runCatching { java.net.URI(it).host }.getOrNull() }
                    if (box != null) {
                        com.flagshipserver.app.core.LanDirectRegistry.shared.refresh(
                            box,
                            com.flagshipserver.app.core.ServerKeys.deriveStkPub(umkSeed, box),
                            com.flagshipserver.app.core.CertPinRegistry.shared.pinFor(box),
                        ) { liveScreens.lanHint() }
                    }
                }
            },
        )

        // Account read tokens (docs/account-read-token.md): every private read
        // of the account's servers, devices and apps on `.com` carries one.
        // Minted with the account device key (no prompt on Android) or the IRK
        // when the biometric session is already fresh — never a prompt.
        com.flagshipserver.app.core.AccountReadTokens.shared = com.flagshipserver.app.core.AccountReadTokens(
            transport = OkHttpJsonTransport(okHttp),
            store = com.flagshipserver.app.keystore.KeystoreReadTokenStore(),
            signers = { username ->
                com.flagshipserver.app.keystore.KeystoreReadTokenSigners.resolve(
                    username = username,
                    currentUser = appState.currentUser.value,
                    profile = appState.activeProfile,
                )
            },
            isDemo = { com.flagshipserver.app.core.AppState.isDemoAccount(appState.activeProfile, appState.pods.value) },
        )

        // Push-token registration is inherently a real-backend operation
        // (registering an FCM token + X25519 push key against .com), so it
        // always uses the live client; without a session it no-ops.
        val registrar = PushRegistrar(
            appState, liveFlagshipServer,
            isEnabled = { privacy.pushNotificationsEnabled.value },
        )
        PushHolder.registrar = registrar

        // Boot-secret RELAY: a `secret-request` push routes into the approval
        // list. The FCM service also synthesizes the deep link for the tap;
        // this bridge covers the foreground-receipt path.
        SecretRequestBridge.onSecretRequest = { deepLinker.enqueue(DeepLink.SecretRequests) }

        // Handle the intent that launched the activity (push tap, custom
        // URL scheme, app-link). The shell consumes the queue once the
        // composition is alive.
        intent?.let { handleIntent(it) }

        setContent {
            // Always the live clients, as iOS does; only a debug gym run swaps in
            // its mocks. A live account with no server (or no session yet) gets
            // the live client's "not paired" answer, which each screen turns
            // into its empty state, never fixtures.
            val sessionToken by sessionStore.sessionToken.collectAsState()
            val effectiveScreens: ScreensClient = mocks?.screens ?: liveScreens
            val effectiveBuild: BuildClient = mocks?.build ?: liveBuild
            val effectiveRelay: QrRelayClient = mocks?.relay ?: liveRelay
            val effectiveMailbox: SecretMailboxClient = mocks?.mailbox ?: liveMailbox
            val effectiveTransfer: ServerTransferClient = mocks?.transfer ?: liveTransfer
            val effectiveFlagshipServer: FlagshipServerClient = mocks?.flagshipServer ?: liveFlagshipServer
            // Clients bound to one server's own base URL and session, for the
            // screens that work on a server other than the current one
            // (docs/app-placement.md).
            val podClients: com.flagshipserver.app.core.PodClients = remember {
                mocks?.podClients ?: com.flagshipserver.app.core.LivePodClients(okHttp, sessionStore)
            }

            // Maintainer-trust check on launch (live only — the Mock control
            // server has no blessing to verify). Uses a NON-gated transport so
            // a re-check can still fetch to RECOVER out of an untrusted state.
            // A network/parse failure is a NON-verdict (never bricks offline).
            LaunchedEffect(useLive) {
                if (!useLive) return@LaunchedEffect
                when (val outcome = TrustChecker(OkHttpJsonTransport(okHttp)).check()) {
                    is TrustChecker.Outcome.Trusted -> trustCenter.markTrusted()
                    is TrustChecker.Outcome.Untrusted -> trustCenter.markUntrusted(listOf(outcome.failure))
                    is TrustChecker.Outcome.NoVerdict -> trustCenter.markNoVerdict()
                }
            }

            // #91 — AI-chat alert foreground poll. Live + paired only: the mock
            // client has no real box to drain. The poller self-gates on
            // paired+unlocked (mirrors the sliver's hide-under-lock). The
            // notifier routes through the FCM-channel local notification so a
            // tap deep-links to the chat, exactly like a real push wake.
            val aiChatPoller = remember {
                com.flagshipserver.app.core.AiChatAlertPoller(
                    operations = operations,
                    client = livePhoneAlerts,
                    isActiveGate = { appState.isPaired.value && appState.isUnlocked.value },
                    notify = { sessionId, request, server ->
                        FlagshipFcmService.showAiChatNotification(
                            appContext,
                            sessionId,
                            isEnvVar = request == com.flagshipserver.app.api.AiChatRequest.REQUEST_ENV_VAR,
                            server = server,
                        )
                    },
                    // The alert client reads the current server's session.
                    currentServer = { appState.sessionPod?.fqdn },
                )
            }
            LaunchedEffect(useLive, sessionToken != null) {
                if (useLive && sessionToken != null) {
                    aiChatPoller.start(this)
                } else {
                    aiChatPoller.stop()
                }
            }

            // Internet-access alerts (§3a). Live only, like the AI-chat poller:
            // the mock has no real box. Every box the phone manages is asked
            // over its own paired session, on foreground, on a `generic`
            // push that lands while open, and on a slow foreground poll.
            val liveNow by androidx.compose.runtime.rememberUpdatedState(useLive)
            val accessBoxes: () -> List<com.flagshipserver.app.core.AccessBox> = remember {
                val clients = HashMap<String, ScreensClient>()
                val resolve: () -> List<com.flagshipserver.app.core.AccessBox> = {
                    if (!liveNow) emptyList() else appState.pods.value.mapNotNull { pod ->
                        if (pod.fqdn.isEmpty() || pod.demoServer != null) return@mapNotNull null
                        val token = sessionStore.sessionToken(forPodId = pod.podId) ?: return@mapNotNull null
                        val client = synchronized(clients) {
                            clients.getOrPut("${pod.fqdn}|$token") {
                                val store = com.flagshipserver.app.api.InMemorySessionStore().apply {
                                    setPodBaseUrl("https://${pod.fqdn}")
                                    setSessionToken(token)
                                }
                                LiveScreensClient(client = okHttp, store = store)
                            }
                        }
                        com.flagshipserver.app.core.AccessBox(pod.podId, pod.fqdn, client)
                    }
                }
                resolve
            }
            val accessCenter = remember {
                com.flagshipserver.app.core.AccessRequestCenter(
                    boxes = accessBoxes,
                    isActiveGate = {
                        foreground.value && appState.isPaired.value && appState.isUnlocked.value &&
                            !appState.isRestrictedDevice() &&
                            // Allow / Deny is an admin order: other devices see
                            // the requests on each app's page, read-only.
                            com.flagshipserver.app.core.AdminOrderGate.allows(appState)
                    },
                    alertsEnabled = { privacy.pushNotificationsEnabled.value },
                )
            }
            // Settings → Push notifications: one switch for this device's push
            // registration with .com and every box's access-request pushes.
            val pushSwitch = remember {
                com.flagshipserver.app.core.PushNotificationsSwitch(
                    enabled = privacy.pushNotificationsEnabled,
                    persist = privacy::setPushNotificationsEnabled,
                    boxes = accessBoxes,
                    register = { registrar.registerCurrentToken() },
                    revoke = { registrar.revoke(forgetOnFailure = false) },
                    isRegistered = { !Keystore.pushTokenId().isNullOrEmpty() },
                    dropProviderToken = { registrar.deleteProviderToken() },
                    scope = this@MainActivity.lifecycleScope,
                )
            }
            // A gym run: the same dialogs, fed by the mock box (one fetch).
            val smokeAccessCenter = remember {
                mocks?.accessBoxes?.let { boxes ->
                    com.flagshipserver.app.core.AccessRequestCenter(
                        boxes = { boxes(appState) },
                        isActiveGate = { appState.isPaired.value && appState.isUnlocked.value },
                    )
                }
            }
            LaunchedEffect(smokeAccessCenter) { smokeAccessCenter?.refresh() }
            val accessScope = androidx.compose.runtime.rememberCoroutineScope()
            androidx.compose.runtime.DisposableEffect(accessCenter) {
                com.flagshipserver.app.core.AccessRequestBridge.onAccessRequest = {
                    accessScope.launch { accessCenter.refresh() }
                }
                onDispose { com.flagshipserver.app.core.AccessRequestBridge.onAccessRequest = null }
            }
            val isForeground by foreground.collectAsState()
            val accessPaired by appState.isPaired.collectAsState()
            val accessUnlocked by appState.isUnlocked.collectAsState()
            LaunchedEffect(useLive, isForeground, accessPaired, accessUnlocked) {
                if (useLive && isForeground && accessPaired && accessUnlocked) {
                    accessCenter.start(this)
                } else {
                    accessCenter.stop()
                }
            }
            val pushOn by privacy.pushNotificationsEnabled.collectAsState()
            LaunchedEffect(pushOn) { accessCenter.refresh() }

            // Pending installs this device created: poll each order's status
            // while the app runs, so the setup notification and the watch
            // advance without a push or an open install screen.
            val currentFlagshipServer = androidx.compose.runtime.rememberUpdatedState(effectiveFlagshipServer)
            val pendingWatchers = remember {
                com.flagshipserver.app.core.PendingPodWatchers(
                    app = appState,
                    server = { currentFlagshipServer.value },
                    report = { u -> com.flagshipserver.app.companion.ProvisionProgressCenter.report(applicationContext, u) },
                )
            }
            val watchedPods by appState.pods.collectAsState()
            val watcherScope = androidx.compose.runtime.rememberCoroutineScope()
            LaunchedEffect(watchedPods, isForeground, accessPaired) {
                if (isForeground && accessPaired) pendingWatchers.sync(watcherScope) else pendingWatchers.stopAll()
            }
            LaunchedEffect(useLive, isForeground, accessPaired, accessUnlocked) {
                if (isForeground && accessPaired && accessUnlocked) runCatching { pushSwitch.resync() }
            }

            // MULTI-POD (Fix B) — PodSessionSync. When the current/leader pod
            // changes, point the single active base-URL + token slots at THAT
            // pod's per-pod token (deterministic base URL `https://<fqdn>`).
            // First-activation also runs the legacy-single-token migration so a
            // box paired before the per-pod store attributes its existing token
            // to its pod (idempotent). A pod with no stored token activates with a
            // null token → the BFF 401s → "pair this device", never borrowing
            // another pod's token. Mirror of iOS PodSessionSync.
            val currentPodId by appState.currentPodId.collectAsState()
            val leaderPodId by appState.leaderPodId.collectAsState()
            val pods by appState.pods.collectAsState()
            LaunchedEffect(currentPodId, leaderPodId, pods, useLive) {
                // currentPod prefers an online leader this device has a
                // session for (docs/app-placement.md §1).
                val pod = appState.currentPod
                if (pod != null && pod.fqdn.isNotEmpty()) {
                    sessionStore.migrateSingleTokenToPod(pod.podId)
                    sessionStore.activatePod(pod.podId, "https://${pod.fqdn}")
                }
            }

            // LiveSync — the single app-scope live-update canal. ONE /stream
            // long-poll feeds AppState (pods + Box Request Inbox), collapsing the
            // per-screen Home pollers into one channel. It is wired HERE (at the
            // shell, not a tab) so it spans every screen, and self-gates on
            // paired+unlocked — locking on onStop (which clears isUnlocked) pauses
            // it, matching the iOS .background semantics (foreground-only). Falls
            // back to /pods when /stream is down, so behavior never degrades.
            val liveSync = remember(effectiveMailbox) {
                com.flagshipserver.app.core.LiveSyncCoordinator(
                    app = appState,
                    mailbox = effectiveMailbox,
                    isActiveGate = { appState.isPaired.value && appState.isUnlocked.value },
                    makeReconciler = {
                        // Same reconcile path Home uses, incl. the secret-free
                        // SWK/pairing deposit for newly-registered boxes
                        // (idempotent, best-effort, no-op unless owed).
                        val swkStore = com.flagshipserver.app.core.PendingSwkDepositStore.from(appContext)
                        val pairingStore = com.flagshipserver.app.core.PendingPairingDepositStore.from(appContext)
                        val cgkStore = com.flagshipserver.app.core.PendingCgkDepositStore.from(appContext)
                        val holdStore = com.flagshipserver.app.core.MigrationHoldStore.from(appContext)
                        com.flagshipserver.app.core.PendingServerReconciler(
                            app = appState,
                            mailbox = effectiveMailbox,
                            onRegistered = { fqdn, identityPubKeyHex ->
                                val user = appState.currentUser.value
                                if (!user.isNullOrEmpty()) {
                                    com.flagshipserver.app.core.SwkDepositCoordinator
                                        .live(user, effectiveMailbox, swkStore, pairingStore, cgkStore, holdStore)
                                        .depositIfNeeded(fqdn, identityPubKeyHex)
                                }
                            },
                            // Per-cert relay-trust aggregation (maintainer-trust
                            // Layer 3): verify each box's STK-signed box-trust-status
                            // and aggregate the untrusted ones BY failing relay
                            // cert-hash into the red sliver — one line + one override
                            // per DISTINCT authority. A warning + override source; it
                            // never gates `.com` I/O.
                            onDirectory = { pods ->
                                trustCenter.setRelayFailures(
                                    com.flagshipserver.app.core.RelayTrustAggregator.aggregate(pods),
                                )
                            },
                        )
                    },
                )
            }
            val liveSyncPaired by appState.isPaired.collectAsState()
            LaunchedEffect(liveSyncPaired) {
                if (liveSyncPaired) liveSync.start(this) else liveSync.stop()
            }
            com.flagshipserver.app.companion.CompanionSurfaces(appState, effectiveMailbox) { foreground.value }

            val sizeClass = calculateWindowSizeClass(this)

            // Appearance override (Settings → Appearance). AUTO follows the
            // system; LIGHT/DARK force the palette app-wide.
            val themeMode by privacy.themeMode.collectAsState()
            val useDark = when (themeMode) {
                ThemeMode.AUTO -> isSystemInDarkTheme()
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
            }

            // With the app lock on, Recents shows no snapshot of the account
            // (the lock screen only arrives after the app is already gone).
            val lockOn by privacy.requireBiometricAtLaunch.collectAsState()
            LaunchedEffect(lockOn) {
                if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!lockOn)
            }

            FlagshipTheme(darkTheme = useDark) {
                CompositionLocalProvider(
                    LocalAppState provides appState,
                    LocalScreensClient provides effectiveScreens,
                    LocalBuildClient provides effectiveBuild,
                    LocalFlagshipServerClient provides effectiveFlagshipServer,
                    LocalQrRelayClient provides effectiveRelay,
                    LocalSecretMailboxClient provides effectiveMailbox,
                    LocalServerTransferClient provides effectiveTransfer,
                    LocalSessionStore provides sessionStore,
                    com.flagshipserver.app.core.LocalPodClients provides podClients,
                    com.flagshipserver.app.viewmodels.LocalServerShares provides (if (useLive) liveShares else mocks?.shares),
                    LocalToastCenter provides toasts,
                    LocalActiveOperationsCenter provides operations,
                    LocalTrustCenter provides trustCenter,
                    LocalDeepLinker provides deepLinker,
                    com.flagshipserver.app.core.LocalAccessRequestCenter provides
                        (if (useLive) accessCenter else smokeAccessCenter),
                    LocalPrivacySettings provides privacy,
                    com.flagshipserver.app.core.LocalPushNotificationsSwitch provides pushSwitch,
                    // Real IRK signer for env changes (was the 128-zero
                    // placeholder, which the daemon always rejected).
                    LocalVibeCodeEnvelopeSigner provides { change ->
                        val bytes = change.canonicalBytes()
                        HexUtil.encode(
                            Keystore.deriveIRK("Sign service configuration").sign(bytes),
                        )
                    },
                ) {
                    Surface(color = FS.colors.bg, modifier = Modifier.fillMaxSize()) {
                        AppRoot(
                            widthSizeClass = mapWidth(sizeClass.widthSizeClass),
                            initialTab = smokeInitialTab,
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        PushHolder.registrar = null
        SecretRequestBridge.onSecretRequest = null
        BiometricAuthority.clearIf(biometric)
    }

    /** C12 — re-arm the lock-screen gate when the activity moves to
     *  background. onPause fires on transient interruptions (e.g. a
     *  pull-down notification center) which we DON'T want to lock on;
     *  onStop fires only when the activity is genuinely backgrounded.
     *  Tradeoff: locking on onPause is "more secure" but disruptive;
     *  locking on onStop matches the iOS .background semantics. */
    override fun onStart() {
        super.onStart()
        foreground.value = true
        // The visible activity owns the biometric prompt (another instance's
        // onDestroy must never leave key use without one).
        if (::biometric.isInitialized) BiometricAuthority.set(biometric)
    }

    override fun onStop() {
        super.onStop()
        foreground.value = false
        if (::appState.isInitialized) {
            appState.relockForBackground()
        }
    }

    /** Parse incoming launch intents (the https://flagshipserver.com
     *  App Links, incl. `/app/<…>`, and older builds' `flagship://…`). Push
     *  notifications surface their deepLink via the same path. The
     *  actual URI→DeepLink translation lives in core.AppLink so it
     *  can be unit-tested without an activity. */
    private fun handleIntent(intent: Intent) {
        val uri = intent.data ?: return
        val link = com.flagshipserver.app.core.AppLink.resolve(uri) ?: return
        deepLinker.enqueue(link)
    }

    private fun buildOkHttp(): OkHttpClient =
        com.flagshipserver.app.core.HttpClientFactory.build()

    private fun mapWidth(w: MaterialWindowWidthSizeClass): WindowWidthSizeClass = when (w) {
        MaterialWindowWidthSizeClass.Expanded -> WindowWidthSizeClass.EXPANDED
        MaterialWindowWidthSizeClass.Medium -> WindowWidthSizeClass.MEDIUM
        else -> WindowWidthSizeClass.COMPACT
    }
}

@Composable
private fun AppRoot(
    widthSizeClass: WindowWidthSizeClass,
    /** GYM smoke-mode (§10 Phase-5) — opens the shell on this tab on first paint
     *  when set (the `flagship.smokeTab` selector). Null ⇒ Home, the production
     *  default. */
    initialTab: com.flagshipserver.app.core.RootDestination? = null,
) {
    val app = LocalAppState.current
    val isPaired by app.isPaired.collectAsState()
    val isUnlocked by app.isUnlocked.collectAsState()
    val toasts = LocalToastCenter.current
    val toastQueue by toasts.queue.collectAsState()
    val operations = LocalActiveOperationsCenter.current
    val pods by app.pods.collectAsState()

    val showSecureAccount by app.pendingSecureAccountNudge.collectAsState()

    // Keep the global operations sliver's deploy feeder in sync with the pod
    // list (mirror of iOS ContentView's syncDeployOperations on every pod
    // change). Cleared to empty while unpaired so a sign-out drops the sliver.
    LaunchedEffect(pods, isPaired) {
        operations.syncDeployOperations(if (isPaired) pods else emptyList())
    }

    // Trust-the-session model (mirror of iOS ContentView clearing the UMK cache
    // on isUnlocked/isPaired -> false): the biometric freshness latch lives only
    // while the app is unlocked + paired. The instant it re-locks (background
    // relock / explicit lock) or signs out, drop the latch so the next session
    // re-authenticates once — the biometric still gates each session, it just no
    // longer fires again mid-session (which is what stopped the random Face ID /
    // fingerprint prompts the periodic deposit refresh used to trigger).
    LaunchedEffect(isUnlocked, isPaired) {
        if (!isUnlocked || !isPaired) BiometricAuthority.current()?.invalidate()
    }

    // Slice B — AUTO-PAIR. On unlock (with pods loaded), silently provision this
    // device's per-box BFF session token for every ONLINE pod that lacks one,
    // behind ONE biometric (the coordinator derives the owner IRK once + reuses
    // it, and no-ops without a prompt when nothing is pending). A per-pod failure
    // retries on the next unlock. Removes the manual "Pair this device" step;
    // pairing-for-use is not sensitive, so it's admin-independent.
    val sessionStore = LocalSessionStore.current
    val server = LocalFlagshipServerClient.current
    LaunchedEffect(isPaired, isUnlocked, pods) {
        if (!isPaired || !isUnlocked) return@LaunchedEffect
        val onlinePods = pods.filter {
            it.status == com.flagshipserver.app.core.PodInfo.Status.ONLINE && it.fqdn.isNotEmpty()
        }
        if (onlinePods.isEmpty()) return@LaunchedEffect
        val username = app.currentUser.value ?: return@LaunchedEffect
        val demoPods = onlinePods.filter { it.demoServer != null }
        for (pod in demoPods) {
            runCatching {
                com.flagshipserver.app.core.DemoSessionPairer.ensurePaired(
                    username = username,
                    server = pod.demoServer!!,
                    client = server,
                    store = sessionStore,
                )
            }
        }
        val realPods = onlinePods.filter { it.demoServer == null }
        com.flagshipserver.app.viewmodels.PodAutoPairCoordinator(store = sessionStore)
            .pairAll(realPods) { reason -> Keystore.deriveIRK(reason) }
    }

    // Edge-to-edge (targetSdk 35 forces it): pad the status bar + landscape
    // side bars ONCE here so the slivers, shell, onboarding, and overlays all
    // clear them. The padding CONSUMES those insets, so inner Scaffolds don't
    // double-pad; the bottom is deliberately left to NavigationBar/Rail, which
    // pad their own systemBars insets.
    Box(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(
                WindowInsets.systemBars.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
            ),
    ) {
        if (isPaired) {
            // The teal sliver sits ABOVE the shell in a Column so revealing it
            // physically pushes the whole shell down (it animates its own
            // height), exactly like WhatsApp's active-call bar.
            Column(Modifier.fillMaxSize()) {
                // The trust sliver sits ABOVE the operations sliver: a degraded
                // maintainer-trust state is higher priority than any running
                // operation, and both push the shell down from the top.
                GlobalTrustBar()
                GlobalOperationsBar()
                RootShell(widthSizeClass = widthSizeClass, initialTab = initialTab)
            }
        } else {
            OnboardingFlow(onFinished = { /* AppState.completeOnboarding flips isPaired */ })
        }
        // SKIPPABLE "Secure your account" backup nudge — layered ABOVE
        // the freshly-mounted shell on the CREATE path only, until the
        // user backs up or skips. Armed by OpenAccountViewModel.
        if (showSecureAccount) {
            com.flagshipserver.app.ui.screens.SecureAccountOverlay(
                onDismiss = { app.clearSecureAccountNudge() },
            )
        }
        // C12 — lock overlay above EVERYTHING whenever the in-memory
        // unlock latch is false. Conditional on isPaired so the Welcome
        // flow isn't gated (passkey auth is the gate on Welcome).
        //
        // The latch is false in two cases: (a) the user requires
        // biometric-at-launch and relockForBackground() re-armed it, or
        // (b) the user explicitly tapped Lock (AppState.lock()), which
        // re-gates regardless of the launch preference. Gating on the
        // latch ALONE (not also requireGate) is what lets an explicit
        // Lock work even when auto-lock is off — the latch starts `true`
        // when the preference is off, so nothing else flips it spuriously.
        // Internet-access requests (§3a): one dialog per request, never over
        // the lock screen. "View access list" opens the app's list on its box.
        val accessCenter = com.flagshipserver.app.core.LocalAccessRequestCenter.current
        val deepLinker = LocalDeepLinker.current
        if (isPaired && isUnlocked && accessCenter != null) {
            com.flagshipserver.app.ui.screens.AccessRequestDialogHost(accessCenter) { alert ->
                deepLinker.enqueue(
                    DeepLink.AccessList(alert.request.serviceId, draft = alert.isDraft, podId = alert.box.podId),
                )
            }
        }
        // The watch's Approve reached a session without its biometric yet.
        if (isPaired && isUnlocked) {
            com.flagshipserver.app.ui.shell.WatchWaitingDialog()
        }
        if (isPaired && !isUnlocked) {
            com.flagshipserver.app.ui.shell.BiometricLockScreen()
        }
        Toaster(queue = toastQueue, onDismiss = { toasts.dismiss(it) })
    }
}
