// W10 — vibe-code session chat surface (Android parallel of iOS
// VibeCodeChatScreen). Polls GET /api/screens/llm/sessions/<id> and
// surfaces the AI's pending tool request (talkToUser or requestEnvVar)
// with a reply field. The value path for requestEnvVar POSTs first to
// /api/screens/services/<appId>/env/set (the only path that carries
// the secret), then finalizes the model-facing ack via /reply.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.ServiceEnvSetEnvelope
import com.flagshipserver.app.api.ServiceEnvSetRequest
import com.flagshipserver.app.api.VibeCodePendingRequest
import com.flagshipserver.app.api.VibeCodeReplyRequest
import com.flagshipserver.app.api.VibeCodeSessionPublicState
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
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
    // tool pending) surfaces the Deploy button; on success the deployed URL
    // renders. The scratch deploy has no other trigger (the WS stream is a pure
    // relay), so this button IS how a chat-built service ships. Mirror of iOS.
    var deploying by remember { mutableStateOf(false) }
    var deployedUrl by remember { mutableStateOf<String?>(null) }

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value
    val serverFqdn = pods.firstOrNull { it.podId == leaderId }?.fqdn
        ?: pods.firstOrNull()?.fqdn
        ?: "unknown"

    suspend fun reload() {
        try {
            state = client.vibeCodeSessionState(sessionId)
        } catch (t: Throwable) {
            errorMessage = t.message
        }
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
                    s.messages.forEach { msg ->
                        Text(
                            if (msg.role == "user") "YOU" else "AI",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                        )
                        Text(msg.text, color = FS.colors.text)
                        Spacer(Modifier.height(FS.space.s2))
                    }
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
                            Spacer(Modifier.height(FS.space.s3))
                            FSPrimaryButton(
                                label = if (submitting) "Sending…" else "Send",
                                enabled = !submitting && replyDraft.isNotEmpty(),
                                modifier = Modifier.semantics { testTag = "vibecode-reply-send-btn" },
                                onClick = {
                                    scope.launch(Dispatchers.Main) {
                                        submitting = true
                                        try {
                                            client.vibeCodeSessionReply(
                                                sessionId,
                                                VibeCodeReplyRequest(text = replyDraft),
                                            )
                                            replyDraft = ""
                                            reload()
                                        } catch (t: Throwable) {
                                            errorMessage = t.message
                                        } finally {
                                            submitting = false
                                        }
                                    }
                                },
                            )
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
                                    val dashIdx = appId.indexOf('-')
                                    if (dashIdx <= 0) {
                                        errorMessage = "Invalid app id shape"
                                        return@FSPrimaryButton
                                    }
                                    val creator = appId.substring(0, dashIdx)
                                    val slug = appId.substring(dashIdx + 1)
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
                                            client.vibeCodeSessionReply(
                                                sessionId,
                                                VibeCodeReplyRequest(envVarStatus = "set"),
                                            )
                                            envValueDraft = ""
                                            reload()
                                        } catch (t: Throwable) {
                                            errorMessage = t.message
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
                                            client.vibeCodeSessionReply(
                                                sessionId,
                                                VibeCodeReplyRequest(envVarStatus = "declined"),
                                            )
                                            reload()
                                        } catch (t: Throwable) {
                                            errorMessage = t.message
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
        // shipped, since the WS stream never auto-deploys. After a successful
        // deploy the canonical URL renders. Mirror of iOS deploySection.
        val deployed = deployedUrl
        if (deployed != null || s.status == "deployed") {
            FSCard {
                Column {
                    Text(
                        "✓ Deployed",
                        color = FS.colors.success,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    if (deployed != null) {
                        Spacer(Modifier.height(FS.space.s1))
                        Text(
                            deployed,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 13.sp),
                            modifier = Modifier.semantics { testTag = "vibecode-deployed-url" },
                        )
                    }
                }
            }
            Spacer(Modifier.height(FS.space.s3))
        } else if (s.status == "ready-to-deploy" || s.status == "deploying") {
            FSCard {
                Column {
                    Text(
                        "Ready to deploy",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Spacer(Modifier.height(FS.space.s1))
                    Text(
                        "The AI finished writing your service. Deploy it to your box.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                    )
                    Spacer(Modifier.height(FS.space.s3))
                    FSPrimaryButton(
                        label = if (deploying || s.status == "deploying") "Deploying…" else "Deploy",
                        enabled = !deploying && s.status == "ready-to-deploy",
                        modifier = Modifier.semantics { testTag = "vibecode-deploy-btn" },
                        onClick = {
                            scope.launch(Dispatchers.Main) {
                                deploying = true
                                try {
                                    val r = client.vibeCodeDeploy(sessionId)
                                    if (r.ok) {
                                        deployedUrl = r.url
                                    } else {
                                        errorMessage = "Deploy was rejected by the box."
                                    }
                                    reload()
                                } catch (t: Throwable) {
                                    errorMessage = t.message
                                } finally {
                                    deploying = false
                                }
                            }
                        },
                    )
                }
            }
            Spacer(Modifier.height(FS.space.s3))
        }

        if (errorMessage != null) {
            ErrorCard(message = errorMessage!!)
        }
        Spacer(Modifier.height(FS.space.s10))
    }
}

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
