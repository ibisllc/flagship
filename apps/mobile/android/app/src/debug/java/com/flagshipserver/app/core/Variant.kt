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

    /** Empty every saved-settings file but the key store's own (its keys are reset per run). */
    private fun freshInstall(context: android.content.Context) {
        val dir = java.io.File(context.applicationInfo.dataDir, "shared_prefs")
        dir.listFiles { f -> f.name.endsWith(".xml") }?.forEach { f ->
            val name = f.name.removeSuffix(".xml")
            if (name == "flagship-keystore") return@forEach
            runCatching { context.getSharedPreferences(name, android.content.Context.MODE_PRIVATE).edit().clear().commit() }
        }
    }

    override fun isGymLaunch(intent: Intent?): Boolean = intent?.hasExtra(SmokeModeConfig.EXTRA_SMOKE_MODE) == true

    override fun applyLaunchOverrides(intent: Intent?) {
        // A gym scenario's in-memory key slot ends with its launch (the process lives on).
        com.flagshipserver.app.keystore.Keystore.restorePersistedActiveProfile()
        val host = intent?.getStringExtra(EXTRA_APEX_HOST)?.trim()?.lowercase().orEmpty()
        // No apex asked: the production one, whatever an earlier scenario in this process pointed at.
        if (host.isEmpty()) { Endpoints.setOverride(null as Endpoints.Override?); return }
        if (host == Endpoints.PROD_CONTROL_HOST) Endpoints.setOverride(null as Endpoints.Override?) else Endpoints.setOverride(host)
    }

    override fun gymLaunch(
        context: android.content.Context,
        intent: Intent?,
        appState: AppState,
        operations: ActiveOperationsCenter,
        trust: TrustCenter,
    ): GymLaunch? {
        // Every launch starts with no notice seam and no remembered notice state.
        GymSeams.noticePin = null
        GymSeams.noticeClockOffsetMs = 0
        GymSeams.noticeFetcher = null
        SecurityNoticeCenter.shared?.reset()
        val cfg = SmokeModeConfig.from(intent)
        if (cfg == null) {
            // A normal launch in the same process as an earlier gym run (the
            // gym's cold-start checks) must not inherit its seams.
            mockRun = false
            GymSeams.reset()
            PodDirect.transport = { OkHttpJsonTransport() }
            return null
        }
        // One process runs every scenario: whatever an earlier one saved on the device
        // (a configured cloud recovery, a seen link, settings) must not reach the next,
        // so each starts like a fresh install. A persisted-session run is the exception:
        // its later plain launch is meant to find what it left.
        if (!cfg.persistSession) freshInstall(context)
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
        GymProbe.appState = appState
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
    override val allowScreenCapture: Boolean get() = mockRun
    override val stubCamera: Boolean get() = mockRun
    override val gymImportBackupFile: java.io.File? get() = GymSeams.importBackupFile
    override val noticePin: String get() = GymSeams.noticePin ?: MaintainersTrust.bakedPin
    override fun noticeNowMs(): Long = System.currentTimeMillis() + GymSeams.noticeClockOffsetMs
    // A mock run has no `.com`: the poll finds no notice unless a scenario serves one.
    override fun noticeFetcher(): NoticeFetcher? = GymSeams.noticeFetcher ?: if (mockRun) NoticeFetcher { NoticeFetch.NoNotice } else null

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
