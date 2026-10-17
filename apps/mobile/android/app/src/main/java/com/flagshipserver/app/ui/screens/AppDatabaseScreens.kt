// The owner's Database section (docs/app-apis.md §6): the entry on the app's
// page, the stores and tables, one table's rows (100 a page, scrolling
// sideways) with Export CSV through the share sheet, and Run SQL, where a
// statement that changes data runs only after the owner confirms and signs it.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppDbColumn
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.AppDatabaseViewModel
import com.flagshipserver.app.viewmodels.AppDbQueryViewModel
import com.flagshipserver.app.viewmodels.AppDbTableViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import java.io.File

fun appDbRoute(serviceId: String) = "app-db/$serviceId"

fun appDbTableRoute(serviceId: String, store: String, table: String) =
    "app-db/$serviceId/table?store=${android.net.Uri.encode(store)}&table=${android.net.Uri.encode(table)}"

fun appDbQueryRoute(serviceId: String, store: String) =
    "app-db/$serviceId/query?store=${android.net.Uri.encode(store)}"

private fun displayName(serviceId: String) = serviceId.substringAfter("--").replaceFirstChar { it.uppercase() }

/** The "Database" entry on the app's page: owner only, an app with a Postgres
 *  store, and a box that has the section (a 404 or 403 hides it). */
@Composable
fun DatabaseEntrySection(nav: NavController, serviceId: String, detail: AppDetailResponse, restricted: Boolean) {
    if (!AppDatabaseViewModel.showsEntry(detail, restricted)) return
    val client = LocalScreensClient.current
    val vm = remember(serviceId, client) { AppDatabaseViewModel(serviceId, client) }
    LaunchedEffect(vm) { vm.load() }
    val phase by vm.phase.collectAsState()
    if (phase is AppDatabaseViewModel.Phase.Hidden) return
    FSGroup(header = AppDatabaseViewModel.TITLE) {
        FSRow(
            title = AppDatabaseViewModel.TITLE,
            subtitle = when (val p = phase) {
                is AppDatabaseViewModel.Phase.Loaded -> AppDatabaseViewModel.summaryText(p.stores)
                is AppDatabaseViewModel.Phase.Failed -> p.message
                else -> "Loading…"
            },
            icon = Icons.Outlined.Storage,
            iconTint = FS.colors.accent,
            onClick = { nav.navigate(appDbRoute(serviceId)) },
            modifier = Modifier.testTag("service-detail-database"),
        )
    }
}

@Composable
private fun DbSubtitle(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyLarge,
        modifier = Modifier.padding(horizontal = FS.space.s1),
    )
}

/** One LazyColumn item's block, spaced like FSScreen's blocks. */
@Composable
private fun DbBlock(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(bottom = FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
    ) { content() }
}

/** Each store's tables: name, approximate rows, size. */
@Composable
fun AppDatabaseScreen(nav: NavController, serviceId: String) {
    val client = LocalScreensClient.current
    val restricted = LocalAppState.current.isRestrictedDevice()
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) { AppDatabaseViewModel(serviceId, client) }
    LaunchedEffect(vm) { vm.load() }
    val phase by vm.phase.collectAsState()
    val appName = displayName(serviceId)

    FSScreen(
        title = AppDatabaseViewModel.TITLE,
        onBack = { nav.popBackStack() },
        titleTag = "db-title",
        scrollable = false,
    ) {
    LazyColumn(Modifier.fillMaxSize()) {
        item { DbBlock { DbSubtitle("$appName · ${AppDatabaseViewModel.NOTE}") } }
        when (val p = phase) {
            is AppDatabaseViewModel.Phase.Loading -> item { MutedLine("Loading…") }
            is AppDatabaseViewModel.Phase.Hidden -> item {
                MutedLine(if (restricted) "Only your owner device can open the database." else "This server can't show the database.")
            }
            is AppDatabaseViewModel.Phase.Failed -> item {
                DbBlock {
                    FSEmptyState(
                        title = "Couldn't load the database",
                        message = p.message,
                        icon = Icons.Outlined.ErrorOutline,
                        iconTint = MaterialTheme.colorScheme.error,
                        action = { FSSecondaryButton("Try again", onClick = { scope.launch { vm.load() } }) },
                    )
                }
            }
            is AppDatabaseViewModel.Phase.Loaded -> {
                if (p.stores.isEmpty()) item { MutedLine(AppDatabaseViewModel.NO_TABLES) }
                p.stores.forEach { store ->
                    item(key = "store-${store.store}") {
                        DbBlock {
                            FSGroup(header = if (p.stores.size > 1) store.store else null) {
                                if (store.tables.isEmpty()) {
                                    FSRow(title = AppDatabaseViewModel.NO_TABLES, titleColor = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                store.tables.forEachIndexed { idx, t ->
                                    if (idx > 0) FSDivider()
                                    FSRow(
                                        title = t.name,
                                        subtitle = "${AppDatabaseViewModel.rowsText(t)} · ${AppDatabaseViewModel.sizeText(t.bytes)}",
                                        icon = Icons.Outlined.TableChart,
                                        onClick = { nav.navigate(appDbTableRoute(serviceId, store.store, t.name)) },
                                        modifier = Modifier.testTag("db-table-row"),
                                    )
                                }
                            }
                            FSSecondaryButton(
                                label = if (p.stores.size > 1) "${AppDatabaseViewModel.RUN_SQL} on ${store.store}" else AppDatabaseViewModel.RUN_SQL,
                                block = true,
                                modifier = Modifier.testTag("db-run-sql"),
                                onClick = { nav.navigate(appDbQueryRoute(serviceId, store.store)) },
                            )
                        }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(FS.space.s6)) }
    }
    }
}

@Composable
private fun MutedLine(text: String) {
    DbBlock { FSNote(text) }
}

/** One table, 100 rows a page, with Export CSV. */
@Composable
fun AppDbTableScreen(nav: NavController, serviceId: String, store: String, table: String) {
    val client = LocalScreensClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, store, table, client) { AppDbTableViewModel(serviceId, store, table, client) }
    LaunchedEffect(vm) { vm.load(0) }
    val page by vm.page.collectAsState()
    val loading by vm.loading.collectAsState()
    val error by vm.error.collectAsState()
    val exporting by vm.exporting.collectAsState()
    val offset by vm.offset.collectAsState()
    val hScroll = rememberScrollState()

    FSScreen(
        title = table,
        onBack = { nav.popBackStack() },
        titleTag = "db-title",
        scrollable = false,
        actions = {
            FSBarAction(
                icon = Icons.Outlined.Share,
                label = if (exporting) "Exporting…" else AppDatabaseViewModel.EXPORT_CSV,
                enabled = !exporting,
                modifier = Modifier.testTag("db-export-csv"),
                onClick = {
                    scope.launch {
                        val csv = vm.exportCsv() ?: return@launch
                        shareCsv(ctx, AppDbTableViewModel.csvFileName(table), csv)
                    }
                },
            )
        },
    ) {
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            DbBlock {
                DbSubtitle("${displayName(serviceId)} · $store")
                Text(
                    if (page == null) (if (loading) "Loading…" else "") else vm.rangeText(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = FS.space.s1).testTag("db-range"),
                )
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        page?.let { p -> resultRows(p.columns, p.rows, hScroll, firstRowNumber = offset + 1) }
        item {
            Row(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                modifier = Modifier.padding(top = FS.space.s4, bottom = FS.space.s6),
            ) {
                FSSecondaryButton(
                    "Previous",
                    enabled = !loading && vm.hasPrevious,
                    modifier = Modifier.weight(1f).testTag("db-prev"),
                    onClick = { scope.launch { vm.previous() } },
                )
                FSSecondaryButton(
                    "Next",
                    enabled = !loading && vm.hasNext,
                    modifier = Modifier.weight(1f).testTag("db-next"),
                    onClick = { scope.launch { vm.next() } },
                )
            }
        }
    }
    }
}

/** Run SQL against one store. */
@Composable
fun AppDbQueryScreen(nav: NavController, serviceId: String, store: String) {
    val appState = LocalAppState.current
    val client = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val appName = displayName(serviceId)
    val signing = com.flagshipserver.app.core.LocalAppOrderSigning.current
    val vm = remember(serviceId, store, client, signing) {
        if (signing != null) {
            AppDbQueryViewModel(serviceId, store, client, appName, fallbackServerDomain = { signing.serverDomain }, signer = signing.signer)
        } else {
            AppDbQueryViewModel(serviceId, store, client, appName, fallbackServerDomain = { appState.sessionPod?.fqdn })
        }
    }
    val phase by vm.phase.collectAsState()
    // A write is a signed `app-db-write/v1` order the box takes from an admin device only.
    val adminDevice = remember(appState) { com.flagshipserver.app.core.AdminOrderGate.allows(appState) }
    var sql by rememberSaveable(serviceId, store) { mutableStateOf("") }
    val hScroll = rememberScrollState()
    val running = phase is AppDbQueryViewModel.Phase.Running

    FSScreen(
        title = AppDatabaseViewModel.RUN_SQL,
        onBack = { nav.popBackStack() },
        titleTag = "db-title",
        scrollable = false,
    ) {
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            DbBlock {
                DbSubtitle("$appName · $store")
                Text(
                    AppDbQueryViewModel.HELP,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = FS.space.s1),
                )
            }
        }
        item {
            DbBlock {
                OutlinedTextField(
                    value = sql,
                    onValueChange = {
                        sql = it
                        vm.cancelWrite()
                    },
                    placeholder = { Text("SELECT * FROM …", fontFamily = FontFamily.Monospace) },
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp).testTag("db-sql-editor"),
                )
                FSPrimaryButton(
                    label = if (running) "Running…" else AppDbQueryViewModel.RUN,
                    enabled = !running && sql.isNotBlank(),
                    block = true,
                    modifier = Modifier.testTag("db-sql-run"),
                    onClick = { val s = sql; scope.launch { vm.run(s) } },
                )
            }
        }
        when (val p = phase) {
            is AppDbQueryViewModel.Phase.NeedsGrant -> item {
                DbBlock {
                    FSCard(modifier = Modifier.testTag("db-needs-grant")) {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Icon(Icons.Outlined.Fingerprint, contentDescription = null, tint = FS.colors.warning)
                                Text(
                                    AppDbQueryViewModel.NEEDS_GRANT,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    style = MaterialTheme.typography.titleSmall,
                                )
                            }
                            if (!adminDevice) {
                                Text(
                                    com.flagshipserver.app.core.AdminOrderGate.DATABASE_WRITE,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.testTag("db-write-admin-only"),
                                )
                                FSSecondaryButton(AppDbQueryViewModel.CANCEL, onClick = { vm.cancelWrite() })
                            } else Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                FSPrimaryButton(
                                    AppDbQueryViewModel.CONFIRM,
                                    onClick = { scope.launch { vm.confirmWrite() } },
                                    modifier = Modifier.testTag("db-confirm-write"),
                                )
                                FSSecondaryButton(AppDbQueryViewModel.CANCEL, onClick = { vm.cancelWrite() })
                            }
                        }
                    }
                }
            }
            is AppDbQueryViewModel.Phase.Failed -> item {
                DbBlock {
                    Text(
                        p.message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("db-sql-error"),
                    )
                }
            }
            is AppDbQueryViewModel.Phase.Done -> item {
                DbBlock {
                    Text(
                        AppDbQueryViewModel.summaryText(p.result),
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.testTag("db-sql-summary"),
                    )
                    AppDbQueryViewModel.truncatedText(p.result)?.let {
                        Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            else -> Unit
        }
        (phase as? AppDbQueryViewModel.Phase.Done)?.result?.let { r ->
            if (r.columns.isNotEmpty()) resultRows(r.columns, r.rows, hScroll, firstRowNumber = 1)
        }
        item { Spacer(Modifier.height(FS.space.s6)) }
    }
    }
}

private val CELL_WIDTH = 160.dp
private val NUMBER_WIDTH = 48.dp
private const val CELL_MAX_CHARS = 300

/** A header row (name and type) and the rows, all sharing one sideways scroll. */
private fun LazyListScope.resultRows(
    columns: List<AppDbColumn>,
    rows: List<List<JsonElement>>,
    hScroll: ScrollState,
    firstRowNumber: Int,
) {
    item(key = "db-header") {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.small)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .horizontalScroll(hScroll)
                .padding(horizontal = FS.space.s2, vertical = FS.space.s2)
                .testTag("db-columns"),
        ) {
            Spacer(Modifier.width(NUMBER_WIDTH))
            columns.forEach { c ->
                Column(Modifier.width(CELL_WIDTH).padding(end = FS.space.s2)) {
                    Text(
                        c.name,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace),
                    )
                    Text(
                        c.type,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
    itemsIndexed(rows) { i, row ->
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(hScroll)
                .padding(horizontal = FS.space.s2, vertical = FS.space.s1)
                .testTag("db-row"),
        ) {
            Text(
                "${firstRowNumber + i}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.width(NUMBER_WIDTH),
            )
            columns.indices.forEach { ci ->
                val cell = row.getOrNull(ci)
                val text = cell?.let { AppDatabaseViewModel.cellText(it) } ?: ""
                Text(
                    text.take(CELL_MAX_CHARS),
                    color = if (cell is kotlinx.serialization.json.JsonNull) FS.colors.textMuted else FS.colors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.width(CELL_WIDTH).padding(end = FS.space.s2),
                )
            }
        }
    }
}

// The FileProvider authority is "<applicationId>.fileprovider" (AndroidManifest
// + res/xml/file_paths.xml). Live data, so only the newest export is kept.
private suspend fun shareCsv(ctx: Context, name: String, csv: ByteArray) {
    val file = withContext(Dispatchers.IO) {
        val dir = File(ctx.cacheDir, "exports")
        dir.deleteRecursively()
        dir.mkdirs()
        File(dir, name).also { it.writeBytes(csv) }
    }
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/csv"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, name)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, "Share $name")
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}
