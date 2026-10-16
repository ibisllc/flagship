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
import com.flagshipserver.app.ui.components.FSCard
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
    Spacer(Modifier.height(FS.space.s4))
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier
            .fillMaxWidth()
            .clickable { nav.navigate(appDbRoute(serviceId)) }
            .testTag("service-detail-database"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    AppDatabaseViewModel.TITLE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    when (val p = phase) {
                        is AppDatabaseViewModel.Phase.Loaded -> AppDatabaseViewModel.summaryText(p.stores)
                        is AppDatabaseViewModel.Phase.Failed -> p.message
                        else -> "Loading…"
                    },
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
            Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 24.sp))
        }
    }
}

@Composable
private fun DbHeader(nav: NavController, title: String, subtitle: String?) {
    Spacer(Modifier.height(FS.space.s8))
    FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
    Spacer(Modifier.height(FS.space.s3))
    Text(
        title,
        color = FS.colors.text,
        style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        modifier = Modifier.testTag("db-title"),
    )
    subtitle?.let {
        Spacer(Modifier.height(FS.space.s1))
        Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
    }
}

private fun Modifier.readingColumn() = this
    .widthIn(max = FSLayout.readingMaxWidth)
    .fillMaxWidth()
    .padding(horizontal = FS.space.s6)

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

    LazyColumn(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        item {
            Column(Modifier.readingColumn()) {
                DbHeader(nav, AppDatabaseViewModel.TITLE, "$appName · ${AppDatabaseViewModel.NOTE}")
                Spacer(Modifier.height(FS.space.s4))
            }
        }
        when (val p = phase) {
            is AppDatabaseViewModel.Phase.Loading -> item { MutedLine("Loading…") }
            is AppDatabaseViewModel.Phase.Hidden -> item {
                MutedLine(if (restricted) "Only your owner device can open the database." else "This server can't show the database.")
            }
            is AppDatabaseViewModel.Phase.Failed -> item {
                Column(Modifier.readingColumn()) {
                    Text(p.message, color = FS.colors.danger, style = TextStyle(fontSize = 14.sp))
                    Spacer(Modifier.height(FS.space.s2))
                    FSSecondaryButton("Try again", onClick = { scope.launch { vm.load() } })
                }
            }
            is AppDatabaseViewModel.Phase.Loaded -> {
                if (p.stores.isEmpty()) item { MutedLine(AppDatabaseViewModel.NO_TABLES) }
                p.stores.forEach { store ->
                    item(key = "store-${store.store}") {
                        Column(Modifier.readingColumn()) {
                            if (p.stores.size > 1) {
                                Spacer(Modifier.height(FS.space.s3))
                                Text(
                                    store.store,
                                    color = FS.colors.textMuted,
                                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                                )
                            }
                            Spacer(Modifier.height(FS.space.s2))
                            if (store.tables.isEmpty()) {
                                Text(AppDatabaseViewModel.NO_TABLES, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                            }
                            store.tables.forEach { t ->
                                FSCard(
                                    padding = PaddingValues(FS.space.s3),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(bottom = FS.space.s2)
                                        .clickable { nav.navigate(appDbTableRoute(serviceId, store.store, t.name)) }
                                        .testTag("db-table-row"),
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                t.name,
                                                color = FS.colors.text,
                                                style = TextStyle(fontSize = 15.sp, fontFamily = FontFamily.Monospace),
                                            )
                                            Text(
                                                "${AppDatabaseViewModel.rowsText(t)} · ${AppDatabaseViewModel.sizeText(t.bytes)}",
                                                color = FS.colors.textMuted,
                                                style = TextStyle(fontSize = 12.sp),
                                            )
                                        }
                                        Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 20.sp))
                                    }
                                }
                            }
                            Spacer(Modifier.height(FS.space.s2))
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
        item { Spacer(Modifier.height(FS.space.s10)) }
    }
}

@Composable
private fun MutedLine(text: String) {
    Column(Modifier.readingColumn()) {
        Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
    }
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

    LazyColumn(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        item {
            Column(Modifier.readingColumn()) {
                DbHeader(nav, table, "${displayName(serviceId)} · $store")
                Spacer(Modifier.height(FS.space.s3))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                    FSSecondaryButton(
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
                }
                Spacer(Modifier.height(FS.space.s3))
                Text(
                    if (page == null) (if (loading) "Loading…" else "") else vm.rangeText(),
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.testTag("db-range"),
                )
                error?.let {
                    Spacer(Modifier.height(FS.space.s2))
                    Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                }
                Spacer(Modifier.height(FS.space.s2))
            }
        }
        page?.let { p -> resultRows(p.columns, p.rows, hScroll, firstRowNumber = offset + 1) }
        item {
            Column(Modifier.readingColumn()) {
                Spacer(Modifier.height(FS.space.s3))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSecondaryButton(
                        "← Previous",
                        enabled = !loading && vm.hasPrevious,
                        modifier = Modifier.testTag("db-prev"),
                        onClick = { scope.launch { vm.previous() } },
                    )
                    FSSecondaryButton(
                        "Next →",
                        enabled = !loading && vm.hasNext,
                        modifier = Modifier.testTag("db-next"),
                        onClick = { scope.launch { vm.next() } },
                    )
                }
                Spacer(Modifier.height(FS.space.s10))
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

    LazyColumn(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        item {
            Column(Modifier.readingColumn()) {
                DbHeader(nav, AppDatabaseViewModel.RUN_SQL, "$appName · $store")
                Spacer(Modifier.height(FS.space.s3))
                Text(AppDbQueryViewModel.HELP, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                Spacer(Modifier.height(FS.space.s3))
                OutlinedTextField(
                    value = sql,
                    onValueChange = {
                        sql = it
                        vm.cancelWrite()
                    },
                    placeholder = { Text("SELECT * FROM …", fontFamily = FontFamily.Monospace) },
                    textStyle = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontFamily = FontFamily.Monospace, color = FS.colors.text),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp).testTag("db-sql-editor"),
                )
                Spacer(Modifier.height(FS.space.s3))
                FSPrimaryButton(
                    label = if (running) "Running…" else AppDbQueryViewModel.RUN,
                    enabled = !running && sql.isNotBlank(),
                    block = true,
                    modifier = Modifier.testTag("db-sql-run"),
                    onClick = { val s = sql; scope.launch { vm.run(s) } },
                )
                when (val p = phase) {
                    is AppDbQueryViewModel.Phase.NeedsGrant -> {
                        Spacer(Modifier.height(FS.space.s3))
                        FSCard(padding = PaddingValues(FS.space.s3), modifier = Modifier.fillMaxWidth().testTag("db-needs-grant")) {
                            Column {
                                Text(
                                    AppDbQueryViewModel.NEEDS_GRANT,
                                    color = FS.colors.text,
                                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
                                )
                                Spacer(Modifier.height(FS.space.s2))
                                if (!adminDevice) {
                                    Text(
                                        com.flagshipserver.app.core.AdminOrderGate.DATABASE_WRITE,
                                        color = FS.colors.textMuted,
                                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                                        modifier = Modifier.testTag("db-write-admin-only"),
                                    )
                                    Spacer(Modifier.height(FS.space.s2))
                                    FSGhostButton(AppDbQueryViewModel.CANCEL, onClick = { vm.cancelWrite() })
                                } else Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                    FSPrimaryButton(
                                        AppDbQueryViewModel.CONFIRM,
                                        onClick = { scope.launch { vm.confirmWrite() } },
                                        modifier = Modifier.testTag("db-confirm-write"),
                                    )
                                    FSGhostButton(AppDbQueryViewModel.CANCEL, onClick = { vm.cancelWrite() })
                                }
                            }
                        }
                    }
                    is AppDbQueryViewModel.Phase.Failed -> {
                        Spacer(Modifier.height(FS.space.s3))
                        Text(
                            p.message,
                            color = FS.colors.danger,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                            modifier = Modifier.testTag("db-sql-error"),
                        )
                    }
                    is AppDbQueryViewModel.Phase.Done -> {
                        Spacer(Modifier.height(FS.space.s3))
                        Text(
                            AppDbQueryViewModel.summaryText(p.result),
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                            modifier = Modifier.testTag("db-sql-summary"),
                        )
                        AppDbQueryViewModel.truncatedText(p.result)?.let {
                            Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp))
                        }
                        Spacer(Modifier.height(FS.space.s2))
                    }
                    else -> Unit
                }
            }
        }
        (phase as? AppDbQueryViewModel.Phase.Done)?.result?.let { r ->
            if (r.columns.isNotEmpty()) resultRows(r.columns, r.rows, hScroll, firstRowNumber = 1)
        }
        item { Spacer(Modifier.height(FS.space.s10)) }
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
                .background(FS.colors.surfaceSunken)
                .horizontalScroll(hScroll)
                .padding(horizontal = FS.space.s4, vertical = FS.space.s2)
                .testTag("db-columns"),
        ) {
            Spacer(Modifier.width(NUMBER_WIDTH))
            columns.forEach { c ->
                Column(Modifier.width(CELL_WIDTH).padding(end = FS.space.s2)) {
                    Text(
                        c.name,
                        color = FS.colors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace),
                    )
                    Text(
                        c.type,
                        color = FS.colors.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = TextStyle(fontSize = 11.sp),
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
                .padding(horizontal = FS.space.s4, vertical = FS.space.s1)
                .testTag("db-row"),
        ) {
            Text(
                "${firstRowNumber + i}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
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
                    style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
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
