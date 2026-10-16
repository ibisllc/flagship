// Toast renderer: the active toasts as Material snackbars at the bottom of
// the screen, above the navigation bar and the shell's tab bar. Subscribes
// to ToastCenter.queue.

package com.flagshipserver.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.Toast
import com.flagshipserver.app.ui.theme.DarkColors
import com.flagshipserver.app.ui.theme.LightColors
import com.flagshipserver.app.ui.theme.FS

@Composable
fun Toaster(queue: List<Toast>, onDismiss: (String) -> Unit) {
    if (queue.isEmpty()) return
    Box(
        Modifier
            .fillMaxSize()
            .navigationBarsPadding()
            // Clears the shell's tab bar (80 dp) with a little air.
            .padding(bottom = 88.dp, start = FS.space.s4, end = FS.space.s4),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth(),
        ) {
            queue.take(3).forEach { toast ->
                ToastRow(toast = toast, onTap = { onDismiss(toast.id) })
            }
        }
    }
}

@Composable
private fun ToastRow(toast: Toast, onTap: () -> Unit) {
    // Snackbars sit on the inverse surface (dark in the light theme, cream in
    // the dark one); status icons take the OTHER theme's colours to read on it.
    val inverse = if (FS.colors == DarkColors) LightColors else DarkColors
    val (icon, tint) = when (toast.kind) {
        Toast.Kind.INFO -> Icons.Outlined.Info to inverse.primary
        Toast.Kind.SUCCESS -> Icons.Outlined.CheckCircle to inverse.success
        Toast.Kind.WARNING -> Icons.Outlined.WarningAmber to inverse.warning
        Toast.Kind.ERROR -> Icons.Outlined.ErrorOutline to inverse.danger
    }
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.inverseSurface,
        contentColor = MaterialTheme.colorScheme.inverseOnSurface,
        shadowElevation = 6.dp,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onTap),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.padding(horizontal = FS.space.s4, vertical = 14.dp),
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
            Text(text = toast.message, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
