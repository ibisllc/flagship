package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.api.VibeCodeNameCheck
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.FreeAiCopy
import com.flagshipserver.app.core.FreeAiSessions
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.shell.tabs.openBuildSessions
import com.flagshipserver.app.ui.shell.tabs.openVibeSession
import com.flagshipserver.app.ui.shell.tabs.vibeSessionChatRoute
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import com.flagshipserver.app.viewmodels.VibeCodeStreamViewModel
import kotlinx.coroutines.launch

/**
 * D.6.1 — VibeCodeProviderPickView.
 *
 * Two cards: Flagship Inference and bring-your-own-key. Both go through the
 * AI-key step, which lists Flagship Inference first.
 */
@Composable
fun VibeCodeProviderPickScreen(nav: NavController) {
    FSScreen(
        title = "How would you like to build it?",
        onBack = { nav.popBackStack() },
        subtitle = "Pick the AI that writes the code. You can change this any time.",
    ) {
        // Flagship Inference card
        FSCard(padding = PaddingValues(FS.space.s5)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Icon(Icons.Outlined.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Text(
                        text = FreeAiCopy.TITLE,
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.titleLarge,
                    )
                }
                Text(
                    text = FreeAiCopy.NOTE,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSPrimaryButton(
                    label = FreeAiCopy.USE_BUTTON,
                    onClick = { nav.navigate("vibe/key") },
                    block = true,
                )
            }
        }
        // BYOK card
        FSCard(padding = PaddingValues(FS.space.s5)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Icon(Icons.Outlined.Key, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Text(
                        text = "Bring your own key",
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.titleLarge,
                    )
                }
                Text(
                    text = "Anthropic, OpenAI, or Google. No daily limits. Your key, your bill, your choice of model.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSSecondaryButton(
                    label = "Set up a key",
                    onClick = { nav.navigate("vibe/key") },
                    block = true,
                )
            }
        }
    }
}

/** Pure parts of the describe form. Mirror of iOS VibeCodeDescribeScreen. */
object VibeCodeDescribe {
    /** Who can reach the built service. Values are the wire contract carried
     *  on [VibeCodeStartRequest.visibility]. */
    const val INVITE_ONLY = "just-me"
    const val ANYONE_WITH_LINK = "link"

    val visibilities = listOf(INVITE_ONLY to "Invite only", ANYONE_WITH_LINK to "Anyone with the link")

    fun explanation(visibility: String): String =
        if (visibility == ANYONE_WITH_LINK) {
            "Anyone with the address can open it. Where it needs to know who someone is, they sign in with Flagship."
        } else {
            "Only you and the people you invite on Flagship can open it."
        }

    val examples = listOf(
        "Habit tracker" to "A habit tracker: I tick off my daily habits and see my streaks for the last month.",
        "Family wishlist" to "A family wishlist: everyone keeps a list, and the others can quietly mark what they'll buy.",
        "Recipe jar" to "A recipe jar: save recipes with a photo, ingredients and steps, and search them by ingredient.",
        "Sleep journal" to "A sleep journal: log when I went to bed, when I woke up and how I slept, with a weekly chart.",
    )

    const val CONFLICT_TITLE = "That name is taken"

    /** The address label the box will serve at. Lowercased; only the safe slug
     *  characters survive (the daemon is the authority, this is the preview +
     *  what we send). */
    fun slug(name: String): String = name.lowercase().filter { it.isLetterOrDigit() || it == '-' }

    fun conflictMessage(check: VibeCodeNameCheck, name: String): String {
        val n = check.name ?: name
        return when (check.kind) {
            "session" -> "A build session already uses \"$n\". To use the name for a new build, open Build sessions and discard that one first."
            "app" -> "You already have a service called \"$n\". Pick another name."
            else -> check.message ?: "Pick another name."
        }
    }

    /** The red line under the name field, or null when there's nothing wrong. */
    fun warning(check: VibeCodeNameCheck?, name: String): String? = when {
        check == null || check.ok -> null
        check.kind == "invalid" -> check.message ?: "That can't be a web address."
        else -> conflictMessage(check, name)
    }

    fun canBuild(slug: String, prompt: String, check: VibeCodeNameCheck?, starting: Boolean): Boolean =
        slug.isNotEmpty() && prompt.isNotBlank() && check?.kind != "invalid" && !starting

    /** Statuses the generating screen hands to the chat: the AI needs the
     *  owner, the build is shippable, or it failed (the chat continues it). */
    fun handsOffToChat(status: String): Boolean =
        status in listOf("awaiting-tool-response", "ready-to-deploy", "deploying", "deployed", "failed")

    /** `model`/`effort` for the first message: the menu's choice once the menu
     *  has loaded (Settings' default only if the menu still offers it), else
     *  nothing, so the box picks; never an unchecked saved model. */
    fun startModel(
        menu: com.flagshipserver.app.core.ModelMenu?,
        choice: com.flagshipserver.app.core.ModelChoice?,
    ): Pair<String?, String?> =
        if (menu == null) null to null else com.flagshipserver.app.core.ModelMenus.startWire(choice)
}

/**
 * D.6.3 — VibeCodeDescribeView. The "new service" form: name it first (its
 * web address, checked with the box as you type, so a clash shows before any
 * description is written), describe it, and choose who can open it. The AI
 * was already chosen on the provider-pick step upstream.
 */
@Composable
fun VibeCodeDescribeScreen(nav: NavController) {
    var prompt by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var visibility by remember { mutableStateOf(VibeCodeDescribe.INVITE_ONLY) }
    val slug = VibeCodeDescribe.slug(name)
    // The latest answer from the box, and the slug it answered for: a check
    // only counts while the field still holds that slug.
    var check by remember { mutableStateOf<VibeCodeNameCheck?>(null) }
    var checkedSlug by remember { mutableStateOf("") }
    val currentCheck = check.takeIf { checkedSlug == slug }
    var conflict by remember { mutableStateOf<VibeCodeNameCheck?>(null) }

    val screens = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val appState = LocalAppState.current
    val username = appState.currentUser.value ?: "you"
    // The chosen server (docs/app-placement.md §2): the address preview and
    // the name check are that box's.
    val podScope = com.flagshipserver.app.core.LocalPodScope.current
    val server = podScope?.pod?.fqdn
        ?: (appState.sessionPod ?: appState.leaderPod)?.fqdn ?: "$username.flagship.services"
    val scope = rememberCoroutineScope()
    var starting by remember { mutableStateOf(false) }
    val describeScroll = rememberScrollState()
    val context = androidx.compose.ui.platform.LocalContext.current

    // The AI model for the first message: the key's default from Settings,
    // checked against what its menu offers (iOS VibeCodeDescribeContainer).
    // No key handed over: no menu, the box picks.
    val pendingCredential = remember { PendingBuildCredential.peek() }
    var menu by remember { mutableStateOf<com.flagshipserver.app.core.ModelMenu?>(null) }
    var choice by remember { mutableStateOf<com.flagshipserver.app.core.ModelChoice?>(null) }
    LaunchedEffect(pendingCredential, screens) {
        if (pendingCredential == null) return@LaunchedEffect
        val m = com.flagshipserver.app.core.ModelCatalogs.menuFor(pendingCredential, screens)
        menu = m
        choice = com.flagshipserver.app.core.ModelMenus.initial(
            m, runCatching { com.flagshipserver.app.core.AiKeyStore.defaultModelFor(pendingCredential) }.getOrNull(),
        )
    }
    // Files and images on the opening message.
    var staged by remember { mutableStateOf<List<com.flagshipserver.app.api.VibeCodeAttachment>>(emptyList()) }
    var attachError by remember { mutableStateOf<String?>(null) }
    var vision by remember { mutableStateOf<com.flagshipserver.app.core.VisionCheck?>(null) }
    fun stage(uri: android.net.Uri?) {
        if (uri == null) return
        scope.launch(kotlinx.coroutines.Dispatchers.Main) {
            val (a, problem) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { readAttachment(context, uri, staged.size) }
            attachError = problem
            if (a != null) staged = staged + a
        }
    }
    val photoPicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia(),
    ) { stage(it) }
    val filePicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { stage(it) }

    suspend fun runCheck(s: String): VibeCodeNameCheck {
        val result = runCatching { screens.vibeCodeNameCheck(s) }.getOrDefault(VibeCodeNameCheck.Unknown)
        if (s == VibeCodeDescribe.slug(name)) {
            check = result
            checkedSlug = s
        }
        return result
    }

    LaunchedEffect(slug, screens) {
        if (slug.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.delay(350)
        runCheck(slug)
    }

    FSScreen(
        title = "New service",
        onBack = { nav.popBackStack() },
        // Scrollable: the form pushes "Build it" below the fold on shorter
        // screens (and under the keyboard); a scroll keeps it reachable.
        scrollState = describeScroll,
        spacing = FS.space.s5,
    ) {
        com.flagshipserver.app.ui.components.RunsOnRow(locked = starting)

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSField(
                value = name,
                onValueChange = { name = it },
                label = "Name",
                placeholder = "plant-tracker",
                fieldTag = "vibe-describe-name",
            )
            val primary = MaterialTheme.colorScheme.primary
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            Text(
                text = buildAnnotatedString {
                    withStyle(SpanStyle(color = muted)) { append("https://") }
                    withStyle(SpanStyle(color = primary, fontWeight = FontWeight.SemiBold)) {
                        append(slug.ifEmpty { "<name>" })
                    }
                    withStyle(SpanStyle(color = muted)) { append(".$server") }
                },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                modifier = Modifier.padding(horizontal = FS.space.s1).testTag("vibe-describe-address"),
            )
            val warning = VibeCodeDescribe.warning(currentCheck, slug)
            if (warning != null) {
                NameStatusLine(warning, ok = false, textModifier = Modifier.testTag("vibe-describe-name-taken"))
            } else if (currentCheck != null && currentCheck.ok && currentCheck.name != null) {
                NameStatusLine("Available", ok = true)
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                label = { Text("What should it do?") },
                minLines = 6,
                maxLines = 12,
                textStyle = MaterialTheme.typography.bodyLarge,
                shape = MaterialTheme.shapes.small,
                supportingText = {
                    Text(
                        "${prompt.length}",
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.End,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    )
                },
                modifier = Modifier.fillMaxWidth().testTag("vibe-describe-prompt"),
            )
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                for ((label, text) in VibeCodeDescribe.examples) {
                    ExampleChip(label) { prompt = text }
                }
            }
            ChatComposerAttachments(
                staged = staged,
                error = attachError,
                onPhoto = {
                    photoPicker.launch(
                        androidx.activity.result.PickVisualMediaRequest(
                            androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly,
                        ),
                    )
                },
                onFile = { filePicker.launch(com.flagshipserver.app.core.ChatAttachments.DOCUMENT_MIME_TYPES) },
                onRemove = { i -> staged = staged.filterIndexed { j, _ -> j != i } },
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader("Who can open it")
            VisibilityPicker(visibility) { visibility = it }
            Text(
                text = VibeCodeDescribe.explanation(visibility),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s1),
            )
        }

        menu?.let { m ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                modifier = Modifier.testTag("vibe-describe-model"),
            ) {
                Text(
                    text = "AI model",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelLarge,
                )
                ChatModelBar(m, choice) { choice = it }
            }
        }

        fun build() {
            if (starting) return
            starting = true
            val s = slug
            // Launch on Main so the post-call nav.navigate runs on the main
            // thread. The network I/O hops to IO inside the client; only the
            // UI work needs Main. (rememberCoroutineScope is Main in prod,
            // but the Compose-UI-Test continuation interceptor can resume a
            // bare launch off-main → 'addObserver/setCurrentState must be
            // called on the main thread'. Pinning Main is correct + robust.)
            scope.launch(kotlinx.coroutines.Dispatchers.Main) {
                try {
                    val latest = check.takeIf { checkedSlug == s } ?: runCheck(s)
                    if (!latest.ok) {
                        if (latest.kind != "invalid") conflict = latest
                        return@launch
                    }
                    val pending = PendingBuildCredential.peek()
                    val cred = pending?.let(LlmProviderCredential::from)
                    val startModel = VibeCodeDescribe.startModel(menu, choice)
                    // Keep the server it starts on for the steps after this one.
                    podScope?.let { it.choose?.invoke(it.pod.podId) }
                    val resp = screens.vibeCodeStart(
                        VibeCodeStartRequest(
                            prompt = prompt, credential = cred,
                            // The menu's choice (the key's default, checked); none ⇒ the box's.
                            model = startModel.first, effort = startModel.second,
                            attachments = staged.takeIf { it.isNotEmpty() },
                            name = s, visibility = visibility,
                        ),
                    )
                    if (resp.needsCredential) {
                        // Box wants a key — route into the AI-key step.
                        nav.navigate("vibe/key")
                    } else {
                        PendingBuildCredential.take()
                        staged = emptyList()
                        com.flagshipserver.app.core.BuildSessionAi.remember(resp.sessionId, pending)
                        if (pending?.isFreeAi == true) FreeAiSessions.remember(resp.sessionId, server)
                        nav.openVibeSession("vibe/generating/${resp.sessionId}")
                    }
                } catch (t: Throwable) {
                    val taken = VibeCodeNameCheck.conflict(t)
                    if (taken != null) {
                        check = taken
                        checkedSlug = s
                        conflict = taken
                        return@launch
                    }
                    // Don't swallow — a tap that does nothing with no
                    // feedback is a dead control. Surface the failure (e.g.
                    // the box paired session isn't ready) so the owner knows
                    // the build didn't start. Mirror of iOS's un-swallowed
                    // vibeCodeStart error. The owner can retry the tap.
                    android.util.Log.e("VibeCodeStart", "failed: ${t::class.java.name}: ${t.message}", t)
                    toasts.error("Couldn't start the build: ${t.boxError() ?: NetworkErrorHumanizer.humanize(t)}")
                } finally {
                    starting = false
                }
            }
        }

        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            FSPrimaryButton(
                label = if (starting) "Starting…" else "Build it",
                modifier = Modifier.testTag("vibe-describe-build"),
                onClick = {
                    if (starting) return@FSPrimaryButton
                    val seeing = com.flagshipserver.app.core.ModelMenus.visionCheck(
                        menu ?: com.flagshipserver.app.core.ModelMenu.Unknown, choice,
                        com.flagshipserver.app.core.ChatAttachments.hasImage(staged),
                    )
                    if (seeing is com.flagshipserver.app.core.VisionCheck.Send) build() else vision = seeing
                },
                enabled = VibeCodeDescribe.canBuild(slug, prompt, currentCheck, starting),
                block = true,
                large = true,
            )
            Text(
                text = "About 90 seconds",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        vision?.let { check ->
            VisionDialog(
                check = check,
                onSwitch = { to ->
                    vision = null
                    choice = to
                    build()
                },
                onDismiss = { vision = null },
            )
        }
    }

    conflict?.let { c ->
        AlertDialog(
            onDismissRequest = { conflict = null },
            title = { Text(VibeCodeDescribe.CONFLICT_TITLE) },
            text = { Text(VibeCodeDescribe.conflictMessage(c, slug)) },
            confirmButton = {
                if (c.kind == "session") {
                    TextButton(
                        onClick = {
                            conflict = null
                            nav.openBuildSessions()
                        },
                        modifier = Modifier.testTag("vibe-describe-open-sessions"),
                    ) { Text("Open build sessions") }
                } else {
                    TextButton(onClick = { conflict = null }) { Text("Pick another name") }
                }
            },
            dismissButton = {
                if (c.kind == "session") {
                    TextButton(onClick = { conflict = null }) { Text("Pick another name") }
                }
            },
        )
    }
}

@Composable
private fun ExampleChip(text: String, onPick: () -> Unit) {
    SuggestionChip(
        onClick = onPick,
        label = { Text(text) },
        shape = MaterialTheme.shapes.small,
    )
}

/** Invite only | Anyone with the link, as a Material segmented button. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VisibilityPicker(visibility: String, onPick: (String) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        val options = VibeCodeDescribe.visibilities
        options.forEachIndexed { i, (value, label) ->
            SegmentedButton(
                selected = visibility == value,
                onClick = { onPick(value) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = options.size),
                modifier = Modifier.testTag("vibe-describe-visibility-$value"),
            ) {
                Text(label, maxLines = 1)
            }
        }
    }
}

/** The line under the name: available (green check) or why not (red). */
@Composable
private fun NameStatusLine(text: String, ok: Boolean, textModifier: Modifier = Modifier) {
    val color = if (ok) FS.colors.success else MaterialTheme.colorScheme.error
    Row(
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = Modifier.padding(horizontal = FS.space.s1),
    ) {
        Icon(
            if (ok) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(18.dp),
        )
        Text(text, color = color, style = MaterialTheme.typography.bodyMedium, modifier = textModifier)
    }
}

/**
 * D.6.4 — VibeCodeGeneratingScreen.
 *
 * Live stream from /api/screens/vibe-code/<id>/stream (WebSocket). Owns a
 * [VibeCodeStreamViewModel] that accumulates the streamed transcript +
 * build logs and surfaces the final deploy URL — the same frame stream the
 * iOS VibeCodeGeneratingScreen consumes. While the build runs it shows up
 * in the global operations sliver via the VM's ActiveOperationsCenter
 * bridge. "Interrupt" opens the chat surface, where a follow-up reply to
 * the live session is sent.
 *
 * MIRRORS: apps/mobile/ios/.../VibeCodeScreens.swift VibeCodeGeneratingScreen
 * (+ its VibeCodeGeneratingContainer wiring).
 */
@Composable
fun VibeCodeGeneratingScreen(nav: NavController, sessionId: String = "") {
    val client = LocalScreensClient.current
    val operations = LocalActiveOperationsCenter.current
    val appState = LocalAppState.current
    // The build runs on the currently-selected box; its name fills the
    // sliver's "building … on <server>" clause (mirror iOS's currentPod).
    val podScope = com.flagshipserver.app.core.LocalPodScope.current
    val serverLabel = remember(appState, podScope?.pod?.podId) {
        podScope?.pod?.name ?: (appState.currentPod ?: appState.leaderPod)?.name
    }

    val vm = remember(sessionId) {
        VibeCodeStreamViewModel(
            sessionId = sessionId,
            client = client,
            operations = operations,
            serverLabel = serverLabel,
            serverFqdn = podScope?.pod?.fqdn ?: appState.sessionPod?.fqdn,
        )
    }
    val status by vm.status.collectAsState()
    val transcript by vm.transcript.collectAsState()
    val buildLogs by vm.buildLogs.collectAsState()
    val deployedUrl by vm.deployedUrl.collectAsState()
    val deployedServiceId by vm.deployedServiceId.collectAsState()
    val errorMessage by vm.errorMessage.collectAsState()

    // Start the stream on first composition; tear it down (and drop the
    // sliver op) when we leave the screen.
    DisposableEffect(sessionId) {
        vm.start()
        onDispose { vm.cancel() }
    }

    // The WS stream is display-only and carries NO talkToUser frame and NO
    // deploy trigger. So we poll the session status here and hand off to the
    // chat surface the moment the AI needs the owner (`awaiting-tool-response`),
    // the build is finished and shippable (`ready-to-deploy`/`deploying`/
    // `deployed`), or it failed (the chat's composer continues it). The chat screen is where the owner replies to the AI AND
    // taps Deploy — making it the single interaction+deploy surface for a
    // scratch build. Mirror of iOS VibeCodeGeneratingContainer.startStatusRouter.
    LaunchedEffect(sessionId) {
        if (sessionId.isEmpty()) return@LaunchedEffect
        var routed = false
        while (!routed) {
            try {
                val st = client.vibeCodeStatus(sessionId)
                if (VibeCodeDescribe.handsOffToChat(st.status)) {
                    routed = true
                    // nav.navigate must run on Main (the live call's
                    // withContext(IO) + the test's continuation interceptor can
                    // leave us off-main). The chat replaces this screen, so
                    // Back from it can't bounce through here again.
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        nav.openVibeSession(vibeSessionChatRoute(sessionId))
                    }
                    break
                }
            } catch (_: Throwable) {
                // transient — keep polling
            }
            kotlinx.coroutines.delay(1500)
        }
    }

    val headline = when (status) {
        VibeCodeStreamViewModel.Status.STREAMING -> "Generating…"
        VibeCodeStreamViewModel.Status.BUILDING -> "Building…"
        VibeCodeStreamViewModel.Status.DEPLOYED -> "Live."
        VibeCodeStreamViewModel.Status.DONE -> "Done."
        VibeCodeStreamViewModel.Status.FAILED -> "Stopped."
    }

    FSScreen(
        title = headline,
        onBack = { nav.popBackStack() },
        scrollable = false,
    ) {
        Text(
            text = "Session $sessionId",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.padding(horizontal = FS.space.s1),
        )

        Surface(
            modifier = Modifier.fillMaxWidth().weight(1f),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
                contentPadding = PaddingValues(FS.space.s4),
            ) {
                item {
                    Text(
                        text = "Assistant",
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Text(
                        text = transcript.ifEmpty { "…" },
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
                if (buildLogs.isNotEmpty()) {
                    item {
                        Spacer(Modifier.height(FS.space.s2))
                        Text(
                            text = "Build logs",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    items(buildLogs) { line ->
                        Text(
                            text = line,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        )
                    }
                }
                val url = deployedUrl
                val sid = deployedServiceId
                if (url != null && sid != null) {
                    item {
                        Spacer(Modifier.height(FS.space.s2))
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(20.dp))
                            Text(
                                text = "Deployed",
                                color = FS.colors.success,
                                style = MaterialTheme.typography.titleSmall,
                            )
                        }
                        Text(
                            text = url,
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        )
                    }
                }
                errorMessage?.let { msg ->
                    item {
                        Spacer(Modifier.height(FS.space.s2))
                        ErrorCard(message = msg)
                        RelayFailureAction(msg)
                    }
                }
            }
        }

        // Interrupt routes to the chat surface — the live reply path for the
        // running session (talkToUser / follow-up turns POST to /reply there).
        FSSecondaryButton(
            "Interrupt with a follow-up",
            onClick = { nav.navigate("vibe-code-chat/$sessionId") },
            block = true,
            modifier = Modifier.padding(bottom = FS.space.s4),
        )
    }
}
