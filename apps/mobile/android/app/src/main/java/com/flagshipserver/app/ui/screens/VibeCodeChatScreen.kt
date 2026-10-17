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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Image
import androidx.navigation.NavController
import com.flagshipserver.app.api.ServiceEnvChange
import com.flagshipserver.app.api.ServiceEnvSetRequest
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.api.VibeCodePendingRequest
import com.flagshipserver.app.api.VibeCodeReplyRequest
import com.flagshipserver.app.api.VibeCodeSessionPublicState
import com.flagshipserver.app.api.VibeCodeAttachment
import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.core.AiCredential
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.AiRelay
import com.flagshipserver.app.core.BuildSessionAi
import com.flagshipserver.app.core.ChatAttachments
import com.flagshipserver.app.core.FreeAiCopy
import com.flagshipserver.app.core.FreeAiRefresh
import com.flagshipserver.app.core.FreeAiSessions
import com.flagshipserver.app.core.MessageCredential
import com.flagshipserver.app.core.ModelCatalogs
import com.flagshipserver.app.core.ModelChoice
import com.flagshipserver.app.core.ModelGroup
import com.flagshipserver.app.core.ModelGroups
import com.flagshipserver.app.core.ModelMenu
import com.flagshipserver.app.core.ModelMenus
import com.flagshipserver.app.core.VisionCheck
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.core.VibeTranscript
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.VibeCodeDeployViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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
    // tool pending) surfaces the Deploy button. The server stages the app on a
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

    // The model menu, grouped by provider: Flagship Inference and each saved
    // key. [groupId] is the group the next message goes with, [boxGroupId]
    // the one whose key the box holds; picking another group sends its key.
    var groups by remember { mutableStateOf<List<ModelGroup>>(emptyList()) }
    val menus = remember { mutableStateMapOf<String, ModelMenu>() }
    var groupId by remember { mutableStateOf<String?>(null) }
    var boxGroupId by remember { mutableStateOf<String?>(null) }
    var menuReady by remember { mutableStateOf(false) }
    var choice by remember { mutableStateOf<ModelChoice?>(null) }
    var pollEpoch by remember { mutableIntStateOf(0) }
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

    fun credentialOf(g: ModelGroup): AiCredential? = when {
        g.isFlagship -> null
        g.id == ModelGroups.SESSION_KEY -> BuildSessionAi.credentialFor(sessionId)
        else -> runCatching { AiKeyStore.credentialFor(g.id) }.getOrNull()
    }

    // Each group's models, once per screen (ModelCatalogs caches them for the
    // app session).
    suspend fun loadMenu(g: ModelGroup): ModelMenu {
        menus[g.id]?.let { return it }
        val m = if (g.isFlagship) {
            ModelMenu.Flagship(ModelCatalogs.inference())
        } else {
            credentialOf(g)?.let { ModelCatalogs.menuFor(it, client) }
                ?: ModelMenu.Own(g.provider, listed = false, options = emptyList(), defaultModel = null, reason = "failed")
        }
        menus[g.id] = m
        return m
    }

    // Every message says the model and effort. A Flagship Inference chat gets
    // a fresh pass each time (they last 12 h); an own key rides along when
    // the owner picked it here or the box holds none. False when nothing was
    // sent (the reason is shown).
    suspend fun reply(base: VibeCodeReplyRequest): Boolean {
        val (model, effort) = ModelMenus.replyWire(choice)
        val req = base.copy(model = model, effort = effort)
        val group = ModelGroups.byId(groups, groupId)
        var passServer: String? = null
        var key: AiCredential? = null
        val rule = ModelGroups.messageCredential(
            group,
            picked = groupId != boxGroupId,
            needsCredential = state?.needsCredential == true,
        )
        val withCred = when (rule) {
            MessageCredential.NONE -> req
            MessageCredential.FLAGSHIP_PASS -> {
                val server = FreeAiSessions.serverFor(sessionId) ?: serverFqdn.takeIf { it != "unknown" }.orEmpty()
                when (val r = freeAiService.passFor(server)) {
                    is FreeAiRefresh.Fresh -> {
                        passServer = server
                        req.copy(credential = LlmProviderCredential.from(r.credential))
                    }
                    is FreeAiRefresh.Stop -> {
                        errorMessage = r.message
                        return false
                    }
                    FreeAiRefresh.None -> req
                }
            }
            MessageCredential.OWN_KEY -> {
                val c = group?.let(::credentialOf)
                if (c == null) {
                    errorMessage = KEY_GONE
                    return false
                }
                key = c
                req.copy(credential = LlmProviderCredential.from(c))
            }
        }
        client.vibeCodeSessionReply(sessionId, withCred)
        boxGroupId = groupId
        passServer?.let {
            FreeAiSessions.remember(sessionId, it)
            AiRelay.lastUsedKeyId = null
        }
        key?.let {
            FreeAiSessions.forget(sessionId)
            BuildSessionAi.remember(sessionId, it)
            AiRelay.lastUsedKeyId = it.keyId
        }
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

    // Open on the group the chat uses now: the box's provider, else the key
    // this app started it with, else (older box) a catalog model id.
    LaunchedEffect(sessionId, state != null) {
        val s = state ?: return@LaunchedEffect
        if (menuReady) return@LaunchedEffect
        val sessionCred = BuildSessionAi.credentialFor(sessionId)
        val (catalog, usable) = coroutineScope {
            val status = async { FreeAiCopy.view(freeAiService.status())?.usable == true }
            ModelCatalogs.inference() to status.await()
        }
        val provider = ModelGroups.chatProvider(
            s.provider,
            sessionCred,
            onFlagship = FreeAiSessions.serverFor(sessionId) != null,
            modelInCatalog = catalog?.models?.any { it.id == s.model } == true,
        )
        val keys = runCatching { AiKeyStore.list() }.getOrDefault(emptyList())
        val built = ModelGroups.build(
            keys,
            flagshipUsable = usable,
            currentProvider = provider,
            sessionKeyProvider = sessionCred?.takeIf { !it.isFreeAi && it.keyId == null }?.provider,
        )
        val g = ModelGroups.initial(built, provider, sessionCred)
        val current = s.model?.takeIf { it.isNotBlank() }?.let { ModelChoice(it, s.effort) }
        choice = if (g == null) {
            current
        } else {
            val saved = runCatching {
                AiKeyStore.defaultModel(if (g.isFlagship) AiKeyStore.FLAGSHIP_INFERENCE_ID else g.id)
            }.getOrNull()
            ModelMenus.initial(loadMenu(g), saved, current)
        }
        groups = built
        groupId = g?.id
        boxGroupId = g?.id
        menuReady = true
    }

    LaunchedEffect(sessionId, pollEpoch) {
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
    val s0 = state
    FSScreen(
        title = chatTitle(s0?.status),
        onBack = { nav.popBackStack() },
        scrollable = false,
        spacing = FS.space.s3,
    ) {
        if (menuReady && (groups.isNotEmpty() || choice != null)) {
            GroupedChatModelBar(
                groups = groups,
                menus = menus,
                groupId = groupId,
                choice = choice,
                notice = ModelGroups.contextNotice(
                    groupId?.let { menus[it] }, choice, state?.model, state?.conversationTokens,
                ),
                onOpen = { groups.forEach { g -> if (menus[g.id] == null) scope.launch { loadMenu(g) } } },
                onPick = { id, c ->
                    groupId = id
                    choice = c
                },
                onEffort = { e -> choice = choice?.copy(effort = e) },
            )
        }

        val s = s0
        if (s == null) {
            ServerCardSkeleton()
            return@FSScreen
        }

        // A new message on a chat that is ready to deploy or failed starts the
        // AI again on its files; polling follows it until it settles.
        fun sendNow(continuing: Boolean) {
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
                        errorMessage = null
                        if (continuing) deployVm.reset()
                        reload()
                        pollEpoch++
                    }
                } catch (t: Throwable) {
                    errorMessage = t.boxError() ?: t.userFacing()
                } finally {
                    submitting = false
                }
            }
        }

        // The input bar under the conversation: the field, attach buttons and Send.
        @Composable
        fun Composer(label: String?, placeholder: String?, continuing: Boolean, fieldTag: String, sendTag: String) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                OutlinedTextField(
                    value = replyDraft,
                    onValueChange = { replyDraft = it },
                    label = if (label != null) ({ Text(label) }) else null,
                    placeholder = if (placeholder != null) ({ Text(placeholder) }) else null,
                    maxLines = 5,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = fieldTag },
                )
                ChatComposerAttachments(
                    staged = staged,
                    error = attachError,
                    onPhoto = {
                        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    onFile = { filePicker.launch(ChatAttachments.DOCUMENT_MIME_TYPES) },
                    onRemove = { i -> staged = staged.filterIndexed { j, _ -> j != i } },
                    trailing = {
                        FSPrimaryButton(
                            label = if (submitting) "Sending…" else "Send",
                            enabled = !submitting && ChatContinuation.canSend(replyDraft, continuing),
                            modifier = Modifier.semantics { testTag = sendTag },
                            onClick = {
                                val check = ModelMenus.visionCheck(
                                    groupId?.let { menus[it] } ?: ModelMenu.Unknown, choice, ChatAttachments.hasImage(staged),
                                )
                                if (check is VisionCheck.Send) sendNow(continuing) else vision = check
                            },
                        )
                    },
                )
                vision?.let { check ->
                    VisionDialog(
                        check = check,
                        onSwitch = { to ->
                            vision = null
                            choice = to
                            sendNow(continuing)
                        },
                        onDismiss = { vision = null },
                    )
                }
            }
        }

        val pending = s.pendingRequest

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

        // The conversation scrolls on its own; the input bar stays below it.
        Box(Modifier.fillMaxWidth().weight(1f)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            ) {
                Text(
                    listOfNotNull(s.appId?.let { "app: $it" }, "session: ${s.id}").joinToString(" · "),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = FS.space.s1),
                )

                FSCard {
                    Column {
                        Text(
                            "Conversation",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelLarge,
                        )
                        Spacer(Modifier.height(FS.space.s3))
                        if (s.messages.isEmpty()) {
                            Text("No messages yet.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                        } else {
                            val (hidden, shown) = transcript
                            if (hidden > 0) {
                                Text(
                                    VibeTranscript.hiddenText(hidden),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.semantics { testTag = "vibecode-hidden-messages" },
                                )
                                Spacer(Modifier.height(FS.space.s2))
                            }
                            if (s.summarised) {
                                Text(EARLIER_SUMMARISED, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                                Spacer(Modifier.height(FS.space.s2))
                            }
                            shown.forEach { msg -> ChatMessage(msg) }
                        }
                    }
                }

                when (pending) {
                    is VibeCodePendingRequest.TalkToUser -> {
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                                Text("The AI asks", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                                Text(pending.payload.message, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }
                    is VibeCodePendingRequest.RequestEnvVar -> {
                        val p = pending.payload
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                                Text("The AI needs ${p.name}", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
                                Text(p.description, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                                Text("Why: ${p.why}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                                val ex = p.example
                                if (ex != null && ex.isNotEmpty()) {
                                    Text("Example: $ex", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                    null -> Unit
                }

                if (deployed != null || (dp !is VibeCodeDeployViewModel.Phase.Failed && s.status == "deployed")) {
                    FSCard {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(22.dp))
                                Text("Deployed", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
                            }
                            if (deployed != null && deployed.url.isNotEmpty()) {
                                Text(
                                    deployed.url,
                                    color = MaterialTheme.colorScheme.primary,
                                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                                    modifier = Modifier.semantics { testTag = "vibecode-deployed-url" },
                                )
                                if (deployed.leftOpen) {
                                    Text(
                                        LEFT_OPEN_WARNING,
                                        color = FS.colors.warning,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                }
                            }
                        }
                    }
                } else if (isDeploying) {
                    FSCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                                Text("Deploying", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    VibeCodeDeployViewModel.stageText(deployingStage),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.semantics { testTag = "vibecode-deploy-stage" },
                                )
                            }
                        }
                    }
                    // Reopened mid-deploy: follow it so the result shows here.
                    LaunchedEffect(sessionId, dp is VibeCodeDeployViewModel.Phase.Idle) {
                        if (dp is VibeCodeDeployViewModel.Phase.Idle) deployVm.resume(s.deployPhase)
                    }
                } else if (s.status == "ready-to-deploy" || dp is VibeCodeDeployViewModel.Phase.Failed) {
                    FSCard {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text(
                                if (failedReason != null) "The app didn't go live" else "Ready to deploy",
                                color = MaterialTheme.colorScheme.onSurface,
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                failedReason ?: "The AI finished writing your service. Deploy it to your server.",
                                color = if (failedReason != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.semantics { testTag = "vibecode-deploy-detail" },
                            )
                            if (failedReason != null) RelayFailureAction(failedReason)
                            Spacer(Modifier.height(FS.space.s1))
                            FSPrimaryButton(
                                label = if (failedReason != null) "Try again" else "Deploy",
                                modifier = Modifier.semantics { testTag = "vibecode-deploy-btn" },
                                block = true,
                                onClick = { deployVm.deploy() },
                            )
                        }
                    }
                } else if (failedReason != null) {
                    // The session itself stopped (e.g. an AI call the relay couldn't carry).
                    ErrorCard(message = failedReason)
                    RelayFailureAction(failedReason)
                }

                if (errorMessage != null) {
                    ErrorCard(message = errorMessage!!)
                }
                Spacer(Modifier.height(FS.space.s2))
            }
            if (!followTail) {
                SmallFloatingActionButton(
                    onClick = {
                        followTail = true
                        scope.launch { scroll.animateScrollTo(scroll.maxValue) }
                    },
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(FS.space.s2)
                        .semantics { testTag = "vibecode-jump-latest" },
                ) {
                    Icon(Icons.Outlined.ArrowDownward, contentDescription = "Jump to latest")
                }
            }
        }

        // The input bar: an answer to the AI, a secret it asked for, or a new
        // message on a chat that can continue.
        when (pending) {
            is VibeCodePendingRequest.TalkToUser -> InputBar {
                Composer(
                    label = "Type your reply",
                    placeholder = null,
                    continuing = false,
                    fieldTag = "vibecode-reply-field",
                    sendTag = "vibecode-reply-send-btn",
                )
            }
            is VibeCodePendingRequest.RequestEnvVar -> {
                val p = pending.payload
                InputBar {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        OutlinedTextField(
                            value = envValueDraft,
                            onValueChange = { envValueDraft = it },
                            label = { Text("Paste your value") },
                            supportingText = { Text("Sent once to your server. Not saved on your phone.") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                            shape = MaterialTheme.shapes.small,
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics { testTag = "vibecode-envvar-field" },
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            FSSecondaryButton(
                                label = "Decline",
                                modifier = Modifier.weight(1f).semantics { testTag = "vibecode-envvar-decline-btn" },
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
                            FSPrimaryButton(
                                label = if (submitting) "Sending…" else "Send value",
                                enabled = !submitting && envValueDraft.isNotEmpty() && s.appId != null,
                                modifier = Modifier.weight(1f).semantics { testTag = "vibecode-envvar-send-btn" },
                                onClick = {
                                    val appId = s.appId ?: return@FSPrimaryButton
                                    // serviceId = "<creator>--<slug>"; split on `--`
                                    // (docs/service-addressing-double-dash.md).
                                    if (appId.indexOf("--") <= 0) {
                                        errorMessage = "Invalid app id shape"
                                        return@FSPrimaryButton
                                    }
                                    scope.launch(Dispatchers.Main) {
                                        submitting = true
                                        try {
                                            val change = ServiceEnvChange.set(serverFqdn, appId, p.name, envValueDraft)
                                            val signature = signer(change)
                                            client.serviceEnvSet(
                                                appId,
                                                ServiceEnvSetRequest(change = change, value = envValueDraft, signature = signature),
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
                        }
                    }
                }
            }
            null -> if (ChatContinuation.takesMessage(s)) {
                InputBar {
                    Composer(
                        label = null,
                        placeholder = ChatContinuation.placeholder(s.status),
                        continuing = true,
                        fieldTag = "vibecode-continue-field",
                        sendTag = "vibecode-continue-send-btn",
                    )
                }
            }
        }
    }
}

/** The bar under the conversation that holds the field being typed in. */
@Composable
private fun InputBar(content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(bottom = FS.space.s3),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Box(Modifier.padding(FS.space.s3)) { content() }
    }
}

/** The screen's title: where the build is, in a word or two (as iOS). */
internal fun chatTitle(status: String?): String = when (status) {
    "streaming" -> "Generating"
    "awaiting-tool-response" -> "Your turn"
    "ready-to-deploy" -> "Ready to deploy"
    "deploying" -> "Deploying"
    "deployed" -> "Live"
    "failed" -> "Failed"
    "cancelled" -> "Stopped"
    else -> "Build chat"
}

/** How close to the bottom still counts as following the conversation. */
private const val FOLLOW_SLACK_PX = 120

internal const val EARLIER_SUMMARISED = "Earlier conversation summarised"

internal const val KEY_GONE = "That AI key isn't saved on this phone any more. Pick another model."

/** When the chat takes a new message that isn't an answer, and what its field says. */
internal object ChatContinuation {
    const val ASK_FOR_CHANGE = "Ask for a change…"
    const val TRY_NEXT = "Tell the AI what to try next…"

    /** The box says the chat can continue and the AI isn't asking anything. */
    fun takesMessage(s: VibeCodeSessionPublicState): Boolean = s.canContinue && s.pendingRequest == null

    fun placeholder(status: String): String = if (status == "failed") TRY_NEXT else ASK_FOR_CHANGE

    /** A new message needs words; an answer may be empty only if it has none. */
    fun canSend(draft: String, continuing: Boolean): Boolean =
        if (continuing) draft.isNotBlank() else draft.isNotEmpty()
}

/** One model menu (Settings → AI keys) and the effort beside it. */
@Composable
internal fun ChatModelBar(menu: ModelMenu, choice: ModelChoice?, onChoice: (ModelChoice?) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        ModelMenuChip(menu, choice, onChoice)
        val efforts = ModelMenus.efforts(menu, choice)
        if (choice != null && efforts.isNotEmpty()) {
            EffortChip(efforts, choice.effort) { e -> onChoice(choice.copy(effort = e)) }
        }
    }
}

/** The build chat's menu grouped by provider, the effort beside it, and the
 *  line saying older messages will be summarised. */
@Composable
internal fun GroupedChatModelBar(
    groups: List<ModelGroup>,
    menus: Map<String, ModelMenu>,
    groupId: String?,
    choice: ModelChoice?,
    notice: String?,
    onOpen: () -> Unit,
    onPick: (String, ModelChoice?) -> Unit,
    onEffort: (String) -> Unit,
) {
    Column {
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            GroupedModelMenuChip(groups, menus, groupId, choice, onOpen, onPick)
            val efforts = ModelGroups.effortOptions(groupId?.let { menus[it] }, choice)
            if (choice != null && efforts.isNotEmpty()) EffortChip(efforts, choice.effort, onEffort)
        }
        if (notice != null) {
            Spacer(Modifier.height(FS.space.s1))
            Text(
                notice,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.semantics { testTag = "model-context-notice" },
            )
        }
    }
}

/** One turn: who said it, what, any attachments, and a Flagship reply's cost. */
@Composable
internal fun ChatMessage(msg: com.flagshipserver.app.api.VibeCodeSessionMessage) {
    Text(
        if (msg.role == "user") "You" else "AI",
        color = if (msg.role == "user") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
        style = MaterialTheme.typography.labelMedium,
    )
    Text(msg.text, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
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
    Spacer(Modifier.height(FS.space.s3))
}

/** Attach buttons (and an optional [trailing] control, the composer's Send),
 *  the staged chips (removable) and the notice under them. */
@Composable
internal fun ChatComposerAttachments(
    staged: List<VibeCodeAttachment>,
    error: String?,
    onPhoto: () -> Unit,
    onFile: () -> Unit,
    onRemove: (Int) -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Pill(
                label = "Photo",
                leading = Icons.Outlined.Image,
                onClick = onPhoto,
                modifier = Modifier.semantics { testTag = "vibecode-attach-photo" },
            )
            Pill(
                label = "File",
                leading = Icons.Outlined.AttachFile,
                onClick = onFile,
                modifier = Modifier.semantics { testTag = "vibecode-attach-file" },
            )
            if (trailing != null) {
                Spacer(Modifier.weight(1f))
                trailing()
            }
        }
        if (staged.isNotEmpty()) {
            AttachmentChips(staged, onRemove)
        }
        AttachmentNotice(staged)
        if (error != null) {
            Text(
                error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { testTag = "vibecode-attach-error" },
            )
        }
    }
}

internal const val LEFT_OPEN_WARNING =
    "This server couldn't make it invite only, so anyone with the link can open it. You can restrict it from the service's Access settings."

