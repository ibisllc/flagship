// The server page's "Runtime" section (release plan G2): which Node.js the server runs and how it checks out against
// Node's and Flagship's signatures. Ports iOS's RuntimeCard; presentation lives in RuntimeVerificationView (shared vectors).

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import com.flagshipserver.app.R
import com.flagshipserver.app.api.RuntimeVerificationView
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay

private fun RuntimeVerificationView.Tone.pillKind(): FSPillKind = when (this) {
    RuntimeVerificationView.Tone.GOOD -> FSPillKind.Online
    RuntimeVerificationView.Tone.NEUTRAL -> FSPillKind.Idle
    RuntimeVerificationView.Tone.BAD -> FSPillKind.Offline
}

@Composable
internal fun RuntimeSection(view: RuntimeVerificationView) {
    var showDetails by rememberSaveable { mutableStateOf(false) }
    var showCheck by rememberSaveable { mutableStateOf(false) }

    com.flagshipserver.app.ui.components.FSSectionHeader(stringResource(R.string.runtime_title))
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("sd-runtime")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(stringResource(R.string.runtime_intro), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            RuntimeRow(stringResource(R.string.runtime_node)) { RuntimeValue(view.version) }
            RuntimeRow(stringResource(R.string.runtime_platform)) { RuntimeValue(view.platform) }
            RuntimeRow(stringResource(R.string.runtime_running)) { RuntimeValue("v" + view.activeVersion) }
            RuntimeRow(stringResource(R.string.runtime_flagship_signature), Modifier.testTag("sd-runtime-flagship")) {
                FSPill(view.flagshipStatus.label, view.flagshipStatus.tone.pillKind())
            }
            RuntimeRow(stringResource(R.string.runtime_node_signature)) {
                FSPill(view.upstreamStatus.label, view.upstreamStatus.tone.pillKind())
            }
            RuntimeRow(stringResource(R.string.runtime_on_this_server), Modifier.testTag("sd-runtime-local")) {
                FSPill(view.localStatus.label, view.localStatus.tone.pillKind())
            }
            view.notes.forEach { n ->
                Text(
                    n.text,
                    color = if (n.tone == RuntimeVerificationView.Tone.BAD) FS.colors.danger else FS.colors.textMuted,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontWeight = if (n.tone == RuntimeVerificationView.Tone.BAD) FontWeight.Medium else FontWeight.Normal,
                    ),
                )
            }
            Text(
                (if (showDetails) "▾ " else "▸ ") + stringResource(R.string.runtime_details),
                color = FS.colors.text,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { showDetails = !showDetails }
                    .padding(vertical = FS.space.s1)
                    .testTag("sd-runtime-details"),
            )
            if (showDetails) RuntimeDetails(view)
            FSSecondaryButton(
                label = stringResource(R.string.runtime_check_yourself),
                onClick = { showCheck = true },
                block = true,
                modifier = Modifier.testTag("sd-runtime-check"),
            )
        }
    }
    if (showCheck) RuntimeCheckDialog(view, onDismiss = { showCheck = false })
}

@Composable
private fun RuntimeRow(label: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit) {
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.weight(1f).width(FS.space.s2))
        trailing()
    }
}

@Composable
private fun RuntimeValue(text: String) {
    Text(
        text,
        color = FS.colors.text,
        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
        textAlign = TextAlign.End,
    )
}

@Composable
private fun RuntimeDetails(view: RuntimeVerificationView) {
    val uri = LocalUriHandler.current
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        RuntimeHash(stringResource(R.string.runtime_expected_checksum), view.expectedChecksum)
        view.localExecutableSha256?.takeIf { it.isNotEmpty() }?.let { RuntimeHash(stringResource(R.string.runtime_computed_here), it) }
        RuntimeHash(stringResource(R.string.runtime_expected_executable), view.expectedExecutableSha256)
        Column {
            Text(stringResource(R.string.runtime_official_source), color = FS.colors.textMuted, style = MaterialTheme.typography.labelSmall)
            Text(
                view.officialUrl,
                color = FS.colors.accentText,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.clickable { runCatching { uri.openUri(view.officialUrl) } },
            )
        }
    }
}

@Composable
private fun RuntimeHash(label: String, value: String) {
    Column {
        Text(label, color = FS.colors.textMuted, style = MaterialTheme.typography.labelSmall)
        SelectionContainer {
            Text(value, color = FS.colors.text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
        }
    }
}

@Composable
private fun RuntimeCheckDialog(view: RuntimeVerificationView, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    var copied by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(copied) {
        if (copied != null) {
            delay(2_000)
            copied = null
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.runtime_check_yourself)) },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                modifier = Modifier.verticalScroll(rememberScrollState()).testTag("sd-runtime-check-dialog"),
            ) {
                Text(stringResource(R.string.runtime_check_intro), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                view.commands.forEachIndexed { i, cmd ->
                    Text(cmd.title, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
                    SelectionContainer {
                        Text(
                            cmd.text,
                            color = FS.colors.text,
                            softWrap = false,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8))
                                .background(FS.colors.surfaceSunken)
                                .horizontalScroll(rememberScrollState())
                                .padding(FS.space.s3),
                        )
                    }
                    FSSecondaryButton(
                        label = if (copied == i) stringResource(R.string.copied_2) else stringResource(R.string.copy),
                        onClick = {
                            copyCommand(context, cmd.text)
                            copied = i
                        },
                        modifier = Modifier.testTag("sd-runtime-copy-${i + 1}"),
                    )
                }
                Text(
                    "flagshipserver.com/runtime",
                    color = FS.colors.accentText,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.clickable { runCatching { uri.openUri(view.pageUrl) } },
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.close)) } },
    )
}

private fun copyCommand(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    cm?.setPrimaryClip(ClipData.newPlainText("flagship", text))
}
