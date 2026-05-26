// P8 — server-side browser viewer.
//
// Renders the JPEG framebuffer the daemon pushes over WS (P1.11) and
// forwards every touch as a `mouseDown` / `mouseMove` / `mouseUp`
// triple to the headless Chromium. Mirrors the webapp viewer at
// apps/web/public/webapp/views/browser-viewer.js + iOS
// FlagshipUI/Screens/BrowserViewerScreen.swift 1:1.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.BrowserViewerViewModel
import kotlinx.coroutines.launch

@Composable
fun BrowserViewerScreen(
    @Suppress("UNUSED_PARAMETER") nav: NavController,
    serviceId: String,
    tabId: String,
) {
    val client = LocalScreensClient.current
    val vm: BrowserViewerViewModel = viewModel(
        key = "$serviceId/$tabId",
        factory = viewModelFactory {
            initializer { BrowserViewerViewModel(client, tabId) }
        },
    )
    val status by vm.status.collectAsState()
    val frame by vm.frame.collectAsState()
    val frameSize by vm.frameSize.collectAsState()
    val scope = rememberCoroutineScope()

    DisposableEffect(tabId) {
        vm.start()
        onDispose { vm.stop() }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (val s = status) {
                is BrowserViewerViewModel.Status.Idle ->
                    Text("Idle", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
                is BrowserViewerViewModel.Status.Connecting -> {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(FS.space.s2))
                    Text("Connecting…", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
                }
                is BrowserViewerViewModel.Status.Streaming ->
                    Text("Streaming tab $tabId", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
                is BrowserViewerViewModel.Status.Closed ->
                    Text("Stream closed", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
                is BrowserViewerViewModel.Status.Failed ->
                    Text(s.message, color = FS.colors.danger, style = TextStyle(fontSize = 14.sp), maxLines = 1)
            }
        }

        var viewportSize by remember { mutableStateOf(IntSize.Zero) }
        var lastDragPos by remember { mutableStateOf(Offset.Zero) }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(FS.colors.surfaceSunken)
                .onSizeChanged { viewportSize = it }
                .pointerInput(tabId) {
                    detectDragGestures(
                        onDragStart = { offset ->
                            lastDragPos = offset
                            val vp = viewportSize
                            val (x, y) = BrowserViewerViewModel.toImageCoords(
                                offset.x, offset.y,
                                vp.width.toFloat(), vp.height.toFloat(),
                                frameSize.width, frameSize.height,
                            )
                            scope.launch { vm.sendMouseDown(x, y) }
                        },
                        onDrag = { change, _ ->
                            lastDragPos = change.position
                            val vp = viewportSize
                            val (x, y) = BrowserViewerViewModel.toImageCoords(
                                change.position.x, change.position.y,
                                vp.width.toFloat(), vp.height.toFloat(),
                                frameSize.width, frameSize.height,
                            )
                            scope.launch { vm.sendMouseMove(x, y) }
                            change.consume()
                        },
                        onDragEnd = {
                            val vp = viewportSize
                            val (x, y) = BrowserViewerViewModel.toImageCoords(
                                lastDragPos.x, lastDragPos.y,
                                vp.width.toFloat(), vp.height.toFloat(),
                                frameSize.width, frameSize.height,
                            )
                            scope.launch { vm.sendMouseUp(x, y) }
                        },
                        onDragCancel = {
                            val vp = viewportSize
                            val (x, y) = BrowserViewerViewModel.toImageCoords(
                                lastDragPos.x, lastDragPos.y,
                                vp.width.toFloat(), vp.height.toFloat(),
                                frameSize.width, frameSize.height,
                            )
                            scope.launch { vm.sendMouseUp(x, y) }
                        },
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            val current = frame
            if (current != null) {
                Image(
                    bitmap = current.asImageBitmap(),
                    contentDescription = "browser framebuffer",
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            } else {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    CircularProgressIndicator()
                    Text(
                        "Waiting for first frame…",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 14.sp),
                    )
                }
            }
        }
    }
}
