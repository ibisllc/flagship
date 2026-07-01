// Phone-side of the create-a-new-server flow.
//
// 1.  Design: user picks a name + description.
// 2.  Scan/paste: user scans the QR shown on flagshipserver.com.
//     We parse sid + browserPubKey; mint our own X25519 keypair;
//     locally derive (kEnc, matchCode) via HKDF.
// 3.  Mint the on-wire install-blob bundle: IRK-signed AuthCode +
//     IRK-signed InstallBlob. Posts /api/auth-code/issue +
//     /api/routing/register-rck + /api/username/claim to .com so the
//     freshly-booted box can register itself once it phones home.
// 4.  Confirm: show the matchCode so the user can compare against the
//     browser screen, then on tap, AEAD-seal the bundle under kEnc and
//     push through /qr-pipe.
// 5.  Hand back to Home with a Pending pod row.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Screens/CreateServerStubScreen.swift
//          + CreateServerViewModel.swift
//          + apps/web/public/webapp/views/create-server.js

package com.flagshipserver.app.ui.screens

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AuthCodeIssueRequest
import com.flagshipserver.app.api.AuthCodeWire
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RckRegisterRequest
import com.flagshipserver.app.core.AuthCode as AuthCodeBytes
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.BurnerPairController
import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.core.LiveBurnerPairClient
import com.flagshipserver.app.core.LocalDeveloperSettings
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
import com.flagshipserver.app.core.SlugUtil
import com.flagshipserver.app.core.WireAuthCode
import com.flagshipserver.app.core.WireBlob
import com.flagshipserver.app.keystore.Keystore
import androidx.compose.ui.platform.testTag
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

// Design → DeliveryChooser fans into the delivery methods: Pair (burner app),
// Burn (on-device USB-OTG), or the website-QR relay (Scan→Match, the demo path).
// Save/Copy mint inline and route straight to onDelivered.
private enum class Phase { Design, DeliveryChooser, Scan, Match, Pair, Burn }

@Composable
fun CreateServerScreen(
    onDelivered: (serverDomain: String, serial: String, name: String, description: String) -> Unit,
    onCancel: () -> Unit,
    // Fired the moment a recipe is out (share/copy/burner-pair delivered) so the
    // host can surface the pending pod on Home WITHOUT navigating away — used by
    // the burner-pair flow, which keeps its screen open to answer consent
    // prompts. Mirrors iOS CreateServerStubScreen.onDeliveredVisible.
    onDeliveredVisible: (serverDomain: String, serial: String, name: String, description: String) -> Unit = { _, _, _, _ -> },
) {
    val app = LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val qrRelay = LocalQrRelayClient.current
    val mailbox = LocalSecretMailboxClient.current
    val sessionStore = LocalSessionStore.current
    val toasts = LocalToastCenter.current
    val dev = LocalDeveloperSettings.current
    // Mock mode (Developer toggle OFF) has no real burner — surface a demo
    // affordance to reach the website-QR relay path. Absent dev ⇒ live (prod).
    val useLive = dev?.useLiveClient?.collectAsState()?.value ?: true
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // Draft-only metadata store (backup policy) — device-local, NOT signed
    // into the InstallBlob; reset on delivery. Mirror of iOS's draftStore.
    val draftStore = remember { CreateServerDraftStore.from(context) }

    var phase by remember { mutableStateOf(Phase.Design) }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var qrText by remember { mutableStateOf("") }
    var matchCode by remember { mutableStateOf<String?>(null) }
    var pendingDelivery by remember { mutableStateOf<PendingDelivery?>(null) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Recipe TTL in MILLIS — default 6h, clamped 5min..24h. Single
    // user-facing TTL on the recipe; drives authCode.expiresAt.
    var recipeTtlMs by remember { mutableStateOf(DEFAULT_RECIPE_TTL_MS) }
    // Boot-unlock policy — "auto" default (self-unlock via box-sealed lease) vs
    // "approve" (phone-gated every boot). Only "approve" rides the wire.
    var bootUnlockMode by remember { mutableStateOf(ServerSettingsStore.Mode.AUTO) }
    // Disk encryption — ON (default) = "luks" (omitted from the wire). OFF =
    // "none": plaintext disk, for boxes that can't keep network at boot.
    var encryptDisk by remember { mutableStateOf(true) }
    // ADVANCED MODE — one toggle, OFF by default ("for people who know what
    // they're doing"). On mobile it gates the offline path: embed-secrets (the
    // box SWK in the recipe), so a box installs fully offline with no
    // post-registration phone step. (Choose-your-own-ISO + debug/local-CLI have
    // no mobile analogue — they live on the website/webapp.) When OFF, the
    // offline sub-options snap back to the secret-free default.
    var advancedMode by remember { mutableStateOf(false) }
    // Whether the recipe EMBEDS the box's SWK (the offline path). Default OFF:
    // the recipe is secret-free of the SWK and the phone DEPOSITS it once the box
    // registers (docs/recipe-delivery-and-remote-install.md).
    var embedSecrets by remember { mutableStateOf(false) }
    // ADVANCED — make this a debug-friendly server. Default OFF (a production box
    // with no console login). ON (only reachable under Advanced mode) bakes an
    // owner-IRK-signed `flagship/debug-access/v1` grant into the recipe as the
    // UNSIGNED `debugGrant` sibling; the box-side gate verifies it under the
    // config-pinned owner IRK + this box's FQDN before enabling the debug console
    // user. Signed at MINT behind the SAME create biometric. Snaps back when
    // Advanced mode is turned off.
    var debugFriendly by remember { mutableStateOf(false) }
    val swkDepositStore = remember { PendingSwkDepositStore.from(context) }
    val pairingDepositStore = remember { PendingPairingDepositStore.from(context) }
    // Per-service leadership (Phase 6): the per-cloud CGK is NEVER embedded in the
    // recipe, so it is owed on EVERY created server and deposited post-registration.
    val cgkDepositStore = remember { com.flagshipserver.app.core.PendingCgkDepositStore.from(context) }
    // Backup policy — draft-only metadata (phone-only default). Hydrated from
    // the draft store so flipping away mid-fill doesn't lose the pick; NOT on
    // the wire (applied later via an owner-signed set-backup-policy order).
    var backupPolicy by remember { mutableStateOf(draftStore.backupPolicy()) }
    // Burner-pairing controller (built when the user picks "Pair with the
    // burner app") + on-device-burn recipe (minted before showing the burn UI).
    var pairController by remember { mutableStateOf<BurnerPairController?>(null) }
    var burnRecipeJson by remember { mutableStateOf<String?>(null) }
    var burnMinted by remember { mutableStateOf<MintedBundle?>(null) }

    // Mint the recipe + pre-publish the auth-code/RCK on .com (the box needs them
    // to register when it phones home, regardless of delivery channel), reusing
    // the shared minter so the recipe is byte-identical across delivery methods.
    suspend fun mintAndRegister(): MintedBundle {
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
            swkDepositStore = swkDepositStore,
            cgkDepositStore = cgkDepositStore,
            pairingDepositStore = pairingDepositStore,
            sessionStore = sessionStore,
        )
        registerControlPlane(
            flagshipServer = flagshipServer,
            bundle = minted.bundle,
            authCodeUserSig = minted.bundle.blob.authCodeUserSignature,
        )
        return minted
    }

    // Per-server bookkeeping every delivery path runs once the recipe is out:
    // remember the boot-unlock choice + clear the draft-only metadata. Mirrors
    // iOS recordDeliveredBookkeeping + the QR path's Match step.
    fun recordDelivered(serverDomain: String) {
        ServerSettingsStore.from(context).setMode(serverDomain, bootUnlockMode)
        draftStore.reset()
    }

    // Pair + Burn are full-screen flows with their OWN scroll containers, so they
    // render OUTSIDE the design/chooser scroll Column (nesting same-direction
    // scrollables would crash). iOS presents the pair sheet the same way.
    if (phase == Phase.Pair) {
        val pc = pairController
        if (pc != null) {
            BurnerPairScreen(
                controller = pc,
                onDeliveredVisible = { domain, serial ->
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
            BurnerOnDeviceScreen(
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

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "New server",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))

        when (phase) {
            Phase.Design -> DesignPhase(
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
                    if (!it) { embedSecrets = false; debugFriendly = false }
                },
                embedSecrets = embedSecrets,
                onEmbedSecrets = { embedSecrets = it },
                debugFriendly = debugFriendly,
                onDebugFriendly = { debugFriendly = it },
                backupPolicy = backupPolicy,
                onBackupPolicy = {
                    backupPolicy = it
                    draftStore.setBackupPolicy(it)
                },
                error = error,
                onContinue = {
                    if (name.isBlank()) { error = "Name required."; return@DesignPhase }
                    error = null
                    phase = Phase.DeliveryChooser
                },
                onCancel = onCancel,
            )
            Phase.DeliveryChooser -> DeliveryChooserPhase(
                busy = working,
                showDemo = !useLive,
                onPair = {
                    // The burner pairing is a LIVE relay session always (mock
                    // mode has no real burner — it uses the demo QR below).
                    val controller = BurnerPairController(
                        client = LiveBurnerPairClient(),
                        scope = scope,
                        // ONE-SHOT: mint the recipe (with the Advanced toggles —
                        // embed-secrets, debug-friendly — baked in behind the
                        // SAME create biometric) + deliver it. No resume, no
                        // debug-consent round-trip (the debug grant rides the
                        // recipe). Byte-identical recipe to share/copy/burn.
                        mint = {
                            val minted = mintAndRegister()
                            val json = Json.encodeToString(InstallBlobBundle.serializer(), minted.bundle)
                            BurnerPairController.MintedRecipe(json, minted.serverDomain, minted.serial)
                        },
                    )
                    pairController = controller
                    phase = Phase.Pair
                },
                onShare = {
                    if (working) return@DeliveryChooserPhase
                    scope.launch {
                        working = true
                        try {
                            val minted = mintAndRegister()
                            val json = Json.encodeToString(InstallBlobBundle.serializer(), minted.bundle)
                            shareRecipeFile(context, name, json)
                            recordDelivered(minted.serverDomain)
                            onDelivered(minted.serverDomain, minted.serial, name, description)
                        } catch (t: Throwable) {
                            error = NetworkErrorHumanizer.humanize(t)
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
                            onDelivered(minted.serverDomain, minted.serial, name, description)
                        } catch (t: Throwable) {
                            error = NetworkErrorHumanizer.humanize(t)
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
                            phase = Phase.Burn
                        } catch (t: Throwable) {
                            error = NetworkErrorHumanizer.humanize(t)
                        } finally {
                            working = false
                        }
                    }
                },
                onDemo = {
                    error = null
                    phase = Phase.Scan
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
                                swkDepositStore = swkDepositStore,
                                pairingDepositStore = pairingDepositStore,
                                cgkDepositStore = cgkDepositStore,
                                // Secret-free pairing: build the order + persist the
                                // session token now; the order is sealed + deposited
                                // post-registration so the box comes online paired.
                                mailbox = mailbox,
                                sessionStore = sessionStore,
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
                            error = NetworkErrorHumanizer.humanize(t)
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
                            qrRelay.deliver(sealed.ciphertextB64u, sealed.nonceB64u)
                            registerControlPlane(
                                flagshipServer = flagshipServer,
                                bundle = delivery.bundle,
                                authCodeUserSig = delivery.bundle.blob.authCodeUserSignature,
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
                            onDelivered(
                                delivery.bundle.blob.serverDomain,
                                delivery.bundle.blob.authCode.serial,
                                name,
                                description,
                            )
                        } catch (t: Throwable) {
                            error = NetworkErrorHumanizer.humanize(t)
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
        Spacer(Modifier.height(FS.space.s12))
    }
}

// Recipe TTL bounds — single user-facing knob on the design page.
// Drives authCode.expiresAt (the only meaningful TTL on the recipe).
internal const val DEFAULT_RECIPE_TTL_MS: Long = 6L * 60L * 60_000L  // 6h
internal const val MIN_RECIPE_TTL_MS: Long = 5L * 60_000L            // 5min
internal const val MAX_RECIPE_TTL_MS: Long = 24L * 60L * 60_000L     // 24h

@Composable
private fun DesignPhase(
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
    backupPolicy: CreateServerDraftStore.BackupPolicy,
    onBackupPolicy: (CreateServerDraftStore.BackupPolicy) -> Unit,
    error: String?,
    onContinue: () -> Unit,
    onCancel: () -> Unit,
) {
    Text(
        "Pick a short name (used as the subdomain) + a one-liner so the Home card reads well.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            FSField(
                value = name,
                onValueChange = onName,
                label = "Name",
                modifier = Modifier.testTag("cs-name-field"),
            )
            Spacer(Modifier.height(FS.space.s2))
            FSField(value = description, onValueChange = onDescription, label = "Description")
            Spacer(Modifier.height(FS.space.s2))
            Text(
                "Subdomain preview: ${SlugUtil.slugify(name).ifEmpty { "name" }}.$username.${Endpoints.dataApex}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
            Spacer(Modifier.height(FS.space.s4))
            RecipeTtlPicker(recipeTtlMs = recipeTtlMs, onRecipeTtlMs = onRecipeTtlMs)
            Spacer(Modifier.height(FS.space.s4))
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
            )
            Spacer(Modifier.height(FS.space.s4))
            BackupPolicyPicker(policy = backupPolicy, onPolicy = onBackupPolicy)
}
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(
        label = "Continue",
        onClick = onContinue,
        block = true,
        modifier = Modifier.testTag("cs-continue-button"),
    )
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun RecipeTtlPicker(
    recipeTtlMs: Long,
    onRecipeTtlMs: (Long) -> Unit,
) {
    val hours = recipeTtlMs.toDouble() / 3_600_000.0
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "Recipe expires in",
            color = FS.colors.text,
            style = TextStyle(fontSize = 14.sp),
            modifier = Modifier.weight(1f),
        )
        Text(
            ttlLabel(hours),
            color = FS.colors.text,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
        )
    }
    Slider(
        value = hours.toFloat(),
        onValueChange = { onRecipeTtlMs((it * 3_600_000.0).toLong()) },
        valueRange = 0.5f..24f,
        steps = 47, // (24-0.5)/0.5 = 47 stops
    )
    Text(
        "After this window, the unused USB can't install — re-mint from this screen.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
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
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = mode == ServerSettingsStore.Mode.AUTO,
        title = "Reboots on its own",
        subtitle = "Best for flaky power or connections. After you approve its first boot, the box self-unlocks on every reboot — no phone needed. Revocable any time.",
        onClick = { onMode(ServerSettingsStore.Mode.AUTO) },
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = mode == ServerSettingsStore.Mode.APPROVE,
        title = "Authorize each boot",
        subtitle = "Most theft-resistant. The box asks your phone on every reboot. Best for critical servers on stable infrastructure.",
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
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
        modifier = Modifier.testTag("cs-encrypt-disk-toggle"),
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = encryptDisk,
        title = "Encrypt the disk (recommended)",
        subtitle = "Full-disk LUKS encryption. The box fetches its unlock key at boot, so it needs a network connection to come back up after a power cut.",
        onClick = { onEncryptDisk(true) },
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = !encryptDisk,
        title = "Don't encrypt my disk",
        subtitle = "Less safe — anyone with the disk can read it. Choose this only for a box that can't keep network at boot (Wi-Fi-only): it boots with no connection.",
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
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                "Advanced mode",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "For people who know what they're doing.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
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
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
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
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Debug-friendly server",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.weight(1f),
            )
            Switch(
                checked = debugFriendly,
                onCheckedChange = onDebugFriendly,
                modifier = Modifier.testTag("cs-debug-friendly-toggle"),
            )
        }
        Text(
            "Anyone with physical access to this server can log into its console. Only turn this on for a server you're actively debugging.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp),
        )
    }
}

// Backup policy — draft-only metadata, three tiers, default "phone-only".
// Mirrors iOS's backupPolicyPicker + the webapp's #cs-backup-policy dropdown.
// NOT carried in the signed InstallBlob; applied later via an owner-signed
// set-backup-policy order.
@Composable
private fun BackupPolicyPicker(
    policy: CreateServerDraftStore.BackupPolicy,
    onPolicy: (CreateServerDraftStore.BackupPolicy) -> Unit,
) {
    Text(
        "Backup policy",
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = policy == CreateServerDraftStore.BackupPolicy.PHONE_ONLY,
        title = "Phone-side backups",
        subtitle = "The default. Your phone pulls an encrypted backup of each app on a schedule. Restores need this device. Because the backup lives on your phone, your server's data can't grow larger than your phone's free space.",
        onClick = { onPolicy(CreateServerDraftStore.BackupPolicy.PHONE_ONLY) },
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = policy == CreateServerDraftStore.BackupPolicy.PEER,
        title = "Peer-distributed backups",
        subtitle = "Your encrypted shards are stored across other Flagship users (and theirs on you). Recoverable from any device with your account.",
        onClick = { onPolicy(CreateServerDraftStore.BackupPolicy.PEER) },
    )
    Spacer(Modifier.height(FS.space.s2))
    BootUnlockOption(
        selected = policy == CreateServerDraftStore.BackupPolicy.NONE,
        title = "No backups",
        subtitle = "Power-user opt-out. If the box dies before you back up manually, the data is gone.",
        onClick = { onPolicy(CreateServerDraftStore.BackupPolicy.NONE) },
    )
}

@Composable
private fun BootUnlockOption(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    val border = if (selected) FS.colors.primary else FS.colors.border
    Column(
        Modifier
            .fillMaxWidth()
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = border,
                shape = androidx.compose.foundation.shape.RoundedCornerShape(FS.radius.md),
            )
            .clickable(onClick = onClick)
            .padding(FS.space.s3),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = selected, onClick = onClick)
            Spacer(Modifier.width(FS.space.s2))
            Text(
                title,
                color = FS.colors.text,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
            )
        }
        Text(
            subtitle,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
            modifier = Modifier.padding(start = FS.space.s2),
        )
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
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    Spacer(Modifier.height(FS.space.s4))
    QRScanner(onScanned = onScanned)
    Spacer(Modifier.height(FS.space.s4))
    FSField(value = qrText, onValueChange = onQrText, label = "Or paste code manually")
    if (qrText.isNotBlank()) {
        FSGhostButton(label = "Use this code", onClick = { onScanned(qrText) }, block = true)
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
    }
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
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
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard(padding = PaddingValues(FS.space.s8)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                QrRelay.formatMatchCode(matchCode),
                color = FS.colors.text,
                style = TextStyle(fontSize = 44.sp, lineHeight = 56.sp, fontWeight = FontWeight.SemiBold),
            )
        }
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
    }
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = "Codes match — deliver", onClick = onConfirm, block = true)
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

// Delivery-method chooser shown after the design step. Mirrors iOS
// CreateServerStubScreen.deliveryChooserPage: pair-with-burner / save-share /
// copy / burn-on-device, plus a mock-only demo affordance.
@Composable
private fun DeliveryChooserPhase(
    busy: Boolean,
    showDemo: Boolean,
    onPair: () -> Unit,
    onShare: () -> Unit,
    onCopy: () -> Unit,
    onBurn: () -> Unit,
    onDemo: () -> Unit,
    error: String?,
    onCancel: () -> Unit,
) {
    Text(
        "Your recipe is ready. Pick how to get it to the Flagship burner that writes your USB stick.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    Spacer(Modifier.height(FS.space.s4))
    DeliveryCard(
        title = "Pair with the burner app",
        body = "Scan the burner's QR (or type its code) and the recipe is sent over a secure live link. Easiest if the burner is open in front of you.",
        enabled = !busy,
        testTag = "cs-delivery-pair",
        onClick = onPair,
    )
    Spacer(Modifier.height(FS.space.s3))
    DeliveryCard(
        title = "Save / share recipe file",
        body = "Save the recipe as a file or send it. Whoever builds the box opens it in the burner. No secrets in the file.",
        enabled = !busy,
        testTag = "cs-delivery-share",
        onClick = onShare,
    )
    Spacer(Modifier.height(FS.space.s3))
    DeliveryCard(
        title = "Copy recipe to clipboard",
        body = "Copy the recipe text, then paste it into the burner's \"I have a recipe\" box.",
        enabled = !busy,
        testTag = "cs-delivery-copy",
        onClick = onCopy,
    )
    Spacer(Modifier.height(FS.space.s3))
    DeliveryCard(
        title = "Burn to USB on this device",
        body = "Connect a USB drive with an OTG adapter and write the bootable installer right here — no computer needed.",
        enabled = !busy,
        testTag = "cs-delivery-burn",
        onClick = onBurn,
    )
    if (showDemo) {
        Spacer(Modifier.height(FS.space.s3))
        // MOCK mode only: reach the website-QR relay path (Scan→Match) so the
        // create flow stays exercisable without a real burner/desktop.
        FSGhostButton(
            label = "Use a demo QR (mock)",
            onClick = onDemo,
            block = true,
            modifier = Modifier.testTag("cs-demo-qr-button"),
        )
    }
    if (busy) {
        Spacer(Modifier.height(FS.space.s4))
        Text("Working…", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
    }
    if (error != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(error, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
    }
    Spacer(Modifier.height(FS.space.s4))
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun DeliveryCard(
    title: String,
    body: String,
    enabled: Boolean,
    testTag: String,
    onClick: () -> Unit,
) {
    FSCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .testTag(testTag),
    ) {
        Column {
            Text(title, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Spacer(Modifier.height(FS.space.s1))
            Text(body, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
        }
    }
}

// Write the recipe JSON to a cache file + offer the system share sheet. The
// FileProvider authority is "<applicationId>.fileprovider" (AndroidManifest +
// res/xml/file_paths.xml). Mirrors InviteIssueScreen.shareViaSystemSheet.
private fun shareRecipeFile(ctx: Context, serverName: String, json: String) {
    val dir = File(ctx.cacheDir, "recipes").apply { mkdirs() }
    val slug = SlugUtil.slugify(serverName).ifEmpty { "server" }
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
    // Debug-friendly server (Advanced): when true, bake an owner-IRK-signed
    // debug-access grant into the recipe as the UNSIGNED `debugGrant` sibling.
    debugFriendly: Boolean = false,
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
        swkDepositStore = swkDepositStore,
        cgkDepositStore = cgkDepositStore,
        pairingDepositStore = pairingDepositStore,
        sessionStore = sessionStore,
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
 *  pending pod, independent of the delivery channel (QR relay, burner pairing,
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
 * [prepareDelivery] (which keeps the QR seal on top) so the burner-pair /
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
    // Debug-friendly server (Advanced): bake an owner-IRK-signed debug-access
    // grant into the recipe as the UNSIGNED `debugGrant` sibling.
    debugFriendly: Boolean = false,
    swkDepositStore: PendingSwkDepositStore? = null,
    cgkDepositStore: com.flagshipserver.app.core.PendingCgkDepositStore? = null,
    pairingDepositStore: PendingPairingDepositStore? = null,
    sessionStore: com.flagshipserver.app.api.SessionStoring? = null,
): MintedBundle {
    val slug = SlugUtil.slugify(serverName)
    val serverDomain = Endpoints.serverFqdn(server = slug, user = username)
    val serial = SerialGen.random()
    val now = System.currentTimeMillis()
    val expiresAt = now + recipeTtlMs.coerceIn(MIN_RECIPE_TTL_MS, MAX_RECIPE_TTL_MS)

    val irk = Keystore.deriveIRK("Create server $serverName")
    val irkPubHex = Keystore.irkPubHex()
    val irkPubBytes = HexUtil.decode(irkPubHex) ?: error("corrupt IRK pub")

    val delegated = Ed25519Sign.KeyPair.newKeyPair()
    val delegatedPubHex = HexUtil.encode(delegated.publicKey)

    val rck = Ed25519Sign.KeyPair.newKeyPair()
    val rckPubHex = HexUtil.encode(rck.publicKey)

    // Slice D (D-1) — pin the account's ADMIN MASTER ROOT into the AuthCode so a
    // fresh box anchors it (signature-covered by the IRK below). Null on a legacy
    // account with no admin root ⇒ byte-identical pre-D canonical bytes.
    val adminRootPubBytes = Keystore.adminRootPubHex()?.let { HexUtil.decode(it) }

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
    // first boot. The box can't derive it (no UMK). Reuses the in-hand UMK seed —
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
            label = "Android",
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

    // Debug-friendly server (Advanced): bake an owner-IRK-signed debug-access
    // grant into the recipe as the UNSIGNED `debugGrant` sibling. Signed here
    // behind the SAME create biometric (the IRK is already in hand) — no extra
    // Face ID, no over-the-session consent round-trip. The box-side gate
    // (debugAccessGate.ts) verifies it under the config-pinned owner IRK + this
    // box's FQDN. nil for the production default (no debug grant).
    val debugGrantSibling = if (debugFriendly) debugGrantEnvelope(serverDomain, irk, now) else null

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

/**
 * Build the recipe's `debugGrant` sibling: an owner-IRK-signed
 * `flagship/debug-access/v1` grant (console-only — empty `sshAuthorizedKey`)
 * serialized to the EXACT `{grant:{serverDomain,sshAuthorizedKey,issuedAt},
 * signatureHex}` JSON the box-side gate consumes (`debugAccessGate.ts`). No box
 * STK in the canonical bytes, so it's signable at mint. Mirror of iOS
 * CreateServerViewModel.debugGrantEnvelope. `internal` so a unit test can pin
 * the byte-identical canonical + verify under the owner IRK.
 */
internal fun debugGrantEnvelope(
    serverDomain: String,
    irk: Ed25519Sign,
    now: Long = System.currentTimeMillis(),
): String {
    val grant = DebugAccess.Grant(serverDomain = serverDomain, sshAuthorizedKey = "", issuedAt = now)
    val sig = try { DebugAccess.sign(grant, irk) } catch (_: Throwable) { "" }
    return DebugAccess.envelopeJson(grant, sig)
}

/**
 * Pre-publish the auth-code + RCK on .com so the freshly-booted box can
 * register itself on first phone-home. Both are IRK-signed canonical-
 * bytes envelopes the Worker verifies.
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
    val irk = Keystore.deriveIRK("Register on flagshipserver.com")

    val rckSig = HexUtil.encode(irk.sign(
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
        ),
    )
}
