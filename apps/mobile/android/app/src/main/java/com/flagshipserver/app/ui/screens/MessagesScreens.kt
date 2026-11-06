// The Messages tab (docs/voici-and-messages.md §11.1): your page, then Messages | Requests, then a thread. Text from
// a visitor is shown only as plain text (Compose `Text`, never HTML); https links in it are underlined and open
// only after "Open <host>?" with the full address shown (§12.1).

package com.flagshipserver.app.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.voici.StoredVoiciConversation
import com.flagshipserver.app.core.voici.StoredVoiciMessage
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciMessages
import com.flagshipserver.app.core.voici.VoiciPageUi
import com.flagshipserver.app.core.voici.VoiciText
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** Bumped when something points to the page (Home, Settings): the Messages tab scrolls back to its header. */
object MessagesScroll {
    val toTop = kotlinx.coroutines.flow.MutableStateFlow(0)
}

/** The app's VoiciCenter (MainActivity provides it; null before an account is open). */
val LocalVoiciCenter = staticCompositionLocalOf<VoiciCenter?> { null }

fun voiciPageStatus(p: VoiciPageUi): String = when {
    !p.canPublish && p.pendingCount > 0 -> FSStrings.get(R.string.voici_waiting_for_admin)
    p.pendingCount == 1 -> FSStrings.get(R.string.voici_one_change_not_published)
    p.pendingCount > 1 -> FSStrings.get(R.string.voici_changes_not_published, p.pendingCount)
    p.publishedSeq > 0 -> FSStrings.get(R.string.voici_published)
    else -> FSStrings.get(R.string.voici_not_published)
}

private fun shortTime(ms: Long): String {
    val now = System.currentTimeMillis()
    return if (now - ms < 86_400_000L) DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))
    else DateFormat.getDateInstance(DateFormat.SHORT).format(Date(ms))
}

@Composable
fun MessagesScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return FSScreen(title = stringResource(R.string.voici_tab)) {
        FSNote(stringResource(R.string.voici_messages_paused))
    }
    val page by center.page.collectAsState()
    val ui by center.messages.collectAsState()
    val scope = rememberCoroutineScope()
    var showRequests by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(center) { center.start() }
    val flow = rememberPagePublicFlow(center)
    val scroll = androidx.compose.foundation.rememberScrollState()
    val density = androidx.compose.ui.platform.LocalDensity.current
    // Like a large title: once the header has scrolled away, a slim bar carries the photo, the name and the switch.
    val collapsed by remember { androidx.compose.runtime.derivedStateOf { scroll.value > with(density) { 180.dp.roundToPx() } } }
    val toTop by MessagesScroll.toTop.collectAsState()
    LaunchedEffect(toTop) { if (toTop > 0) scroll.animateScrollTo(0) }
    PagePublicDialogs(flow)

    FSScreen(
        title = stringResource(R.string.voici_tab),
        titleTag = "messages-title",
        scrollState = scroll,
        topPinned = {
            androidx.compose.animation.AnimatedVisibility(
                visible = collapsed,
                enter = androidx.compose.animation.expandVertically() + androidx.compose.animation.fadeIn(),
                exit = androidx.compose.animation.shrinkVertically() + androidx.compose.animation.fadeOut(),
            ) { PageHeaderBar(center, page, flow) { scope.launch { scroll.animateScrollTo(0) } } }
        },
        onRefresh = { scope.launch { center.refresh() } },
        refreshing = ui.loading,
        actions = { FSBarAction(Icons.Outlined.Settings, stringResource(R.string.voici_settings_title), { nav.navigate("messages-settings") }, Modifier.testTag("messages-settings")) },
    ) {
        // The page is managed here, at the top (Home and Settings only point to it).
        PageHeaderCard(center, page, flow) { nav.navigate("page-editor") }
        val replies by center.replyNotices.collectAsState()
        if (replies.isNotEmpty()) {
            val context = LocalContext.current
            FSGroup {
                replies.forEach { n ->
                    FSRow(
                        title = stringResource(R.string.voici_reply_notice, n.username),
                        icon = Icons.Outlined.ChatBubbleOutline,
                        iconTint = FS.colors.accent,
                        onClick = {
                            scope.launch { center.openedReply(n) }
                            runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, Uri.parse("${com.flagshipserver.app.core.Endpoints.voiciOrigin}/${n.username}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            }
                        },
                        modifier = Modifier.testTag("messages-reply-notice"),
                    )
                }
            }
        }
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = !showRequests, onClick = { showRequests = false },
                shape = SegmentedButtonDefaults.itemShape(0, 2), modifier = Modifier.testTag("messages-segment-messages"),
            ) { Text(stringResource(R.string.voici_segment_messages)) }
            SegmentedButton(
                selected = showRequests, onClick = { showRequests = true },
                shape = SegmentedButtonDefaults.itemShape(1, 2), modifier = Modifier.testTag("messages-segment-requests"),
            ) {
                Text(if (ui.requests.isEmpty()) stringResource(R.string.voici_segment_requests_none) else stringResource(R.string.voici_segment_requests, ui.requests.size))
            }
        }
        val list = if (showRequests) ui.requests else ui.accepted
        if (page.publishedSeq == 0L && ui.conversations.isEmpty()) {
            FSNote(stringResource(R.string.voici_messages_paused))
        } else if (list.isEmpty()) {
            FSEmptyState(
                title = stringResource(if (showRequests) R.string.voici_empty_requests else R.string.voici_empty_messages),
                icon = Icons.Outlined.ChatBubbleOutline,
                modifier = Modifier.testTag("messages-empty"),
            )
        } else {
            FSGroup {
                list.forEachIndexed { i, c ->
                    ConversationRow(c, ui.name(c, VoiciCopy::visitorName), ui.unread(c)) { nav.navigate("thread/${c.conv}") }
                    if (i < list.size - 1) FSDivider(0.dp)
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(c: StoredVoiciConversation, name: String, unread: Boolean, onClick: () -> Unit) {
    val last = c.ordered.lastOrNull()
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s3)
            .testTag("messages-row-${c.conv.take(8)}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Box(Modifier.size(8.dp).background(if (unread) FS.colors.accent else androidx.compose.ui.graphics.Color.Transparent, CircleShape))
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                last?.text?.lineSequence()?.firstOrNull().orEmpty(),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (last != null) Text(shortTime(last.sentAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Message text with its https links marked (the shared strict matcher); a tap asks first. */
@Composable
fun VoiciLinkedText(text: String, color: androidx.compose.ui.graphics.Color, onLink: (String, String) -> Unit, modifier: Modifier = Modifier) {
    val links = remember(text) { VoiciText.findVoiciLinks(text) }
    val annotated: AnnotatedString = remember(text, color) {
        buildAnnotatedString {
            var at = 0
            for (m in links) {
                if (m.start < at || m.end > text.length) continue
                append(text.substring(at, m.start))
                withLink(
                    LinkAnnotation.Clickable(
                        tag = m.url,
                        styles = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline)),
                        linkInteractionListener = { onLink(m.url, m.host) },
                    ),
                ) { append(text.substring(m.start, m.end)) }
                at = m.end
            }
            append(text.substring(at))
        }
    }
    Text(annotated, color = color, style = MaterialTheme.typography.bodyLarge, modifier = modifier)
}

/** "Open <host>?" with the full address, then the system browser. */
@Composable
fun VoiciOpenLinkDialog(url: String, host: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.voici_open_link_title, host)) },
        text = { Text(url, style = MaterialTheme.typography.bodySmall) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_open), {
                onDismiss()
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }, modifier = Modifier.testTag("voici-open-link-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), onDismiss) },
    )
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ThreadScreen(nav: NavController, conv: String) {
    val center = LocalVoiciCenter.current ?: return
    val ui by center.messages.collectAsState()
    val c = ui.conversations.firstOrNull { it.conv == conv } ?: return
    val name = ui.name(c, VoiciCopy::visitorName)
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var draft by rememberSaveable(conv) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var blocking by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var reporting by remember { mutableStateOf<String?>(null) }
    var link by remember { mutableStateOf<Pair<String, String>?>(null) }
    val blocked = c.pseudonymPub in ui.state.blocks
    val request = ui.isRequest(c)
    val listState = rememberLazyListState()
    val ordered = c.ordered
    LaunchedEffect(conv, ordered.size) {
        center.markRead(conv)
        if (ordered.isNotEmpty()) listState.scrollToItem(ordered.size - 1)
    }

    FSScreen(
        title = name,
        onBack = { nav.popBackStack() },
        titleTag = "thread-title",
        scrollable = false,
        actions = {
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.testTag("thread-menu")) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.voici_more))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.voici_menu_rename)) }, onClick = { menu = false; renaming = true }, modifier = Modifier.testTag("thread-rename"))
                    if (request) DropdownMenuItem(text = { Text(stringResource(R.string.voici_menu_accept)) }, onClick = { menu = false; scope.launch { center.accept(conv)?.let { toasts.error(VoiciCopy.sendError(it)) } } }, modifier = Modifier.testTag("thread-accept"))
                    DropdownMenuItem(
                        text = { Text(stringResource(if (blocked) R.string.voici_menu_unblock else R.string.voici_menu_block)) },
                        onClick = { menu = false; if (blocked) scope.launch { center.block(conv, false) } else blocking = true },
                        modifier = Modifier.testTag("thread-block"),
                    )
                    val lastVisitor = ordered.lastOrNull { !it.mine }
                    if (lastVisitor != null) DropdownMenuItem(text = { Text(stringResource(R.string.voici_menu_report)) }, onClick = { menu = false; reporting = lastVisitor.msgId }, modifier = Modifier.testTag("thread-report"))
                    DropdownMenuItem(text = { Text(stringResource(R.string.voici_menu_delete)) }, onClick = { menu = false; deleting = true }, modifier = Modifier.testTag("thread-delete"))
                }
            }
        },
        bottomBar = {
            Row(
                Modifier.fillMaxWidth().padding(FS.space.s3),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { if (it.codePointCount(0, it.length) <= 2000) draft = it },
                    placeholder = { Text(stringResource(R.string.voici_compose_hint)) },
                    modifier = Modifier.weight(1f).testTag("thread-compose"),
                    maxLines = 5,
                )
                IconButton(
                    enabled = draft.isNotBlank() && !sending && !blocked,
                    onClick = {
                        sending = true
                        scope.launch {
                            val err = center.reply(conv, draft.trim())
                            sending = false
                            if (err == null) draft = "" else toasts.error(VoiciCopy.sendError(err))
                        }
                    },
                    modifier = Modifier.testTag("thread-send"),
                ) { Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = stringResource(R.string.voici_send)) }
            }
        },
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().testTag("thread-list"),
            verticalArrangement = Arrangement.spacedBy(FS.space.s2),
        ) {
            if (request) item { FSNote(stringResource(R.string.voici_request_banner), Modifier.testTag("thread-request-banner")) }
            if (c.hasGap) item { FSNote(stringResource(R.string.voici_thread_gap), Modifier.testTag("thread-gap")) }
            val lastMine = ordered.lastOrNull { it.mine }?.msgId
            items(ordered, key = { it.msgId }) { m ->
                Bubble(m, showStatus = m.msgId == lastMine, onLink = { u, h -> link = u to h }, onLongPress = { if (!m.mine) reporting = m.msgId })
            }
        }
    }

    link?.let { (u, h) -> VoiciOpenLinkDialog(u, h) { link = null } }
    if (renaming) RenameDialog(ui.state.nicknames[c.pseudonymPub]?.name ?: "", onDismiss = { renaming = false }) { n ->
        scope.launch {
            val err = center.rename(c.pseudonymPub, n)
            if (err != null) toasts.error(VoiciCopy.sendError(err)) else renaming = false
        }
    }
    if (blocking) AlertDialog(
        onDismissRequest = { blocking = false },
        title = { Text(stringResource(R.string.voici_block_title)) },
        text = { Text(stringResource(R.string.voici_block_body)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_menu_block), {
                blocking = false
                scope.launch {
                    val err = center.block(conv, true)
                    if (err == null) toasts.success(FSStrings.get(R.string.voici_blocked)) else toasts.error(VoiciCopy.sendError(err))
                }
            }, modifier = Modifier.testTag("thread-block-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { blocking = false }) },
    )
    if (deleting) AlertDialog(
        onDismissRequest = { deleting = false },
        title = { Text(stringResource(R.string.voici_delete_title)) },
        text = { Text(stringResource(R.string.voici_delete_body)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_delete), {
                deleting = false
                scope.launch { center.archive(conv); nav.popBackStack() }
            }, modifier = Modifier.testTag("thread-delete-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { deleting = false }) },
    )
    reporting?.let { msgId ->
        ReportDialog(onDismiss = { reporting = null }) { reason ->
            reporting = null
            scope.launch {
                val err = center.report(conv, msgId, reason)
                if (err == null) toasts.success(FSStrings.get(R.string.voici_reported)) else toasts.error(VoiciCopy.sendError(err))
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Bubble(m: StoredVoiciMessage, showStatus: Boolean, onLink: (String, String) -> Unit, onLongPress: () -> Unit) {
    val mine = m.mine
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Box(
            Modifier
                .widthIn(max = 320.dp)
                .background(
                    if (mine) FS.colors.fill else MaterialTheme.colorScheme.surfaceContainerHigh,
                    RoundedCornerShape(16.dp),
                )
                .combinedClickable(onClick = {}, onLongClick = onLongPress)
                .padding(horizontal = FS.space.s3, vertical = FS.space.s2)
                .testTag(if (mine) "bubble-mine" else "bubble-visitor"),
        ) {
            VoiciLinkedText(m.text, if (mine) FS.colors.onAccent else MaterialTheme.colorScheme.onSurface, onLink)
        }
        if (showStatus) {
            Text(
                stringResource(
                    when (m.status) {
                        "direct" -> R.string.voici_status_direct
                        "delivered" -> R.string.voici_status_delivered
                        else -> R.string.voici_status_sent
                    },
                ),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp).testTag("bubble-status"),
            )
        }
    }
}

@Composable
private fun RenameDialog(current: String, onDismiss: () -> Unit, onSave: (String?) -> Unit) {
    var name by remember { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.voici_rename_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(stringResource(R.string.voici_rename_hint), style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(
                    value = name,
                    onValueChange = { if (it.codePointCount(0, it.length) <= 40) name = it },
                    label = { Text(stringResource(R.string.voici_name_label)) },
                    singleLine = true,
                    modifier = Modifier.testTag("rename-field"),
                )
            }
        },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_save), { onSave(name.takeIf { it.isNotBlank() }) }, modifier = Modifier.testTag("rename-save")) },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), onDismiss) },
    )
}

@Composable
private fun ReportDialog(onDismiss: () -> Unit, onReport: (String) -> Unit) {
    var reason by remember { mutableStateOf("spam") }
    val reasons = listOf(
        "spam" to R.string.voici_reason_spam,
        "harassment" to R.string.voici_reason_harassment,
        "impersonation" to R.string.voici_reason_impersonation,
        "illegal" to R.string.voici_reason_illegal,
        "other" to R.string.voici_reason_other,
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.voici_report_title)) },
        text = {
            Column {
                Text(stringResource(R.string.voici_report_body), style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.size(FS.space.s2))
                reasons.forEach { (code, label) ->
                    Row(
                        Modifier.fillMaxWidth().clickable { reason = code }.padding(vertical = FS.space.s1).testTag("report-reason-$code"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        androidx.compose.material3.RadioButton(selected = reason == code, onClick = { reason = code })
                        Text(stringResource(label))
                    }
                }
            }
        },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_report_send), { if (reason in VoiciMessages.VOICI_REPORT_REASONS) onReport(reason) }, modifier = Modifier.testTag("report-send")) },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), onDismiss) },
    )
}
