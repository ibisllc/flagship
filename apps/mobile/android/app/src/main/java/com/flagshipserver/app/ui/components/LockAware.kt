package com.flagshipserver.app.ui.components

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SheetState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.DialogProperties

/**
 * Sheets, dialogs and menus live in windows of their own, above everything the
 * activity draws, the lock screen included. While the app is locked the shell is
 * still composed underneath, so a sheet left open would stay on top of the lock
 * screen. These wrappers (same parameters as Material's, imported in their place)
 * draw nothing while locked and ask their owner to dismiss, so a locked app shows
 * only the lock screen and an unlocked one does not bring a stale sheet back.
 */
val LocalAppLocked = compositionLocalOf { false }

@Composable
private fun DismissWhileLocked(onDismissRequest: () -> Unit): Boolean {
    val locked = LocalAppLocked.current
    if (locked) LaunchedEffect(Unit) { onDismissRequest() }
    return locked
}

@Composable
fun AlertDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    icon: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
) {
    if (DismissWhileLocked(onDismissRequest)) return
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismissRequest,
        confirmButton = confirmButton,
        modifier = modifier,
        dismissButton = dismissButton,
        icon = icon,
        title = title,
        text = text,
    )
}

@Composable
fun Dialog(
    onDismissRequest: () -> Unit,
    properties: DialogProperties = DialogProperties(),
    content: @Composable () -> Unit,
) {
    if (DismissWhileLocked(onDismissRequest)) return
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismissRequest, properties = properties, content = content)
}

@Composable
fun DropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (DismissWhileLocked(onDismissRequest)) return
    androidx.compose.material3.DropdownMenu(expanded = expanded, onDismissRequest = onDismissRequest, modifier = modifier, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModalBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    sheetState: SheetState = rememberModalBottomSheetState(),
    containerColor: Color = androidx.compose.material3.BottomSheetDefaults.ContainerColor,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (DismissWhileLocked(onDismissRequest)) return
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        modifier = modifier,
        sheetState = sheetState,
        containerColor = containerColor,
        content = content,
    )
}
