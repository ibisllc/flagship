// The release build adds nothing: always live, no fixtures, no mock clients,
// no developer mode, no gym seams (see AppVariant).

package com.flagshipserver.app.core

import android.content.Intent
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.ServerTransferClient

object Variant : AppVariant {
    override fun applyLaunchOverrides(intent: Intent?) = Unit

    override fun isGymLaunch(intent: Intent?): Boolean = false

    override fun gymLaunch(
        context: android.content.Context,
        intent: Intent?,
        appState: AppState,
        operations: ActiveOperationsCenter,
        trust: TrustCenter,
    ): GymLaunch? = null

    override val usesMockClients: Boolean get() = false
    override val forceAdminRoot: Boolean get() = false
    override val bypassBiometricGates: Boolean get() = false
    override val refuseBiometricGates: Boolean get() = false
    override val allowScreenCapture: Boolean get() = false
    override val stubCamera: Boolean get() = false
    override val gymImportBackupFile: java.io.File? get() = null
    override val noticePin: String get() = MaintainersTrust.bakedPin
    override fun noticeLockEnabled(): Boolean = false
    override fun noticeNowMs(): Long = System.currentTimeMillis()
    override fun noticeFetcher(): NoticeFetcher? = null

    private fun missing(what: String): Nothing =
        error("No $what was provided; the app provides the live one.")

    override fun defaultScreens(): ScreensClient = missing("ScreensClient")
    override fun defaultBuild(): BuildClient = missing("BuildClient")
    override fun defaultFlagshipServer(): FlagshipServerClient = missing("FlagshipServerClient")
    override fun defaultQrRelay(): QrRelayClient = missing("QrRelayClient")
    override fun defaultMailbox(): SecretMailboxClient = missing("SecretMailboxClient")
    override fun defaultTransfer(): ServerTransferClient = missing("ServerTransferClient")

    override fun serviceAccessFixture(screens: ScreensClient): ServiceAccessFixture? = null
    override fun freeAiClient(): FreeAiClient? = null
    override fun reuseRelay(shared: QrRelayClient): QrRelayClient? = null
    override fun credentialCalls(): com.flagshipserver.app.keystore.CredentialCalls? = null
    override fun devicePairingRelays(): DevicePairingRelays? =
        DevicePairingRelays(LiveAdminPairingRelay(), LiveIncomingPairingRelay())
}
