// "Build a service" modes — Compose screens. The create-a-service entry
// opens the chooser, which fans into:
//   - scratch     → the existing vibe-code flow
//   - git         → import a repo (fit → install / not fit → AI-adapt)
//   - mcp         → connect Cursor/Cline with your own AI
// plus "Resume or view past builds" into the build sessions list.
//
// MIRRORS the webapp reference apps/web/public/webapp/views/build-*.js and
// the iOS BuildModeScreens.swift. Plain, reassuring copy throughout.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavController
import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.api.BuildEnvRequest
import com.flagshipserver.app.api.BuildJournalEntry
import com.flagshipserver.app.api.BuildMcpConnection
import com.flagshipserver.app.api.BuildSummary
import com.flagshipserver.app.api.VibeCodeNameCheck
import com.flagshipserver.app.api.VibeCodeSessionMeta
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalBuildClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSListLeading
import com.flagshipserver.app.ui.components.FSListRow
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.plural
import com.flagshipserver.app.ui.shell.tabs.openBuildSessions
import com.flagshipserver.app.ui.shell.tabs.navigateOnPod
import com.flagshipserver.app.ui.shell.tabs.openVibeSession
import com.flagshipserver.app.ui.shell.tabs.vibeSessionChatRoute
import com.flagshipserver.app.ui.theme.FS
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.runtime.DisposableEffect
import com.flagshipserver.app.viewmodels.BuildGitViewModel
import com.flagshipserver.app.viewmodels.BuildJournalViewModel
import com.flagshipserver.app.viewmodels.BuildMcpViewModel
import com.flagshipserver.app.viewmodels.BuildSessions
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File

// ── shared bits ─────────────────────────────────────────────────

private val prettyJson = Json { prettyPrint = true }

private fun ideConfigString(ideConfig: JsonElement): String =
    prettyJson.encodeToString(JsonElement.serializer(), ideConfig)

private fun copyToClipboard(ctx: Context, label: String, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}

/** The build screens' frame: a pushed [FSScreen] with a back arrow and room
 *  for an app-bar action (the chooser's help). */
@Composable
private fun ScreenScaffold(
    title: String,
    subtitle: String?,
    onBack: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    FSScreen(
        title = title,
        onBack = onBack,
        subtitle = subtitle,
        actions = actions,
        content = content,
    )
}

/** A Material outlined field in monospace (URLs, branch names, app names). */
@Composable
private fun MonoField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    testTag: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text(placeholder, fontFamily = FontFamily.Monospace) },
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        shape = MaterialTheme.shapes.small,
        modifier = Modifier
            .fillMaxWidth()
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
    )
}

/** A card's headline: an optional status icon and a title. */
@Composable
private fun CardHeadline(text: String, icon: ImageVector? = null, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = modifier,
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(22.dp))
        Text(text, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun MutedText(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
        modifier = modifier,
    )
}

@Composable
private fun NoteText(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
        modifier = modifier,
    )
}

/** A line under a field: an icon in the line's colour and the words. */
@Composable
private fun StatusLine(text: String, icon: ImageVector, ok: Boolean, textModifier: Modifier = Modifier) {
    val color = if (ok) FS.colors.success else MaterialTheme.colorScheme.error
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        Text(text, color = color, style = MaterialTheme.typography.bodyMedium, modifier = textModifier)
    }
}

// ── chooser ─────────────────────────────────────────────────────

/**
 * The first screen of the create-a-service flow. Resuming comes first, so an
 * unfinished build isn't abandoned for a new one; the help dialog carries the
 * explanations the tiles leave out. The scratch tile routes to the existing
 * vibe flow.
 */
@Composable
fun BuildSourceChooserScreen(nav: NavController) {
    val screens = LocalScreensClient.current
    var activeSessions by remember { mutableStateOf(0) }
    var showHelp by remember { mutableStateOf(false) }
    // Composition restarts each time the chooser comes back on top (e.g.
    // Back from a session), so this re-counts then.
    LaunchedEffect(screens) {
        val sessions = runCatching { screens.vibeCodeSessions().sessions }.getOrDefault(emptyList())
        activeSessions = sessions.count { it.isActive }
    }
    ScreenScaffold(
        title = "Build a service",
        subtitle = null,
        onBack = { nav.popBackStack() },
        actions = {
            IconButton(onClick = { showHelp = true }, modifier = Modifier.testTag("build-source-help")) {
                Icon(Icons.AutoMirrored.Outlined.HelpOutline, contentDescription = "Help")
            }
        },
    ) {
        com.flagshipserver.app.ui.components.RunsOnRow()
        val podScope = com.flagshipserver.app.core.LocalPodScope.current
        ResumeRow(activeSessions) {
            // The sessions listed are this server's.
            podScope?.let { it.choose?.invoke(it.pod.podId) }
            nav.navigate("build/journal")
        }
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader("New build")
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                SourceTile(
                    icon = Icons.Outlined.AutoAwesome,
                    title = "Start from scratch with AI",
                    body = "Describe it in plain English. The AI writes it and deploys it for you.",
                    // The server's model drives this build, so confirm an AI key first.
                    onClick = { nav.navigate("vibe/key") },
                    testTag = "build-src-scratch",
                )
                SourceTile(
                    icon = Icons.Outlined.CloudDownload,
                    title = "Import from a Git repo",
                    body = "Paste a repo URL. If it's Flagship-ready we install it as-is, otherwise the AI adapts it.",
                    onClick = { nav.navigate("build/git") },
                    testTag = "build-src-git",
                )
                SourceTile(
                    icon = Icons.Outlined.Laptop,
                    title = "Connect your IDE",
                    body = "Build from Cursor or Cline using your own AI. No model key is stored on your server.",
                    onClick = { nav.navigate("build/mcp") },
                    testTag = "build-src-mcp",
                )
            }
        }
    }
    if (showHelp) BuildHelpDialog { showHelp = false }
}

@Composable
private fun ResumeRow(activeSessions: Int, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag("build-source-journal-link"),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        border = BorderStroke(1.dp, if (activeSessions > 0) FS.colors.success else MaterialTheme.colorScheme.outlineVariant),
    ) {
        FSRow(
            title = "Resume or view past builds",
            icon = Icons.Outlined.History,
            iconTint = MaterialTheme.colorScheme.primary,
            trailing = if (activeSessions > 0) ({
                androidx.compose.material3.Badge(
                    containerColor = FS.colors.success,
                    contentColor = FS.colors.onAccent,
                    modifier = Modifier.semantics { contentDescription = "$activeSessions active" },
                ) {
                    Text("$activeSessions", style = MaterialTheme.typography.labelMedium)
                }
            }) else null,
        )
    }
}

private data class BuildHelpItem(val icon: ImageVector, val title: String, val body: String)

private val BUILD_HELP_ITEMS = listOf(
    BuildHelpItem(
        Icons.Outlined.History, "Resume or view past builds",
        "Builds still open on your server can be picked up where you left off: answer the AI, deploy, or retry a failed deploy. Older builds keep a timeline of what happened. A build stays open until your server restarts.",
    ),
    BuildHelpItem(
        Icons.Outlined.AutoAwesome, "Start from scratch with AI",
        "Describe the app you want in plain English. An AI model writes the code on your server, asks you questions when it needs to, and you deploy it with one tap. You need a key from an AI provider (OpenAI, Anthropic, OpenRouter…); it is sent only to your server.",
    ),
    BuildHelpItem(
        Icons.Outlined.CloudDownload, "Import from a Git repo",
        "Paste the address of a code repository, for example on GitHub. If it is already set up for Flagship it installs as-is; otherwise the AI can adapt it for you.",
    ),
    BuildHelpItem(
        Icons.Outlined.Laptop, "Connect your IDE",
        "For developers: work in Cursor or Cline on your computer with your own AI, connected to your server over MCP. No AI key is stored on the server.",
    ),
)

@Composable
private fun BuildHelpDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        title = { Text("How building works") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(FS.space.s4),
            ) {
                MutedText("Every option ends the same way: the app is installed and running on your own server, at its own web address.")
                BUILD_HELP_ITEMS.forEach { item ->
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.Top) {
                        Icon(item.icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                            Text(item.title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                            NoteText(item.body)
                        }
                    }
                }
            }
        },
    )
}

/** A way to start a build: a card row with the option's icon. */
@Composable
private fun SourceTile(icon: ImageVector, title: String, body: String, onClick: () -> Unit, testTag: String? = null) {
    Surface(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        FSRow(
            title = title,
            subtitle = body,
            icon = icon,
            iconTint = MaterialTheme.colorScheme.primary,
        )
    }
}

// ── git ─────────────────────────────────────────────────────────

@Composable
fun BuildGitScreen(nav: NavController) {
    val client = LocalBuildClient.current
    val toasts = LocalToastCenter.current
    val operations = LocalActiveOperationsCenter.current
    val appState = LocalAppState.current
    // The server this build deploys onto — its name fills the sliver's
    // "building <service> on <server>" clause. Resolved once at first
    // composition (the current/leader pod). The sliver's TAP target is the
    // build's own journal (the VM derives it from the buildId), not this
    // server — tapping should open the build, not the box.
    // The chosen server (docs/app-placement.md §2); the build client is bound
    // to it. A new choice before the repo is checked starts a fresh model on
    // that server.
    val podScope = com.flagshipserver.app.core.LocalPodScope.current
    val targetPod = podScope?.pod ?: appState.currentPod ?: appState.leaderPod
    val holder: BuildGitHolder = viewModel()
    val current = holder.vm
    val vm = if (current != null && (holder.podId == targetPod?.podId || current.phase.value !is BuildGitViewModel.GitPhase.Idle)) {
        current
    } else {
        BuildGitViewModel(
            client = client,
            operations = operations,
            serviceLabel = "your repo",
            serverLabel = targetPod?.name,
        ).also {
            holder.vm = it
            holder.podId = targetPod?.podId
        }
    }
    val phase by vm.phase.collectAsState()

    var url by rememberSaveable { mutableStateOf("") }
    var ref by rememberSaveable { mutableStateOf("") }

    // A 503 from adapt means the box has no model wired — bounce to scratch.
    LaunchedEffect(phase) {
        if (phase is BuildGitViewModel.GitPhase.AdaptUnavailable) {
            toasts.info("AI adapt isn't available on this server yet — starting from scratch instead.")
            nav.navigate("vibe/key")
        }
    }

    // Returning from the AI-key step (build/git/key): a credential was chosen
    // for THIS adapt → run the adapt pass with it (single-use). Fires on the
    // RESUME after the key screen pops back.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                PendingBuildCredential.take()?.let { cred ->
                    vm.adapt(
                        credential = LlmProviderCredential.from(cred),
                    )
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    var name by rememberSaveable { mutableStateOf("") }
    val slug = BuildGitViewModel.slug(name)
    val conflict by vm.conflict.collectAsState()
    val assignedName by vm.assignedName.collectAsState()
    val adaptError by vm.adaptError.collectAsState()
    val adapterFile by vm.adapterFile.collectAsState()
    val ctx = LocalContext.current
    LaunchedEffect(adapterFile) {
        val file = adapterFile ?: return@LaunchedEffect
        shareAdapterFile(ctx, file)
        vm.adapterFileShared()
    }
    val screens = LocalScreensClient.current
    val username = appState.currentUser.value ?: "you"
    val server = podScope?.pod?.fqdn
        ?: (appState.sessionPod ?: appState.leaderPod)?.fqdn ?: "$username.flagship.services"
    // The latest answer from the box, and the slug it answered for: a check
    // only counts while the field still holds that slug.
    var check by remember { mutableStateOf<VibeCodeNameCheck?>(null) }
    var checkedSlug by remember { mutableStateOf("") }
    val currentCheck = check.takeIf { checkedSlug == slug }
    val nameRefused = currentCheck?.ok == false

    LaunchedEffect(slug, screens) {
        if (slug.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.delay(350)
        val result = runCatching { screens.vibeCodeNameCheck(slug) }.getOrDefault(VibeCodeNameCheck.Unknown)
        check = result
        checkedSlug = slug
    }

    ScreenScaffold(
        title = "Git import",
        subtitle = null,
        onBack = { nav.popBackStack() },
    ) {
        com.flagshipserver.app.ui.components.RunsOnRow(locked = phase !is BuildGitViewModel.GitPhase.Idle)
        MonoField(url, { url = it }, label = "Repository URL", placeholder = "https://github.com/you/app", keyboardType = KeyboardType.Uri)
        MonoField(ref, { ref = it }, label = "Branch or tag (optional)", placeholder = "main")
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            MonoField(name, { name = it }, label = "Name (optional)", placeholder = "From the repo's name", testTag = "build-git-name")
            val primary = MaterialTheme.colorScheme.primary
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            Text(
                text = buildAnnotatedString {
                    withStyle(SpanStyle(color = muted)) { append("https://") }
                    withStyle(SpanStyle(color = primary, fontWeight = FontWeight.SemiBold)) {
                        append(BuildGitViewModel.addressLabel(slug, assignedName))
                    }
                    withStyle(SpanStyle(color = muted)) { append(".$server") }
                },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                modifier = Modifier.padding(horizontal = FS.space.s1).testTag("build-git-address"),
            )
            val warning = VibeCodeDescribe.warning(currentCheck, slug)
            if (warning != null) {
                StatusLine(warning, Icons.Outlined.ErrorOutline, ok = false, textModifier = Modifier.testTag("build-git-name-taken"))
            } else if (currentCheck != null && currentCheck.ok && currentCheck.name != null) {
                StatusLine("Available", Icons.Outlined.CheckCircle, ok = true)
            } else if (slug.isEmpty()) {
                MutedText(BuildGitViewModel.blankNameHint(ref), Modifier.padding(horizontal = FS.space.s1))
            }
        }

        val checkRepo = {
            if (url.isBlank()) {
                toasts.error("Paste a repo URL first.")
            } else {
                // Keep the server it builds on for the steps after this one.
                podScope?.let { it.choose?.invoke(it.pod.podId) }
                vm.checkRepo(url, ref, name)
            }
        }
        if (BuildGitViewModel.showsCheckRepo(phase)) {
            val checking = phase is BuildGitViewModel.GitPhase.Checking
            FSPrimaryButton(
                label = if (checking) "Cloning…" else "Check repo",
                onClick = { checkRepo() },
                enabled = !checking && !nameRefused,
                block = true,
                modifier = Modifier.testTag("build-git-check"),
            )
        }
        when (val p = phase) {
            is BuildGitViewModel.GitPhase.Verdict -> VerdictCard(p, vm, nav, adaptError, recheckEnabled = !nameRefused) { checkRepo() }
            is BuildGitViewModel.GitPhase.Adapting -> AdaptingCard(p.progress, p.phase)
            is BuildGitViewModel.GitPhase.NotLive -> NotLiveCard(p.reason, nav, vm, recheckEnabled = !nameRefused) { checkRepo() }
            is BuildGitViewModel.GitPhase.Sealed -> SealedCard(p.message, nav, vm, recheckEnabled = !nameRefused) { checkRepo() }
            is BuildGitViewModel.GitPhase.Adapted -> AdaptedCard(p, vm, nav)
            is BuildGitViewModel.GitPhase.Deploying -> InfoCard("Installing…", "Building and deploying to your server.", busy = true)
            is BuildGitViewModel.GitPhase.Deployed -> DeployedCard(p.url, vm)
            is BuildGitViewModel.GitPhase.Failed -> {
                ErrorCardSimple(p.message)
                RelayFailureAction(p.message)
            }
            else -> {}
        }
    }

    conflict?.let { c ->
        AlertDialog(
            onDismissRequest = { vm.dismissConflict() },
            title = { Text(VibeCodeDescribe.CONFLICT_TITLE) },
            text = { Text(VibeCodeDescribe.conflictMessage(c, slug)) },
            confirmButton = {
                if (c.kind == "session") {
                    TextButton(
                        onClick = {
                            vm.dismissConflict()
                            nav.openBuildSessions()
                        },
                        modifier = Modifier.testTag("build-git-open-sessions"),
                    ) { Text("Open build sessions") }
                } else {
                    TextButton(onClick = { vm.dismissConflict() }) { Text("Pick another name") }
                }
            },
            dismissButton = {
                if (c.kind == "session") {
                    TextButton(onClick = { vm.dismissConflict() }) { Text("Pick another name") }
                }
            },
        )
    }
}

/** Keeps the git screen's model on its back-stack entry. The AI-key step
 *  takes this screen out of composition, and a plain `remember` would come
 *  back without the checked build (or the share switch) to adapt. */
internal class BuildGitHolder : ViewModel() {
    var vm: BuildGitViewModel? = null
    /** The server [vm] builds on. */
    var podId: String? = null
}

@Composable
private fun VerdictCard(
    p: BuildGitViewModel.GitPhase.Verdict,
    vm: BuildGitViewModel,
    nav: NavController,
    adaptError: String?,
    recheckEnabled: Boolean,
    onCheckAgain: () -> Unit,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            if (p.fit) {
                VerdictHead(recheckEnabled, onCheckAgain) {
                    CardHeadline("Flagship-ready", Icons.Outlined.Verified)
                }
                MutedText("${p.reason} — ${plural(p.fileCount, "file")}.")
                FSPrimaryButton("Install it", onClick = { vm.deploy() }, block = true)
            } else {
                val share by vm.share.collectAsState()
                VerdictHead(recheckEnabled, onCheckAgain) {
                    Text(
                        BuildGitViewModel.notReadyText(p.reason),
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
                adaptError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    RelayFailureAction(it)
                }
                // The server's model rewrites the repo, so confirm an AI key
                // first; the git screen runs the adapt pass on return with it.
                FSPrimaryButton(
                    BuildGitViewModel.ADAPT_BUTTON,
                    onClick = { nav.navigate("build/git/key") },
                    block = true,
                    modifier = Modifier.testTag("build-git-adapt"),
                )
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            BuildGitViewModel.SHARE_LABEL,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f),
                        )
                        Switch(
                            checked = share,
                            onCheckedChange = { vm.setShare(it) },
                            modifier = Modifier.testTag("build-git-share"),
                        )
                    }
                    NoteText(BuildGitViewModel.SHARE_NOTE)
                }
            }
            JournalLink(nav, vm.buildId)
        }
    }
}

/** A verdict's first line with the small "Check again" control trailing it,
 *  since the card hides the "Check repo" button. */
@Composable
private fun VerdictHead(recheckEnabled: Boolean, onCheckAgain: () -> Unit, content: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.weight(1f).padding(top = FS.space.s3)) { content() }
        IconButton(
            onClick = onCheckAgain,
            enabled = recheckEnabled,
            modifier = Modifier.testTag("build-git-recheck"),
        ) {
            Icon(Icons.Outlined.Refresh, contentDescription = BuildGitViewModel.CHECK_AGAIN, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The AI's tested app didn't go live: the server's reason, a new AI run (on
 *  a new build, since this one is closed to the AI), and "Check again". */
@Composable
private fun NotLiveCard(
    reason: String,
    nav: NavController,
    vm: BuildGitViewModel,
    recheckEnabled: Boolean,
    onCheckAgain: () -> Unit,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            VerdictHead(recheckEnabled, onCheckAgain) {
                CardHeadline(BuildGitViewModel.NOT_LIVE_TITLE)
            }
            MutedText(reason, Modifier.testTag("build-git-not-live-reason"))
            RelayFailureAction(reason)
            FSPrimaryButton(
                BuildGitViewModel.RETRY_ADAPT,
                onClick = { nav.navigate("build/git/key") },
                block = true,
                modifier = Modifier.testTag("build-git-retry-adapt"),
            )
            JournalLink(nav, vm.buildId)
        }
    }
}

/** The build is closed to the AI: no AI run here, only a new build. */
@Composable
private fun SealedCard(
    message: String,
    nav: NavController,
    vm: BuildGitViewModel,
    recheckEnabled: Boolean,
    onCheckAgain: () -> Unit,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(message, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
            FSPrimaryButton(
                BuildGitViewModel.CHECK_AGAIN,
                onClick = onCheckAgain,
                enabled = recheckEnabled,
                block = true,
                modifier = Modifier.testTag("build-git-sealed-check-again"),
            )
            JournalLink(nav, vm.buildId)
        }
    }
}

@Composable
private fun AdaptingCard(progress: String?, phase: String?) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(
                    BuildGitViewModel.adaptingHeadline(phase),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.testTag("build-git-adapting"),
                )
            }
            if (!progress.isNullOrEmpty()) {
                Text(
                    progress,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    modifier = Modifier.testTag("build-git-progress"),
                )
            }
            NoteText("This can take several minutes. You can leave this screen; Build sessions shows how it went.")
        }
    }
}

@Composable
private fun AdaptedCard(p: BuildGitViewModel.GitPhase.Adapted, vm: BuildGitViewModel, nav: NavController) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            CardHeadline("Adapted", Icons.Outlined.Verified)
            MutedText("The AI rewrote this repo into a Flagship service (${plural(p.fileCount, "file")}).")
            FSPrimaryButton("Install it", onClick = { vm.deploy() }, block = true)
            AdapterExport(vm)
            JournalLink(nav, vm.buildId)
        }
    }
}

@Composable
private fun DeployedCard(url: String, vm: BuildGitViewModel) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            CardHeadline("Installed", Icons.Outlined.CheckCircle)
            Text(
                url,
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            )
            AdapterExport(vm)
        }
    }
}

/** For the repo's author: the file to commit so every Flagship server runs
 *  the repo this way. */
@Composable
private fun AdapterExport(vm: BuildGitViewModel) {
    val ctx = LocalContext.current
    val exporting by vm.exportingAdapter.collectAsState()
    val error by vm.exportError.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSecondaryButton(
            if (exporting) "Preparing…" else "Get flagship.app.json",
            onClick = { vm.exportAdapter(File(ctx.cacheDir, "adapters")) },
            enabled = !exporting,
            block = true,
            modifier = Modifier.testTag("build-git-export"),
        )
        NoteText("Is this your repo? Commit this file at its root and every Flagship server will run it this way.")
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// The FileProvider authority is "<applicationId>.fileprovider" (AndroidManifest
// + res/xml/file_paths.xml); mirrors CreateServerScreen.shareRecipeFile.
private fun shareAdapterFile(ctx: Context, file: File) {
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "application/json"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, BuildGitViewModel.ADAPTER_FILE_NAME)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, "Share flagship.app.json")
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

/** A quiet inline link to the build's timeline. */
@Composable
private fun JournalLink(nav: NavController, buildId: String?) {
    if (buildId == null) return
    FSGhostButton("View build journal", onClick = { nav.navigate("build/journal/$buildId") })
}

// ── mcp ─────────────────────────────────────────────────────────

@Composable
fun BuildMcpScreen(nav: NavController, editServiceId: String? = null) {
    val client = LocalBuildClient.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val podScope = com.flagshipserver.app.core.LocalPodScope.current
    // Bound to the chosen server (docs/app-placement.md §2). The picker locks
    // once a connection is being made, so the client can't change under it.
    val vm = remember(editServiceId, client) { BuildMcpViewModel(client, editServiceId = editServiceId) }
    val phase by vm.phase.collectAsState()
    val connection by vm.connection.collectAsState()
    val envRequests by vm.envRequests.collectAsState()
    val deployStatus by vm.deployStatus.collectAsState()

    ScreenScaffold(
        title = "Connect your IDE",
        subtitle = vm.editingName?.let { EditService.ideIntro(it) }
            ?: "Build from Cursor or Cline using your own AI. Your server runs an MCP server for just this build, and no model key is stored on it.",
        onBack = { nav.popBackStack() },
    ) {
        val creating = phase is BuildMcpViewModel.McpPhase.Creating
        val conn = connection
        com.flagshipserver.app.ui.components.RunsOnRow(locked = creating || conn != null)
        if (conn == null) {
            FSPrimaryButton(
                label = if (creating) "Creating…" else "Create a connection",
                onClick = {
                    // Keep the server it builds on for the steps after this one.
                    podScope?.let { it.choose?.invoke(it.pod.podId) }
                    vm.create()
                },
                enabled = !creating,
                block = true,
                modifier = Modifier.testTag("build-mcp-create"),
            )
            (phase as? BuildMcpViewModel.McpPhase.Failed)?.let {
                ErrorCardSimple(it.message)
            }
        } else {
            ConnectionCard(
                conn = conn,
                onCopyConfig = {
                    copyToClipboard(ctx, "Flagship MCP config", ideConfigString(conn.ideConfig))
                    toasts.success("Config copied.")
                },
                onCopyKey = {
                    copyToClipboard(ctx, "Flagship MCP key", conn.key)
                    toasts.success("Key copied.")
                },
                onRotate = { vm.rotate(); toasts.info("Key regenerated — update your IDE.") },
                onJournal = { vm.buildId?.let { nav.navigate("build/journal/$it") } },
                onDeploy = { vm.deploy() },
                onRefreshEnv = { vm.refreshEnvRequests() },
                envRequests = envRequests,
                deployStatus = deployStatus,
            )
        }
    }
}

@Composable
private fun ConnectionCard(
    conn: BuildMcpConnection,
    onCopyConfig: () -> Unit,
    onCopyKey: () -> Unit,
    onRotate: () -> Unit,
    onJournal: () -> Unit,
    onDeploy: () -> Unit,
    onRefreshEnv: () -> Unit,
    envRequests: List<BuildEnvRequest>,
    deployStatus: String?,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            MutedText("Paste this into your IDE's MCP settings (Cursor: Settings → MCP; Cline: MCP servers). The key works only for this build.")
            KeyValueRow("URL", conn.url)
            KeyValueRow("Key", conn.key)
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSSecondaryButton("Copy key", onClick = onCopyKey, modifier = Modifier.weight(1f))
                FSSecondaryButton("Copy IDE config", onClick = onCopyConfig, modifier = Modifier.weight(1f))
            }
            CodeBlock(ideConfigString(conn.ideConfig))
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSSecondaryButton("Regenerate key", onClick = onRotate, modifier = Modifier.weight(1f))
                FSSecondaryButton("View journal", onClick = onJournal, modifier = Modifier.weight(1f))
            }
            FSCardDivider()
            NoteText("Your editor's agent writes files, validates, requests any secrets (value-free), and deploys. You can also deploy here once it's done:")
            FSPrimaryButton("Deploy now", onClick = onDeploy, block = true)
            deployStatus?.let { NoteText(it) }
        }
    }
    if (envRequests.isNotEmpty()) {
        EnvRequestsCard(envRequests, onRefreshEnv)
    }
}

@Composable
private fun EnvRequestsCard(requests: List<BuildEnvRequest>, onRefresh: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader("Your IDE asked for these secrets")
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                NoteText("The editor and its AI never see the value: you set it here on your server. Open Configure environment on the service after it's deployed and enter each value there; it never travels through your IDE.")
                requests.forEachIndexed { i, q ->
                    if (i > 0) FSCardDivider()
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                q.name,
                                color = MaterialTheme.colorScheme.onSurface,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (q.currentlySet) {
                                FSPill("Set", FSPillKind.Online)
                            } else {
                                FSPill("Needs you", FSPillKind.Pending)
                            }
                        }
                        q.why?.let { NoteText(it) }
                    }
                }
                FSSecondaryButton("Refresh", onClick = onRefresh, block = true)
            }
        }
    }
}

@Composable
private fun KeyValueRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
        Text(
            value,
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        )
    }
}

@Composable
private fun CodeBlock(text: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.padding(FS.space.s3),
        )
    }
}

// ── journal ─────────────────────────────────────────────────────

@Composable
fun BuildJournalScreen(nav: NavController, buildId: String? = null) {
    val client = LocalBuildClient.current
    val screens = LocalScreensClient.current
    val appState = com.flagshipserver.app.core.LocalAppState.current
    val podClients = com.flagshipserver.app.core.LocalPodClients.current
    val vm = remember {
        BuildJournalViewModel(
            client,
            fetchLiveSessions = { screens.vibeCodeSessions().sessions },
            discardSession = { screens.vibeCodeDiscard(it) },
            // The list covers every server this device has a session on, as
            // the webapp's does; a build started anywhere shows up.
            servers = { BuildSessions.servers(appState.pods.value, podClients) },
        )
    }
    val multiServer by vm.multiServer.collectAsState()
    val failedServers by vm.failedServers.collectAsState()
    val list by vm.list.collectAsState()
    val detail by vm.detail.collectAsState()
    val liveSessions by vm.liveSessions.collectAsState()
    val discardError by vm.discardError.collectAsState()
    var confirmDiscard by remember { mutableStateOf<VibeCodeSessionMeta?>(null) }
    var confirmDiscardBuild by remember { mutableStateOf<BuildSummary?>(null) }

    LaunchedEffect(buildId) {
        if (buildId != null) vm.loadDetail(buildId) else vm.loadList()
    }

    ScreenScaffold(
        title = if (buildId != null) "Build timeline" else "Build sessions",
        subtitle = if (buildId != null) "How this service was built." else null,
        onBack = { nav.popBackStack() },
    ) {
        if (buildId != null) {
            when (val d = detail) {
                is LoadingState.Loaded -> TimelineCard(buildId, d.value)
                is LoadingState.Failed -> ErrorCardSimple(d.message)
                else -> InfoCard("Loading…", "Fetching the build timeline.", busy = true)
            }
        } else {
            when (val l = list) {
                is LoadingState.Loaded -> {
                    val builds = l.value
                    val ended = BuildSessions.endedBuilds(builds, liveSessions)
                    val open = BuildSessions.openBuilds(builds, liveSessions)
                    val anyOpen = liveSessions.isNotEmpty() || open.isNotEmpty()
                    if (builds.isEmpty() && liveSessions.isEmpty()) {
                        FSEmptyState(
                            title = "No builds yet.",
                            message = "Builds you start will show up here.",
                            icon = Icons.Outlined.History,
                        )
                    } else {
                        if (anyOpen) {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                FSSectionHeader(if (multiServer) "Open on your servers" else "Open on your server")
                                open.forEach { b ->
                                    val on = vm.serverOfBuild(b.buildId)
                                    BuildTile(b, startedOnly = true, server = on?.name?.takeIf { multiServer }) {
                                        nav.navigateOnPod("build/journal/${b.buildId}", on?.podId)
                                    }
                                    DiscardLink(Modifier.testTag("build-discard-${b.buildId}")) { confirmDiscardBuild = b }
                                }
                                liveSessions.forEach { session ->
                                    val on = vm.serverOfSession(session.sessionId)
                                    SessionTile(session, BuildSessions.name(session, builds), server = on?.name?.takeIf { multiServer }) {
                                        nav.openVibeSession(vibeSessionChatRoute(session.sessionId), on?.podId)
                                    }
                                    if (session.canDiscard) {
                                        DiscardLink(Modifier.testTag("build-session-discard-${session.sessionId}")) { confirmDiscard = session }
                                    }
                                }
                                discardError?.let { ErrorCardSimple(it) }
                            }
                        }
                        if (ended.isNotEmpty()) {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                FSSectionHeader("Past builds")
                                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                                    ended.forEach { b ->
                                        val on = vm.serverOfBuild(b.buildId)
                                        BuildTile(b, server = on?.name?.takeIf { multiServer }) {
                                            nav.navigateOnPod("build/journal/${b.buildId}", on?.podId)
                                        }
                                    }
                                }
                            }
                        }
                        if (failedServers.isNotEmpty()) {
                            NoteText(
                                BuildSessions.unreadServersLine(failedServers),
                                Modifier.padding(horizontal = FS.space.s1).testTag("build-sessions-unread-servers"),
                            )
                        }
                    }
                }
                is LoadingState.Failed -> ErrorCardSimple(l.message)
                else -> InfoCard("Loading…", "Fetching your builds.", busy = true)
            }
        }
    }

    confirmDiscard?.let { session ->
        AlertDialog(
            onDismissRequest = { confirmDiscard = null },
            title = { Text(BuildSessions.DISCARD_TITLE) },
            text = { Text(BuildSessions.discardMessage(session)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDiscard = null
                    vm.discard(session)
                }) { Text("Discard build", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = null }) { Text("Cancel") } },
        )
    }

    confirmDiscardBuild?.let { b ->
        AlertDialog(
            onDismissRequest = { confirmDiscardBuild = null },
            title = { Text(BuildSessions.DISCARD_TITLE) },
            text = { Text(BuildSessions.discardBuildMessage(b)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDiscardBuild = null
                    vm.discard(b)
                }) { Text("Discard build", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscardBuild = null }) { Text("Cancel") } },
        )
    }
}

/** The small red "Discard…" under an open build, right-aligned. */
@Composable
private fun DiscardLink(modifier: Modifier, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onClick, modifier = modifier) {
            Text("Discard…", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelLarge)
        }
    }
}

private fun modeIcon(mode: String): ImageVector = when (mode) {
    "git" -> Icons.Outlined.CloudDownload
    "mcp" -> Icons.Outlined.Laptop
    else -> Icons.Outlined.AutoAwesome
}

@Composable
private fun SessionTile(session: VibeCodeSessionMeta, title: String, server: String? = null, onClick: () -> Unit) {
    val active = session.isActive
    val action = BuildSessions.action(session.status)
    FSListRow(
        leading = FSListLeading.Icon(
            Icons.Outlined.AutoAwesome,
            if (active) FS.colors.success else MaterialTheme.colorScheme.onSurfaceVariant,
        ),
        title = title,
        subtitle = listOfNotNull("Started ${fmtTimestamp(session.startedAt)}", server?.let { "on $it" }).joinToString(" "),
        onClick = onClick,
        modifier = Modifier
            .then(
                if (active) Modifier.border(1.dp, FS.colors.success.copy(alpha = 0.6f), MaterialTheme.shapes.medium) else Modifier,
            )
            .testTag("build-session-${session.sessionId}"),
        below = {
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPill(BuildSessions.label(session.status), sessionPill(session.status))
                FSPill(BuildSummary.methodLabel("scratch"), FSPillKind.Idle)
            }
        },
        trailing = {
            Text(
                action,
                color = if (action == "Open") MaterialTheme.colorScheme.primary else FS.colors.success,
                style = MaterialTheme.typography.labelLarge,
            )
        },
    )
}

private fun sessionPill(status: String): FSPillKind = when (status) {
    "awaiting-tool-response", "ready-to-deploy" -> FSPillKind.Pending
    "streaming", "deploying" -> FSPillKind.Provisioning
    "deployed" -> FSPillKind.Online
    "failed" -> FSPillKind.Offline
    else -> FSPillKind.Idle
}

@Composable
private fun BuildTile(b: BuildSummary, startedOnly: Boolean = false, server: String? = null, onClick: () -> Unit) {
    FSListRow(
        leading = FSListLeading.Icon(modeIcon(b.mode), MaterialTheme.colorScheme.primary),
        title = b.displayName,
        subtitle = (if (startedOnly) "Started ${fmtTimestamp(b.startedAt)}" else BuildSessions.pastBuildSubtitle(b, fmtTimestamp(b.startedAt))) +
            (server?.let { " on $it" } ?: ""),
        onClick = onClick,
        below = { FSPill(b.methodLabel, FSPillKind.Idle) },
    )
}

@Composable
private fun TimelineCard(buildId: String, entries: List<BuildJournalEntry>) {
    if (entries.isEmpty()) {
        com.flagshipserver.app.ui.components.FSNote("No steps recorded for this build yet.")
        return
    }
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Build $buildId",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
            )
            entries.forEachIndexed { i, e ->
                if (i > 0) FSCardDivider()
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                        Text(fmtTimestamp(e.ts), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
                        JournalBadge(e.kind)
                        JournalBadge(e.actor)
                    }
                    Text(e.summary, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
                    e.detail?.takeIf { it.isNotEmpty() }?.let { NoteText(it) }
                }
            }
        }
    }
}

@Composable
private fun JournalBadge(text: String) {
    Surface(
        shape = MaterialTheme.shapes.extraSmall,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

private fun fmtTimestamp(ms: Long): String {
    if (ms <= 0) return ""
    return com.flagshipserver.app.core.FlagshipDateFormat.format(ms, includeTime = true)
}

// ── small shared cards ──────────────────────────────────────────

@Composable
private fun InfoCard(title: String, body: String, busy: Boolean = false) {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                Text(title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
                MutedText(body)
            }
        }
    }
}

@Composable
private fun ErrorCardSimple(message: String) {
    FSCard {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                Text("Something went wrong", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleMedium)
                MutedText(message)
            }
        }
    }
}
