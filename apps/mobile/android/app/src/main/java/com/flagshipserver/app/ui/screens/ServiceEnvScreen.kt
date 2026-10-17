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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
import com.flagshipserver.app.api.ServiceEnvChange
import com.flagshipserver.app.api.ServiceEnvSetRequest
import com.flagshipserver.app.api.ServiceEnvUnsetRequest
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.LocalVibeCodeEnvelopeSigner
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
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

    FSScreen(
        title = "Configure environment",
        onBack = { nav.popBackStack() },
    ) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Environment variables",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "Names appear here; values stay on this server. They're sealed at rest and never leave it.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }

        errorMessage?.let { ErrorCard(message = it) }

        if (loading) {
            ServerCardSkeleton()
        } else if (names.isEmpty()) {
            FSEmptyState(
                title = "No env vars set",
                message = "Tap below to add one.",
                icon = Icons.Outlined.Key,
            )
        } else {
            FSGroup {
                names.forEachIndexed { idx, name ->
                    if (idx > 0) FSDivider()
                    FSRow(
                        title = name,
                        icon = Icons.Outlined.Key,
                        modifier = Modifier.semantics { testTag = "service-env-row-$name" },
                        trailing = {
                            IconButton(
                                modifier = Modifier.semantics { testTag = "service-env-remove-$name" },
                                onClick = {
                                    scope.launch {
                                        // The signed change names this one variable, so the others stay.
                                        val change = ServiceEnvChange.unset(serverFqdn, appId, name)
                                        try {
                                            val signature = signer(change)
                                            client.serviceEnvUnset(
                                                appId,
                                                ServiceEnvUnsetRequest(change = change, signature = signature),
                                            )
                                            reload()
                                        } catch (t: Throwable) {
                                            errorMessage = t.message
                                        }
                                    }
                                },
                            ) {
                                Icon(Icons.Outlined.Delete, contentDescription = "Remove $name", tint = MaterialTheme.colorScheme.error)
                            }
                        },
                    )
                }
            }
        }

        FSPrimaryButton(
            label = "Add environment variable",
            onClick = { showAddDialog = true },
            block = true,
            modifier = Modifier.semantics { testTag = "service-env-add-btn" },
        )
    }

    if (showAddDialog) {
        AddEnvVarDialog(
            onDismiss = { showAddDialog = false },
            onSubmit = { name, value ->
                scope.launch {
                    ServiceEnvChange.nameError(name)?.let {
                        errorMessage = it
                        return@launch
                    }
                    // One signed change naming this variable and its value's
                    // SHA-256; the box keeps every other variable as it is.
                    val change = ServiceEnvChange.set(serverFqdn, appId, name, value)
                    try {
                        val signature = signer(change)
                        client.serviceEnvSet(
                            appId,
                            ServiceEnvSetRequest(change = change, value = value, signature = signature),
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
    // A name the box can't take is refused here, before anything is signed.
    var nameError by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New environment variable") },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it; nameError = null },
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
                nameError?.let {
                    Spacer(Modifier.height(FS.space.s1))
                    Text(
                        it,
                        color = FS.colors.danger,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.semantics { testTag = "service-env-name-error" },
                    )
                }
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    "The value is sent once to your server. The Flagship phone app does not save it.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val trimmed = name.trim()
                    nameError = ServiceEnvChange.nameError(trimmed)
                    if (nameError == null) onSubmit(trimmed, value)
                },
                enabled = name.isNotEmpty() && value.isNotEmpty(),
                modifier = Modifier.semantics { testTag = "service-env-save-btn" },
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
