// The photo editor before a picture becomes the page photo (docs/social-tab.md), as on iOS (PhotoCropEditor.swift):
// the square the page will show, the picture moved under it with a drag and zoomed with a pinch, Rotate (a quarter
// clockwise) and Flip (left to right), then Use or Cancel. What is drawn is the map the encoder applies
// (VoiciImageEdit.output), so the preview and the result match.

package com.flagshipserver.app.ui.screens

import android.graphics.Bitmap
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.RotateRight
import androidx.compose.material.icons.outlined.Flip
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.flagshipserver.app.R
import com.flagshipserver.app.core.voici.VoiciImageEdit
import com.flagshipserver.app.core.voici.VoiciJpeg

@Composable
fun PhotoCropEditor(bitmap: Bitmap, onUse: (VoiciImageEdit) -> Unit, onCancel: () -> Unit) {
    var edit by remember(bitmap) { mutableStateOf(VoiciImageEdit.of(bitmap.width, bitmap.height)) }
    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).systemBarsPadding().padding(16.dp).testTag("photo-editor"),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel, modifier = Modifier.testTag("photo-edit-cancel")) { Text(stringResource(R.string.cancel)) }
                Text(stringResource(R.string.voici_photo_edit_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                Button(onClick = { onUse(edit) }, modifier = Modifier.testTag("photo-edit-use")) { Text(stringResource(R.string.voici_photo_use)) }
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                val side = if (maxWidth < maxHeight) maxWidth else maxHeight
                CropArea(bitmap, edit, { edit = it }, Modifier.size(side))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedButton(onClick = { edit = edit.rotate() }, modifier = Modifier.testTag("photo-edit-rotate")) {
                    Icon(Icons.AutoMirrored.Outlined.RotateRight, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.voici_photo_rotate))
                }
                OutlinedButton(onClick = { edit = edit.flip() }, modifier = Modifier.testTag("photo-edit-flip")) {
                    Icon(Icons.Outlined.Flip, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.voici_photo_flip))
                }
            }
            Text(stringResource(R.string.voici_photo_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun CropArea(bitmap: Bitmap, edit: VoiciImageEdit, onEdit: (VoiciImageEdit) -> Unit, modifier: Modifier) {
    val current by rememberUpdatedState(edit)
    val update by rememberUpdatedState(onEdit)
    val paint = remember { Paint(Paint.FILTER_BITMAP_FLAG) }
    val label = stringResource(R.string.voici_photo_crop)
    val maxZoom = VoiciImageEdit.maxZoom(edit.displayWidth, edit.displayHeight).toFloat()
    Box(modifier.aspectRatio(1f).background(Color.White)) {
        Canvas(
            Modifier
                .fillMaxSize()
                .testTag("photo-edit-crop")
                .semantics {
                    contentDescription = label
                    progressBarRangeInfo = ProgressBarRangeInfo(edit.zoom.toFloat(), 1f..maxZoom)
                    setProgress { v -> update(current.withZoom(v.toDouble())); true }
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        update(current.pan(pan.x.toDouble(), pan.y.toDouble(), size.width.toDouble()).let { it.withZoom(it.zoom * zoom) })
                    }
                },
        ) {
            drawIntoCanvas { c ->
                val n = c.nativeCanvas
                n.save()
                n.clipRect(0f, 0f, size.width, size.height)
                n.concat(VoiciJpeg.matrixOf(edit.output(size.width.toDouble())))
                n.drawBitmap(bitmap, 0f, 0f, paint)
                n.restore()
            }
            // The page shows the photo in a circle: dim what falls outside it.
            val outside = Path().apply {
                addRect(Rect(Offset.Zero, size))
                addOval(Rect(Offset.Zero, size))
                fillType = PathFillType.EvenOdd
            }
            drawPath(outside, Color.Black.copy(alpha = 0.45f))
            drawCircle(Color.White.copy(alpha = 0.9f), style = Stroke(1.5.dp.toPx()))
        }
    }
}
