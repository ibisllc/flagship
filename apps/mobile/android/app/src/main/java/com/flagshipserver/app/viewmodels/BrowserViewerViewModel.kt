// P8 — drives BrowserViewerScreen.
//
// Subscribes to the WS frame stream (ScreensClient.browserTabStream),
// decodes each `frame` into an Android Bitmap, and forwards user
// gestures back as BrowserInput events. Mirrors the webapp viewer at
// apps/web/public/webapp/views/browser-viewer.js.

package com.flagshipserver.app.viewmodels

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.BrowserFrame
import com.flagshipserver.app.api.BrowserInput
import com.flagshipserver.app.api.BrowserStream
import com.flagshipserver.app.api.ScreensClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

class BrowserViewerViewModel(
    private val client: ScreensClient,
    val tabId: String,
) : ViewModel() {

    sealed interface Status {
        data object Idle : Status
        data object Connecting : Status
        data object Streaming : Status
        data object Closed : Status
        data class Failed(val message: String) : Status
    }

    private val _status = MutableStateFlow<Status>(Status.Idle)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _frame = MutableStateFlow<Bitmap?>(null)
    val frame: StateFlow<Bitmap?> = _frame.asStateFlow()

    private val _frameSize = MutableStateFlow(IntSize(0, 0))
    val frameSize: StateFlow<IntSize> = _frameSize.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var stream: BrowserStream? = null
    private var collectorJob: Job? = null

    fun start() {
        if (stream != null) return
        _status.value = Status.Connecting
        val s = client.browserTabStream(tabId)
        stream = s
        collectorJob = viewModelScope.launch {
            s.incoming.collectLatest { f -> apply(f) }
            _status.value = Status.Closed
        }
    }

    fun stop() {
        collectorJob?.cancel()
        collectorJob = null
        stream?.close()
        stream = null
    }

    override fun onCleared() {
        super.onCleared()
        stop()
    }

    /** Decode + dispatch a single frame. Public so tests can drive the
     *  VM directly without spinning up a real WS. */
    fun apply(f: BrowserFrame) {
        when (f) {
            is BrowserFrame.Frame -> {
                val bytes = try { Base64.decode(f.dataBase64, Base64.DEFAULT) } catch (_: Throwable) { return }
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
                _frame.value = bmp
                _frameSize.value = IntSize(bmp.width, bmp.height)
                _status.value = Status.Streaming
            }
            is BrowserFrame.Err -> {
                _error.value = f.message
                _status.value = Status.Failed(f.message)
            }
        }
    }

    suspend fun sendMouseDown(x: Int, y: Int) {
        stream?.send(BrowserInput.MouseDown(x, y, "left"))
    }
    suspend fun sendMouseUp(x: Int, y: Int) {
        stream?.send(BrowserInput.MouseUp(x, y, "left"))
    }
    suspend fun sendMouseMove(x: Int, y: Int) {
        stream?.send(BrowserInput.MouseMove(x, y))
    }
    suspend fun sendScroll(x: Int, y: Int, deltaX: Double, deltaY: Double) {
        stream?.send(BrowserInput.Scroll(x, y, deltaX, deltaY))
    }
    suspend fun sendKey(eventType: String, key: String, code: String) {
        stream?.send(BrowserInput.Key(eventType, key, code))
    }

    data class IntSize(val width: Int, val height: Int)

    companion object {
        /** Convert touch-coords in the viewport's pixel space to the
         *  frame's natural pixel space (mirrors the webapp's
         *  `toImgCoords`). */
        fun toImageCoords(
            touchX: Float, touchY: Float,
            viewportWidth: Float, viewportHeight: Float,
            imageWidth: Int, imageHeight: Int,
        ): Pair<Int, Int> {
            val imgW = if (imageWidth > 0) imageWidth.toFloat() else viewportWidth
            val imgH = if (imageHeight > 0) imageHeight.toFloat() else viewportHeight
            val vw = if (viewportWidth == 0f) 1f else viewportWidth
            val vh = if (viewportHeight == 0f) 1f else viewportHeight
            val x = (touchX / vw) * imgW
            val y = (touchY / vh) * imgH
            return x.roundToInt() to y.roundToInt()
        }
    }
}
