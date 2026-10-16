// Debug builds: the UI gym's launch seams and the mock clients its no-backend
// scenarios run on (see AppVariant). Never compiled into a release build.

package com.flagshipserver.app.core

import android.content.Intent
import com.flagshipserver.app.api.AppAccessPending
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockBoxDirect
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.MockServerTransferClient
import com.flagshipserver.app.api.MockServiceAccessClient
import com.flagshipserver.app.api.PodDirect
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.api.ServiceAccessClient

object Variant : AppVariant {
    /** Launch extra that points every client at another backend apex (the
     *  gym environment, or an unreachable host to keep a live run offline). */
    const val EXTRA_APEX_HOST = "flagship.apexHost"

    @Volatile private var mockRun = false

    override fun applyLaunchOverrides(intent: Intent?) {
        val host = intent?.getStringExtra(EXTRA_APEX_HOST)?.trim()?.lowercase().orEmpty()
        if (host.isEmpty()) return
        if (host == Endpoints.PROD_CONTROL_HOST) Endpoints.setOverride(null as Endpoints.Override?) else Endpoints.setOverride(host)
    }

    override fun gymLaunch(
        context: android.content.Context,
        intent: Intent?,
        appState: AppState,
        operations: ActiveOperationsCenter,
        trust: TrustCenter,
    ): GymLaunch? {
        val cfg = SmokeModeConfig.from(intent)
        if (cfg == null) {
            // A normal launch in the same process as an earlier gym run (the
            // gym's cold-start checks) must not inherit its seams.
            mockRun = false
            GymSeams.reset()
            PodDirect.transport = { OkHttpJsonTransport() }
            return null
        }
        if (cfg.persistSession) {
            // A real-looking signed-in device: an active keystore profile with
            // an account key and the lock on, as a cold start finds it.
            com.flagshipserver.app.keystore.Keystore.setActiveProfile(cfg.username)
            com.flagshipserver.app.keystore.Keystore.loadOrCreateUmkSeed()
            PrivacySettings.fromContext(context).setRequireBiometricAtLaunch(true)
        }
        val tab = SmokeMode.apply(config = cfg, appState = appState, operations = operations, trust = trust)
        mockRun = !cfg.live
        if (cfg.live) return GymLaunch(tab, mocks = null)

        val screens = MockScreensClient()
        // The access dialogs ask about each waiting host in turn: give Plants a
        // second one so Allow and Deny can both be answered (iOS has two).
        if (cfg.seedAccessAlert) {
            screens.accessFixture["bright-maple--plants"]?.let { plants ->
                screens.accessFixture["bright-maple--plants"] = plants.copy(
                    pending = plants.pending + AppAccessPending(
                        "tile.openstreetmap.org",
                        AppAccessPending.SOURCE_ATTEMPT,
                        3,
                        System.currentTimeMillis() - 600_000L,
                        System.currentTimeMillis() - 60_000L,
                    ),
                )
            }
        }
        screens.seedBackups(cfg.backups)
        MockScreensClient.smokeInstance = screens
        val build = MockBuildClient()
        // Smoke mode has no `.com` or box: an in-memory share world instead.
        val shares = if (!cfg.seedShares) null else {
            val home = appState.pods.value.firstOrNull { it.name == "Home" }
            MockServerShares.runtime(
                username = cfg.username,
                homeDomain = home?.fqdn ?: "home.${cfg.username}.flagship.services",
                homeStkPubHex = home?.identityPubKeyHex ?: "51".repeat(32),
                memberScreens = screens,
            )
        }
        val accessBoxes: ((AppState) -> List<AccessBox>)? = if (!cfg.seedAccessAlert) null else { app ->
            app.currentPod?.let { listOf(AccessBox(it.podId, it.fqdn, screens)) }.orEmpty()
        }
        val flagshipServer = MockFlagshipServerClient()
        val relay = MockQrRelayClient()
        val transfer = MockServerTransferClient()
        val mailbox = MockSecretMailboxClient()
        // The instrumented scenario (same process) checks what a button sent.
        GymProbe.screens = screens
        GymProbe.build = build
        GymProbe.flagship = flagshipServer
        GymProbe.mailbox = mailbox
        GymProbe.transfer = transfer
        GymProbe.relay = relay
        GymProbe.access = MockServiceAccessClient.shared
        cfg.chatVariant?.let { screens.chatVariant = it }
        // Power, dead-man, journal and front page talk to the box directly.
        val boxDirect = MockBoxDirect()
        GymProbe.boxDirect = boxDirect
        PodDirect.transport = { boxDirect }
        return GymLaunch(
            tab,
            GymMocks(
                screens = screens,
                build = build,
                flagshipServer = flagshipServer,
                relay = relay,
                transfer = transfer,
                mailbox = mailbox,
                podClients = FixedPodClients(screens, build),
                shares = shares,
                accessBoxes = accessBoxes,
            ),
        )
    }

    override val usesMockClients: Boolean get() = mockRun
    override val forceAdminRoot: Boolean get() = GymSeams.forceAdminRoot
    override val bypassBiometricGates: Boolean get() = GymSeams.bypassBiometricGates
    override val gymImportBackupFile: java.io.File? get() = GymSeams.importBackupFile

    override fun defaultScreens(): ScreensClient = MockScreensClient()
    override fun defaultBuild(): BuildClient = MockBuildClient()
    override fun defaultFlagshipServer(): FlagshipServerClient = MockFlagshipServerClient()
    override fun defaultQrRelay(): QrRelayClient = MockQrRelayClient()
    override fun defaultMailbox(): SecretMailboxClient = MockSecretMailboxClient()
    override fun defaultTransfer(): ServerTransferClient = MockServerTransferClient()

    override fun serviceAccessFixture(screens: ScreensClient): ServiceAccessFixture? {
        if (screens !is MockScreensClient) return null
        return ServiceAccessFixture(
            client = if (mockRun) MockServiceAccessClient.shared else ServiceAccessClient(),
            selfDeviceId = MockScreensClient.SELF_DEVICE_ID,
            selfDevicePub = MockScreensClient.SELF_DEVICE_PUB,
            deviceNames = MockScreensClient.DEVICE_NAMES,
        )
    }

    override fun freeAiClient(): FreeAiClient? = if (mockRun) MockFreeAiClient() else null

    override fun reuseRelay(shared: QrRelayClient): QrRelayClient? = shared.takeIf { it is MockQrRelayClient }

    override fun credentialCalls(): com.flagshipserver.app.keystore.CredentialCalls? =
        if (GymSeams.fakePasskeysNoPrfOnCreate) com.flagshipserver.app.keystore.FakePasskeyApp() else null

    override fun devicePairingRelays(): DevicePairingRelays =
        MockDevicePairingRelay().let { DevicePairingRelays(it.admin, it.incoming) }
}
