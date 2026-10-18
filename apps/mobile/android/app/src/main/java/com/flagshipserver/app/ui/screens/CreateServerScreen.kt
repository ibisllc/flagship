// Phone-side create-server flow: design, mint a signed recipe, then pair with
// Studio or share/copy/burn the recipe. The relay protocol remains reusable
// pairing machinery; the retired website-homepage QR is not an entry point.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Screens/CreateServerStubScreen.swift
//          + CreateServerViewModel.swift
//          + apps/web/public/webapp/views/create-server.js

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.ui.components.fsFocusRing
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Usb
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.draw.clip
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Row
import com.flagshipserver.app.ui.components.RadioButton
import androidx.compose.material3.Slider
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AuthCodeIssueRequest
import com.flagshipserver.app.api.AuthCodeWire
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RckRegisterRequest
import com.flagshipserver.app.core.AuthCode as AuthCodeBytes
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.BuilderPairController
import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.core.LiveBuilderPairClient
import com.flagshipserver.app.core.CreateServerDraftStore
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.InstallBlob as InstallBlobBytes
import com.flagshipserver.app.core.InstallBlobBundle
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalQrRelayClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.CreateTimePairing
import com.flagshipserver.app.core.clampedServerDescription
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.PendingSwkDepositStore
import com.flagshipserver.app.core.PendingPairingDepositStore
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.core.RckRegister
import com.flagshipserver.app.core.SerialGen
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.ServerLabel
import com.flagshipserver.app.core.ServerBackupFormat
import com.flagshipserver.app.viewmodels.ImportBackupViewModel
import com.flagshipserver.app.core.WireAuthCode
import com.flagshipserver.app.core.WireBlob
import com.flagshipserver.app.keystore.Keystore
import androidx.compose.ui.platform.testTag
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

// Design → DeliveryChooser fans into the delivery methods: Pair (builder app),
// Burn (on-device USB-OTG), Save, or Copy.
// Save/Copy mint inline and route straight to onDelivered.
private enum class Phase { Design, DeliveryChooser, Scan, Match, Pair, Burn }

/** A server made with settings decided elsewhere (Import a backup,
 *  docs/server-backup-and-clone.md): the screen opens at the delivery chooser,
 *  and the owner-signed restore order rides beside the pairing order so the box
 *  waits for exactly that data file. */
data class CreateServerPreset(
    val name: String,
    /** `auto` | `approve` */
    val bootUnlockMode: String,
    val encryptDisk: Boolean,
    val restore: ImportBackupViewModel.RestoreTarget,
)

/** The server's backup policy as the wizard chose it: `phone` | `peer` | `none`, and the phone's reserve. */
data class BackupPolicyChoice(val policy: String, val phoneReserveBytes: Long)

/** The pairing order couldn't be built, so a server made to restore a backup can't be told which one. */
internal class RestoreNeedsPairingException :
    Exception("This server couldn't be prepared to receive the backup. Try again.")

/** Saves the design and chooser phases; the live ones restore as the chooser. */
private val PhaseSaver = androidx.compose.runtime.saveable.Saver<Phase, String>(
    save = { if (it == Phase.Design) Phase.Design.name else Phase.DeliveryChooser.name },
    restore = { Phase.valueOf(it) },
)

private fun createError(t: Throwable): String {
    if (t is RestoreNeedsPairingException) {
        com.flagshipserver.app.core.ErrorLog.caught("create-server", t, NetworkErrorHumanizer.errorCode(t))
        return t.message!!
    }
    return NetworkErrorHumanizer.humanize(t, "create-server")
}

@Composable
fun CreateServerScreen(
    onDelivered: (serverDomain: String, serial: String, name: String, description: String) -> Unit,
    onCancel: () -> Unit,
    // Fired the moment a recipe is out (share/copy/builder-pair delivered) so the
    // host can surface the pending pod on Home WITHOUT navigating away — used by
    // the builder-pair flow, which keeps its screen open to answer consent
    // prompts. Mirrors iOS CreateServerStubScreen.onDeliveredVisible.
    onDeliveredVisible: (serverDomain: String, serial: String, name: String, description: String) -> Unit = { _, _, _, _ -> },
    /** A Studio pairing QR the phone's camera opened the app with: once the
     *  server is designed, pairing starts with it instead of the scanner. */
    builderLink: String? = null,
    preset: CreateServerPreset? = null,
) {
    val app = LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val qrRelay = LocalQrRelayClient.current
    val mailbox = LocalSecretMailboxClient.current
    val sessionStore = LocalSessionStore.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // Draft-only metadata store (backup policy) — device-local, NOT signed
    // into the InstallBlob; reset on delivery. Mirror of iOS's draftStore.
    val draftStore = remember { CreateServerDraftStore.from(context) }

    // The draft survives the activity being recreated or the process being
    // killed while the person is away (device bug M9). A phase that holds a
    // live session (scan, match, pair, burn) comes back as the chooser.
    var phase by rememberSaveable(stateSaver = PhaseSaver) {
        mutableStateOf(if (preset != null) Phase.DeliveryChooser else Phase.Design)
    }
    // Which sub-step of the design phase is showing — the long single form is
    // split into one decision per page (0 identity, 1 boot unlock, 2 backups),
    // matching the iOS wizard.
    var designStep by rememberSaveable { mutableStateOf(0) }
    val designStepCount = 3
    // Prefilled with the address the preview shows ("home", or the next
    // free one), so Next never says "Enter a subdomain." under a preview
    // that already names one (device bug M6).
    val takenLabels = LocalAppState.current.pods.value.map { it.fqdn.substringBefore('.').lowercase() }
    var name by rememberSaveable { mutableStateOf(preset?.name ?: ServerLabel.firstFree(takenLabels)) }
    var description by rememberSaveable { mutableStateOf("") }
    var qrText by remember { mutableStateOf("") }
    var matchCode by remember { mutableStateOf<String?>(null) }
    var pendingDelivery by remember { mutableStateOf<PendingDelivery?>(null) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Recipe TTL in MILLIS — default 6h, clamped 5min..24h. Single
    // user-facing TTL on the recipe; drives authCode.expiresAt.
    var recipeTtlMs by rememberSaveable { mutableStateOf(DEFAULT_RECIPE_TTL_MS) }
    // Boot-unlock policy — "auto" default (self-unlock via box-sealed lease) vs
    // "approve" (phone-gated every boot). Only "approve" rides the wire.
    var bootUnlockMode by rememberSaveable {
        mutableStateOf(if (preset?.bootUnlockMode == "approve") ServerSettingsStore.Mode.APPROVE else ServerSettingsStore.Mode.AUTO)
    }
    // Disk encryption — ON (default) = "luks" (omitted from the wire). OFF =
    // "none": plaintext disk, for boxes that can't keep network at boot.
    var encryptDisk by rememberSaveable { mutableStateOf(preset?.encryptDisk ?: true) }
    // ADVANCED MODE — one toggle, OFF by default ("for people who know what
    // they're doing"). On mobile it gates the offline path: embed-secrets (the
    // box SWK in the recipe), so a box installs fully offline with no
    // post-registration phone step. (Choose-your-own-ISO + debug/local-CLI have
    // no mobile analogue — they live on the website/webapp.) When OFF, the
    // offline sub-options snap back to the secret-free default.
    var advancedMode by rememberSaveable { mutableStateOf(false) }
    // Whether the recipe EMBEDS the box's SWK (the offline path). Default OFF:
    // the recipe is secret-free of the SWK and the phone DEPOSITS it once the box
    // registers (docs/recipe-delivery-and-remote-install.md).
    var embedSecrets by rememberSaveable { mutableStateOf(false) }
    // ADVANCED — make this a debug-friendly server. Default OFF (a production
    // box nobody can log into). ON (only reachable under Advanced mode) bakes an
    // admin-signed `flagship/debug-access/v2` grant for the pasted SSH key into
    // the recipe as the UNSIGNED `debugGrant` sibling; the box lets that key in
    // as `debug` for 7 days once it has verified the grant. Snaps back when
    // Advanced mode is turned off.
    var debugFriendly by rememberSaveable { mutableStateOf(false) }
    var debugSshKey by rememberSaveable { mutableStateOf("") }
    val swkDepositStore = remember { PendingSwkDepositStore.from(context) }
    val pairingDepositStore = remember { PendingPairingDepositStore.from(context) }
    // Per-service leadership (Phase 6): the per-cloud CGK is NEVER embedded in the
    // recipe, so it is owed on EVERY created server and deposited post-registration.
    val cgkDepositStore = remember { com.flagshipserver.app.core.PendingCgkDepositStore.from(context) }
    // Backup policy (phone-side default) and the phone's reserve: hydrated from
    // the draft store so flipping away mid-fill doesn't lose the pick; signed as
    // a `flagship/backup-policy/v1` order beside the pairing order at mint.
    // Nothing is preselected: Continue stays disabled until one is picked.
    var backupPolicyWire by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<String?>(null) }
    val backupPolicy = CreateServerDraftStore.BackupPolicy.fromWire(backupPolicyWire)
    val phoneFree = remember { phoneFreeBytes(context) }
    var reserveGb by remember { mutableStateOf(draftStore.reserveGb() ?: com.flagshipserver.app.core.BackupsText.defaultReserveGb(phoneFree)) }
    val backupChoice = backupPolicy?.let { BackupPolicyChoice(it.order, reserveGb.toLong() * com.flagshipserver.app.core.BackupsText.GB) }
    // Builder-pairing controller (built when the user picks "Pair with the
    // builder app") + on-device-burn recipe (minted before showing the burn UI).
    var pairController by remember { mutableStateOf<BuilderPairController?>(null) }
    var pendingBuilderLink by remember { mutableStateOf(builderLink) }
    var burnRecipeJson by remember { mutableStateOf<String?>(null) }
    var burnMinted by remember { mutableStateOf<MintedBundle?>(null) }

    // Mint the recipe + pre-publish the auth-code/RCK on .com (the box needs them
    // to register when it phones home, regardless of delivery channel), reusing
    // the shared minter so the recipe is byte-identical across delivery methods.
    suspend fun mintAndRegister(): MintedBundle {
        com.flagshipserver.app.core.ErrorLog.step("create-server", "mint start")
        val username = app.currentUser.value ?: throw IllegalStateException("not paired yet")
        val minted = mintRecipeBundle(
            username = username,
            serverName = name,
            recipeTtlMs = recipeTtlMs,
            // Only "approve" rides the wire; "auto" stays absent (legacy bytes).
            bootUnlockMode = bootUnlockMode.takeIf { it == ServerSettingsStore.Mode.APPROVE }?.wire,
            // Only "none" rides the wire; "luks" (default) stays absent.
            diskEncryption = if (encryptDisk) null else "none",
            embedSecrets = embedSecrets,
            debugFriendly = debugFriendly,
            debugSshKey = debugSshKey,
            swkDepositStore = swkDepositStore,
            cgkDepositStore = cgkDepositStore,
            pairingDepositStore = pairingDepositStore,
            sessionStore = sessionStore,
            isDemoAccount = app.isDemoAccountNow(),
            restore = preset?.restore,
            backupPolicy = backupChoice,
        )
        com.flagshipserver.app.core.ErrorLog.step("create-server", "minted; registering with .com")
        registerControlPlane(
            flagshipServer = flagshipServer,
            bundle = minted.bundle,
            authCodeUserSig = minted.bundle.blob.authCodeUserSignature,
        )
        com.flagshipserver.app.core.ErrorLog.step("create-server", "registered")
        return minted
    }

    // Per-server bookkeeping every delivery path runs once the recipe is out:
    // remember the boot-unlock choice + clear the draft-only metadata. Mirrors
    // iOS recordDeliveredBookkeeping + the QR path's Match step.
    fun recordDelivered(serverDomain: String) {
        ServerSettingsStore.from(context).setMode(serverDomain, bootUnlockMode)
        draftStore.reset()
    }

    fun startPair() {
        // Builder pairing is a live relay session because Studio is
        // the peer that receives and stages the signed recipe.
        val controller = BuilderPairController(
            client = LiveBuilderPairClient(),
            scope = scope,
            // ONE-SHOT: mint the recipe (with the Advanced toggles —
            // embed-secrets, debug-friendly — baked in behind the
            // SAME create biometric) + deliver it. No resume, no
            // debug-consent round-trip (the debug grant rides the
            // recipe). Byte-identical recipe to share/copy/burn.
            mint = {
                val minted = mintAndRegister()
                val json = Json.encodeToString(InstallBlobBundle.serializer(), minted.bundle)
                BuilderPairController.MintedRecipe(json, minted.serverDomain, minted.serial)
            },
        )
        val link = pendingBuilderLink
        pendingBuilderLink = null
        // Undispatched so the scanner never flashes before Connecting.
        if (link != null) scope.launch(start = CoroutineStart.UNDISPATCHED) { controller.begin(link) }
        pairController = controller
        phase = Phase.Pair
    }

    // Pair + Burn are full-screen flows with their OWN scroll containers, so they
    // render OUTSIDE the design/chooser scroll Column (nesting same-direction
    // scrollables would crash). iOS presents the pair sheet the same way.
    if (phase == Phase.Pair) {
        val pc = pairController
        if (pc != null) {
            BuilderPairScreen(
                controller = pc,
                onDeliveredVisible = { domain, serial ->
                    recordDelivered(domain)
                    onDeliveredVisible(domain, serial, name, description)
                },
                onClose = { domain, serial -> onDelivered(domain, serial, name, description) },
                onCancel = {
                    pc.cancel()
                    pairController = null
                    phase = Phase.DeliveryChooser
                },
            )
        } else {
            LaunchedEffect(Unit) { phase = Phase.DeliveryChooser }
        }
        return
    }
    if (phase == Phase.Burn) {
        val json = burnRecipeJson
        if (json != null) {
            BuilderOnDeviceScreen(
                recipeJson = json,
                onDone = {
                    val minted = burnMinted
                    if (minted != null) onDelivered(minted.serverDomain, minted.serial, name, description)
                    else phase = Phase.DeliveryChooser
                },
            )
        } else {
            LaunchedEffect(Unit) { phase = Phase.DeliveryChooser }
        }
        return
    }

    // Small per-page title, like iOS's compact header per step/page.
    val pageTitle = when (phase) {
        Phase.Design -> when (designStep) {
            0 -> "Name your server"
            1 -> "Boot unlock"
            else -> "Backups"
        }
        Phase.DeliveryChooser -> "Get it to a builder"
        Phase.Scan -> "Scan the QR"
        Phase.Match -> "Confirm match code"
        else -> "New server"
    }
    androidx.activity.compose.BackHandler(enabled = phase == Phase.Design && designStep > 0) { designStep -= 1 }
    FSScreen(
        title = pageTitle,
        // The app bar's back steps back through the design pages, else leaves.
        onBack = {
            when {
                phase == Phase.Design && designStep > 0 -> designStep -= 1
                else -> onCancel()
            }
        },
        spacing = 0.dp,
    ) {
        if (phase == Phase.Design && pendingBuilderLink != null) {
            Text(
                "Flagship Studio is waiting. Set up your server and it goes straight to Studio.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("create-server-studio-waiting"),
            )
            Spacer(Modifier.height(FS.space.s4))
        }

        when (phase) {
            Phase.Design -> DesignPhase(
                step = designStep,
                stepCount = designStepCount,
                name = name,
                onName = { name = it },
                description = description,
                onDescription = { description = it.clampedServerDescription() },
                username = app.currentUser.value ?: "you",
                recipeTtlMs = recipeTtlMs,
                onRecipeTtlMs = {
                    recipeTtlMs = it.coerceIn(MIN_RECIPE_TTL_MS, MAX_RECIPE_TTL_MS)
                },
                bootUnlockMode = bootUnlockMode,
                onBootUnlockMode = { bootUnlockMode = it },
                encryptDisk = encryptDisk,
                onEncryptDisk = { encryptDisk = it },
                advancedMode = advancedMode,
                onAdvancedMode = {
                    advancedMode = it
                    if (!it) { embedSecrets = false; debugFriendly = false; debugSshKey = "" }
                },
                embedSecrets = embedSecrets,
                onEmbedSecrets = { embedSecrets = it },
                debugFriendly = debugFriendly,
                onDebugFriendly = { debugFriendly = it },
                debugSshKey = debugSshKey,
                onDebugSshKey = { debugSshKey = it },
                backupPolicy = backupPolicy,
                reserveGb = reserveGb,
                onReserveGb = {
                    reserveGb = it
                    draftStore.setReserveGb(it)
                },
                phoneFreeBytes = phoneFree,
                onBackupPolicy = {
                    backupPolicyWire = it.wire
                    draftStore.setBackupPolicy(it)
                },
                error = error,
                onBack = { if (designStep > 0) designStep -= 1 },
                onNext = {
                    // Step 0 gates on a valid subdomain; later steps advance freely.
                    if (designStep == 0 && !ServerLabel.isValid(name)) {
                        error = ServerLabel.errorMessage(name) ?: "Enter a subdomain."
                        return@DesignPhase
                    }
                    error = null
                    designStep += 1
                },
                onContinue = {
                    error = null
                    // Studio is already waiting on a scanned QR: pair with it.
                    if (pendingBuilderLink != null) startPair() else phase = Phase.DeliveryChooser
                },
                onCancel = onCancel,
            )
            Phase.DeliveryChooser -> DeliveryChooserPhase(
                busy = working,
                onPair = { startPair() },
                onShare = {
                    if (working) return@DeliveryChooserPhase
                    scope.launch {
                        working = true
                        try {
                            val minted = mintAndRegister()
                            val json = Json.encodeToString(InstallBlobBundle.serializer(), minted.bundle)
                            shareRecipeFile(context, name, json)
                            recordDelivered(minted.serverDomain)
                            onDeliveredVisible(minted.serverDomain, minted.serial, name, description)
                            onDelivered(minted.serverDomain, minted.serial, name, description)
                        } catch (t: Throwable) {
                            error = createError(t)
                        } finally {
                            working = false
                        }
                    }
                },
                onCopy = {
                    if (working) return@DeliveryChooserPhase
                    scope.launch {
                        working = true
                        try {
                            val minted = mintAndRegister()
                            val json = Json.encodeToString(InstallBlobBundle.serializer(), minted.bundle)
                            copyRecipeToClipboard(context, json)
                            toasts.success("Recipe copied.")
                            recordDelivered(minted.serverDomain)
                            onDeliveredVisible(minted.serverDomain, minted.serial, name, description)
                            onDelivered(minted.serverDomain, minted.serial, name, description)
                        } catch (t: Throwable) {
                            error = createError(t)
                        } finally {
                            working = false
                        }
                    }
                },
                onBurn = {
                    if (working) return@DeliveryChooserPhase
                    scope.launch {
                        working = true
                        try {
                            val minted = mintAndRegister()
                            burnRecipeJson = Json.encodeToString(InstallBlobBundle.serializer(), minted.bundle)
                            burnMinted = minted
                            recordDelivered(minted.serverDomain)
                            onDeliveredVisible(minted.serverDomain, minted.serial, name, description)
                            phase = Phase.Burn
                        } catch (t: Throwable) {
                            error = createError(t)
                        } finally {
                            working = false
                        }
                    }
                },
                error = error,
                onCancel = onCancel,
            )
            Phase.Pair, Phase.Burn -> Unit // handled by an early return above
            Phase.Scan -> ScanPhase(
                qrText = qrText,
                onQrText = { qrText = it },
                error = error,
                onCancel = onCancel,
                onScanned = { scanned ->
                    if (working) return@ScanPhase
                    scope.launch {
                        working = true
                        try {
                            val username = app.currentUser.value
                                ?: throw IllegalStateException("not paired yet")
                            val delivery = prepareDelivery(
                                rawQr = scanned,
                                username = username,
                                serverName = name,
                                recipeTtlMs = recipeTtlMs,
                                // Only "approve" rides the wire; "auto" stays
                                // absent (legacy bytes + webapp parity).
                                bootUnlockMode = bootUnlockMode
                                    .takeIf { it == ServerSettingsStore.Mode.APPROVE }?.wire,
                                // Only "none" rides the wire; "luks" (default)
                                // stays absent (legacy bytes + webapp parity).
                                diskEncryption = if (encryptDisk) null else "none",
                                // Secret-free recipe: embed the SWK in the recipe
                                // ONLY when Advanced + embed-secrets is on; OFF
                                // (default) keeps the recipe secret-free and the
                                // phone deposits the SWK after registration.
                                embedSecrets = embedSecrets,
                                debugFriendly = debugFriendly,
                                debugSshKey = debugSshKey,
                                swkDepositStore = swkDepositStore,
                                pairingDepositStore = pairingDepositStore,
                                cgkDepositStore = cgkDepositStore,
                                // Secret-free pairing: build the order + persist the
                                // session token now; the order is sealed + deposited
                                // post-registration so the box comes online paired.
                                mailbox = mailbox,
                                sessionStore = sessionStore,
                                isDemoAccount = app.isDemoAccountNow(),
                                restore = preset?.restore,
                                backupPolicy = backupChoice,
                            )
                            qrRelay.openAndHello(
                                sid = delivery.sid,
                                phonePkBase64Url = delivery.phonePubKeyB64u,
                            )
                            matchCode = delivery.matchCode
                            pendingDelivery = delivery
                            phase = Phase.Match
                            error = null
                        } catch (t: Throwable) {
                            error = createError(t)
                        } finally {
                            working = false
                        }
                    }
                },
            )
            Phase.Match -> MatchPhase(
                matchCode = matchCode ?: "",
                error = error,
                onConfirm = {
                    val delivery = pendingDelivery ?: return@MatchPhase
                    scope.launch {
                        working = true
                        try {
                            val plainJson = Json.encodeToString(
                                InstallBlobBundle.serializer(),
                                delivery.bundle,
                            )
                            val sealed = delivery.session.seal(plainJson.toByteArray())
                            // `.com` must accept the server before the recipe
                            // leaves the phone: a refused AuthCode (a non-admin
                            // device, a rotated root) would otherwise leave the
                            // browser or Studio holding a recipe that can never
                            // register.
                            registerThenDeliver(
                                register = {
                                    registerControlPlane(
                                        flagshipServer = flagshipServer,
                                        bundle = delivery.bundle,
                                        authCodeUserSig = delivery.bundle.blob.authCodeUserSignature,
                                    )
                                },
                                deliver = { qrRelay.deliver(sealed.ciphertextB64u, sealed.nonceB64u) },
                            )
                            // Remember the boot-unlock choice so the approval
                            // screen (deposit-or-not) + server detail (kill
                            // switch) can act on it.
                            ServerSettingsStore.from(context).setMode(
                                delivery.bundle.blob.serverDomain, bootUnlockMode,
                            )
                            // Clear the draft-only metadata so a fresh "Add a
                            // server" starts at the defaults rather than ghost-
                            // restoring this build's pick (mirrors iOS).
                            draftStore.reset()
                            toasts.success("Delivered. Watch Home for the new server.")
                            onDeliveredVisible(
                                delivery.bundle.blob.serverDomain,
                                delivery.bundle.blob.authCode.serial,
                                name,
                                description,
                            )
                            onDelivered(
                                delivery.bundle.blob.serverDomain,
                                delivery.bundle.blob.authCode.serial,
                                name,
                                description,
                            )
                        } catch (t: Throwable) {
                            error = createError(t)
                        } finally {
                            qrRelay.close()
                            working = false
                        }
                    }
                },
                onCancel = {
                    qrRelay.close()
                    pendingDelivery = null
                    matchCode = null
                    phase = Phase.Scan
                },
            )
        }
    }
}

// Recipe TTL bounds — single user-facing knob on the design page.
// Drives authCode.expiresAt (the only meaningful TTL on the recipe).
internal const val DEFAULT_RECIPE_TTL_MS: Long = 6L * 60L * 60_000L  // 6h
internal const val MIN_RECIPE_TTL_MS: Long = 5L * 60_000L            // 5min
internal const val MAX_RECIPE_TTL_MS: Long = 24L * 60L * 60_000L     // 24h

@Composable
private fun DesignPhase(
    step: Int,
    stepCount: Int,
    name: String,
    onName: (String) -> Unit,
    description: String,
    onDescription: (String) -> Unit,
    username: String,
    recipeTtlMs: Long,
    onRecipeTtlMs: (Long) -> Unit,
    bootUnlockMode: ServerSettingsStore.Mode,
    onBootUnlockMode: (ServerSettingsStore.Mode) -> Unit,
    encryptDisk: Boolean,
    onEncryptDisk: (Boolean) -> Unit,
    advancedMode: Boolean,
    onAdvancedMode: (Boolean) -> Unit,
    embedSecrets: Boolean,
    onEmbedSecrets: (Boolean) -> Unit,
    debugFriendly: Boolean,
    onDebugFriendly: (Boolean) -> Unit,
    debugSshKey: String,
    onDebugSshKey: (String) -> Unit,
    backupPolicy: CreateServerDraftStore.BackupPolicy?,
    reserveGb: Int,
    onReserveGb: (Int) -> Unit,
    phoneFreeBytes: Long,
    onBackupPolicy: (CreateServerDraftStore.BackupPolicy) -> Unit,
    error: String?,
    onBack: () -> Unit,
    onNext: () -> Unit,
    onContinue: () -> Unit,
    onCancel: () -> Unit,
) {
    Text(
        "Step ${step + 1} of $stepCount",
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.titleSmall,
    )
    Spacer(Modifier.height(FS.space.s2))
    androidx.compose.material3.LinearProgressIndicator(
        progress = { (step + 1).toFloat() / stepCount },
        modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
        trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        drawStopIndicator = {},
    )
    Spacer(Modifier.height(FS.space.s3))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            when (step) {
                0 -> {
                    // The subdomain IS what the user types (validated as a DNS
                    // label; no slugify), so an invalid entry blocks Next.
                    FSField(
                        value = name,
                        onValueChange = onName,
                        label = "Server name",
                        error = ServerLabel.errorMessage(name),
                        modifier = Modifier.testTag("cs-name-field"),
                    )
                    Spacer(Modifier.height(FS.space.s2))
                    // Live "this is the address it becomes" preview.
                    val previewLabel = ServerLabel.normalized(name).ifEmpty { "home" }
                    Text(
                        "$previewLabel.$username.${Endpoints.dataApex}",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(FS.space.s3))
                    FSField(
                        value = description,
                        onValueChange = onDescription,
                        label = "Short description (optional)",
                    )
                    Spacer(Modifier.height(FS.space.s4))
                    RecipeTtlPicker(recipeTtlMs = recipeTtlMs, onRecipeTtlMs = onRecipeTtlMs)
                }
                1 -> {
                    BootUnlockPicker(mode = bootUnlockMode, onMode = onBootUnlockMode)
                    Spacer(Modifier.height(FS.space.s4))
                    DiskEncryptionPicker(encryptDisk = encryptDisk, onEncryptDisk = onEncryptDisk)
                    Spacer(Modifier.height(FS.space.s4))
                    AdvancedModePicker(
                        advancedMode = advancedMode,
                        onAdvancedMode = onAdvancedMode,
                        embedSecrets = embedSecrets,
                        onEmbedSecrets = onEmbedSecrets,
                        debugFriendly = debugFriendly,
                        onDebugFriendly = onDebugFriendly,
                        debugSshKey = debugSshKey,
                        onDebugSshKey = onDebugSshKey,
                    )
                }
                else -> {
                    BackupPolicyPicker(
                        policy = backupPolicy,
                        onPolicy = onBackupPolicy,
                        reserveGb = reserveGb,
                        onReserveGb = onReserveGb,
                        phoneFreeBytes = phoneFreeBytes,
                    )
                }
            }
        }
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(FS.space.s4))
    if (step < stepCount - 1) {
        FSPrimaryButton(
            label = "Next",
            onClick = onNext,
            block = true,
            modifier = Modifier.testTag("cs-next-button"),
        )
    } else {
        FSPrimaryButton(
            label = "Continue",
            onClick = onContinue,
            enabled = backupPolicy != null,
            block = true,
            modifier = Modifier.testTag("cs-continue-button"),
        )
    }
    Spacer(Modifier.height(FS.space.s2))
    if (step > 0) {
        FSSecondaryButton(label = "Back", onClick = onBack, block = true)
    } else {
        FSSecondaryButton(label = "Cancel", onClick = onCancel, block = true)
    }
}

@Composable
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
private fun RecipeTtlPicker(
    recipeTtlMs: Long,
    onRecipeTtlMs: (Long) -> Unit,
) {
    val hours = recipeTtlMs.toDouble() / 3_600_000.0
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "Recipe expires in",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        Text(
            ttlLabel(hours),
            color = FS.colors.accentText,
            style = MaterialTheme.typography.titleMedium,
        )
    }
    // Half-hour snaps without 47 tick dots; the label above is the value.
    Slider(
        value = hours.toFloat(),
        onValueChange = { onRecipeTtlMs((Math.round(it * 2f) / 2.0 * 3_600_000.0).toLong()) },
        valueRange = 0.5f..24f,
        modifier = Modifier.semantics { stateDescription = ttlLabel(hours) },
        track = { state -> androidx.compose.material3.SliderDefaults.Track(state, drawStopIndicator = null) },
    )
    Text(
        "After this window, the unused USB can't install — re-mint from this screen.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
    )
}

private fun ttlLabel(hours: Double): String = when {
    hours < 1.0 -> "${(hours * 60).toInt()} min"
    hours == hours.toInt().toDouble() -> "${hours.toInt()} hour${if (hours == 1.0) "" else "s"}"
    else -> String.format("%.1f hours", hours)
}

// Two tiers, no middle ground (docs/security-phone-as-unlock-endpoint.md
// §7a.1). "auto" is the default — a box that reboots without the phone, with
// a remote kill switch. "approve" gates every boot behind the phone.
@Composable
private fun BootUnlockPicker(
    mode: ServerSettingsStore.Mode,
    onMode: (ServerSettingsStore.Mode) -> Unit,
) {
    Text(
        "Boot unlock",
        style = MaterialTheme.typography.titleSmall,
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = mode == ServerSettingsStore.Mode.AUTO,
        title = "Reboots on its own",
        subtitle = "Best for flaky power or connections. After you approve its first boot, the server unlocks itself on every reboot — no phone needed. Revocable any time.",
        onClick = { onMode(ServerSettingsStore.Mode.AUTO) },
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = mode == ServerSettingsStore.Mode.APPROVE,
        title = "Authorize each boot",
        subtitle = "Most theft-resistant. The server asks your phone on every reboot. Best for critical servers on stable infrastructure.",
        onClick = { onMode(ServerSettingsStore.Mode.APPROVE) },
    )
}

// Disk encryption — a binary, default ON. ON = "luks" (full-disk encryption,
// the box needs network at boot to fetch its unlock key). OFF = "none":
// plaintext disk, less safe, but it boots with no network — for Wi-Fi-only
// boxes that can't keep a connection at boot. Default-OFF rides "de=none" on
// the signed wire; ON stays absent (legacy bytes).
@Composable
private fun DiskEncryptionPicker(
    encryptDisk: Boolean,
    onEncryptDisk: (Boolean) -> Unit,
) {
    Text(
        "Encrypt disk",
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.testTag("cs-encrypt-disk-toggle"),
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = encryptDisk,
        title = "Encrypt the disk (recommended)",
        subtitle = "The whole disk is encrypted. The server fetches its unlock key at boot, so it needs a network connection to come back up after a power cut.",
        onClick = { onEncryptDisk(true) },
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = !encryptDisk,
        title = "Don't encrypt my disk",
        subtitle = "Less safe — anyone with the disk can read it. Choose this only for a server that can't keep network at boot (Wi-Fi-only): it boots with no connection.",
        onClick = { onEncryptDisk(false) },
    )
}

// Advanced mode — ONE toggle, OFF by default, "for people who know what they're
// doing". It gates the offline path: embed-secrets (the box SWK in the recipe),
// so a box installs fully offline with no post-registration phone step. The
// DEFAULT (Advanced off) is the secret-free recipe — the phone deposits the SWK
// after the box registers. (Choose-your-own-ISO + debug/local-CLI have no mobile
// analogue; they live on the website/webapp.)
@Composable
private fun AdvancedModePicker(
    advancedMode: Boolean,
    onAdvancedMode: (Boolean) -> Unit,
    embedSecrets: Boolean,
    onEmbedSecrets: (Boolean) -> Unit,
    debugFriendly: Boolean,
    onDebugFriendly: (Boolean) -> Unit,
    debugSshKey: String,
    onDebugSshKey: (String) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Advanced mode", style = MaterialTheme.typography.titleSmall)
            Text(
                "For people who know what they're doing.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(
            checked = advancedMode,
            onCheckedChange = onAdvancedMode,
            modifier = Modifier.testTag("cs-advanced-toggle"),
        )
    }
    if (advancedMode) {
        Spacer(Modifier.height(FS.space.s2))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Embed secrets for offline install",
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
            Switch(
                checked = embedSecrets,
                onCheckedChange = onEmbedSecrets,
                modifier = Modifier.testTag("cs-embed-secrets-toggle"),
            )
        }
        Text(
            "This embeds security keys directly in the recipe. Hence, the server will be able to boot even if the phone is offline.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(FS.space.s2))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Debug-friendly server",
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
            Switch(
                checked = debugFriendly,
                onCheckedChange = onDebugFriendly,
                modifier = Modifier.testTag("cs-debug-friendly-toggle"),
            )
        }
        Text(
            DebugAccess.CREATE_WARNING,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        if (debugFriendly) {
            Spacer(Modifier.height(FS.space.s2))
            FSField(
                value = debugSshKey,
                onValueChange = onDebugSshKey,
                label = "SSH public key",
                placeholder = "ssh-ed25519 AAAA… you@laptop",
                error = debugSshKey.takeIf { it.isNotBlank() }?.let { debugSshKeyProblem(it) },
                fieldTag = "cs-debug-ssh-key",
            )
        }
    }
}

// Backup policy — three choices, phone-side by default, with the phone's
// reserve (docs/server-backup-and-clone.md, "Backup policy"). The choice is
// signed at mint and rides beside the pairing order. Same words as iOS and
// the webapp (BackupPolicyOptions).
@Composable
private fun BackupPolicyPicker(
    policy: CreateServerDraftStore.BackupPolicy?,
    onPolicy: (CreateServerDraftStore.BackupPolicy) -> Unit,
    reserveGb: Int,
    onReserveGb: (Int) -> Unit,
    phoneFreeBytes: Long,
) {
    Text(
        "Where should backups go?",
        style = MaterialTheme.typography.titleSmall,
    )
    Spacer(Modifier.height(FS.space.s2))
    BackupPolicyOptions(
        policy = policy?.order,
        forCreate = true,
        onPolicy = { k -> CreateServerDraftStore.BackupPolicy.fromOrder(k)?.let(onPolicy) },
        reserveGb = reserveGb,
        onReserveGb = onReserveGb,
        phoneFreeBytes = phoneFreeBytes,
        tagPrefix = "cs-backup-policy",
    )
}

@Composable
private fun BootUnlockOption(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    val border = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Row(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = border,
                shape = MaterialTheme.shapes.small,
            )
            .fsFocusRing(8.dp).selectable(selected = selected, onClick = onClick, role = androidx.compose.ui.semantics.Role.RadioButton)
            .padding(end = FS.space.s3, top = FS.space.s1, bottom = FS.space.s3),
    ) {
        RadioButton(selected = selected, onClick = null, modifier = Modifier.padding(FS.space.s3))
        Column(Modifier.weight(1f).padding(top = FS.space.s3), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                subtitle,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ScanPhase(
    qrText: String,
    onQrText: (String) -> Unit,
    error: String?,
    onScanned: (String) -> Unit,
    onCancel: () -> Unit,
) {
    Text(
        "Scan the code shown on flagshipserver.com. Both screens stay open until the browser acks.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
    )
    Spacer(Modifier.height(FS.space.s4))
    QRScanner(onScanned = onScanned)
    Spacer(Modifier.height(FS.space.s4))
    FSField(value = qrText, onValueChange = onQrText, label = "Or paste code manually")
    if (qrText.isNotBlank()) {
        Spacer(Modifier.height(FS.space.s2))
        FSPrimaryButton(label = "Use this code", onClick = { onScanned(qrText) }, block = true)
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun MatchPhase(
    matchCode: String,
    error: String?,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    Text(
        "Compare the code on this phone and the one shown on the browser. Confirm only if they match exactly — otherwise the relay has been tampered with.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard(padding = PaddingValues(FS.space.s8)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                QrRelay.formatMatchCode(matchCode),
                style = MaterialTheme.typography.displayMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = "Codes match — deliver", onClick = onConfirm, block = true)
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = "Cancel", onClick = onCancel, block = true)
}

// Delivery-method chooser shown after the design step. Mirrors iOS
// CreateServerStubScreen.deliveryChooserPage: pair-with-builder / save-share /
// copy / burn-on-device.
@Composable
private fun DeliveryChooserPhase(
    busy: Boolean,
    onPair: () -> Unit,
    onShare: () -> Unit,
    onCopy: () -> Unit,
    onBurn: () -> Unit,
    error: String?,
    onCancel: () -> Unit,
) {
    DeliveryCard(
        icon = Icons.Outlined.QrCodeScanner,
        title = "Pair with the builder app",
        body = "Scan the builder's QR (or type its code) and the recipe is sent over a secure live link. Easiest if the builder is open in front of you.",
        enabled = !busy,
        testTag = "cs-delivery-pair",
        onClick = onPair,
    )
    Spacer(Modifier.height(FS.space.s3))
    DeliveryCard(
        icon = Icons.Outlined.Share,
        title = "Save / share recipe file",
        body = "Save the recipe as a file or send it. Whoever builds the server opens it in the builder. No secrets in the file.",
        enabled = !busy,
        testTag = "cs-delivery-share",
        onClick = onShare,
    )
    Spacer(Modifier.height(FS.space.s3))
    DeliveryCard(
        icon = Icons.Outlined.ContentCopy,
        title = "Copy recipe to clipboard",
        body = "Copy the recipe text, then paste it into the builder's \"I have a recipe\" field.",
        enabled = !busy,
        testTag = "cs-delivery-copy",
        onClick = onCopy,
    )
    Spacer(Modifier.height(FS.space.s3))
    DeliveryCard(
        icon = Icons.Outlined.Usb,
        title = "Burn to USB on this device",
        body = "Connect a USB drive with an OTG adapter and write the bootable installer right here — no computer needed.",
        enabled = !busy,
        testTag = "cs-delivery-burn",
        onClick = onBurn,
    )
    if (busy) {
        Spacer(Modifier.height(FS.space.s4))
        androidx.compose.material3.LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(FS.space.s4))
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun DeliveryCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    body: String,
    enabled: Boolean,
    testTag: String,
    onClick: () -> Unit,
) {
    androidx.compose.material3.Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag(testTag),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
    ) {
        com.flagshipserver.app.ui.components.FSRow(
            title = title,
            subtitle = body,
            icon = icon,
            iconTint = FS.colors.accent,
            enabled = enabled,
        )
    }
}

// Write the recipe JSON to a cache file + offer the system share sheet. The
// FileProvider authority is "<applicationId>.fileprovider" (AndroidManifest +
// res/xml/file_paths.xml).
private fun shareRecipeFile(ctx: Context, serverName: String, json: String) {
    val dir = File(ctx.cacheDir, "recipes").apply { mkdirs() }
    val slug = ServerLabel.normalized(serverName).ifEmpty { "server" }
    val file = File(dir, "$slug.flagship-recipe.json")
    file.writeText(json)
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "application/json"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, "Share recipe")
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

private fun copyRecipeToClipboard(ctx: Context, json: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("Flagship recipe", json))
}

// ── Plumbing ──────────────────────────────────────────────────────

private data class PendingDelivery(
    val sid: String,
    val phonePubKeyB64u: String,
    val matchCode: String,
    val session: QrSession,
    val bundle: InstallBlobBundle,
    val irkPubHex: String,
)

/**
 * Run the half of the protocol that happens on the phone: parse the
 * QR, mint a fresh X25519 keypair, derive (kEnc, matchCode), build +
 * sign the install-blob, and return everything the deliver step needs.
 */
private suspend fun prepareDelivery(
    rawQr: String,
    username: String,
    serverName: String,
    recipeTtlMs: Long = DEFAULT_RECIPE_TTL_MS,
    bootUnlockMode: String? = null,
    // "none" when the user opted out of disk encryption; null ⇒ the LUKS
    // default (omitted from the signed canonical bytes + the wire, like
    // bootUnlockMode's "auto").
    diskEncryption: String? = null,
    // Secret-free recipe: when true (advanced/offline) the SWK is embedded in the
    // recipe and NO deposit is owed; when false (the DEFAULT) the recipe is
    // secret-free of the SWK and a deposit is recorded as owed.
    embedSecrets: Boolean = false,
    // Debug-friendly server (Advanced): when true, bake an admin-signed
    // debug-access grant for [debugSshKey] into the recipe as the UNSIGNED
    // `debugGrant` sibling.
    debugFriendly: Boolean = false,
    debugSshKey: String? = null,
    swkDepositStore: PendingSwkDepositStore? = null,
    // Per-service leadership (Phase 6): the per-cloud CGK is NEVER embedded in the
    // recipe; it is owed on EVERY created server (independent of embed-secrets) and
    // sealed + deposited post-registration on the SWK biometric pass.
    cgkDepositStore: com.flagshipserver.app.core.PendingCgkDepositStore? = null,
    // Secret-free pairing: stashes the create-time order owed when embed-secrets
    // is OFF, so the Home reconcile seals + deposits it post-registration.
    pairingDepositStore: PendingPairingDepositStore? = null,
    // Create-time pairing: optional so the unit tests' direct calls stay simple;
    // production passes the session store so the token-persist runs.
    mailbox: com.flagshipserver.app.api.SecretMailboxClient? = null,
    sessionStore: com.flagshipserver.app.api.SessionStoring? = null,
    isDemoAccount: Boolean = false,
    restore: ImportBackupViewModel.RestoreTarget? = null,
    backupPolicy: BackupPolicyChoice? = null,
): PendingDelivery {
    val parsed = QrRelay.parseQrUrl(rawQr)
    val session = QrSession.fresh()
    val matchCode = session.pair(parsed.browserPublicKey)

    val minted = mintRecipeBundle(
        username = username,
        serverName = serverName,
        recipeTtlMs = recipeTtlMs,
        bootUnlockMode = bootUnlockMode,
        diskEncryption = diskEncryption,
        embedSecrets = embedSecrets,
        debugFriendly = debugFriendly,
        debugSshKey = debugSshKey,
        swkDepositStore = swkDepositStore,
        cgkDepositStore = cgkDepositStore,
        pairingDepositStore = pairingDepositStore,
        sessionStore = sessionStore,
        isDemoAccount = isDemoAccount,
        restore = restore,
        backupPolicy = backupPolicy,
    )

    return PendingDelivery(
        sid = parsed.sid,
        phonePubKeyB64u = Base64URL.encode(session.phonePubKey),
        matchCode = matchCode,
        session = session,
        bundle = minted.bundle,
        irkPubHex = minted.irkPubHex,
    )
}

/** The signed install-blob bundle + the bits a caller needs to surface a
 *  pending pod, independent of the delivery channel (QR relay, builder pairing,
 *  share file, clipboard, on-device burn). */
internal data class MintedBundle(
    val bundle: InstallBlobBundle,
    val serverDomain: String,
    val serial: String,
    val irkPubHex: String,
)

/**
 * The DELIVERY-AGNOSTIC half of minting: issue the IRK-signed AuthCode, build +
 * sign the InstallBlob, run create-time pairing, and record the deposit-store
 * bookkeeping — WITHOUT any QR-session seal/deliver. Extracted from
 * [prepareDelivery] (which keeps the QR seal on top) so the builder-pair /
 * save-share / copy / burn-on-device delivery paths reuse the EXACT same mint
 * (a byte-identical recipe). Side effects + ordering are preserved verbatim.
 *
 * NOTE: this does NOT pre-publish the auth-code/RCK on .com — that is
 * [registerControlPlane], which each delivery path calls separately (the QR
 * path in its deliver step; the new paths right after minting).
 */
internal suspend fun mintRecipeBundle(
    username: String,
    serverName: String,
    recipeTtlMs: Long = DEFAULT_RECIPE_TTL_MS,
    bootUnlockMode: String? = null,
    diskEncryption: String? = null,
    embedSecrets: Boolean = false,
    // Debug-friendly server (Advanced): bake an admin-signed debug-access grant
    // for [debugSshKey] into the recipe as the UNSIGNED `debugGrant` sibling.
    debugFriendly: Boolean = false,
    debugSshKey: String? = null,
    swkDepositStore: PendingSwkDepositStore? = null,
    cgkDepositStore: com.flagshipserver.app.core.PendingCgkDepositStore? = null,
    pairingDepositStore: PendingPairingDepositStore? = null,
    sessionStore: com.flagshipserver.app.api.SessionStoring? = null,
    isDemoAccount: Boolean = false,
    // Import a backup: sign a restore order for this server and attach it beside
    // the pairing order (docs/server-backup-and-clone.md).
    restore: ImportBackupViewModel.RestoreTarget? = null,
    // The server's backup policy, signed and attached beside the pairing order
    // (docs/server-backup-and-clone.md, "Backup policy").
    backupPolicy: BackupPolicyChoice? = null,
): MintedBundle {
    // Only an admin device of the account adds servers, and only opening the
    // account mints an admin root: refuse here, before any prompt or `.com`
    // call, rather than mint a recipe the account's admins don't anchor.
    val adminRootPinHex = com.flagshipserver.app.core.AddServerGate.recipeAdminRootPin(
        adminRootPubHex = if (Keystore.hasAdminRoot()) Keystore.adminRootPubHex() else null,
        isDemoAccount = isDemoAccount,
    )
    // A debug-friendly server needs a usable key; say why before any prompt.
    val debugKey = if (debugFriendly) {
        debugSshKeyProblem(debugSshKey.orEmpty())?.let { throw IllegalArgumentException(it) }
        DebugAccess.normalizeSshPublicKey(debugSshKey.orEmpty())
    } else {
        null
    }
    // The subdomain IS what the user typed (validated as a DNS label in the
    // design step; no slugify). Normalize case only.
    val slug = ServerLabel.normalized(serverName)
    val serverDomain = Endpoints.serverFqdn(server = slug, user = username)
    val serial = SerialGen.random()
    val now = System.currentTimeMillis()
    val expiresAt = now + recipeTtlMs.coerceIn(MIN_RECIPE_TTL_MS, MAX_RECIPE_TTL_MS)

    com.flagshipserver.app.core.ErrorLog.step("create-server", "admin pin ok; asking for the account key")
    val irk = Keystore.deriveIRK("Create server $serverName")
    com.flagshipserver.app.core.ErrorLog.step("create-server", "account key ok")
    val irkPubHex = Keystore.irkPubHex()
    val irkPubBytes = HexUtil.decode(irkPubHex) ?: error("corrupt account key")

    val delegated = Ed25519Sign.KeyPair.newKeyPair()
    val delegatedPubHex = HexUtil.encode(delegated.publicKey)

    val rck = Ed25519Sign.KeyPair.newKeyPair()
    val rckPubHex = HexUtil.encode(rck.publicKey)

    // Slice D (D-1) — pin the account's ADMIN MASTER ROOT into the AuthCode so a
    // fresh box anchors it (signature-covered by the IRK below). Null only on a
    // demo account ⇒ byte-identical pre-D canonical bytes.
    val adminRootPubBytes = adminRootPinHex?.let { HexUtil.decode(it) }

    val authCodeBytesObj = AuthCodeBytes(
        version = 1,
        serial = serial,
        username = username,
        serverName = serverName,
        serverDomain = serverDomain,
        delegatedPubKey = delegated.publicKey,
        userPubKey = irkPubBytes,
        issuedAt = now,
        expiresAt = expiresAt,
        adminRootPubKey = adminRootPubBytes,
    )
    val authCodeUserSig = irk.sign(authCodeBytesObj.canonicalBytes())
    val authCodeUserSigHex = HexUtil.encode(authCodeUserSig)

    val installBlobBytesObj = InstallBlobBytes(
        serverDomain = serverDomain,
        username = username,
        serverName = serverName,
        phoneDelegatedPubKey = delegated.publicKey,
        authCode = authCodeBytesObj,
        authCodeUserSignature = authCodeUserSig,
        rckPubKey = rck.publicKey,
        bootUnlockMode = bootUnlockMode,
        diskEncryption = diskEncryption,
    )
    val blobSigHex = HexUtil.encode(irk.sign(installBlobBytesObj.canonicalBytes()))

    // SWK provisioning: derive the box's deterministic SWK from the SAME UMK seed
    // + serverId (serverDomain) used for the STK/BAK above, via ServerKeys.deriveSwk
    // (DOTS info "flagship.swk.v1|<serverId>" — the protocol/daemon derivation),
    // and embed it as an UNSIGNED `swkHex` recipe sibling the daemon persists at
    // first boot. The server can't derive it (no UMK). Reuses the in-hand UMK seed —
    // no extra biometric.
    val derivedSwkHex = HexUtil.encode(ServerKeys.deriveSwk(Keystore.currentUmkSeed(), serverDomain))

    // Secret-free pairing: build the owner-IRK-signed `add-paired-session` order
    // at create time (the FIRST recipe carries ZERO pairing secret — no pairing
    // keypair, no `pairingKeyPrivHex`). Reuses the IRK above (no extra biometric).
    // Persist the token as this device's session token so the BFF auths once the
    // box claims the order. The order JSON is routed by mode below. Best-effort: a
    // build failure leaves the manual pairing path as the fallback.
    var pairingOrderJson: String? = null
    try {
        val pairing = CreateTimePairing.build(
            serverDomain = serverDomain,
            irk = irk,
        )
        // MULTI-POD (Fix B): persist under THIS pod's id (`pod-<lowercased-fqdn>`)
        // so creating a 2nd box never clobbers the 1st box's token; also keep the
        // single active slot pointed at the box being created.
        sessionStore?.setSessionToken(pairing.token, forPodId = com.flagshipserver.app.core.PodInfo.podId(serverDomain))
        sessionStore?.setSessionToken(pairing.token)
        pairingOrderJson = pairing.pairingOrderJson
    } catch (_: Throwable) {
        // non-fatal — fall back to manual pairing when the box is up
    }
    if (restore != null) {
        val json = pairingOrderJson ?: throw RestoreNeedsPairingException()
        val order = ServerBackupFormat.RestoreOrder(
            serverDomain = serverDomain,
            archiveId = restore.archiveId,
            bytes = restore.bytes,
            sha256 = restore.sha256,
            issuedAt = now,
        )
        // An admin-pinned box takes a restore order only from the admin root
        // (adding a server is admin-only); a demo account signs with the IRK.
        val restoreSigner = if (adminRootPinHex != null) Keystore.adminRootKey("Restore a backup on $serverName") else irk
        val sig = restoreSigner.sign(order.canonicalBytes())
        pairingOrderJson = ServerBackupFormat.attachRestore(json, order, HexUtil.encode(sig))
    }
    // The box takes the policy under its sensitive-order key once the pairing
    // order verifies: the admin root it pins, the IRK on a demo box (none pinned).
    pairingOrderJson = pairingOrderJson?.let { json ->
        val choice = backupPolicy ?: return@let json
        val order = com.flagshipserver.app.core.BackupPolicyOrder.make(serverDomain, choice.policy, choice.phoneReserveBytes, now)
        if (!order.isValid) return@let json
        val signer = if (adminRootPinHex != null) Keystore.adminRootKey("Set the backup policy of $serverName") else irk
        ServerBackupFormat.attachBackupPolicy(json, order, HexUtil.encode(signer.sign(order.canonicalBytes())))
    }

    // Secret-free recipe (docs/recipe-delivery-and-remote-install.md).
    //   embed-secrets ON (advanced/offline): bake BOTH the SWK and the plaintext
    //     `pairingOrder` into the recipe; the box self-configures + self-pairs
    //     fully offline with NO post-registration deposit.
    //   embed-secrets OFF (the DEFAULT): the recipe is secret-free; stash the SWK
    //     + the pairing order so the Home reconcile seals + deposits each once the
    //     box registers (one tap then, not now).
    val embeddedSwkHex: String?
    val embeddedPairingOrder: String?
    if (embedSecrets) {
        embeddedSwkHex = derivedSwkHex
        swkDepositStore?.clear(serverDomain)
        embeddedPairingOrder = pairingOrderJson
        pairingDepositStore?.clear(serverDomain)
    } else {
        embeddedSwkHex = null
        swkDepositStore?.markPending(serverDomain)
        embeddedPairingOrder = null
        pairingOrderJson?.let { pairingDepositStore?.markPending(serverDomain, it) }
    }
    // The CGK is NEVER embedded in the recipe (the per-cloud gossip secret is
    // always post-boot delivered), so it is owed on EVERY created server,
    // independent of the embed-secrets choice.
    cgkDepositStore?.markPending(serverDomain)

    // Debug-friendly server (Advanced): bake an admin-signed debug-access grant
    // (the pasted key, 7 days) into the recipe as the UNSIGNED `debugGrant`
    // sibling. An admin-pinned box takes it only from the admin root; a demo
    // account (no root) signs with the IRK. Every grant asks for its own
    // biometric, even in an unlocked session. null for the production default.
    val debugGrantSibling = debugKey?.let { key ->
        val reason = "Turn on debug access for $serverName"
        val signer = if (adminRootPinHex != null) {
            Keystore.adminRootKeyConfirmed(reason)
        } else {
            com.flagshipserver.app.keystore.BiometricAuthority.confirmNow(reason)
            irk
        }
        debugGrantEnvelope(serverDomain, key, signer, now)
    }

    val bundle = InstallBlobBundle(
        blob = WireBlob(
            serverDomain = serverDomain,
            username = username,
            serverName = serverName,
            phoneDelegatedPubKey = delegatedPubHex,
            authCode = WireAuthCode(
                serial = serial,
                username = username,
                serverName = serverName,
                serverDomain = serverDomain,
                delegatedPubKey = delegatedPubHex,
                userPubKey = irkPubHex,
                issuedAt = now,
                expiresAt = expiresAt,
                adminRootPubKey = adminRootPubBytes?.let { HexUtil.encode(it) },
            ),
            authCodeUserSignature = authCodeUserSigHex,
            rckPubKey = rckPubHex,
            bootUnlockMode = bootUnlockMode,
            diskEncryption = diskEncryption,
        ),
        blobSignature = blobSigHex,
        pairingOrder = embeddedPairingOrder,
        swkHex = embeddedSwkHex,
        debugGrant = debugGrantSibling,
    )

    return MintedBundle(
        bundle = bundle,
        serverDomain = serverDomain,
        serial = serial,
        irkPubHex = irkPubHex,
    )
}

/** Why a pasted key can't be used for debug access, or null when it can. */
internal fun debugSshKeyProblem(input: String): String? = when {
    input.isBlank() -> "Debug access needs an SSH public key."
    DebugAccess.normalizeSshPublicKey(input) == null -> "That isn't an SSH public key this server can use."
    else -> null
}

/**
 * Build the recipe's `debugGrant` sibling: a `flagship/debug-access/v2` grant
 * for [sshPublicKey] that ends 7 days after [now], as the `{grant,
 * signatureHex}` JSON the box consumes (`debugAccessGate.ts`). No box STK in
 * the canonical bytes, so it's signable at mint. `internal` for the unit test.
 */
internal fun debugGrantEnvelope(
    serverDomain: String,
    sshPublicKey: String,
    signer: Ed25519Sign,
    now: Long = System.currentTimeMillis(),
): String {
    val grant = DebugAccess.Grant(
        serverDomain = serverDomain,
        sshPublicKey = DebugAccess.normalizeSshPublicKey(sshPublicKey) ?: sshPublicKey,
        issuedAt = now,
        expiresAt = now + DebugAccess.MAX_MS,
    )
    return DebugAccess.envelopeJson(grant, DebugAccess.sign(grant, signer))
}

/** The QR delivery's order: `.com` accepts the server, then the recipe goes out.
 *  A refusal throws before [deliver] runs. */
internal suspend fun registerThenDeliver(register: suspend () -> Unit, deliver: suspend () -> Unit) {
    register()
    deliver()
}

/**
 * Pre-publish the auth-code + RCK on .com so the freshly-booted box can
 * register itself on first phone-home. The auth-code is IRK-signed and, since
 * adding a server is admin-only (owner rule 2026-10-16), approved by the admin
 * root it pins; the admin root also signs the RCK. A demo account pins no root
 * and keeps the IRK path.
 *
 * Phase 2 (login redesign): the USERNAME CLAIM no longer happens here.
 * Account creation is decoupled from server provisioning — the account
 * (and its username claim) is opened up-front in the open-account step,
 * so the username is already claimed before any server is added. Adding
 * a server (1st or Nth) from Home must NOT re-claim — the claim is
 * idempotent server-side, but issuing it again from a different device
 * key would be wrong, and there's simply no need.
 *
 * `internal` so the "add-server does NOT re-claim" contract is pinned
 * by a unit test.
 */
internal suspend fun registerControlPlane(
    flagshipServer: FlagshipServerClient,
    bundle: InstallBlobBundle,
    authCodeUserSig: String,
) {
    val now = System.currentTimeMillis()
    val wire = bundle.blob.authCode
    val pinsRoot = wire.adminRootPubKey != null
    val rckSigner = if (pinsRoot) Keystore.adminRootKey("Add ${wire.serverName} to your account")
    else Keystore.adminSigningKey("Authorize server routing")
    val adminSignature = if (pinsRoot) {
        val code = AuthCodeBytes(
            version = wire.version,
            serial = wire.serial,
            username = wire.username,
            serverName = wire.serverName,
            serverDomain = wire.serverDomain,
            delegatedPubKey = HexUtil.decode(wire.delegatedPubKey) ?: error("corrupt recipe"),
            userPubKey = HexUtil.decode(wire.userPubKey) ?: error("corrupt recipe"),
            issuedAt = wire.issuedAt,
            expiresAt = wire.expiresAt,
            adminRootPubKey = HexUtil.decode(wire.adminRootPubKey!!) ?: error("corrupt recipe"),
        )
        HexUtil.encode(rckSigner.sign(code.adminCanonicalBytes()))
    } else {
        null
    }

    flagshipServer.issueAuthCode(
        AuthCodeIssueRequest(
            code = AuthCodeWire(
                version = bundle.blob.authCode.version,
                serial = bundle.blob.authCode.serial,
                username = bundle.blob.authCode.username,
                serverName = bundle.blob.authCode.serverName,
                serverDomain = bundle.blob.authCode.serverDomain,
                delegatedPubKey = bundle.blob.authCode.delegatedPubKey,
                userPubKey = bundle.blob.authCode.userPubKey,
                issuedAt = bundle.blob.authCode.issuedAt,
                expiresAt = bundle.blob.authCode.expiresAt,
                adminRootPubKey = bundle.blob.authCode.adminRootPubKey,
            ),
            signature = authCodeUserSig,
            adminSignature = adminSignature,
        ),
    )

    val rckSig = HexUtil.encode(rckSigner.sign(
        RckRegister.canonicalBytes(
            username = bundle.blob.username,
            subdomain = bundle.blob.serverDomain,
            rckPubHex = bundle.blob.rckPubKey,
            issuedAt = now,
        ),
    ))
    flagshipServer.registerRck(
        RckRegisterRequest(
            request = RckRegisterRequest.Inner(
                username = bundle.blob.username,
                subdomain = bundle.blob.serverDomain,
                rckPubKey = bundle.blob.rckPubKey,
                issuedAt = now,
            ),
            signature = rckSig,
        ),
    )
}
