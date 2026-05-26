// P8 — BrowserViewerViewModel wire-shape + decode contract.
//
// Pins:
//   - BrowserInput.toWireJson() matches the webapp wire format
//     (apps/web/public/webapp/views/browser-viewer.js).
//   - BrowserFrame.decode() handles `frame` / `error` / unknown.
//   - Coordinate transform mirrors the webapp's `toImgCoords`.
//   - VM.apply() on an Err frame surfaces .Failed status + message.
//   - MockScreensClient.browserTabStream records the tabId + accepts
//     bidirectional input.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BrowserFrame
import com.flagshipserver.app.api.BrowserInput
import com.flagshipserver.app.api.MockBrowserStream
import com.flagshipserver.app.api.MockScreensClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BrowserViewerViewModelTest {

    // ── Wire-shape parity ─────────────────────────────────────────

    @Test fun browserInput_mouseDown_encodesToWebappShape() {
        val txt = BrowserInput.MouseDown(42, 17, "left").toWireJson()
        val obj = JSONObject(txt)
        assertEquals("input", obj.getString("kind"))
        val inner = obj.getJSONObject("input")
        assertEquals("mouseDown", inner.getString("kind"))
        assertEquals(42, inner.getInt("x"))
        assertEquals(17, inner.getInt("y"))
        assertEquals("left", inner.getString("button"))
    }

    @Test fun browserInput_mouseUp_encodesToWebappShape() {
        val obj = JSONObject(BrowserInput.MouseUp(1, 2, "left").toWireJson())
        val inner = obj.getJSONObject("input")
        assertEquals("mouseUp", inner.getString("kind"))
        assertEquals(1, inner.getInt("x"))
        assertEquals(2, inner.getInt("y"))
        assertEquals("left", inner.getString("button"))
    }

    @Test fun browserInput_mouseMove_omitsButtonField() {
        val obj = JSONObject(BrowserInput.MouseMove(3, 4).toWireJson())
        val inner = obj.getJSONObject("input")
        assertEquals("mouseMove", inner.getString("kind"))
        assertEquals(3, inner.getInt("x"))
        assertEquals(4, inner.getInt("y"))
        assertTrue("button must NOT appear on mouseMove", !inner.has("button"))
    }

    @Test fun browserInput_scroll_carriesDeltas() {
        val obj = JSONObject(BrowserInput.Scroll(5, 6, 12.5, -33.0).toWireJson())
        val inner = obj.getJSONObject("input")
        assertEquals("scroll", inner.getString("kind"))
        assertEquals(12.5, inner.getDouble("deltaX"), 0.0001)
        assertEquals(-33.0, inner.getDouble("deltaY"), 0.0001)
    }

    @Test fun browserInput_key_carriesEventTypeKeyAndCode() {
        val obj = JSONObject(BrowserInput.Key("keyDown", "a", "KeyA").toWireJson())
        val inner = obj.getJSONObject("input")
        assertEquals("key", inner.getString("kind"))
        assertEquals("keyDown", inner.getString("eventType"))
        assertEquals("a", inner.getString("key"))
        assertEquals("KeyA", inner.getString("code"))
    }

    // ── BrowserFrame decoding ─────────────────────────────────────

    @Test fun browserFrame_decodesFrameMessage() {
        val f = BrowserFrame.decode("""{"kind":"frame","dataBase64":"aGVsbG8="}""")
        assertTrue(f is BrowserFrame.Frame)
        assertEquals("aGVsbG8=", (f as BrowserFrame.Frame).dataBase64)
    }

    @Test fun browserFrame_decodesErrorMessage() {
        val f = BrowserFrame.decode("""{"kind":"error","message":"nav blocked by DomainGate"}""")
        assertTrue(f is BrowserFrame.Err)
        assertEquals("nav blocked by DomainGate", (f as BrowserFrame.Err).message)
    }

    @Test fun browserFrame_unknownKind_returnsNull() {
        assertNull(BrowserFrame.decode("""{"kind":"pong"}"""))
    }

    @Test fun browserFrame_malformedJson_returnsNull() {
        assertNull(BrowserFrame.decode("not json"))
    }

    // ── Coordinate transform ──────────────────────────────────────

    @Test fun coordTransform_mapsViewportToImageNaturalPixels() {
        val (x, y) = BrowserViewerViewModel.toImageCoords(
            touchX = 50f, touchY = 100f,
            viewportWidth = 100f, viewportHeight = 200f,
            imageWidth = 1000, imageHeight = 2000,
        )
        assertEquals(500, x)
        assertEquals(1000, y)
    }

    @Test fun coordTransform_zeroImageDims_fallsBackToViewport() {
        val (x, y) = BrowserViewerViewModel.toImageCoords(
            touchX = 25f, touchY = 75f,
            viewportWidth = 100f, viewportHeight = 200f,
            imageWidth = 0, imageHeight = 0,
        )
        assertEquals(25, x)
        assertEquals(75, y)
    }

    // ── VM behavior ───────────────────────────────────────────────

    @Test fun vm_applyErrorFrame_setsFailedStatusAndMessage() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = BrowserViewerViewModel(mock, "tab-x")
        vm.apply(BrowserFrame.Err("broken"))
        assertEquals("broken", vm.error.value)
        val s = vm.status.value
        assertTrue(s is BrowserViewerViewModel.Status.Failed)
        assertEquals("broken", (s as BrowserViewerViewModel.Status.Failed).message)
    }

    @Test fun vm_applyFrame_oneByOnePng_setsStreaming() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = BrowserViewerViewModel(mock, "tab-y")
        // 1×1 transparent PNG (Robolectric's BitmapFactory decodes).
        val onePxPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        vm.apply(BrowserFrame.Frame(onePxPng))
        assertEquals(BrowserViewerViewModel.Status.Streaming, vm.status.value)
        assertNotNull(vm.frame.value)
    }

    // ── Stream lifecycle through MockScreensClient ────────────────

    @Test fun browserTabStream_recordsTabIdAndCanSendInputs() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val s = mock.browserTabStream("tab-42")
        assertEquals(listOf("tab-42"), mock.browserStreamsOpened)
        s.send(BrowserInput.MouseDown(10, 20, "left"))
        s.send(BrowserInput.MouseUp(10, 20, "left"))
        assertTrue(s is MockBrowserStream)
        val m = s as MockBrowserStream
        assertEquals(2, m.sent.size)
        assertEquals(BrowserInput.MouseDown(10, 20, "left"), m.sent[0])
        s.close()
    }
}
