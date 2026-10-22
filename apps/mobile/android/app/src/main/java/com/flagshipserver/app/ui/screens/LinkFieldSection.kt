// "Your link" on a service's page (docs/named-links.md): `voi.ci/` and an
// editable name, one line under it, and the buttons that line allows. Kotlin
// mirror of the webapp's lib/linkField.js; the rules are in LinkFieldViewModel.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.flagshipserver.app.R
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LinkField
import com.flagshipserver.app.viewmodels.LinkFieldViewModel
import kotlinx.coroutines.launch

@Composable
internal fun LinkFieldSection(
    vm: LinkFieldViewModel,
    shortCode: String,
    admin: Boolean,
    /** "I own it": hand the typed name to the domain proof. */
    onOwnIt: (name: String) -> Unit,
) {
    val typed by vm.typed.collectAsState()
    val message by vm.message.collectAsState()
    val link by vm.linkState.collectAsState()
    val confirm by vm.confirm.collectAsState()
    val freeUp by vm.freeUp.collectAsState()
    val busy by vm.busy.collectAsState()
    val canUseDefault by vm.canUseDefault.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val mono = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace)

    // Back from the domain proof, the typed name may now be free to take.
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    LaunchedEffect(vm) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) { vm.runCheck() }
    }

    val shown = link.name?.takeIf { it.isNotEmpty() } ?: shortCode
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        Text(
            text = stringResource(R.string.your_link),
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.labelLarge,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("voi.ci/", color = MaterialTheme.colorScheme.onSurfaceVariant, style = mono)
            OutlinedTextField(
                value = typed,
                onValueChange = vm::onTyped,
                singleLine = true,
                readOnly = !admin,
                enabled = !busy,
                textStyle = mono,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    keyboardType = KeyboardType.Uri,
                ),
                modifier = Modifier.weight(1f).padding(horizontal = FS.space.s1).semantics { testTag = "link-field-input" },
            )
            IconButton(onClick = { copyLink(ctx, "https://voi.ci/$shown") }) {
                Icon(
                    Icons.Outlined.ContentCopy,
                    contentDescription = fsString(R.string.copy_2, "voi.ci/$shown"),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (message.text.isNotEmpty()) {
            Text(
                text = message.text,
                color = when (message.tone) {
                    LinkField.Tone.Ok -> FS.colors.success
                    LinkField.Tone.Bad -> FS.colors.danger
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.semantics { testTag = "link-field-message" },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
            if (message.canSave) {
                FSPrimaryButton(
                    label = stringResource(R.string.save),
                    onClick = { scope.launch { vm.requestSave() } },
                    enabled = !busy,
                    modifier = Modifier.semantics { testTag = "link-field-save" },
                )
            }
            if (message.action == LinkField.Action.Dibs) {
                FSSecondaryButton(
                    label = stringResource(R.string.i_own_it),
                    onClick = { onOwnIt(typed.trim()) },
                    modifier = Modifier.semantics { testTag = "link-field-dibs" },
                )
            }
            if (message.action == LinkField.Action.FreeUp) {
                FSSecondaryButton(
                    label = stringResource(R.string.free_one_up),
                    onClick = { scope.launch { vm.openFreeUp() } },
                    modifier = Modifier.semantics { testTag = "link-field-free-up" },
                )
            }
            if (canUseDefault) {
                FSGhostButton(
                    label = stringResource(R.string.use_default),
                    onClick = { scope.launch { vm.requestClear() } },
                    enabled = !busy,
                    modifier = Modifier.semantics { testTag = "link-field-use-default" },
                )
            }
        }
        freeUp?.let { names ->
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1), modifier = Modifier.semantics { testTag = "link-field-names" }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.your_names),
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.weight(1f),
                    )
                    FSGhostButton(label = stringResource(R.string.close), onClick = vm::closeFreeUp)
                }
                names.forEach { entry ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "voi.ci/${entry.name}",
                            color = MaterialTheme.colorScheme.onSurface,
                            style = mono,
                            modifier = Modifier.weight(1f),
                        )
                        FSGhostButton(
                            label = stringResource(R.string.use_default),
                            onClick = { scope.launch { vm.requestClear(entry) } },
                            enabled = !busy,
                        )
                    }
                }
            }
        }
        if (!link.name.isNullOrEmpty() && link.releasesAt != null) {
            Text(
                text = stringResource(R.string.unused_for_60_days_its_released),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    confirm?.let { change ->
        AlertDialog(
            onDismissRequest = vm::dismissConfirm,
            title = { Text(stringResource(R.string.replace_voici_link_confirm, change.replacing)) },
            confirmButton = {
                TextButton(onClick = { scope.launch { vm.confirmPending() } }) {
                    Text(stringResource(R.string.replace), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = vm::dismissConfirm) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

private fun copyLink(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    cm?.setPrimaryClip(ClipData.newPlainText("flagship", text))
}
