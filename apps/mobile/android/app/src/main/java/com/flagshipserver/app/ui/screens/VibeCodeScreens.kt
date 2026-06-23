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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.BuildCredential
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.core.LocalActiveOperationsCenter
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import com.flagshipserver.app.viewmodels.VibeCodeStreamViewModel
import kotlinx.coroutines.launch

/**
 * D.6.1 — VibeCodeProviderPickView.
 *
 * Two cards: free-tier promo (with daily/lifetime usage display) and
 * BYOK. Picking one navigates to the describe screen; BYOK first
 * routes through APIKeyView to set up the key.
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
            // Free-tier card
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.fillMaxWidth(0.7f)) {
                        Text(
                            text = "Use Flagship's credits",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                        )
                        Spacer(Modifier.height(FS.space.s2))
                        Text(
                            text = "50 free calls a day · 200 lifetime · we cover the API bill.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                        )
                    }
                    Spacer(Modifier.fillMaxWidth(0.0f))
                    PromoUsageBadge(used = 12, cap = 50)
                }
                Spacer(Modifier.height(FS.space.s4))
                Text(
                    text = "Honest note: your prompts go directly to Anthropic, not through us.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
                FSPrimaryButton(
                    label = "Use the promo →",
                    onClick = { nav.navigate("vibe/describe") },
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

@Composable
private fun PromoUsageBadge(used: Int, cap: Int) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(FS.colors.primary.copy(alpha = 0.12f))
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Text(
            text = "$used / $cap today",
            color = FS.colors.primary,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
    }
}

/**
 * D.6.3 — VibeCodeDescribeView.
 *
 * Free-text textarea (the textarea IS the hero), a few example
 * chips, structured fields below (name, visibility, AI provider).
 * Permissions preview surfaces below the fold.
 */
@Composable
fun VibeCodeDescribeScreen(nav: NavController) {
    var prompt by remember {
        mutableStateOf(
            "A little site to track which of my houseplants I've watered, with a photo per plant. Send me a push when one's been thirsty 5+ days.",
        )
    }
    // YOU decide the name + who can see it (no longer fixed). The AI was chosen
    // on the previous step — not asked again here.
    var name by remember { mutableStateOf("") }
    var visibility by remember { mutableStateOf("just-me") }
    // The web-address label: lowercased, only the safe slug characters survive.
    val slug = name.lowercase().filter { it.isLetterOrDigit() || it == '-' }

    val screens = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val appState = LocalAppState.current
    val username = appState.currentUser.value ?: "you"
    val scope = rememberCoroutineScope()
    // A credential picked at the AI-key step (BYOK path) — null for promo.
    val credential = remember { PendingBuildCredential.peek() }
    var starting by remember { mutableStateOf(false) }
    val describeScroll = rememberScrollState()

    Column(
        // Scrollable: title + prompt (180dp) + examples + the two cards push the
        // "Build it" button below the fold on shorter screens (and under the
        // keyboard); a scroll keeps it reachable.
        modifier = Modifier.fillMaxSize().verticalScroll(describeScroll).padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = "New service",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s3))
        Text(
            text = "Describe what you want. Your Flagship will build it and run it at ${if (slug.isEmpty()) "<name>" else slug}.$username.flagship.services.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
        )
        Spacer(Modifier.height(FS.space.s6))

        // Textarea
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

        Spacer(Modifier.height(FS.space.s6))

        // Examples row
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            for (ex in listOf("Habit tracker", "Family wishlist", "Recipe jar", "Sleep journal")) {
                ExampleChip(ex) { prompt = it }
            }
        }

        Spacer(Modifier.height(FS.space.s8))

        // Owner-editable name (→ slug/address) + who can see it. (AI was chosen
        // on the previous step — not asked again.)
        FSField(
            value = name,
            onValueChange = { name = it },
            label = "Name",
            placeholder = "plant-tracker",
            helper = "Lowercase letters, digits, and dashes — this is its web address.",
            fieldTag = "vibe-describe-name",
        )

        Spacer(Modifier.height(FS.space.s4))

        Text(
            text = "Visible to",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            for ((value, label) in listOf("just-me" to "Just me", "link" to "Anyone with the link")) {
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
                        color = if (selected) Color.White else FS.colors.text,
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                    )
                }
            }
        }

        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Text(
                text = "It'll ask for these:",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            )
            Spacer(Modifier.height(FS.space.s2))
            Text(
                text = "· Postgres (a 'plants' table)\n· Object store (photos)\n· Push notifications",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, lineHeight = 22.sp),
            )
        }

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = if (starting) "Starting…" else "Build it",
            modifier = Modifier.testTag("vibe-describe-build"),
            onClick = {
                if (starting) return@FSPrimaryButton
                starting = true
                // Launch on Main so the post-call nav.navigate runs on the main
                // thread. The network I/O hops to IO inside the client; only the
                // UI work needs Main. (rememberCoroutineScope is Main in prod,
                // but the Compose-UI-Test continuation interceptor can resume a
                // bare launch off-main → 'addObserver/setCurrentState must be
                // called on the main thread'. Pinning Main is correct + robust.)
                scope.launch(kotlinx.coroutines.Dispatchers.Main) {
                    try {
                        val cred = PendingBuildCredential.peek()?.let {
                            BuildCredential(it.provider, it.apiKey, it.baseUrl)
                        }
                        val resp = screens.vibeCodeStart(
                            VibeCodeStartRequest(
                                prompt = prompt, credential = cred,
                                name = slug, visibility = visibility,
                            ),
                        )
                        if (resp.needsCredential) {
                            // Box wants a key — route into the AI-key step.
                            starting = false
                            nav.navigate("vibe/key")
                        } else {
                            PendingBuildCredential.take()
                            nav.navigate("vibe/generating/${resp.sessionId}")
                        }
                    } catch (t: Throwable) {
                        // Don't swallow — a tap that does nothing with no
                        // feedback is a dead control. Surface the failure (e.g.
                        // the box paired session isn't ready) so the owner knows
                        // the build didn't start. Mirror of iOS's un-swallowed
                        // vibeCodeStart error. The owner can retry the tap.
                        starting = false
                        android.util.Log.e("VibeCodeStart", "failed: ${t::class.java.name}: ${t.message}", t)
                        toasts.error("Couldn't start the build: ${NetworkErrorHumanizer.humanize(t)}")
                    }
                }
            },
            enabled = !starting && slug.isNotEmpty(),
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
    }
}

@Composable
private fun ExampleChip(text: String, onPick: (String) -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(FS.colors.surfaceSunken)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.pill))
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
    val serverLabel = remember(appState) { (appState.currentPod ?: appState.leaderPod)?.name }

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
                    // leave us off-main); launchSingleTop avoids a
                    // generating⇄chat loop.
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        nav.navigate("vibe-code-chat/$sessionId") { launchSingleTop = true }
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
