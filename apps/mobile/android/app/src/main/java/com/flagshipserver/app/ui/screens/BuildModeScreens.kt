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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.BuildCredential
import com.flagshipserver.app.api.BuildEnvRequest
import com.flagshipserver.app.api.BuildJournalEntry
import com.flagshipserver.app.api.BuildMcpConnection
import com.flagshipserver.app.api.BuildSummary
import com.flagshipserver.app.api.VibeCodeSessionMeta
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalBuildClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
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

// ── shared bits ─────────────────────────────────────────────────

private val prettyJson = Json { prettyPrint = true }

private fun ideConfigString(ideConfig: JsonElement): String =
    prettyJson.encodeToString(JsonElement.serializer(), ideConfig)

private fun copyToClipboard(ctx: Context, label: String, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}

@Composable
private fun ScreenScaffold(
    title: String,
    subtitle: String?,
    onBack: () -> Unit,
    action: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = title,
                color = FS.colors.text,
                style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.weight(1f),
            )
            action?.invoke()
        }
        if (subtitle != null) {
            Spacer(Modifier.height(FS.space.s3))
            Text(
                text = subtitle,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
            )
        }
        Spacer(Modifier.height(FS.space.s6))
        content()
        Spacer(Modifier.height(FS.space.s6))
        FSGhostButton("Back", onClick = onBack, block = true)
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun MonoField(value: String, onValueChange: (String) -> Unit, placeholder: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(FS.radius.sm))
            .background(FS.colors.surfaceSunken)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.sm))
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            cursorBrush = SolidColor(FS.colors.primary),
            textStyle = TextStyle(color = FS.colors.text, fontSize = 15.sp, fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        ) { inner ->
            if (value.isEmpty()) {
                Text(placeholder, color = FS.colors.textMuted, style = TextStyle(fontSize = 15.sp))
            }
            inner()
        }
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
    LaunchedEffect(Unit) {
        val sessions = runCatching { screens.vibeCodeSessions().sessions }.getOrDefault(emptyList())
        activeSessions = sessions.count { it.isActive }
    }
    ScreenScaffold(
        title = "Build a service",
        subtitle = null,
        onBack = { nav.popBackStack() },
        action = {
            IconButton(onClick = { showHelp = true }, modifier = Modifier.testTag("build-source-help")) {
                Icon(Icons.AutoMirrored.Outlined.HelpOutline, contentDescription = "Help", tint = FS.colors.textMuted)
            }
        },
    ) {
        ResumeRow(activeSessions) { nav.navigate("build/journal") }
        Spacer(Modifier.height(FS.space.s5))
        Text("New build", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
        Spacer(Modifier.height(FS.space.s2))
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            SourceTile(
                title = "Start from scratch with AI",
                body = "Describe what you want. The AI writes it and the box runs it.",
                // The box's model drives this build, so confirm an AI key first.
                onClick = { nav.navigate("vibe/key") },
                testTag = "build-src-scratch",
            )
            SourceTile(
                title = "Import from a Git repo",
                body = "Paste a repo URL. If it's Flagship-ready we install it as-is; if not, the AI can adapt it.",
                onClick = { nav.navigate("build/git") },
                testTag = "build-src-git",
            )
            SourceTile(
                title = "Connect your IDE (Cursor/Cline)",
                body = "Build from your editor using your own AI. No model key lives on the box.",
                onClick = { nav.navigate("build/mcp") },
                testTag = "build-src-mcp",
            )
        }
    }
    if (showHelp) BuildHelpDialog { showHelp = false }
}

@Composable
private fun ResumeRow(activeSessions: Int, onClick: () -> Unit) {
    val shape = RoundedCornerShape(FS.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(FS.colors.surface)
            .border(1.dp, if (activeSessions > 0) FS.colors.success else FS.colors.border, shape)
            .clickable(onClick = onClick)
            .padding(FS.space.s4)
            .testTag("build-source-journal-link"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Icon(Icons.Outlined.History, contentDescription = null, tint = FS.colors.primary)
        Text(
            "Resume or view past builds",
            color = FS.colors.text,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            modifier = Modifier.weight(1f),
        )
        if (activeSessions > 0) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .background(FS.colors.success)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
                    .semantics { contentDescription = "$activeSessions active" },
            ) {
                Text("$activeSessions", color = Color.White, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold))
            }
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = FS.colors.textMuted)
    }
}

private val BUILD_HELP_ITEMS = listOf(
    "Resume or view past builds" to
        "Builds still open on your server can be picked up where you left off: answer the AI, deploy, or retry a failed deploy. Older builds keep a timeline of what happened. A build stays open until your server restarts.",
    "Start from scratch with AI" to
        "Describe the app you want in plain English. An AI model writes the code on your server, asks you questions when it needs to, and you deploy it with one tap. You need a key from an AI provider (OpenAI, Anthropic, OpenRouter…); it is sent only to your server.",
    "Import from a Git repo" to
        "Paste the address of a code repository, for example on GitHub. If it is already set up for Flagship it installs as-is; otherwise the AI can adapt it for you.",
    "Connect your IDE" to
        "For developers: work in Cursor or Cline on your computer with your own AI, connected to your server over MCP. No AI key is stored on the server.",
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
                Text(
                    "Every option ends the same way: the app is installed and running on your own server, at its own web address.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                BUILD_HELP_ITEMS.forEach { (title, body) ->
                    Column {
                        Text(title, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                        Spacer(Modifier.height(FS.space.s1))
                        Text(body, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                    }
                }
            }
        },
    )
}

@Composable
private fun SourceTile(title: String, body: String, onClick: () -> Unit, testTag: String? = null) {
    FSCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        padding = PaddingValues(FS.space.s5),
    ) {
        Text(
            text = title,
            color = FS.colors.text,
            style = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = body,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
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
    val targetPod = remember(appState) { appState.currentPod ?: appState.leaderPod }
    val vm = remember {
        BuildGitViewModel(
            client = client,
            operations = operations,
            serviceLabel = "your repo",
            serverLabel = targetPod?.name,
        )
    }
    val phase by vm.phase.collectAsState()

    var url by remember { mutableStateOf("") }
    var ref by remember { mutableStateOf("") }

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
                        credential = BuildCredential(cred.provider, cred.apiKey, cred.baseUrl),
                    )
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    ScreenScaffold(
        title = "Import from Git",
        subtitle = "Paste a repo URL. We'll clone it and tell you whether it's Flagship-ready.",
        onBack = { nav.popBackStack() },
    ) {
        Text("Repo URL", color = FS.colors.text, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
        Spacer(Modifier.height(FS.space.s2))
        MonoField(url, { url = it }, "https://github.com/you/app")
        Spacer(Modifier.height(FS.space.s4))
        Text("Branch / tag (optional)", color = FS.colors.text, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
        Spacer(Modifier.height(FS.space.s2))
        MonoField(ref, { ref = it }, "main")
        Spacer(Modifier.height(FS.space.s4))

        val checking = phase is BuildGitViewModel.GitPhase.Checking
        FSPrimaryButton(
            label = if (checking) "Cloning…" else "Check repo",
            onClick = { if (url.isBlank()) toasts.error("Paste a repo URL first.") else vm.checkRepo(url, ref) },
            enabled = !checking,
            block = true,
            modifier = Modifier.testTag("build-git-check"),
        )

        Spacer(Modifier.height(FS.space.s4))
        when (val p = phase) {
            is BuildGitViewModel.GitPhase.Verdict -> VerdictCard(p, vm, nav)
            is BuildGitViewModel.GitPhase.Adapting -> InfoCard("Adapting…", "The AI is rewriting this repo into a Flagship service.")
            is BuildGitViewModel.GitPhase.Adapted -> AdaptedCard(p, vm, nav)
            is BuildGitViewModel.GitPhase.Deploying -> InfoCard("Installing…", "Building and deploying to your box.")
            is BuildGitViewModel.GitPhase.Deployed -> DeployedCard(p.url)
            is BuildGitViewModel.GitPhase.Failed -> ErrorCardSimple(p.message)
            else -> {}
        }
    }
}

@Composable
private fun VerdictCard(p: BuildGitViewModel.GitPhase.Verdict, vm: BuildGitViewModel, nav: NavController) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        if (p.fit) {
            Text("Flagship-ready ✓", color = FS.colors.success, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
            Spacer(Modifier.height(FS.space.s2))
            Text("${p.reason} — ${p.fileCount} file(s).", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
            Spacer(Modifier.height(FS.space.s4))
            FSPrimaryButton("Install it", onClick = { vm.deploy() }, block = true)
        } else {
            Text("Not Flagship-ready yet", color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
            Spacer(Modifier.height(FS.space.s2))
            Text(p.reason, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
            Spacer(Modifier.height(FS.space.s3))
            Text(
                "The AI rewrites this repo into a Flagship app — adds the app config, removes its own login, and wires it to your box's data layer.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
            Spacer(Modifier.height(FS.space.s4))
            // The box's model rewrites the repo, so confirm an AI key first;
            // the git screen runs the adapt pass on return with it.
            FSPrimaryButton("Build with AI instead", onClick = { nav.navigate("build/git/key") }, block = true)
        }
        Spacer(Modifier.height(FS.space.s2))
        JournalLink(nav, vm.buildId)
    }
}

@Composable
private fun AdaptedCard(p: BuildGitViewModel.GitPhase.Adapted, vm: BuildGitViewModel, nav: NavController) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text("Adapted ✓", color = FS.colors.success, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text("The AI rewrote this repo into a Flagship service (${p.fileCount} file(s)).", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton("Install it", onClick = { vm.deploy() }, block = true)
        Spacer(Modifier.height(FS.space.s2))
        JournalLink(nav, vm.buildId)
    }
}

@Composable
private fun DeployedCard(url: String) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text("Installed ✓", color = FS.colors.success, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text(url, color = FS.colors.primary, style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace))
    }
}

@Composable
private fun JournalLink(nav: NavController, buildId: String?) {
    if (buildId == null) return
    FSGhostButton("View build journal →", onClick = { nav.navigate("build/journal/$buildId") }, block = true)
}

// ── mcp ─────────────────────────────────────────────────────────

@Composable
fun BuildMcpScreen(nav: NavController, editServiceId: String? = null) {
    val client = LocalBuildClient.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val vm = remember(editServiceId) { BuildMcpViewModel(client, editServiceId = editServiceId) }
    val phase by vm.phase.collectAsState()
    val connection by vm.connection.collectAsState()
    val envRequests by vm.envRequests.collectAsState()
    val deployStatus by vm.deployStatus.collectAsState()

    ScreenScaffold(
        title = "Connect your IDE",
        subtitle = vm.editingName?.let { EditService.ideIntro(it) }
            ?: "Build from Cursor or Cline using your own AI. The box runs an MCP server scoped to just this build — no model key on the box.",
        onBack = { nav.popBackStack() },
    ) {
        val creating = phase is BuildMcpViewModel.McpPhase.Creating
        val conn = connection
        if (conn == null) {
            FSPrimaryButton(
                label = if (creating) "Creating…" else "Create a connection",
                onClick = { vm.create() },
                enabled = !creating,
                block = true,
                modifier = Modifier.testTag("build-mcp-create"),
            )
            (phase as? BuildMcpViewModel.McpPhase.Failed)?.let {
                Spacer(Modifier.height(FS.space.s4))
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
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(
            "Paste this into your IDE's MCP settings (Cursor: Settings → MCP; Cline: MCP servers). The key works only for this build.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s3))
        KeyValueRow("URL", conn.url)
        Spacer(Modifier.height(FS.space.s2))
        KeyValueRow("Key", conn.key)
        Spacer(Modifier.height(FS.space.s3))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSecondaryButton("Copy key", onClick = onCopyKey)
            FSSecondaryButton("Copy IDE config", onClick = onCopyConfig)
        }
        Spacer(Modifier.height(FS.space.s3))
        CodeBlock(ideConfigString(conn.ideConfig))
        Spacer(Modifier.height(FS.space.s3))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSecondaryButton("Regenerate key", onClick = onRotate)
            FSSecondaryButton("View journal", onClick = onJournal)
        }
        Spacer(Modifier.height(FS.space.s4))
        Text(
            "Your editor's agent writes files, validates, requests any secrets (value-free), and deploys. You can also deploy here once it's done:",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPrimaryButton("Deploy now", onClick = onDeploy, block = true)
        deployStatus?.let {
            Spacer(Modifier.height(FS.space.s2))
            Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
        }
    }
    if (envRequests.isNotEmpty()) {
        Spacer(Modifier.height(FS.space.s3))
        EnvRequestsCard(envRequests, onRefreshEnv)
    }
}

@Composable
private fun EnvRequestsCard(requests: List<BuildEnvRequest>, onRefresh: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text("Your IDE asked for these secrets", color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "The editor and its AI never see the value — you set it here on your box. Open Configure environment on the service after it's deployed and enter each value there; it never travels through your IDE.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        )
        Spacer(Modifier.height(FS.space.s3))
        requests.forEach { q ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = FS.space.s1),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(q.name, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace))
                Text(
                    if (q.currentlySet) "set ✓" else "needs you",
                    color = if (q.currentlySet) FS.colors.success else FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
            q.why?.let {
                Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp))
            }
        }
        Spacer(Modifier.height(FS.space.s3))
        FSSecondaryButton("Refresh", onClick = onRefresh, block = true)
    }
}

@Composable
private fun KeyValueRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium))
        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace))
    }
}

@Composable
private fun CodeBlock(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.sm))
            .background(FS.colors.surfaceSunken)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.sm))
            .padding(12.dp),
    ) {
        Text(text, color = FS.colors.text, style = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace))
    }
}

// ── journal ─────────────────────────────────────────────────────

@Composable
fun BuildJournalScreen(nav: NavController, buildId: String? = null) {
    val client = LocalBuildClient.current
    val screens = LocalScreensClient.current
    val vm = remember {
        BuildJournalViewModel(
            client,
            fetchLiveSessions = { screens.vibeCodeSessions().sessions },
            discardSession = { screens.vibeCodeDiscard(it) },
        )
    }
    val list by vm.list.collectAsState()
    val detail by vm.detail.collectAsState()
    val liveSessions by vm.liveSessions.collectAsState()
    val discardError by vm.discardError.collectAsState()
    var confirmDiscard by remember { mutableStateOf<VibeCodeSessionMeta?>(null) }

    LaunchedEffect(buildId) {
        if (buildId != null) vm.loadDetail(buildId) else vm.loadList()
    }

    ScreenScaffold(
        title = "Build sessions",
        subtitle = if (buildId != null) "How this service was built." else null,
        onBack = { nav.popBackStack() },
    ) {
        if (buildId != null) {
            when (val d = detail) {
                is LoadingState.Loaded -> TimelineCard(buildId, d.value)
                is LoadingState.Failed -> ErrorCardSimple(d.message)
                else -> InfoCard("Loading…", "Fetching the build timeline.")
            }
        } else {
            when (val l = list) {
                is LoadingState.Loaded -> {
                    val builds = l.value
                    val ended = BuildSessions.endedBuilds(builds, liveSessions)
                    if (builds.isEmpty() && liveSessions.isEmpty()) {
                        InfoCard("No builds yet.", "Builds you start will show up here.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            if (liveSessions.isNotEmpty()) {
                                SectionCaption("Open on your server")
                                liveSessions.forEach { session ->
                                    SessionTile(session, BuildSessions.name(session, builds)) {
                                        nav.openVibeSession(vibeSessionChatRoute(session.sessionId))
                                    }
                                    if (session.canDiscard) {
                                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                            TextButton(
                                                onClick = { confirmDiscard = session },
                                                modifier = Modifier.testTag("build-session-discard-${session.sessionId}"),
                                            ) {
                                                Text("Discard…", color = FS.colors.danger, style = TextStyle(fontSize = 14.sp))
                                            }
                                        }
                                    }
                                }
                                discardError?.let { ErrorCardSimple(it) }
                            }
                            if (ended.isNotEmpty()) {
                                if (liveSessions.isNotEmpty()) Spacer(Modifier.height(FS.space.s2))
                                SectionCaption("Past builds")
                                ended.forEach { b -> BuildTile(b) { nav.navigate("build/journal/${b.buildId}") } }
                            }
                        }
                    }
                }
                is LoadingState.Failed -> ErrorCardSimple(l.message)
                else -> InfoCard("Loading…", "Fetching your builds.")
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
                }) { Text("Discard build", color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SectionCaption(text: String) {
    Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
}

@Composable
private fun SessionTile(session: VibeCodeSessionMeta, title: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(FS.radius.md)
    val active = session.isActive
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(FS.colors.surface)
            .border(1.dp, if (active) FS.colors.success.copy(alpha = 0.6f) else FS.colors.border, shape)
            .clickable(onClick = onClick)
            .padding(FS.space.s5)
            .testTag("build-session-${session.sessionId}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Spacer(Modifier.height(FS.space.s1))
            Text(
                "Started ${fmtTimestamp(session.startedAt)}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            Spacer(Modifier.height(FS.space.s2))
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPill(BuildSessions.label(session.status), sessionPill(session.status))
                FSPill(BuildSummary.methodLabel("scratch"), FSPillKind.Idle)
            }
        }
        Text(
            if (active) "Resume" else "Open",
            color = if (active) FS.colors.success else FS.colors.primary,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
        )
    }
}

private fun sessionPill(status: String): FSPillKind = when (status) {
    "awaiting-tool-response", "ready-to-deploy" -> FSPillKind.Pending
    "streaming", "deploying" -> FSPillKind.Provisioning
    "deployed" -> FSPillKind.Online
    "failed" -> FSPillKind.Offline
    else -> FSPillKind.Idle
}

@Composable
private fun BuildTile(b: BuildSummary, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s5),
    ) {
        Text(
            b.displayName,
            color = FS.colors.text,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s1))
        Text(
            BuildSessions.pastBuildSubtitle(b, fmtTimestamp(b.startedAt)),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPill(b.methodLabel, FSPillKind.Idle)
    }
}

@Composable
private fun TimelineCard(buildId: String, entries: List<BuildJournalEntry>) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text("Build $buildId", color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s3))
        if (entries.isEmpty()) {
            Text("No steps recorded yet.", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
        } else {
            entries.forEach { e ->
                Column(Modifier.fillMaxWidth().padding(vertical = FS.space.s2)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                        Badge(e.kind)
                        Badge(e.actor)
                    }
                    Spacer(Modifier.height(FS.space.s1))
                    Text(e.summary, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                    e.detail?.let {
                        Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp))
                    }
                    Text(fmtTimestamp(e.ts), color = FS.colors.textMuted, style = TextStyle(fontSize = 11.sp))
                }
            }
        }
    }
}

@Composable
private fun Badge(text: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(FS.colors.surfaceSunken)
            .padding(horizontal = 10.dp, vertical = 3.dp),
    ) {
        Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium))
    }
}

private fun fmtTimestamp(ms: Long): String {
    if (ms <= 0) return ""
    return com.flagshipserver.app.core.FlagshipDateFormat.format(ms, includeTime = true)
}

// ── small shared cards ──────────────────────────────────────────

@Composable
private fun InfoCard(title: String, body: String) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(title, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s1))
        Text(body, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
    }
}

@Composable
private fun ErrorCardSimple(message: String) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text("Something went wrong", color = FS.colors.danger, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s1))
        Text(message, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
    }
}
