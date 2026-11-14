// The page's Public switch and its flow (docs/voici-and-messages.md §3.3, docs/social-tab.md §1.1), the round avatar,
// and a sample account's read-only page. Mirrors iOS PageHeader.swift.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.voici.PagePublicStep
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciJpeg
import com.flagshipserver.app.core.voici.VoiciPageUi
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Turning the page public or taking it down: the rules once per device, then the one-time public warning per
 * account, then the signature. Nothing is signed before "Make it public"; a device that can't sign never gets past the
 * first step. One per screen; [PagePublicDialogs] draws its dialogs.
 */
class PagePublicFlow(private val center: VoiciCenter, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private enum class Action { GoPublic, PublishAll }

    var showRules by mutableStateOf(false)
    var showWarning by mutableStateOf(false)
    var confirmRemove by mutableStateOf(false)
    private var action: Action? = null

    fun setPublic(on: Boolean) {
        val p = center.page.value
        if (!p.canPublish || p.publishing) return
        if (on && !p.isPublic) begin(Action.GoPublic) else if (!on && p.isPublic) confirmRemove = true
    }

    /** The editor's Publish bar: while the page is not public, publishing makes it public, so the same steps apply. */
    fun publishAll() {
        val p = center.page.value
        if (!p.canPublish) return
        if (p.isPublic) scope.launch { if (!center.publish(FSStrings.get(R.string.voici_publish_reason))) center.page.value.error?.let { onError(VoiciCopy.publishError(it)) } }
        else begin(Action.PublishAll)
    }

    private fun begin(a: Action) {
        action = a
        advance()
    }

    private fun advance() {
        when (center.publicStep()) {
            PagePublicStep.Refuse -> action = null
            PagePublicStep.Rules -> showRules = true
            PagePublicStep.Warning -> showWarning = true
            PagePublicStep.Publish -> run()
        }
    }

    fun rulesAgreed() {
        showRules = false
        scope.launch {
            center.acceptRules()
            advance()
        }
    }

    fun makePublic() {
        showWarning = false
        scope.launch {
            center.acknowledgePublicWarning()
            run()
        }
    }

    fun cancel() {
        showRules = false
        showWarning = false
        action = null
    }

    fun remove() {
        confirmRemove = false
        scope.launch {
            if (!center.removePage(FSStrings.get(R.string.voici_remove_reason))) center.page.value.error?.let { onError(VoiciCopy.removeError(it)) }
        }
    }

    private fun run() {
        val a = action ?: return
        action = null
        scope.launch {
            val reason = FSStrings.get(R.string.voici_publish_reason)
            val ok = if (a == Action.GoPublic) center.goPublic(reason) else center.publish(reason)
            if (!ok) center.page.value.error?.let { onError(VoiciCopy.publishError(it)) }
        }
    }
}

@Composable
fun rememberPagePublicFlow(center: VoiciCenter): PagePublicFlow {
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    return remember(center) { PagePublicFlow(center, scope) { toasts.error(it) } }
}

@Composable
fun PagePublicDialogs(flow: PagePublicFlow) {
    if (flow.showRules) VoiciRulesDialog(onAgree = { flow.rulesAgreed() }, onDismiss = { flow.cancel() })
    if (flow.showWarning) AlertDialog(
        onDismissRequest = { flow.cancel() },
        title = { Text(stringResource(R.string.voici_public_warning_title)) },
        text = { Text(stringResource(R.string.voici_public_warning_body)) },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_make_it_public), { flow.makePublic() }, modifier = Modifier.testTag("page-make-public")) },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { flow.cancel() }) },
        modifier = Modifier.testTag("page-public-warning"),
    )
    if (flow.confirmRemove) AlertDialog(
        onDismissRequest = { flow.confirmRemove = false },
        title = { Text(stringResource(R.string.voici_remove_title)) },
        text = { Text(stringResource(R.string.voici_remove_body)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_remove), { flow.remove() }, modifier = Modifier.testTag("page-remove-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { flow.confirmRemove = false }) },
        modifier = Modifier.testTag("page-remove-dialog"),
    )
}

/** The Public switch: on = visitors see the page on voi.ci. Off on a device that can't sign the page. */
@Composable
fun PagePublicSwitch(page: VoiciPageUi, flow: PagePublicFlow, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.voici_public)
    Switch(
        checked = page.isPublic,
        onCheckedChange = { flow.setPublic(it) },
        enabled = page.canPublish && !page.publishing,
        modifier = modifier.testTag("page-public-switch").semantics { contentDescription = label },
    )
}

/** A round avatar: the page photo, or an empty person silhouette until one is set. */
@Composable
fun PageAvatar(bytes: ByteArray?, size: Dp, modifier: Modifier = Modifier) {
    val bmp = remember(bytes) { bytes?.let { runCatching { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() } }
    val ring = MaterialTheme.colorScheme.outlineVariant
    if (bmp != null) {
        Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier.size(size).clip(CircleShape).border(1.dp, ring, CircleShape))
    } else {
        Box(
            modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh).border(1.dp, ring, CircleShape),
            contentAlignment = Alignment.BottomCenter,
        ) {
            Icon(Icons.Filled.Person, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f), modifier = Modifier.size(size * 0.82f))
        }
    }
}

/** voi.ci/<username> with a copy button. It writes only the page's address. */
@Composable
fun PageAddressRow(username: String) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(2000); copied = false } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "voi.ci/$username",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        val copyLabel = stringResource(if (copied) R.string.voici_link_copied else R.string.voici_copy_link)
        IconButton(
            onClick = {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("voi.ci", "https://voi.ci/$username"))
                copied = true
            },
            modifier = Modifier.testTag("page-copy-link").semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Icon(if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy, contentDescription = copyLabel, tint = if (copied) FS.colors.success else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
    }
}

/**
 * A sample account's page header, read only: the photo, the name, voi.ci/<username> with copy, the Public switch
 * (disabled), why it can't be changed, and View page (opens voi.ci in the browser).
 */
@Composable
fun DemoPageHeaderCard(demo: com.flagshipserver.app.core.voici.VoiciDemoPageUi) {
    val context = LocalContext.current
    FSCard(Modifier.testTag("messages-demo-page")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                PageAvatar(demo.avatar, 72.dp)
                Column(Modifier.weight(1f)) {
                    Text(
                        demo.displayName,
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("demo-page-name"),
                    )
                    PageAddressRow(demo.username)
                }
            }
            HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.voici_public), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                    Text(
                        stringResource(if (demo.isPublic) R.string.voici_public else R.string.voici_not_public),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("messages-page-status"),
                    )
                }
                val label = stringResource(R.string.voici_public)
                Switch(
                    checked = demo.isPublic,
                    onCheckedChange = null,
                    enabled = false,
                    modifier = Modifier.testTag("demo-page-public-switch").semantics { contentDescription = label },
                )
            }
            Text(
                stringResource(R.string.voici_demo_page_note),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("demo-page-note"),
            )
            FSSecondaryButton(
                stringResource(R.string.voici_view_page),
                {
                    runCatching {
                        context.startActivity(
                            android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse("${com.flagshipserver.app.core.Endpoints.voiciOrigin}/${demo.username}"),
                            ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth().testTag("demo-page-view"),
            )
        }
    }
}
