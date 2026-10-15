package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.api.VibeCodeNameCheck
import com.flagshipserver.app.api.VibeCodeStartRequest
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
import com.flagshipserver.app.ui.components.FSSecondaryButton
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
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = "How would you like to build it?",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))
        Text(
            text = "Pick the AI that writes the code. You can change this any time.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        Spacer(Modifier.height(FS.space.s8))

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            // Flagship Inference card
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Text(
                    text = FreeAiCopy.TITLE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    text = FreeAiCopy.NOTE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
                FSPrimaryButton(
                    label = FreeAiCopy.USE_BUTTON,
                    onClick = { nav.navigate("vibe/key") },
                    block = true,
                )
            }
            // BYOK card
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Text(
                    text = "Bring your own key",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    text = "Anthropic, OpenAI, or Google. No daily limits. Your key, your bill, your choice of model.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
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

    Column(
        // Scrollable: the form pushes "Build it" below the fold on shorter
        // screens (and under the keyboard); a scroll keeps it reachable.
        modifier = Modifier.fillMaxSize().verticalScroll(describeScroll).padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        // No app bar on Android: the title sits where the other build screens
        // put theirs (iOS shows it in the navigation bar).
        Text(
            text = "New Service",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s6))

        com.flagshipserver.app.ui.components.RunsOnRow(locked = starting)
        Spacer(Modifier.height(FS.space.s4))

        FSField(
            value = name,
            onValueChange = { name = it },
            label = "Name",
            placeholder = "plant-tracker",
            fieldTag = "vibe-describe-name",
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = FS.colors.textMuted)) { append("https://") }
                withStyle(SpanStyle(color = FS.colors.primary, fontWeight = FontWeight.SemiBold)) {
                    append(slug.ifEmpty { "<name>" })
                }
                withStyle(SpanStyle(color = FS.colors.textMuted)) { append(".$server") }
            },
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            maxLines = 2,
            modifier = Modifier.testTag("vibe-describe-address"),
        )
        val warning = VibeCodeDescribe.warning(currentCheck, slug)
        if (warning != null) {
            Spacer(Modifier.height(FS.space.s2))
            Text(
                text = "⚠ $warning",
                color = FS.colors.danger,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                modifier = Modifier.testTag("vibe-describe-name-taken"),
            )
        } else if (currentCheck != null && currentCheck.ok && currentCheck.name != null) {
            Spacer(Modifier.height(FS.space.s2))
            Text(
                text = "✓ Available",
                color = FS.colors.success,
                style = TextStyle(fontSize = 14.sp),
            )
        }

        Spacer(Modifier.height(FS.space.s6))

        Text(
            text = "What should it do?",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(FS.radius.sm))
                .background(FS.colors.surfaceSunken)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.sm))
                .padding(14.dp),
        ) {
            BasicTextField(
                value = prompt,
                onValueChange = { prompt = it },
                cursorBrush = SolidColor(FS.colors.primary),
                textStyle = TextStyle(color = FS.colors.text, fontSize = 16.sp, lineHeight = 22.sp),
                modifier = Modifier.fillMaxSize().testTag("vibe-describe-prompt"),
            )
            Box(
                contentAlignment = Alignment.BottomEnd,
                modifier = Modifier.fillMaxSize(),
            ) {
                Text(
                    text = "${prompt.length}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
            }
        }
        Spacer(Modifier.height(FS.space.s2))
        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        ) {
            for ((label, text) in VibeCodeDescribe.examples) {
                ExampleChip(label) { prompt = text }
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        Text(
            text = "Who can open it",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            for ((value, label) in VibeCodeDescribe.visibilities) {
                val selected = visibility == value
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(FS.radius.sm))
                        .background(if (selected) FS.colors.primary else FS.colors.surfaceSunken)
                        .border(1.dp, if (selected) FS.colors.primary else FS.colors.border, RoundedCornerShape(FS.radius.sm))
                        .clickable { visibility = value }
                        .padding(vertical = 10.dp)
                        .testTag("vibe-describe-visibility-$value"),
                ) {
                    Text(
                        text = label,
                        color = if (selected) FS.colors.onAccent else FS.colors.text,
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                    )
                }
            }
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = VibeCodeDescribe.explanation(visibility),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = if (starting) "Starting…" else "Build it",
            modifier = Modifier.testTag("vibe-describe-build"),
            onClick = {
                if (starting) return@FSPrimaryButton
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
                        val startModel = com.flagshipserver.app.core.ModelMenus.startWire(
                            runCatching { com.flagshipserver.app.core.AiKeyStore.defaultModelFor(pending) }.getOrNull(),
                        )
                        // Keep the server it starts on for the steps after this one.
                        podScope?.let { it.choose?.invoke(it.pod.podId) }
                        val resp = screens.vibeCodeStart(
                            VibeCodeStartRequest(
                                prompt = prompt, credential = cred,
                                // The default model chosen in Settings for this key; none ⇒ the box's.
                                model = startModel.first, effort = startModel.second,
                                name = s, visibility = visibility,
                            ),
                        )
                        if (resp.needsCredential) {
                            // Box wants a key — route into the AI-key step.
                            nav.navigate("vibe/key")
                        } else {
                            PendingBuildCredential.take()
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
                        toasts.error("Couldn't start the build: ${NetworkErrorHumanizer.humanize(t)}")
                    } finally {
                        starting = false
                    }
                }
            },
            enabled = VibeCodeDescribe.canBuild(slug, prompt, currentCheck, starting),
            block = true,
            large = true,
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = "about 90 seconds",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
            modifier = Modifier.fillMaxWidth().padding(top = FS.space.s1),
        )
        Spacer(Modifier.height(FS.space.s8))
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
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(FS.colors.surfaceSunken)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.pill))
            .clickable(onClick = onPick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
    }
}

@Composable
private fun LabelRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = FS.space.s2),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium))
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
    // chat surface the moment the AI needs the owner (`awaiting-tool-response`)
    // or the build is finished and shippable (`ready-to-deploy`/`deploying`/
    // `deployed`). The chat screen is where the owner replies to the AI AND
    // taps Deploy — making it the single interaction+deploy surface for a
    // scratch build. Mirror of iOS VibeCodeGeneratingContainer.startStatusRouter.
    LaunchedEffect(sessionId) {
        if (sessionId.isEmpty()) return@LaunchedEffect
        var routed = false
        while (!routed) {
            try {
                val st = client.vibeCodeStatus(sessionId)
                if (st.status in listOf("awaiting-tool-response", "ready-to-deploy", "deploying", "deployed")) {
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

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6)) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = headline,
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = "Session $sessionId",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
        )

        Spacer(Modifier.height(FS.space.s6))

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.7f)
                .clip(RoundedCornerShape(FS.radius.md))
                .background(FS.colors.surface)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.md))
                .padding(FS.space.s4),
        ) {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                item {
                    Text(
                        text = "ASSISTANT",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        text = transcript.ifEmpty { "…" },
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
                    )
                }
                if (buildLogs.isNotEmpty()) {
                    item {
                        Spacer(Modifier.height(FS.space.s2))
                        Text(
                            text = "BUILD LOGS",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                        )
                    }
                    items(buildLogs) { line ->
                        Text(
                            text = line,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace),
                        )
                    }
                }
                val url = deployedUrl
                val sid = deployedServiceId
                if (url != null && sid != null) {
                    item {
                        Spacer(Modifier.height(FS.space.s2))
                        Text(
                            text = "Deployed ✓",
                            color = FS.colors.success,
                            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        )
                        Text(
                            text = url,
                            color = FS.colors.primary,
                            style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
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

        Spacer(Modifier.height(FS.space.s4))

        // Interrupt routes to the chat surface — the live reply path for the
        // running session (talkToUser / follow-up turns POST to /reply there).
        FSSecondaryButton(
            "Interrupt with a follow-up",
            onClick = { nav.navigate("vibe-code-chat/$sessionId") },
            block = true,
        )
    }
}
