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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.KeyboardHide
import androidx.compose.material.icons.outlined.Sensors
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.BrowserViewerViewModel
import kotlinx.coroutines.launch

@Composable
fun BrowserViewerScreen(
    nav: NavController,
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

    var keyboardVisible by remember { mutableStateOf(false) }

    FSScreen(
        title = "Browser",
        onBack = { nav.popBackStack() },
        scrollable = false,
        spacing = FS.space.s2,
        actions = {
            FSBarAction(
                icon = if (keyboardVisible) Icons.Outlined.KeyboardHide else Icons.Outlined.Keyboard,
                label = if (keyboardVisible) "Hide keyboard" else "Show keyboard",
                onClick = { keyboardVisible = !keyboardVisible },
            )
        },
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = FS.space.s1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        ) {
            when (val s = status) {
                is BrowserViewerViewModel.Status.Idle ->
                    Text("Idle", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                is BrowserViewerViewModel.Status.Connecting -> {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text("Connecting…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
                is BrowserViewerViewModel.Status.Streaming -> {
                    Icon(Icons.Outlined.Sensors, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(18.dp))
                    Text("Streaming tab $tabId", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
                }
                is BrowserViewerViewModel.Status.Closed ->
                    Text("Stream closed", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                is BrowserViewerViewModel.Status.Failed -> {
                    Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                    Text(s.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                }
            }
        }

        // Soft-keyboard input row — visible only when toggled on. Each
        // edit gets diffed against the previous text via the VM's pure
        // `keyEvents()` helper and the resulting keyDown/keyUp pairs are
        // shipped through `vm.sendKey`. Wire format mirrors the webapp
        // viewer byte-for-byte (BrowserInput.key).
        if (keyboardVisible) {
            var keyboardText by remember { mutableStateOf("") }
            val prevText = remember { mutableStateOf("") }
            val focusRequester = remember { FocusRequester() }
            OutlinedTextField(
                value = keyboardText,
                onValueChange = { newText ->
                    val events = BrowserViewerViewModel.keyEvents(prevText.value, newText)
                    for (e in events) {
                        scope.launch { vm.sendKey(e.eventType, e.key, e.code) }
                    }
                    prevText.value = newText
                    keyboardText = newText
                },
                placeholder = { Text("Type to send keys to the page") },
                singleLine = true,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
            )
            LaunchedEffect(keyboardVisible) {
                if (keyboardVisible) focusRequester.requestFocus()
            }
        }

        var viewportSize by remember { mutableStateOf(IntSize.Zero) }
        var lastDragPos by remember { mutableStateOf(Offset.Zero) }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(bottom = FS.space.s4)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
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
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}
