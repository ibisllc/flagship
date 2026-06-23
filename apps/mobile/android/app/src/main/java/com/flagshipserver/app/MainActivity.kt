package com.flagshipserver.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.fragment.app.FragmentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
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
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.LiveSecretMailboxClient
import com.flagshipserver.app.api.LiveServerTransferClient
import com.flagshipserver.app.api.MockServerTransferClient
import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.core.LocalServerTransferClient
import com.flagshipserver.app.api.LiveFlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.DeepLinker
import com.flagshipserver.app.core.DeveloperSettings
import com.flagshipserver.app.core.LiveQrRelayClient
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalPrivacySettings
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.core.canonicalSetServiceEnv
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
import com.flagshipserver.app.core.MockQrRelayClient
import com.flagshipserver.app.core.PrivacySettings
import com.flagshipserver.app.core.ThemeMode
import com.flagshipserver.app.core.QrRelayClient
import com.flagshipserver.app.core.ToastCenter
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.Keystore
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

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // FIRST: apply a backend-apex override from the launch intent, BEFORE
        // the OkHttp client / clients are built below (the pinner + the live
        // clients read Endpoints at construction). The gym test build launches
        // with `--es flagship.apexHost gym.flagshipserver.com`; a prod launch
        // passes nothing, so Endpoints stays on today's literal (and the prod
        // SPKI pins still apply). A persisted DeveloperSettings.apexHost is the
        // fallback when no intent extra is present.
        intent?.getStringExtra("flagship.apexHost")?.let { host ->
            if (host.isNotBlank()) DeveloperSettings.applyApexOverride(host)
        }
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
        val sessionStore = EncryptedSessionStore.create(applicationContext)
        val toasts = ToastCenter()
        // App-wide "active operations" registry feeding the global teal sliver.
        // Deploy ops are kept in sync from the pod list in AppRoot; build ops
        // are registered by the build lifecycle (BuildGitViewModel).
        val operations = ActiveOperationsCenter()
        // App-wide maintainer-trust verdict + failing-cert registry feeding the
        // red persistent trust sliver + the `.com` backend short-circuit.
        val trustCenter = TrustCenter()
        deepLinker = DeepLinker()

        // GYM smoke-mode seam (§10 Phase-5) — DEBUG-ONLY, mirror of iOS
        // FlagshipApp.applySmokeModeIfRequested. When the app is debuggable AND
        // the launch intent carries `flagship.smokeMode`, seed DemoFixtures (no
        // backend) + an optional ops/trust/server-event state and land on the
        // requested tab. A RELEASE build skips this branch entirely, so an
        // intent extra can never seed fixtures in production. The resulting
        // initial tab is threaded into RootShell below.
        val isDebuggable =
            (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (isDebuggable) {
            com.flagshipserver.app.core.SmokeModeConfig.from(intent)?.let { cfg ->
                smokeInitialTab = com.flagshipserver.app.core.SmokeMode.apply(
                    config = cfg,
                    appState = appState,
                    operations = operations,
                    trust = trustCenter,
                )
            }
        }

        val devSettings = DeveloperSettings.create(applicationContext)
        AiKeyStore.attach(applicationContext)
        com.flagshipserver.app.core.SecuredSessionStore.attach(applicationContext)
        val okHttp = buildOkHttp()

        // Identity / security plane. Mock for emulator/dev; Live talks to the
        // real flagshipserver.com (identity claims, login/resolve, recovery,
        // device admit/replace/wipe, TOTP, audit, revoke, peer-backup, tier).
        // Pivoted on the developer toggle below — previously this was hardwired
        // to the mock, so a shipped build never reached the real backend.
        val mockFlagshipServer = MockFlagshipServerClient()
        // Maintainer-trust short-circuit: the live `.com` transport refuses to
        // send when the control server is positively untrusted (and the owner
        // hasn't overridden). UNKNOWN/TRUSTED + any network-error no-verdict
        // all let traffic through (we never brick on the absence of a verdict).
        val liveFlagshipServer = LiveFlagshipServerClient(
            TrustGatedTransport(OkHttpJsonTransport(okHttp)) { trustCenter.isServerTrusted },
        )

        val mockScreens = MockScreensClient()
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
        val mockBuild = MockBuildClient()
        val liveBuild = LiveBuildClient(client = okHttp, store = sessionStore)
        val mockRelay = MockQrRelayClient()
        val liveRelay = LiveQrRelayClient(client = okHttp)
        val mockTransfer = MockServerTransferClient()
        val liveTransfer = LiveServerTransferClient(OkHttpJsonTransport(okHttp))
        val mockMailbox = MockSecretMailboxClient()
        // A′ pinning — every live /pods fetch reconciles the cert-pin
        // registry under STKs derived from THIS device's UMK. Live-only by
        // construction (the mock never invokes the observer), so demo/mock
        // sessions can never install pins; without a UMK there is nothing
        // to verify against, so no pins either.
        val liveMailbox = LiveSecretMailboxClient(
            OkHttpJsonTransport(okHttp),
            onPods = { response ->
                if (Keystore.hasUmkSeed()) {
                    com.flagshipserver.app.core.CertPinRegistry.shared.update(
                        response.pods,
                        Keystore.currentUmkSeed(),
                    )
                }
            },
        )

        // Push-token registration is inherently a real-backend operation
        // (registering an FCM token + X25519 push key against .com), so it
        // always uses the live client; without a session it no-ops.
        val registrar = PushRegistrar(appState, liveFlagshipServer)
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
            // Pivot Mock vs Live on the developer toggle + presence of
            // a stored session token. The CompositionLocal swap is
            // automatic — every screen that reads LocalScreensClient
            // re-composes when the value changes.
            val useLive by devSettings.useLiveClient.collectAsState()
            val sessionToken by sessionStore.sessionToken.collectAsState()
            val effectiveScreens: ScreensClient =
                if (useLive && sessionToken != null) liveScreens else mockScreens
            val effectiveBuild: BuildClient =
                if (useLive && sessionToken != null) liveBuild else mockBuild
            val effectiveRelay: QrRelayClient =
                if (useLive) liveRelay else mockRelay
            val effectiveMailbox: SecretMailboxClient =
                if (useLive) liveMailbox else mockMailbox
            val effectiveTransfer: ServerTransferClient =
                if (useLive) liveTransfer else mockTransfer
            // Identity calls are IRK-signed (not session-token gated), so this
            // pivots on the toggle alone — like relay/mailbox above.
            val effectiveFlagshipServer: FlagshipServerClient =
                if (useLive) liveFlagshipServer else mockFlagshipServer

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
                    notify = { sessionId, request ->
                        FlagshipFcmService.showAiChatNotification(
                            appContext,
                            sessionId,
                            isEnvVar = request == com.flagshipserver.app.api.AiChatRequest.REQUEST_ENV_VAR,
                        )
                    },
                )
            }
            LaunchedEffect(useLive, sessionToken != null) {
                if (useLive && sessionToken != null) {
                    aiChatPoller.start(this)
                } else {
                    aiChatPoller.stop()
                }
            }

            val sizeClass = calculateWindowSizeClass(this)

            // Appearance override (Settings → Appearance). AUTO follows the
            // system; LIGHT/DARK force the palette app-wide.
            val themeMode by privacy.themeMode.collectAsState()
            val useDark = when (themeMode) {
                ThemeMode.AUTO -> isSystemInDarkTheme()
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
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
                    LocalToastCenter provides toasts,
                    LocalActiveOperationsCenter provides operations,
                    LocalTrustCenter provides trustCenter,
                    LocalDeepLinker provides deepLinker,
                    LocalDeveloperSettings provides devSettings,
                    LocalPrivacySettings provides privacy,
                    // Real IRK signer for SetServiceEnv envelopes (was the
                    // 128-zero placeholder, which the daemon always rejected).
                    LocalVibeCodeEnvelopeSigner provides { envelope ->
                        HexUtil.encode(
                            Keystore.deriveIRK("Sign service configuration")
                                .sign(canonicalSetServiceEnv(envelope)),
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
        BiometricAuthority.set(null)
    }

    /** C12 — re-arm the lock-screen gate when the activity moves to
     *  background. onPause fires on transient interruptions (e.g. a
     *  pull-down notification center) which we DON'T want to lock on;
     *  onStop fires only when the activity is genuinely backgrounded.
     *  Tradeoff: locking on onPause is "more secure" but disruptive;
     *  locking on onStop matches the iOS .background semantics. */
    override fun onStop() {
        super.onStop()
        if (::appState.isInitialized) {
            appState.relockForBackground()
        }
    }

    /** Parse incoming launch intents (`flagship://...` and the
     *  https://flagshipserver.com/app/<…> universal-link form). Push
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

    Box(Modifier.fillMaxSize()) {
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
        if (isPaired && !isUnlocked) {
            com.flagshipserver.app.ui.shell.BiometricLockScreen()
        }
        Toaster(queue = toastQueue, onDismiss = { toasts.dismiss(it) })
    }
}
