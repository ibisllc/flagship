package com.flagshipserver.app.ui.components

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MediumTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout

/**
 * Every screen's frame: a Material top app bar (a collapsing large title on
 * a tab's first screen, like iOS's large titles; a back arrow and a small
 * title on a pushed screen), then one scrolling column with a 16 dp gutter,
 * a reading-width clamp on tablets, and an even [spacing] between blocks.
 *
 * Insets: AppRoot pads the status bar, and the content stops above the
 * navigation bar or the shell's bottom bar (whichever is there). The bar
 * keeps the page colour; a hairline appears under it once content scrolls
 * beneath.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FSScreen(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    /** A collapsing large title. Defaults to the tab roots (no back arrow). */
    largeTitle: Boolean = onBack == null,
    /** A muted line under the title, as the screen's first block. */
    subtitle: String? = null,
    titleTag: String? = null,
    subtitleTag: String? = null,
    actions: @Composable RowScope.() -> Unit = {},
    /** Pull to refresh; [refreshing] shows the spinner while a reload runs. */
    onRefresh: (() -> Unit)? = null,
    refreshing: Boolean = false,
    scrollState: ScrollState = rememberScrollState(),
    spacing: Dp = FS.space.s4,
    floatingActionButton: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    /** False when the body scrolls itself (a LazyColumn, a chat). */
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val scrollBehavior = if (largeTitle) {
        TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    } else {
        TopAppBarDefaults.pinnedScrollBehavior()
    }
    val bg = MaterialTheme.colorScheme.background
    val barColors = TopAppBarDefaults.topAppBarColors(
        containerColor = bg,
        // AppRoot pads the status bar in the page colour, so the bar keeps
        // that colour when content scrolls under it (no seam above it).
        scrolledContainerColor = bg,
    )
    val titleText: @Composable () -> Unit = {
        Text(
            title,
            maxLines = if (largeTitle) 2 else 1,
            overflow = TextOverflow.Ellipsis,
            modifier = if (titleTag != null) Modifier.testTag(titleTag) else Modifier,
        )
    }
    val navIcon: @Composable () -> Unit = {
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.testTag("nav-back")) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        }
    }
    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        containerColor = bg,
        topBar = {
          Column {
            if (largeTitle) {
                MediumTopAppBar(
                    title = titleText,
                    navigationIcon = navIcon,
                    actions = actions,
                    scrollBehavior = scrollBehavior,
                    colors = TopAppBarDefaults.mediumTopAppBarColors(
                        containerColor = bg,
                        scrolledContainerColor = bg,
                    ),
                )
            } else {
                TopAppBar(
                    title = titleText,
                    navigationIcon = navIcon,
                    actions = actions,
                    scrollBehavior = scrollBehavior,
                    colors = barColors,
                )
            }
            if (scrollable && scrollState.value > 0) {
                HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
            }
          }
        },
        floatingActionButton = floatingActionButton,
        bottomBar = bottomBar,
    ) { inner ->
        val body: @Composable () -> Unit = {
            val column = Modifier
                .widthIn(max = FSLayout.readingMaxWidth)
                .fillMaxWidth()
                .padding(horizontal = FS.space.s4)
                .padding(top = FS.space.s2, bottom = FS.space.s6)
            if (scrollable) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(scrollState),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Column(column, verticalArrangement = Arrangement.spacedBy(spacing)) {
                        if (subtitle != null) ScreenSubtitle(subtitle, subtitleTag)
                        content()
                    }
                }
            } else {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Column(
                        column.padding(bottom = 0.dp).weight(1f, fill = true),
                        verticalArrangement = Arrangement.spacedBy(spacing),
                    ) {
                        if (subtitle != null) ScreenSubtitle(subtitle, subtitleTag)
                        content()
                    }
                }
            }
        }
        Box(Modifier.fillMaxSize().padding(inner).consumeWindowInsets(inner)) {
            if (onRefresh != null) {
                PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) { body() }
            } else {
                body()
            }
        }
    }
}

@Composable
private fun ScreenSubtitle(text: String, tag: String?) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyLarge,
        modifier = (if (tag != null) Modifier.testTag(tag) else Modifier).padding(horizontal = FS.space.s1),
    )
}

/** An app-bar action: an icon button with a spoken label. */
@Composable
fun FSBarAction(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier) {
        Icon(icon, contentDescription = label)
    }
}

/**
 * An empty or quiet state inside a card: an optional icon, a title, a line
 * of explanation, and an optional action, all left-aligned with the card's
 * other content.
 */
@Composable
fun FSEmptyState(
    title: String,
    modifier: Modifier = Modifier,
    message: String? = null,
    icon: ImageVector? = null,
    iconTint: Color? = null,
    action: (@Composable () -> Unit)? = null,
) {
    FSCard(modifier = modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = iconTint ?: MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
            }
            Text(title, style = MaterialTheme.typography.titleMedium)
            if (message != null) {
                Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
            if (action != null) {
                Box(Modifier.padding(top = FS.space.s2)) { action() }
            }
        }
    }
}

/** A quiet one-line note inside a card ("Nothing has happened yet."). */
@Composable
fun FSNote(text: String, modifier: Modifier = Modifier) {
    FSCard(modifier = modifier) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Start)
    }
}

/** A hairline across a card. */
@Composable
fun FSCardDivider() {
    HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
}

/** "1 service", "2 services": English count + noun. [plural] defaults to noun + "s". */
fun plural(count: Int, noun: String, plural: String = noun + "s"): String =
    "$count ${if (count == 1) noun else plural}"
