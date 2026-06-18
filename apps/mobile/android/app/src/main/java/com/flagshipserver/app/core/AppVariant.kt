// What a build type adds to the app. A release build adds nothing: it is
// always live, with no fixtures, mock clients, developer mode or gym seams
// (src/release/…/Variant.kt). A debug build adds the UI gym's launch seams and
// the mock clients its no-backend scenarios run on (src/debug/…/Variant.kt).
// Main code reaches them only through [Variant], which each build type defines.

package com.flagshipserver.app.core

import android.content.Intent
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.viewmodels.ServerShareRuntime

interface AppVariant {
    /** Launch-intent overrides applied before any client is built (debug:
     *  the gym's backend apex). */
    fun applyLaunchOverrides(intent: Intent?)

    /** True for a debug gym launch (the release build never is). */
    fun isGymLaunch(intent: Intent?): Boolean

    /** A gym launch (debug only): seeds [appState] and returns the tab to open
     *  and, unless the run keeps the live clients, the mock clients. Null for a
     *  normal launch, and always in release. */
    fun gymLaunch(
        context: android.content.Context,
        intent: Intent?,
        appState: AppState,
        operations: ActiveOperationsCenter,
        trust: TrustCenter,
    ): GymLaunch?

    /** Gym live e2e (debug only): adopt a real box's owner identity when the
     *  launch carries `flagship.gymAdoptSeed`. Nothing in release. */
    fun adoptLiveIdentity(
        intent: Intent?,
        appState: AppState,
        store: com.flagshipserver.app.api.SessionStoring,
        client: okhttp3.OkHttpClient,
        scope: kotlinx.coroutines.CoroutineScope,
    )

    /** True while the app runs on mock clients (a debug gym run). */
    val usesMockClients: Boolean

    /** Gym: treat this device as holding the admin root. */
    val forceAdminRoot: Boolean

    /** Gym: the file Import a backup hands over instead of the system picker. */
    val gymImportBackupFile: java.io.File?

    /** Gym: pass the biometric prompts (an emulator has no screen lock). */
    val bypassBiometricGates: Boolean

    /** Clients for composables that run without a provider (previews and
     *  JVM tests). The app always provides the live ones. */
    fun defaultScreens(): ScreensClient
    fun defaultBuild(): BuildClient
    fun defaultFlagshipServer(): FlagshipServerClient
    fun defaultQrRelay(): QrRelayClient
    fun defaultMailbox(): SecretMailboxClient
    fun defaultTransfer(): ServerTransferClient

    /** Gym: the mock box's access-control fixture for a mock [screens]. */
    fun serviceAccessFixture(screens: ScreensClient): ServiceAccessFixture?

    /** Gym: the free-AI client of a mock run. */
    fun freeAiClient(): FreeAiClient?

    /** Gym: the relay to reuse when [shared] is the mock one. */
    fun reuseRelay(shared: QrRelayClient): QrRelayClient?

    /** Gym: a fake passkey app in place of Credential Manager. */
    fun credentialCalls(): com.flagshipserver.app.keystore.CredentialCalls?

    /** The phone-to-phone pairing relay. Null until a live one exists: the
     *  pairing screens then say it isn't available yet. */
    fun devicePairingRelays(): DevicePairingRelays?
}

/** A gym launch: the tab to open and the mock clients (null: live clients). */
class GymLaunch(
    val initialTab: RootDestination,
    val mocks: GymMocks?,
)

class GymMocks(
    val screens: ScreensClient,
    val build: BuildClient,
    val flagshipServer: FlagshipServerClient,
    val relay: QrRelayClient,
    val transfer: ServerTransferClient,
    val mailbox: SecretMailboxClient,
    val podClients: PodClients,
    val shares: ServerShareRuntime?,
    /** The boxes the app-wide access dialogs ask, when the run raises them. */
    val accessBoxes: ((AppState) -> List<AccessBox>)?,
)

/** The mock box's access-control fixture (fixed device keys and names). */
class ServiceAccessFixture(
    val client: ServiceAccessClient,
    val selfDeviceId: String,
    val selfDevicePub: String,
    val deviceNames: Map<String, String>,
)

class DevicePairingRelays(
    val admin: AdminPairingRelay,
    val incoming: IncomingPairingRelay,
)

/** Shown where device pairing would start while no live relay exists. */
const val DEVICE_PAIRING_UNAVAILABLE = "Adding a device this way isn't available yet."
