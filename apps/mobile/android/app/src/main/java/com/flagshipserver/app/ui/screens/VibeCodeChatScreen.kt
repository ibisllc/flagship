// W10 — vibe-code session chat surface (Android parallel of iOS
// VibeCodeChatScreen). Polls GET /api/screens/llm/sessions/<id> and
// surfaces the AI's pending tool request (talkToUser or requestEnvVar)
// with a reply field. The value path for requestEnvVar POSTs first to
// /api/screens/services/<appId>/env/set (the only path that carries
// the secret), then finalizes the model-facing ack via /reply.

package com.flagshipserver.app.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Image
import androidx.navigation.NavController
import com.flagshipserver.app.api.ServiceEnvSetEnvelope
import com.flagshipserver.app.api.ServiceEnvSetRequest
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.api.VibeCodePendingRequest
import com.flagshipserver.app.api.VibeCodeReplyRequest
import com.flagshipserver.app.api.VibeCodeSessionPublicState
import com.flagshipserver.app.api.VibeCodeAttachment
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.BuildSessionAi
import com.flagshipserver.app.core.ChatAttachments
import com.flagshipserver.app.core.FreeAiSessions
import com.flagshipserver.app.core.ModelCatalogs
import com.flagshipserver.app.core.ModelChoice
import com.flagshipserver.app.core.ModelMenu
import com.flagshipserver.app.core.ModelMenus
import com.flagshipserver.app.core.VisionCheck
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.core.VibeTranscript
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.VibeCodeDeployViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun VibeCodeChatScreen(nav: NavController, sessionId: String) {
    val client = LocalScreensClient.current
    val appState = LocalAppState.current
    val signer = LocalVibeCodeEnvelopeSigner.current
    val scope = rememberCoroutineScope()

    var state by remember { mutableStateOf<VibeCodeSessionPublicState?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var replyDraft by remember { mutableStateOf("") }
    var envValueDraft by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    // Deploy state. `ready-to-deploy` (the model finished emitting files + no
    // tool pending) surfaces the Deploy button. The box stages the app on a
    // private copy first, then installs the tested image; the deploy VM
    // follows those phases. The scratch deploy has no other trigger (the WS
    // stream is a pure relay), so this button IS how a chat-built service
    // ships. Mirror of iOS.
    val deployVm = remember(sessionId) { VibeCodeDeployViewModel(sessionId, client, scope = scope) }
    val deployPhase by deployVm.phase.collectAsState()

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value
    val serverFqdn = com.flagshipserver.app.core.LocalPodScope.current?.pod?.fqdn
        ?: appState.currentPod?.fqdn
        ?: pods.firstOrNull { it.podId == leaderId }?.fqdn
        ?: pods.firstOrNull()?.fqdn
        ?: "unknown"

    val freeAiService = rememberFreeAiService()
    val context = LocalContext.current

    // The model menu: the session's AI (the credential it started with), and
    // the model + effort the next message goes with. The owner may change
    // them between messages; every reply carries them.
    var menu by remember { mutableStateOf<ModelMenu?>(null) }
    var choice by remember { mutableStateOf<ModelChoice?>(null) }
    var staged by remember { mutableStateOf<List<VibeCodeAttachment>>(emptyList()) }
    var attachError by remember { mutableStateOf<String?>(null) }
    var vision by remember { mutableStateOf<VisionCheck?>(null) }

    fun stage(uri: android.net.Uri?) {
        if (uri == null) return
        scope.launch(Dispatchers.Main) {
            val (a, problem) = kotlinx.coroutines.withContext(Dispatchers.IO) { readAttachment(context, uri, staged.size) }
            attachError = problem
            if (a != null) staged = staged + a
        }
    }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { stage(it) }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { stage(it) }

    // A build on free AI credits gets a fresh credential with every reply
    // (they last 12 h); false when the credits ran out and nothing was sent.
    suspend fun reply(base: VibeCodeReplyRequest): Boolean {
        val (model, effort) = ModelMenus.replyWire(choice)
        val req = base.copy(model = model, effort = effort)
        val withCred = when (val r = freeAiService.refreshFor(sessionId)) {
            is com.flagshipserver.app.core.FreeAiRefresh.None -> req
            is com.flagshipserver.app.core.FreeAiRefresh.Fresh ->
                req.copy(credential = com.flagshipserver.app.api.BuildCredential.from(r.credential))
            is com.flagshipserver.app.core.FreeAiRefresh.Stop -> {
                errorMessage = r.message
                return false
            }
        }
        client.vibeCodeSessionReply(sessionId, withCred)
        return true
    }

    suspend fun reload() {
        try {
            state = client.vibeCodeSessionState(sessionId)
        } catch (t: Throwable) {
            errorMessage = t.userFacing()
        }
    }

    LaunchedEffect(deployPhase) {
        if (deployPhase is VibeCodeDeployViewModel.Phase.Deployed || deployPhase is VibeCodeDeployViewModel.Phase.Failed) reload()
    }

    LaunchedEffect(sessionId, state != null) {
        val s = state ?: return@LaunchedEffect
        if (menu != null) return@LaunchedEffect
        val cred = BuildSessionAi.credentialFor(sessionId)
        val m = when {
            cred != null -> ModelCatalogs.menuFor(cred, client)
            FreeAiSessions.serverFor(sessionId) != null -> ModelMenu.Flagship(ModelCatalogs.inference())
            else -> {
                // Reopened after a restart: a catalog id means Flagship Inference.
                val cat = ModelCatalogs.inference()
                if (cat != null && cat.models.any { it.id == s.model }) ModelMenu.Flagship(cat) else ModelMenu.Unknown
            }
        }
        val saved = runCatching { AiKeyStore.defaultModelFor(cred) }.getOrNull()
        choice = ModelMenus.initial(m, saved, s.model?.takeIf { it.isNotBlank() }?.let { ModelChoice(it, s.effort) })
        menu = m
    }

    LaunchedEffect(sessionId) {
        reload()
        // Poll the public state while the session is still moving toward a
        // terminal state. `ready-to-deploy` is included so the screen keeps
        // refreshing until the owner taps Deploy (and reflects a deploy that
        // completed out-of-band). Mirror of iOS.
        while (true) {
            delay(1500)
            val s = state ?: continue
            if (s.status !in listOf("streaming", "awaiting-tool-response", "ready-to-deploy", "deploying")) break
            try {
                state = client.vibeCodeSessionState(sessionId)
            } catch (_: Throwable) {
                // network blip — keep polling
            }
        }
    }

    val scroll = rememberScrollState()
    // Follow new text while the owner is at the bottom; once they scroll up,
    // leave them there and offer "Jump to latest". Only a finished scroll
    // decides: content growing under a still list must not stop the follow.
    // Mirror of iOS.
    val atBottom by remember { derivedStateOf { scroll.value >= scroll.maxValue - FOLLOW_SLACK_PX } }
    var followTail by remember { mutableStateOf(true) }
    LaunchedEffect(scroll.isScrollInProgress) { if (!scroll.isScrollInProgress) followTail = atBottom }
    val transcript = remember(state?.messages) { VibeTranscript.lines(state?.messages.orEmpty()) }
    val contentSignature = (state?.messages?.size ?: 0) to (state?.pendingRequest != null) to state?.status
    LaunchedEffect(contentSignature, scroll.maxValue) {
        if (followTail) scroll.scrollTo(scroll.maxValue)
    }
    Box(Modifier.fillMaxSize()) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Vibe-code session",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        val m = menu
        if (m != null && !(m is ModelMenu.Unknown && choice == null)) {
            Spacer(Modifier.height(FS.space.s2))
            ChatModelBar(m, choice, onChoice = { choice = it })
        }
        Spacer(Modifier.height(FS.space.s4))

        val s = state
        if (s == null) {
            ServerCardSkeleton()
            return@Column
        }

        FSCard {
            Column {
                Text(
                    statusLabel(s.status),
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                if (s.appId != null) {
                    Spacer(Modifier.height(FS.space.s1))
                    Text("app: ${s.appId}", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                }
                Spacer(Modifier.height(FS.space.s1))
                Text("session: ${s.id}", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
            }
        }
        Spacer(Modifier.height(FS.space.s3))

        FSCard {
            Column {
                Text(
                    "CONVERSATION",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                if (s.messages.isEmpty()) {
                    Text("No messages yet.", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                } else {
                    val (hidden, shown) = transcript
                    if (hidden > 0) {
                        Text(
                            VibeTranscript.hiddenText(hidden),
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                            modifier = Modifier.semantics { testTag = "vibecode-hidden-messages" },
                        )
                        Spacer(Modifier.height(FS.space.s2))
                    }
                    if (s.summarised) {
                        Text(EARLIER_SUMMARISED, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                        Spacer(Modifier.height(FS.space.s2))
                    }
                    shown.forEach { msg -> ChatMessage(msg) }
                }
            }
        }
        Spacer(Modifier.height(FS.space.s3))

        val pending = s.pendingRequest
        if (pending != null) {
            when (pending) {
                is VibeCodePendingRequest.TalkToUser -> {
                    FSCard {
                        Column {
                            Text("AI asked:", color = FS.colors.textMuted, style = TextStyle(fontSize = 11.sp))
                            Spacer(Modifier.height(FS.space.s1))
                            Text(pending.payload.message, color = FS.colors.text)
                            Spacer(Modifier.height(FS.space.s3))
                            OutlinedTextField(
                                value = replyDraft,
                                onValueChange = { replyDraft = it },
                                label = { Text("Type your reply") },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .semantics { testTag = "vibecode-reply-field" },
                            )
                            Spacer(Modifier.height(FS.space.s2))
                            fun sendNow() {
                                scope.launch(Dispatchers.Main) {
                                    submitting = true
                                    try {
                                        val req = VibeCodeReplyRequest(
                                            text = replyDraft,
                                            attachments = staged.takeIf { it.isNotEmpty() },
                                        )
                                        if (reply(req)) {
                                            replyDraft = ""
                                            staged = emptyList()
                                            attachError = null
                                            reload()
                                        }
                                    } catch (t: Throwable) {
                                        errorMessage = t.userFacing()
                                    } finally {
                                        submitting = false
                                    }
                                }
                            }
                            ChatComposerAttachments(
                                staged = staged,
                                error = attachError,
                                onPhoto = {
                                    photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                },
                                onFile = { filePicker.launch(ChatAttachments.DOCUMENT_MIME_TYPES) },
                                onRemove = { i -> staged = staged.filterIndexed { j, _ -> j != i } },
                            )
                            Spacer(Modifier.height(FS.space.s3))
                            FSPrimaryButton(
                                label = if (submitting) "Sending…" else "Send",
                                enabled = !submitting && replyDraft.isNotEmpty(),
                                modifier = Modifier.semantics { testTag = "vibecode-reply-send-btn" },
                                onClick = {
                                    val check = ModelMenus.visionCheck(
                                        menu ?: ModelMenu.Unknown, choice, ChatAttachments.hasImage(staged),
                                    )
                                    if (check is VisionCheck.Send) sendNow() else vision = check
                                },
                            )
                            vision?.let { check ->
                                VisionDialog(
                                    check = check,
                                    onSwitch = { to ->
                                        vision = null
                                        choice = to
                                        sendNow()
                                    },
                                    onDismiss = { vision = null },
                                )
                            }
                        }
                    }
                }
                is VibeCodePendingRequest.RequestEnvVar -> {
                    val p = pending.payload
                    FSCard {
                        Column {
                            Text("AI needs ${p.name}", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                            Spacer(Modifier.height(FS.space.s2))
                            Text(p.description, color = FS.colors.text)
                            Spacer(Modifier.height(FS.space.s1))
                            Text("Why: ${p.why}", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                            val ex = p.example
                            if (ex != null && ex.isNotEmpty()) {
                                Spacer(Modifier.height(FS.space.s1))
                                Text("Example: $ex", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                            }
                            Spacer(Modifier.height(FS.space.s3))
                            OutlinedTextField(
                                value = envValueDraft,
                                onValueChange = { envValueDraft = it },
                                label = { Text("paste your value") },
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .semantics { testTag = "vibecode-envvar-field" },
                            )
                            Spacer(Modifier.height(FS.space.s1))
                            Text("Sent once to your server. Not saved on your phone.", color = FS.colors.textMuted, style = TextStyle(fontSize = 11.sp))
                            Spacer(Modifier.height(FS.space.s3))
                            FSPrimaryButton(
                                label = if (submitting) "Sending…" else "Send value",
                                enabled = !submitting && envValueDraft.isNotEmpty() && s.appId != null,
                                modifier = Modifier.semantics { testTag = "vibecode-envvar-send-btn" },
                                onClick = {
                                    val appId = s.appId ?: return@FSPrimaryButton
                                    // serviceId = "<creator>--<slug>"; split on `--`
                                    // (docs/service-addressing-double-dash.md).
                                    val delimIdx = appId.indexOf("--")
                                    if (delimIdx <= 0) {
                                        errorMessage = "Invalid app id shape"
                                        return@FSPrimaryButton
                                    }
                                    val creator = appId.substring(0, delimIdx)
                                    val slug = appId.substring(delimIdx + 2)
                                    scope.launch(Dispatchers.Main) {
                                        submitting = true
                                        try {
                                            val issuedAt = System.currentTimeMillis()
                                            val envelope = ServiceEnvSetEnvelope(
                                                serverId = serverFqdn,
                                                creator = creator, slug = slug,
                                                env = mapOf(p.name to envValueDraft),
                                                issuedAt = issuedAt,
                                            )
                                            val signature = signer(envelope)
                                            client.serviceEnvSet(
                                                appId,
                                                ServiceEnvSetRequest(
                                                    name = p.name, value = envValueDraft,
                                                    request = envelope, signature = signature,
                                                ),
                                            )
                                            reply(VibeCodeReplyRequest(envVarStatus = "set"))
                                            envValueDraft = ""
                                            reload()
                                        } catch (t: Throwable) {
                                            errorMessage = t.userFacing()
                                        } finally {
                                            submitting = false
                                        }
                                    }
                                },
                            )
                            Spacer(Modifier.height(FS.space.s2))
                            FSGhostButton(
                                label = "Decline",
                                modifier = Modifier.semantics { testTag = "vibecode-envvar-decline-btn" },
                                onClick = {
                                    scope.launch(Dispatchers.Main) {
                                        try {
                                            reply(VibeCodeReplyRequest(envVarStatus = "declined"))
                                            reload()
                                        } catch (t: Throwable) {
                                            errorMessage = t.userFacing()
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(FS.space.s3))
        }

        // Deploy affordance + result. Shown once the model has finished emitting
        // the app (`ready-to-deploy`) — the only point a scratch session can be
        // shipped, since the WS stream never auto-deploys. While the box stages
        // and installs it, the card says which step it's on; then the canonical
        // URL renders, or the reason it didn't go live. Mirror of iOS deploySection.
        val dp = deployPhase
        val deployed = dp as? VibeCodeDeployViewModel.Phase.Deployed
        val deployingStage: String? = when {
            dp is VibeCodeDeployViewModel.Phase.Deploying -> dp.stage ?: s.deployPhase
            dp is VibeCodeDeployViewModel.Phase.Idle && s.status == "deploying" -> s.deployPhase
            else -> null
        }
        val isDeploying = dp is VibeCodeDeployViewModel.Phase.Deploying ||
            (dp is VibeCodeDeployViewModel.Phase.Idle && s.status == "deploying")
        val failedReason = (dp as? VibeCodeDeployViewModel.Phase.Failed)?.reason
            ?: s.failureReason?.takeIf { s.status == "failed" }
        if (deployed != null || (dp !is VibeCodeDeployViewModel.Phase.Failed && s.status == "deployed")) {
            FSCard {
                Column {
                    Text(
                        "✓ Deployed",
                        color = FS.colors.success,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    if (deployed != null && deployed.url.isNotEmpty()) {
                        Spacer(Modifier.height(FS.space.s1))
                        Text(
                            deployed.url,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 13.sp),
                            modifier = Modifier.semantics { testTag = "vibecode-deployed-url" },
                        )
                        if (deployed.leftOpen) {
                            Spacer(Modifier.height(FS.space.s2))
                            Text(
                                LEFT_OPEN_WARNING,
                                color = FS.colors.warning,
                                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(FS.space.s3))
        } else if (isDeploying) {
            FSCard {
                Column {
                    Text(
                        "Deploying",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Spacer(Modifier.height(FS.space.s1))
                    Text(
                        VibeCodeDeployViewModel.stageText(deployingStage),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        modifier = Modifier.semantics { testTag = "vibecode-deploy-stage" },
                    )
                }
            }
            // Reopened mid-deploy: follow it so the result shows here.
            LaunchedEffect(sessionId, dp is VibeCodeDeployViewModel.Phase.Idle) {
                if (dp is VibeCodeDeployViewModel.Phase.Idle) deployVm.resume(s.deployPhase)
            }
            Spacer(Modifier.height(FS.space.s3))
        } else if (s.status == "ready-to-deploy" || dp is VibeCodeDeployViewModel.Phase.Failed) {
            FSCard {
                Column {
                    Text(
                        if (failedReason != null) "The app didn't go live" else "Ready to deploy",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Spacer(Modifier.height(FS.space.s1))
                    Text(
                        failedReason ?: "The AI finished writing your service. Deploy it to your box.",
                        color = if (failedReason != null) FS.colors.danger else FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        modifier = Modifier.semantics { testTag = "vibecode-deploy-detail" },
                    )
                    if (failedReason != null) RelayFailureAction(failedReason)
                    Spacer(Modifier.height(FS.space.s3))
                    FSPrimaryButton(
                        label = if (failedReason != null) "Try again" else "Deploy",
                        modifier = Modifier.semantics { testTag = "vibecode-deploy-btn" },
                        onClick = { deployVm.deploy() },
                    )
                }
            }
            Spacer(Modifier.height(FS.space.s3))
        } else if (failedReason != null) {
            // The session itself stopped (e.g. an AI call the relay couldn't carry).
            ErrorCard(message = failedReason)
            RelayFailureAction(failedReason)
            Spacer(Modifier.height(FS.space.s3))
        }

        if (errorMessage != null) {
            ErrorCard(message = errorMessage!!)
        }
        Spacer(Modifier.height(FS.space.s10))
    }
    if (!followTail) {
        FSSecondaryButton(
            label = "↓ Jump to latest",
            onClick = {
                followTail = true
                scope.launch { scroll.animateScrollTo(scroll.maxValue) }
            },
            modifier = Modifier
                .align(androidx.compose.ui.Alignment.BottomEnd)
                .padding(FS.space.s4)
                .semantics { testTag = "vibecode-jump-latest" },
        )
    }
    }
}

/** How close to the bottom still counts as following the conversation. */
private const val FOLLOW_SLACK_PX = 120

internal const val EARLIER_SUMMARISED = "Earlier conversation summarised"

/** The header's model menu and, for a Flagship model that reasons, "Think harder". */
@Composable
internal fun ChatModelBar(menu: ModelMenu, choice: ModelChoice?, onChoice: (ModelChoice?) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        ModelMenuChip(menu, choice, onChoice)
        if (choice != null && ModelMenus.thinkHarderOffered(menu, choice)) {
            ThinkHarderChip(ModelMenus.thinkHarder(choice)) { on -> onChoice(ModelMenus.withThinkHarder(choice, on)) }
        }
    }
}

/** One turn: who said it, what, any attachments, and a Flagship reply's cost. */
@Composable
internal fun ChatMessage(msg: com.flagshipserver.app.api.VibeCodeSessionMessage) {
    Text(
        if (msg.role == "user") "YOU" else "AI",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
    )
    Text(msg.text, color = FS.colors.text)
    val attached = msg.attachments.orEmpty()
    if (attached.isNotEmpty()) {
        Spacer(Modifier.height(FS.space.s1))
        AttachmentChips(attached)
    }
    val credits = msg.credits
    if (msg.role == "assistant" && credits != null) {
        Spacer(Modifier.height(2.dp))
        CreditsLine(credits)
    }
    Spacer(Modifier.height(FS.space.s2))
}

/** Attach buttons, the staged chips (removable) and the notice under them. */
@Composable
internal fun ChatComposerAttachments(
    staged: List<VibeCodeAttachment>,
    error: String?,
    onPhoto: () -> Unit,
    onFile: () -> Unit,
    onRemove: (Int) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Pill(
            label = "Photo",
            leading = androidx.compose.material.icons.Icons.Outlined.Image,
            onClick = onPhoto,
            modifier = Modifier.semantics { testTag = "vibecode-attach-photo" },
        )
        Pill(
            label = "File",
            leading = androidx.compose.material.icons.Icons.Outlined.AttachFile,
            onClick = onFile,
            modifier = Modifier.semantics { testTag = "vibecode-attach-file" },
        )
    }
    if (staged.isNotEmpty()) {
        Spacer(Modifier.height(FS.space.s2))
        AttachmentChips(staged, onRemove)
    }
    Spacer(Modifier.height(FS.space.s2))
    AttachmentNotice(staged)
    if (error != null) {
        Spacer(Modifier.height(FS.space.s1))
        Text(
            error,
            color = FS.colors.danger,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            modifier = Modifier.semantics { testTag = "vibecode-attach-error" },
        )
    }
}

internal const val LEFT_OPEN_WARNING =
    "This server couldn't make it invite only, so anyone with the link can open it. You can restrict it from the service's Access settings."

private fun statusLabel(status: String): String = when (status) {
    "streaming" -> "Generating…"
    "awaiting-tool-response" -> "AI is asking you something"
    "ready-to-deploy" -> "Ready to deploy"
    "deploying" -> "Deploying…"
    "deployed" -> "Deployed"
    "failed" -> "Failed"
    "cancelled" -> "Cancelled"
    else -> status
}
