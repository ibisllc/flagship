// W10 — per-app environment-variable KV editor (Android parallel of
// the iOS ServiceEnvScreen). NAMES only on the list path; values are
// typed locally, signed via the IRK envelope signer, and POSTed once
// over the daemon's TLS. The phone NEVER persists the value, NEVER
// logs it, NEVER shows it after the dialog dismisses.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
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
import com.flagshipserver.app.api.ServiceEnvUnsetRequest
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun ServiceEnvScreen(
    nav: NavController,
    appId: String,
    creator: String,
    slug: String,
) {
    val client = LocalScreensClient.current
    val appState = LocalAppState.current
    val toasts = LocalToastCenter.current
    val signer = LocalVibeCodeEnvelopeSigner.current
    val scope = rememberCoroutineScope()
    val names = remember { mutableStateListOf<String>() }
    var loading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showAddDialog by remember { mutableStateOf(false) }

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value
    val serverFqdn = pods.firstOrNull { it.podId == leaderId }?.fqdn
        ?: pods.firstOrNull()?.fqdn
        ?: "unknown"

    suspend fun reload() {
        loading = true
        errorMessage = null
        try {
            val resp = client.serviceEnvList(appId)
            names.clear()
            names.addAll(resp.names)
        } catch (t: Throwable) {
            errorMessage = t.message
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

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
            "Configure environment",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))

        FSCard {
            Column {
                Text(
                    "Environment variables",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    "Names appear here; values stay on this server. They're sealed at rest and never leave your pod.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
        }
        Spacer(Modifier.height(FS.space.s4))

        if (errorMessage != null) {
            ErrorCard(message = errorMessage!!)
            Spacer(Modifier.height(FS.space.s3))
        }

        if (loading) {
            ServerCardSkeleton()
        } else if (names.isEmpty()) {
            FSCard {
                Column {
                    Text("No env vars set", color = FS.colors.text)
                    Spacer(Modifier.height(FS.space.s1))
                    Text("Tap below to add one.", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                }
            }
        } else {
            names.forEach { name ->
                FSCard(modifier = Modifier.semantics { testTag = "service-env-row-$name" }) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            name,
                            color = FS.colors.text,
                            modifier = Modifier.weight(1f),
                            style = TextStyle(fontSize = 14.sp),
                        )
                        FSDangerButton(
                            label = "Remove",
                            onClick = {
                                scope.launch {
                                    val issuedAt = System.currentTimeMillis()
                                    val envelope = ServiceEnvSetEnvelope(
                                        serverId = serverFqdn,
                                        creator = creator, slug = slug,
                                        env = emptyMap(),
                                        issuedAt = issuedAt,
                                    )
                                    try {
                                        val signature = signer(envelope)
                                        client.serviceEnvUnset(
                                            appId,
                                            ServiceEnvUnsetRequest(name = name, request = envelope, signature = signature),
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
                Spacer(Modifier.height(FS.space.s2))
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = "Add environment variable",
            onClick = { showAddDialog = true },
            modifier = Modifier.semantics { testTag = "service-env-add-btn" },
        )
        Spacer(Modifier.height(FS.space.s10))
    }

    if (showAddDialog) {
        AddEnvVarDialog(
            onDismiss = { showAddDialog = false },
            onSubmit = { name, value ->
                scope.launch {
                    val issuedAt = System.currentTimeMillis()
                    val envelope = ServiceEnvSetEnvelope(
                        serverId = serverFqdn,
                        creator = creator, slug = slug,
                        env = mapOf(name to value),
                        issuedAt = issuedAt,
                    )
                    try {
                        val signature = signer(envelope)
                        client.serviceEnvSet(
                            appId,
                            ServiceEnvSetRequest(name = name, value = value, request = envelope, signature = signature),
                        )
                        showAddDialog = false
                        reload()
                    } catch (t: Throwable) {
                        errorMessage = t.message
                    }
                }
            },
        )
    }
}

@Composable
private fun AddEnvVarDialog(
    onDismiss: () -> Unit,
    onSubmit: (name: String, value: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New environment variable") },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name (e.g. OPENAI_API_KEY)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-env-name-field" },
                )
                Spacer(Modifier.height(FS.space.s2))
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text("Value") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-env-value-field" },
                )
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    "The value is sent once to your server. The Flagship phone app does not save it.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 11.sp),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSubmit(name, value) },
                enabled = name.isNotEmpty() && value.isNotEmpty(),
                modifier = Modifier.semantics { testTag = "service-env-save-btn" },
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
