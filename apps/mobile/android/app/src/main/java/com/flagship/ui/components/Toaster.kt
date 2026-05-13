// Top-of-screen toast renderer. Subscribes to ToastCenter.queue and
// renders the active toasts as a vertical stack of pill-shaped cards.

package com.flagship.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagship.core.Toast
import com.flagship.ui.theme.FS

@Composable
fun Toaster(queue: List<Toast>, onDismiss: (String) -> Unit) {
    if (queue.isEmpty()) return
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = FS.space.s8, start = FS.space.s4, end = FS.space.s4),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        queue.take(3).forEach { toast ->
            val (bg, fg) = when (toast.kind) {
                Toast.Kind.INFO -> FS.colors.surfaceSunken to FS.colors.text
                Toast.Kind.SUCCESS -> FS.colors.success.copy(alpha = 0.18f) to FS.colors.success
                Toast.Kind.WARNING -> FS.colors.warning.copy(alpha = 0.18f) to FS.colors.warning
                Toast.Kind.ERROR -> FS.colors.danger.copy(alpha = 0.20f) to FS.colors.danger
            }
            ToastRow(message = toast.message, bg = bg, fg = fg, onTap = { onDismiss(toast.id) })
            Spacer(Modifier.height(FS.space.s2))
        }
    }
}

@Composable
private fun ToastRow(message: String, bg: Color, fg: Color, onTap: () -> Unit) {
    Text(
        text = message,
        color = fg,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.lg))
            .background(bg)
            .clickable(onClick = onTap)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s3),
    )
}
