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

private enum class Phase { Design, Scan, Match }

@Composable
fun CreateServerScreen(
    onDelivered: (serverDomain: String, serial: String, name: String, description: String) -> Unit,
    onCancel: () -> Unit,
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
    val swkDepositStore = remember { PendingSwkDepositStore.from(context) }
    val pairingDepositStore = remember { PendingPairingDepositStore.from(context) }
    // Backup policy — draft-only metadata (phone-only default). Hydrated from
    // the draft store so flipping away mid-fill doesn't lose the pick; NOT on
    // the wire (applied later via an owner-signed set-backup-policy order).
    var backupPolicy by remember { mutableStateOf(draftStore.backupPolicy()) }

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
                    if (!it) embedSecrets = false
                },
                embedSecrets = embedSecrets,
                onEmbedSecrets = { embedSecrets = it },
                backupPolicy = backupPolicy,
                onBackupPolicy = {
                    backupPolicy = it
                    draftStore.setBackupPolicy(it)
                },
                error = error,
                onContinue = {
                    if (name.isBlank()) { error = "Name required."; return@DesignPhase }
                    error = null
                    phase = Phase.Scan
                },
                onCancel = onCancel,
            )
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
                                swkDepositStore = swkDepositStore,
                                pairingDepositStore = pairingDepositStore,
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
            if (embedSecrets)
                "The recipe carries the box's app key. The box installs fully offline — no later step on your phone — but the recipe now holds a secret. Keep it safe."
            else
                "Off (recommended): the recipe holds no app key. Your phone delivers it securely once the box comes online.",
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
    swkDepositStore: PendingSwkDepositStore? = null,
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
            ),
            authCodeUserSignature = authCodeUserSigHex,
            rckPubKey = rckPubHex,
            bootUnlockMode = bootUnlockMode,
            diskEncryption = diskEncryption,
        ),
        blobSignature = blobSigHex,
        pairingOrder = embeddedPairingOrder,
        swkHex = embeddedSwkHex,
    )

    return PendingDelivery(
        sid = parsed.sid,
        phonePubKeyB64u = Base64URL.encode(session.phonePubKey),
        matchCode = matchCode,
        session = session,
        bundle = bundle,
        irkPubHex = irkPubHex,
    )
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
            ),
            signature = authCodeUserSig,
        ),
    )
}
