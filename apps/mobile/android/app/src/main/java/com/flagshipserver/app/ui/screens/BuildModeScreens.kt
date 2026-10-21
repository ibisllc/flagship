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

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
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
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.WarningAmber
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
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

@Composable
private fun ScreenScaffold(
    title: String,
    subtitle: String?,
    onBack: () -> Unit,
    action: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    FSScreen(
        title = title,
        subtitle = subtitle,
        onBack = onBack,
        actions = { action?.invoke() },
    ) {
        content()
    }
}

/** A one-line verdict with a Material check or warning icon (no text glyphs). */
@Composable
private fun StatusLine(
    text: String,
    color: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    ok: Boolean = true,
    large: Boolean = false,
) {
    Row(modifier = modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        Icon(
            if (ok) Icons.Outlined.CheckCircle else Icons.Outlined.WarningAmber,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(if (large) 20.dp else 16.dp),
        )
        Text(
            text,
            color = color,
            style = if (large) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun MonoField(value: String, onValueChange: (String) -> Unit, placeholder: String, testTag: String? = null) {
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
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = FS.colors.text, fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth().then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        ) { inner ->
            if (value.isEmpty()) {
                Text(placeholder, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
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
    LaunchedEffect(screens) {
        val sessions = runCatching { screens.vibeCodeSessions().sessions }.getOrDefault(emptyList())
        activeSessions = sessions.count { it.isActive }
    }
    ScreenScaffold(
        title = stringResource(R.string.build_a_service),
        subtitle = null,
        onBack = { nav.popBackStack() },
        action = {
            IconButton(onClick = { showHelp = true }, modifier = Modifier.testTag("build-source-help")) {
                Icon(Icons.AutoMirrored.Outlined.HelpOutline, contentDescription = stringResource(R.string.help), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
    ) {
        com.flagshipserver.app.ui.components.RunsOnRow()
        Spacer(Modifier.height(FS.space.s4))
        val podScope = com.flagshipserver.app.core.LocalPodScope.current
        ResumeRow(activeSessions) {
            // The sessions listed are this server's.
            podScope?.let { it.choose?.invoke(it.pod.podId) }
            nav.navigate("build/journal")
        }
        Spacer(Modifier.height(FS.space.s5))
        Text(stringResource(R.string.new_build), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium))
        Spacer(Modifier.height(FS.space.s2))
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            SourceTile(
                title = stringResource(R.string.start_from_scratch_with_ai),
                body = stringResource(R.string.describe_what_you_want_the_ai),
                // The box's model drives this build, so confirm an AI key first.
                onClick = { nav.navigate("vibe/key") },
                testTag = "build-src-scratch",
            )
            SourceTile(
                title = stringResource(R.string.import_from_a_git_repo),
                body = stringResource(R.string.paste_a_repo_url_if_its),
                onClick = { nav.navigate("build/git") },
                testTag = "build-src-git",
            )
            SourceTile(
                title = stringResource(R.string.connect_your_ide_cursor_cline),
                body = stringResource(R.string.build_from_your_editor_using_your),
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
        Icon(Icons.Outlined.History, contentDescription = null, tint = FS.colors.accent)
        Text(
            stringResource(R.string.resume_or_view_past_builds),
            color = FS.colors.text,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            modifier = Modifier.weight(1f),
        )
        if (activeSessions > 0) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .background(FS.colors.success)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
                    .semantics { contentDescription = FSStrings.get(R.string.active, activeSessions) },
            ) {
                Text("$activeSessions", color = Color.White, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold))
            }
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private val BUILD_HELP_ITEMS get() = listOf(
    "Resume or view past builds" to
        FSStrings.get(R.string.builds_still_open_on_your_server),
    "Start from scratch with AI" to
        FSStrings.get(R.string.describe_the_app_you_want_in),
    "Import from a Git repo" to
        FSStrings.get(R.string.paste_the_address_of_a_code),
    "Connect your IDE" to
        FSStrings.get(R.string.for_developers_work_in_your_own),
)

@Composable
private fun BuildHelpDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) } },
        title = { Text(stringResource(R.string.how_building_works)) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(FS.space.s4),
            ) {
                Text(
                    stringResource(R.string.every_option_ends_the_same_way),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                BUILD_HELP_ITEMS.forEach { (title, body) ->
                    Column {
                        Text(title, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                        Spacer(Modifier.height(FS.space.s1))
                        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
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
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

// ── git ─────────────────────────────────────────────────────────

/** The build's own state above its timeline: an AI adapt that failed (one a
 *  box restart cut off comes back failed with the box's sentence) offers to
 *  deploy the build as it is or run the AI again. */
@Composable
private fun DetailAdaptCard(buildId: String, vm: BuildJournalViewModel, nav: NavController) {
    val state by vm.detailAdapt.collectAsState()
    // Back from the AI-key step with a key: run the AI with it.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, buildId) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && vm.detailAdapt.value is BuildJournalViewModel.DetailAdapt.Failed) {
                PendingBuildCredential.take()?.let { vm.runAiAgain(buildId, LlmProviderCredential.from(it)) }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    when (val s = state) {
        is BuildJournalViewModel.DetailAdapt.None -> return
        is BuildJournalViewModel.DetailAdapt.Failed -> FSCard(padding = PaddingValues(FS.space.s5)) {
            Text(
                s.reason,
                color = FS.colors.text,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.testTag("build-journal-adapt-failed"),
            )
            RelayFailureAction(s.reason)
            Spacer(Modifier.height(FS.space.s4))
            if (s.canRunAi) {
                FSPrimaryButton(
                    BuildGitViewModel.RUN_AI_AGAIN,
                    onClick = { nav.navigate("build/git/key") },
                    block = true,
                    modifier = Modifier.testTag("build-journal-run-ai"),
                )
                Spacer(Modifier.height(FS.space.s2))
                FSSecondaryButton(
                    BuildGitViewModel.DEPLOY,
                    onClick = { vm.deployAgain(buildId) },
                    block = true,
                    modifier = Modifier.testTag("build-journal-deploy"),
                )
            } else {
                FSPrimaryButton(
                    BuildGitViewModel.DEPLOY,
                    onClick = { vm.deployAgain(buildId) },
                    block = true,
                    modifier = Modifier.testTag("build-journal-deploy"),
                )
            }
        }
        is BuildJournalViewModel.DetailAdapt.Working -> InfoCard(s.text, stringResource(R.string.this_can_take_several_minutes_you))
        is BuildJournalViewModel.DetailAdapt.Adapted -> FSCard(padding = PaddingValues(FS.space.s5)) {
            StatusLine(stringResource(R.string.adapted), FS.colors.success, large = true)
            Spacer(Modifier.height(FS.space.s2))
            Text(fsString(R.string.the_ai_rewrote_this_repo_into, s.fileCount), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(FS.space.s4))
            FSPrimaryButton(stringResource(R.string.install_it), onClick = { vm.deployAgain(buildId) }, block = true, modifier = Modifier.testTag("build-journal-deploy"))
        }
        is BuildJournalViewModel.DetailAdapt.Deployed -> FSCard(padding = PaddingValues(FS.space.s5)) {
            StatusLine(stringResource(R.string.installed), FS.colors.success, large = true, modifier = Modifier.testTag("build-journal-deployed"))
            Spacer(Modifier.height(FS.space.s2))
            Text(s.url, color = FS.colors.accentText, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
        }
    }
    Spacer(Modifier.height(FS.space.s4))
}

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
            serviceLabel = stringResource(R.string.your_repo),
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
            toasts.info(FSStrings.get(R.string.ai_adapt_isnt_available_on_this))
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
        title = stringResource(R.string.git_import),
        subtitle = null,
        onBack = { nav.popBackStack() },
    ) {
        com.flagshipserver.app.ui.components.RunsOnRow(locked = phase !is BuildGitViewModel.GitPhase.Idle)
        Spacer(Modifier.height(FS.space.s4))
        FieldLabel(stringResource(R.string.repository_url))
        MonoField(url, { url = it }, "https://github.com/you/app")
        Spacer(Modifier.height(FS.space.s4))
        FieldLabel(stringResource(R.string.branch_or_tag_optional))
        MonoField(ref, { ref = it }, "main")
        Spacer(Modifier.height(FS.space.s4))
        FieldLabel(stringResource(R.string.name_optional))
        MonoField(name, { name = it }, stringResource(R.string.from_the_repos_name), testTag = "build-git-name")
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("https://") }
                withStyle(SpanStyle(color = FS.colors.accentText, fontWeight = FontWeight.SemiBold)) {
                    append(BuildGitViewModel.addressLabel(slug, assignedName))
                }
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(".$server") }
            },
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            modifier = Modifier.testTag("build-git-address"),
        )
        val warning = VibeCodeDescribe.warning(currentCheck, slug)
        if (warning != null) {
            Spacer(Modifier.height(FS.space.s2))
            StatusLine(warning, MaterialTheme.colorScheme.error, ok = false, modifier = Modifier.testTag("build-git-name-taken"))
        } else if (currentCheck != null && currentCheck.ok && currentCheck.name != null) {
            Spacer(Modifier.height(FS.space.s2))
            StatusLine(stringResource(R.string.available), FS.colors.success)
        } else if (slug.isEmpty()) {
            Spacer(Modifier.height(FS.space.s2))
            Text(
                BuildGitViewModel.blankNameHint(ref),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Spacer(Modifier.height(FS.space.s4))

        // A check answers for the repo, ref and name it was made with. Edit any of them afterwards and
        // the answer (and the name the box reserved) no longer applies: ask again rather than install
        // under a name other than the one shown.
        var checkedInputs by remember { mutableStateOf<Triple<String, String, String>?>(null) }
        val inputs = Triple(url.trim(), ref.trim(), slug)
        LaunchedEffect(inputs, phase) {
            val checked = checkedInputs
            if (checked != null && checked != inputs && phase !is BuildGitViewModel.GitPhase.Idle &&
                phase !is BuildGitViewModel.GitPhase.Checking
            ) {
                checkedInputs = null
                vm.reset()
            }
        }
        val checkRepo = {
            if (url.isBlank()) {
                toasts.error(FSStrings.get(R.string.paste_a_repo_url_first))
            } else {
                // Keep the server it builds on for the steps after this one.
                podScope?.let { it.choose?.invoke(it.pod.podId) }
                checkedInputs = inputs
                vm.checkRepo(url, ref, name)
            }
        }
        if (BuildGitViewModel.showsCheckRepo(phase)) {
            val checking = phase is BuildGitViewModel.GitPhase.Checking
            FSPrimaryButton(
                label = if (checking) stringResource(R.string.cloning) else stringResource(R.string.check_repo),
                onClick = { checkRepo() },
                enabled = !checking && !nameRefused,
                block = true,
                modifier = Modifier.testTag("build-git-check"),
            )
            Spacer(Modifier.height(FS.space.s4))
        }
        when (val p = phase) {
            is BuildGitViewModel.GitPhase.Verdict -> VerdictCard(p, vm, nav, adaptError, recheckEnabled = !nameRefused) { checkRepo() }
            is BuildGitViewModel.GitPhase.Adapting -> AdaptingCard(p.progress, p.phase)
            is BuildGitViewModel.GitPhase.NotLive -> NotLiveCard(p.reason, nav, vm, recheckEnabled = !nameRefused) { checkRepo() }
            is BuildGitViewModel.GitPhase.Sealed -> SealedCard(p.message, nav, vm, recheckEnabled = !nameRefused) { checkRepo() }
            is BuildGitViewModel.GitPhase.Adapted -> AdaptedCard(p, vm, nav)
            is BuildGitViewModel.GitPhase.Deploying -> InfoCard(stringResource(R.string.installing), stringResource(R.string.building_and_deploying_to_your_server))
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
                    ) { Text(stringResource(R.string.open_build_sessions)) }
                } else {
                    TextButton(onClick = { vm.dismissConflict() }) { Text(stringResource(R.string.pick_another_name)) }
                }
            },
            dismissButton = {
                if (c.kind == "session") {
                    TextButton(onClick = { vm.dismissConflict() }) { Text(stringResource(R.string.pick_another_name)) }
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
private fun FieldLabel(text: String) {
    Text(text, color = FS.colors.text, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium))
    Spacer(Modifier.height(FS.space.s2))
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
    FSCard(padding = PaddingValues(FS.space.s5)) {
        if (p.fit) {
            VerdictHead(recheckEnabled, onCheckAgain) {
                StatusLine(stringResource(R.string.flagship_ready), FS.colors.success, large = true)
            }
            Spacer(Modifier.height(FS.space.s2))
            Text(fsString(R.string.file_s, p.reason, p.fileCount), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(FS.space.s4))
            FSPrimaryButton(stringResource(R.string.install_it), onClick = { vm.deploy() }, block = true)
        } else {
            val share by vm.share.collectAsState()
            VerdictHead(recheckEnabled, onCheckAgain) {
                Text(
                    BuildGitViewModel.notReadyText(p.reason),
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            adaptError?.let {
                Spacer(Modifier.height(FS.space.s3))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("build-git-adapt-error"))
                RelayFailureAction(it)
                // A restart cut the AI off: its files are kept, so the build
                // can go live as it is (the button below runs the AI again).
                if (BuildGitViewModel.interrupted(it)) {
                    Spacer(Modifier.height(FS.space.s3))
                    FSSecondaryButton(
                        BuildGitViewModel.DEPLOY,
                        onClick = { vm.deploy() },
                        block = true,
                        modifier = Modifier.testTag("build-git-deploy-anyway"),
                    )
                }
            }
            Spacer(Modifier.height(FS.space.s4))
            // The box's model rewrites the repo, so confirm an AI key first;
            // the git screen runs the adapt pass on return with it.
            FSPrimaryButton(
                BuildGitViewModel.ADAPT_BUTTON,
                onClick = { nav.navigate("build/git/key") },
                block = true,
                modifier = Modifier.testTag("build-git-adapt"),
            )
            Spacer(Modifier.height(FS.space.s4))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    BuildGitViewModel.SHARE_LABEL,
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = share,
                    onCheckedChange = { vm.setShare(it) },
                    modifier = Modifier.testTag("build-git-share"),
                )
            }
            Text(
                BuildGitViewModel.SHARE_NOTE,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Spacer(Modifier.height(FS.space.s2))
        JournalLink(nav, vm.buildId)
    }
}

/** A verdict's first line with the small "Check again" control trailing it,
 *  since the card hides the "Check repo" button. */
@Composable
private fun VerdictHead(recheckEnabled: Boolean, onCheckAgain: () -> Unit, content: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.weight(1f).padding(top = FS.space.s2)) { content() }
        IconButton(
            onClick = onCheckAgain,
            enabled = recheckEnabled,
            modifier = Modifier.testTag("build-git-recheck"),
        ) {
            Icon(Icons.Default.Refresh, contentDescription = BuildGitViewModel.CHECK_AGAIN, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The AI's tested app didn't go live: the box's reason, a new AI run (on a
 *  new build, since this one is closed to the AI), and "Check again". */
@Composable
private fun NotLiveCard(
    reason: String,
    nav: NavController,
    vm: BuildGitViewModel,
    recheckEnabled: Boolean,
    onCheckAgain: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        VerdictHead(recheckEnabled, onCheckAgain) {
            Text(
                BuildGitViewModel.NOT_LIVE_TITLE,
                color = FS.colors.text,
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
            )
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(
            reason,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("build-git-not-live-reason"),
        )
        RelayFailureAction(reason)
        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            BuildGitViewModel.RETRY_ADAPT,
            onClick = { nav.navigate("build/git/key") },
            block = true,
            modifier = Modifier.testTag("build-git-retry-adapt"),
        )
        Spacer(Modifier.height(FS.space.s2))
        JournalLink(nav, vm.buildId)
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
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(message, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            BuildGitViewModel.CHECK_AGAIN,
            onClick = onCheckAgain,
            enabled = recheckEnabled,
            block = true,
            modifier = Modifier.testTag("build-git-sealed-check-again"),
        )
        Spacer(Modifier.height(FS.space.s2))
        JournalLink(nav, vm.buildId)
    }
}

@Composable
private fun AdaptingCard(progress: String?, phase: String?) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(
            BuildGitViewModel.adaptingHeadline(phase),
            color = FS.colors.text,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            modifier = Modifier.testTag("build-git-adapting"),
        )
        if (!progress.isNullOrEmpty()) {
            Spacer(Modifier.height(FS.space.s1))
            Text(
                progress,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                modifier = Modifier.testTag("build-git-progress"),
            )
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(
            stringResource(R.string.this_can_take_several_minutes_you_2),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun AdaptedCard(p: BuildGitViewModel.GitPhase.Adapted, vm: BuildGitViewModel, nav: NavController) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        StatusLine(stringResource(R.string.adapted), FS.colors.success, large = true)
        Spacer(Modifier.height(FS.space.s2))
        Text(fsString(R.string.the_ai_rewrote_this_repo_into, p.fileCount), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(stringResource(R.string.install_it), onClick = { vm.deploy() }, block = true)
        Spacer(Modifier.height(FS.space.s2))
        AdapterExport(vm)
        Spacer(Modifier.height(FS.space.s2))
        JournalLink(nav, vm.buildId)
    }
}

@Composable
private fun DeployedCard(url: String, vm: BuildGitViewModel) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        StatusLine(stringResource(R.string.installed), FS.colors.success, large = true)
        Spacer(Modifier.height(FS.space.s2))
        Text(url, color = FS.colors.accentText, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
        Spacer(Modifier.height(FS.space.s4))
        AdapterExport(vm)
    }
}

/** For the repo's author: the file to commit so every Flagship server runs
 *  the repo this way. */
@Composable
private fun AdapterExport(vm: BuildGitViewModel) {
    val ctx = LocalContext.current
    val exporting by vm.exportingAdapter.collectAsState()
    val error by vm.exportError.collectAsState()
    FSSecondaryButton(
        if (exporting) stringResource(R.string.preparing) else stringResource(R.string.get_flagship_app_json),
        onClick = { vm.exportAdapter(File(ctx.cacheDir, "adapters")) },
        enabled = !exporting,
        block = true,
        modifier = Modifier.testTag("build-git-export"),
    )
    Spacer(Modifier.height(FS.space.s2))
    Text(
        stringResource(R.string.is_this_your_repo_commit_this),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
    )
    error?.let {
        Spacer(Modifier.height(FS.space.s2))
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
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
    val chooser = Intent.createChooser(send, FSStrings.get(R.string.share_flagship_app_json))
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

@Composable
private fun JournalLink(nav: NavController, buildId: String?) {
    if (buildId == null) return
    FSGhostButton(stringResource(R.string.view_build_journal), onClick = { nav.navigate("build/journal/$buildId") }, block = true)
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
        title = stringResource(R.string.connect_your_ide),
        subtitle = vm.editingName?.let { EditService.ideIntro(it) }
            ?: stringResource(R.string.build_from_your_own_ide_claude),
        onBack = { nav.popBackStack() },
    ) {
        val creating = phase is BuildMcpViewModel.McpPhase.Creating
        val conn = connection
        com.flagshipserver.app.ui.components.RunsOnRow(locked = creating || conn != null)
        Spacer(Modifier.height(FS.space.s4))
        if (conn == null) {
            FSPrimaryButton(
                label = if (creating) stringResource(R.string.creating) else stringResource(R.string.create_a_connection),
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
                Spacer(Modifier.height(FS.space.s4))
                ErrorCardSimple(it.message)
            }
        } else {
            ConnectionCard(
                conn = conn,
                onCopyConfig = { config ->
                    copyToClipboard(ctx, FSStrings.get(R.string.flagship_mcp_config), config)
                    toasts.success(FSStrings.get(R.string.config_copied))
                },
                onCopyCommand = { command ->
                    copyToClipboard(ctx, FSStrings.get(R.string.flagship_mcp_command), command)
                    toasts.success(FSStrings.get(R.string.command_copied))
                },
                onCopyKey = {
                    copyToClipboard(ctx, FSStrings.get(R.string.flagship_mcp_key), conn.key)
                    toasts.success(FSStrings.get(R.string.key_copied))
                },
                onRotate = { vm.rotate(); toasts.info(FSStrings.get(R.string.key_regenerated_update_your_ide)) },
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
    onCopyConfig: (String) -> Unit,
    onCopyCommand: (String) -> Unit,
    onCopyKey: () -> Unit,
    onRotate: () -> Unit,
    onJournal: () -> Unit,
    onDeploy: () -> Unit,
    onRefreshEnv: () -> Unit,
    envRequests: List<BuildEnvRequest>,
    deployStatus: String?,
) {
    val choices = conn.ideChoices()
    var selected by remember { mutableStateOf("claude-code") }
    val ide = choices.firstOrNull { it.id == selected } ?: choices.first()
    val config = ideConfigString(ide.config)
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(
            stringResource(R.string.add_this_to_your_ides_own),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("build-mcp-user-settings"),
        )
        Spacer(Modifier.height(FS.space.s3))
        KeyValueRow("URL", conn.url)
        Spacer(Modifier.height(FS.space.s2))
        KeyValueRow(stringResource(R.string.key), conn.key)
        Spacer(Modifier.height(FS.space.s3))
        if (choices.size > 1) {
            Spacer(Modifier.height(FS.space.s3))
            Row(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                modifier = Modifier.horizontalScroll(rememberScrollState()).testTag("build-mcp-ide-picker"),
            ) {
                choices.forEach { c ->
                    com.flagshipserver.app.ui.components.FSChip(
                        label = c.name,
                        selected = c.id == ide.id,
                        onClick = { selected = c.id },
                        modifier = Modifier.testTag("build-mcp-ide-${c.id}"),
                    )
                }
            }
        }
        ide.where?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(FS.space.s2))
            Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("build-mcp-ide-where"))
        }
        Spacer(Modifier.height(FS.space.s3))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSecondaryButton(stringResource(R.string.copy_key), onClick = onCopyKey)
            FSSecondaryButton(stringResource(R.string.copy_ide_config), onClick = { onCopyConfig(config) }, modifier = Modifier.testTag("build-mcp-copy-config"))
        }
        Spacer(Modifier.height(FS.space.s3))
        Box(Modifier.testTag("build-mcp-ide-config")) { CodeBlock(config) }
        ide.command?.let { command ->
            Spacer(Modifier.height(FS.space.s3))
            Text(stringResource(R.string.or_run), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(FS.space.s2))
            Box(Modifier.testTag("build-mcp-ide-command")) { CodeBlock(command) }
            Spacer(Modifier.height(FS.space.s2))
            FSSecondaryButton(stringResource(R.string.copy_command), onClick = { onCopyCommand(command) }, block = true, modifier = Modifier.testTag("build-mcp-copy-command"))
        }
        Spacer(Modifier.height(FS.space.s3))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSecondaryButton(stringResource(R.string.regenerate_key), onClick = onRotate)
            FSSecondaryButton(stringResource(R.string.view_journal), onClick = onJournal)
        }
        Spacer(Modifier.height(FS.space.s4))
        Text(
            stringResource(R.string.your_editors_agent_writes_files_validates),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPrimaryButton(stringResource(R.string.deploy_now), onClick = onDeploy, block = true)
        deployStatus?.let {
            Spacer(Modifier.height(FS.space.s2))
            Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
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
        Text(stringResource(R.string.your_ide_asked_for_these_secrets), color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text(
            stringResource(R.string.the_editor_and_its_ai_never),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(FS.space.s3))
        requests.forEach { q ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = FS.space.s1),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(q.name, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                if (q.currentlySet) {
                    StatusLine("set", FS.colors.success)
                } else {
                    Text(stringResource(R.string.needs_you), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
            }
            q.why?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
        }
        Spacer(Modifier.height(FS.space.s3))
        FSSecondaryButton(stringResource(R.string.refresh), onClick = onRefresh, block = true)
    }
}

@Composable
private fun KeyValueRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium))
        Text(value, color = FS.colors.text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
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
        Text(text, color = FS.colors.text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
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
        title = stringResource(R.string.build_sessions),
        subtitle = if (buildId != null) stringResource(R.string.how_this_service_was_built) else null,
        onBack = { nav.popBackStack() },
    ) {
        if (buildId != null) {
            DetailAdaptCard(buildId, vm, nav)
            when (val d = detail) {
                is LoadingState.Loaded -> TimelineCard(buildId, d.value)
                is LoadingState.Failed -> ErrorCardSimple(d.message, onRetry = { buildId?.let { vm.loadDetail(it) } })
                else -> InfoCard(stringResource(R.string.loading), stringResource(R.string.fetching_the_build_timeline))
            }
        } else {
            when (val l = list) {
                is LoadingState.Loaded -> {
                    val builds = l.value
                    val ended = BuildSessions.endedBuilds(builds, liveSessions)
                    val open = BuildSessions.openBuilds(builds, liveSessions)
                    val anyOpen = liveSessions.isNotEmpty() || open.isNotEmpty()
                    if (builds.isEmpty() && liveSessions.isEmpty()) {
                        InfoCard(stringResource(R.string.no_builds_yet), stringResource(R.string.builds_you_start_will_show_up))
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            if (anyOpen) {
                                SectionCaption(stringResource(R.string.open_on_your_server))
                                open.forEach { b ->
                                    val on = vm.serverOfBuild(b.buildId)
                                    BuildTile(b, startedOnly = true, server = on?.name?.takeIf { multiServer }) {
                                        nav.navigateOnPod("build/journal/${b.buildId}", on?.podId)
                                    }
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                        TextButton(
                                            onClick = { confirmDiscardBuild = b },
                                            modifier = Modifier.testTag("build-discard-${b.buildId}"),
                                        ) {
                                            Text(stringResource(R.string.discard), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                                        }
                                    }
                                }
                                liveSessions.forEach { session ->
                                    val on = vm.serverOfSession(session.sessionId)
                                    SessionTile(session, BuildSessions.name(session, builds), server = on?.name?.takeIf { multiServer }) {
                                        nav.openVibeSession(vibeSessionChatRoute(session.sessionId), on?.podId)
                                    }
                                    if (session.canDiscard) {
                                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                            TextButton(
                                                onClick = { confirmDiscard = session },
                                                modifier = Modifier.testTag("build-session-discard-${session.sessionId}"),
                                            ) {
                                                Text(stringResource(R.string.discard), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                                            }
                                        }
                                    }
                                }
                                discardError?.let { ErrorCardSimple(it) }
                            }
                            if (ended.isNotEmpty()) {
                                if (anyOpen) Spacer(Modifier.height(FS.space.s2))
                                SectionCaption(stringResource(R.string.past_builds))
                                ended.forEach { b ->
                                    val on = vm.serverOfBuild(b.buildId)
                                    BuildTile(b, server = on?.name?.takeIf { multiServer }) {
                                        nav.navigateOnPod("build/journal/${b.buildId}", on?.podId)
                                    }
                                }
                            }
                            if (failedServers.isNotEmpty()) {
                                Text(
                                    BuildSessions.unreadServersLine(failedServers),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.testTag("build-sessions-unread-servers"),
                                )
                            }
                        }
                    }
                }
                is LoadingState.Failed -> ErrorCardSimple(l.message, onRetry = { vm.loadList() })
                else -> InfoCard(stringResource(R.string.loading), stringResource(R.string.fetching_your_builds))
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
                }) { Text(stringResource(R.string.discard_build), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = null }) { Text(stringResource(R.string.cancel)) } },
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
                }) { Text(stringResource(R.string.discard_build), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscardBuild = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun SectionCaption(text: String) {
    FSSectionHeader(text)
}

@Composable
private fun SessionTile(session: VibeCodeSessionMeta, title: String, server: String? = null, onClick: () -> Unit) {
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
            Text(title, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
            Spacer(Modifier.height(FS.space.s1))
            Text(
                listOfNotNull(fsString(R.string.started, fmtTimestamp(session.startedAt)), server?.let { "on $it" }).joinToString(" "),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(FS.space.s2))
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPill(BuildSessions.label(session.status), sessionPill(session.status))
                FSPill(BuildSummary.methodLabel("scratch"), FSPillKind.Idle)
            }
        }
        val action = BuildSessions.action(session.status)
        Text(
            action,
            color = if (action == "Open") FS.colors.accentText else FS.colors.success,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
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
private fun BuildTile(b: BuildSummary, startedOnly: Boolean = false, server: String? = null, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s5),
    ) {
        Text(
            b.displayName,
            color = FS.colors.text,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s1))
        Text(
            (if (startedOnly) fsString(R.string.started, fmtTimestamp(b.startedAt)) else BuildSessions.pastBuildSubtitle(b, fmtTimestamp(b.startedAt))) +
                (server?.let { " on $it" } ?: ""),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPill(b.methodLabel, FSPillKind.Idle)
    }
}

@Composable
private fun TimelineCard(buildId: String, entries: List<BuildJournalEntry>) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(fsString(R.string.build, buildId), color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s3))
        if (entries.isEmpty()) {
            Text(stringResource(R.string.no_steps_recorded_yet), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        } else {
            entries.forEach { e ->
                Column(Modifier.fillMaxWidth().padding(vertical = FS.space.s2)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                        Badge(e.kind)
                        Badge(e.actor)
                    }
                    Spacer(Modifier.height(FS.space.s1))
                    Text(e.summary, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
                    e.detail?.let {
                        Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    }
                    Text(fmtTimestamp(e.ts), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
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
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium))
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
        Text(title, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s1))
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ErrorCardSimple(message: String, onRetry: (() -> Unit)? = null) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Text(stringResource(R.string.something_went_wrong), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s1))
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        if (onRetry != null) {
            Spacer(Modifier.height(FS.space.s3))
            FSSecondaryButton(label = stringResource(R.string.try_again), onClick = onRetry, block = true)
        }
    }
}
