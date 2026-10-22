// W10 — per-app environment-variable KV editor (Android parallel of
// the iOS ServiceEnvScreen). NAMES only on the list path; values are
// typed locally, signed via the IRK envelope signer, and POSTed once
// over the daemon's TLS. The phone NEVER persists the value, NEVER
// logs it, NEVER shows it after the dialog dismisses.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import com.flagshipserver.app.ui.components.OutlinedTextField
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
    /** When set (a marketplace install of an app that needs an LLM key), the
     *  add-dialog auto-opens with this NAME prefilled — the user only pastes
     *  the value, which is set on the box. */
    prefillName: String? = null,
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

    LaunchedEffect(Unit) {
        reload()
        // Marketplace-install deep link: open the add-dialog straight away with
        // the expected env-var name prefilled so the owner just pastes the key.
        if (!prefillName.isNullOrEmpty()) showAddDialog = true
    }

    FSScreen(
        title = stringResource(R.string.configure_environment),
        onBack = { nav.popBackStack() },
    ) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    stringResource(R.string.environment_variables),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(R.string.names_appear_here_values_stay_on),
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
                title = stringResource(R.string.no_env_vars_set),
                message = stringResource(R.string.tap_below_to_add_one),
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
                                Icon(Icons.Outlined.Delete, contentDescription = fsString(R.string.remove, name), tint = MaterialTheme.colorScheme.error)
                            }
                        },
                    )
                }
            }
        }

        FSPrimaryButton(
            label = stringResource(R.string.add_environment_variable),
            onClick = { showAddDialog = true },
            block = true,
            modifier = Modifier.semantics { testTag = "service-env-add-btn" },
        )
    }

    if (showAddDialog) {
        AddEnvVarDialog(
            prefillName = prefillName,
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
    prefillName: String? = null,
    onDismiss: () -> Unit,
    onSubmit: (name: String, value: String) -> Unit,
) {
    // Seed only the NAME from the deep link; the value stays empty for the
    // owner to paste.
    var name by remember { mutableStateOf(prefillName.orEmpty()) }
    var value by remember { mutableStateOf("") }
    // A name the box can't take is refused here, before anything is signed.
    var nameError by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.new_environment_variable)) },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it; nameError = null },
                    label = { Text(stringResource(R.string.name_e_g_openai_api_key)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-env-name-field" },
                )
                Spacer(Modifier.height(FS.space.s2))
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text(stringResource(R.string.value)) },
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
                    stringResource(R.string.the_value_is_sent_once_to),
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
            ) { Text(stringResource(R.string.save)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}
