// "Build a service" modes — Compose screens. The create-a-service entry
// opens the chooser ("how do you want to build it?") which fans into:
//   - scratch     → the existing vibe-code flow
//   - git         → import a repo (fit → install / not fit → AI-adapt)
//   - mcp         → connect Cursor/Cline with your own AI
//   - marketplace → install something already built (opens the catalog)
// plus a "View past builds" link to the build journal.
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
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
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalBuildClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.runtime.DisposableEffect
import com.flagshipserver.app.viewmodels.BuildGitViewModel
import com.flagshipserver.app.viewmodels.BuildJournalViewModel
import com.flagshipserver.app.viewmodels.BuildMcpViewModel
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
    subtitle: String,
    onBack: () -> Unit,
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
        Text(
            text = title,
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s3))
        Text(
            text = subtitle,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
        )
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
 * "Build a service — how do you want to build it?" Four tiles + a
 * "View past builds" link. The scratch tile routes to the existing vibe
 * flow; the marketplace tile opens the marketplace catalog.
 */
@Composable
fun BuildSourceChooserScreen(nav: NavController) {
    ScreenScaffold(
        title = "Build a service",
        subtitle = "How do you want to build it?",
        onBack = { nav.popBackStack() },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            SourceTile(
                title = "Start from scratch with AI",
                body = "Describe what you want. The AI writes it and the box runs it.",
                // The box's model drives this build, so confirm an AI key first.
                onClick = { nav.navigate("vibe/key") },
            )
            SourceTile(
                title = "Import from a Git repo",
                body = "Paste a repo URL. If it's Flagship-ready we install it as-is; if not, the AI can adapt it.",
                onClick = { nav.navigate("build/git") },
            )
            SourceTile(
                title = "Connect your IDE (Cursor/Cline)",
                body = "Build from your editor using your own AI. No model key lives on the box.",
                onClick = { nav.navigate("build/mcp") },
            )
            SourceTile(
                title = "Get from the marketplace",
                body = "Install something your neighbours already built. One tap onto any of your boxes.",
                onClick = { nav.navigate("marketplace") },
            )
        }
        Spacer(Modifier.height(FS.space.s4))
        FSGhostButton(
            "View past builds →",
            onClick = { nav.navigate("build/journal") },
            block = true,
        )
    }
}

@Composable
private fun SourceTile(title: String, body: String, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
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
                "The AI rewrites this repo into a Flagship app — adds the manifest, removes its own login, and wires it to your box's data layer.",
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
fun BuildMcpScreen(nav: NavController) {
    val client = LocalBuildClient.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val vm = remember { BuildMcpViewModel(client) }
    val phase by vm.phase.collectAsState()
    val connection by vm.connection.collectAsState()
    val envRequests by vm.envRequests.collectAsState()
    val deployStatus by vm.deployStatus.collectAsState()

    ScreenScaffold(
        title = "Connect your IDE",
        subtitle = "Build from Cursor or Cline using your own AI. The box runs an MCP server scoped to just this build — no model key on the box.",
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
    val vm = remember { BuildJournalViewModel(client) }
    val list by vm.list.collectAsState()
    val detail by vm.detail.collectAsState()

    LaunchedEffect(buildId) {
        if (buildId != null) vm.loadDetail(buildId) else vm.loadList()
    }

    ScreenScaffold(
        title = "Build journal",
        subtitle = if (buildId != null) "How this service was built." else "How each service was built, across every mode.",
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
                    if (l.value.isEmpty()) {
                        InfoCard("No builds yet", "Builds you start will show up here.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            l.value.forEach { b -> BuildTile(b) { nav.navigate("build/journal/${b.buildId}") } }
                        }
                    }
                }
                is LoadingState.Failed -> ErrorCardSimple(l.message)
                else -> InfoCard("Loading…", "Fetching past builds.")
            }
        }
    }
}

@Composable
private fun BuildTile(b: BuildSummary, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s5),
    ) {
        Text(
            "${b.serviceId ?: b.mode}  (${b.mode})",
            color = FS.colors.text,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s1))
        Text(
            "${b.entryCount} step(s) · last: ${b.lastKind}",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
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
    val fmt = java.text.DateFormat.getDateTimeInstance(
        java.text.DateFormat.SHORT,
        java.text.DateFormat.SHORT,
        java.util.Locale.US,
    )
    return fmt.format(java.util.Date(ms))
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
