// P8 — browser-viewer wire format.
//
// MIRRORS apps/web/public/webapp/views/browser-viewer.js byte-for-byte
// AND apps/mobile/ios/Sources/FlagshipAPI/Models/BrowserStreamModels.swift.
// The daemon's WS path is `/api/screens/browser-tabs/:tabId/stream`
// (P1.11); the session token rides the URL query param `sessionToken`
// because OkHttp's `WebSocket` upgrade reuses the connection's headers
// once but the daemon-side parser keys auth off the query param the
// same way the webapp does.

package com.flagshipserver.app.api

import org.json.JSONObject

sealed interface BrowserFrame {
    data class Frame(val dataBase64: String) : BrowserFrame
    data class Err(val message: String) : BrowserFrame

    companion object {
        fun decode(json: String): BrowserFrame? = try {
            val obj = JSONObject(json)
            when (obj.optString("kind")) {
                "frame" -> {
                    val b64 = obj.optString("dataBase64", "")
                    if (b64.isEmpty()) null else Frame(b64)
                }
                "error" -> Err(obj.optString("message", "stream error"))
                else -> null
            }
        } catch (_: Throwable) {
            null
        }
    }
}

sealed interface BrowserInput {
    data class MouseDown(val x: Int, val y: Int, val button: String) : BrowserInput
    data class MouseUp(val x: Int, val y: Int, val button: String) : BrowserInput
    data class MouseMove(val x: Int, val y: Int) : BrowserInput
    data class Scroll(val x: Int, val y: Int, val deltaX: Double, val deltaY: Double) : BrowserInput
    data class Key(val eventType: String, val key: String, val code: String) : BrowserInput

    fun toWireJson(): String {
        val outer = JSONObject()
        outer.put("kind", "input")
        val inner = JSONObject()
        when (this) {
            is MouseDown -> {
                inner.put("kind", "mouseDown"); inner.put("x", x); inner.put("y", y); inner.put("button", button)
            }
            is MouseUp -> {
                inner.put("kind", "mouseUp"); inner.put("x", x); inner.put("y", y); inner.put("button", button)
            }
            is MouseMove -> {
                inner.put("kind", "mouseMove"); inner.put("x", x); inner.put("y", y)
            }
            is Scroll -> {
                inner.put("kind", "scroll"); inner.put("x", x); inner.put("y", y)
                inner.put("deltaX", deltaX); inner.put("deltaY", deltaY)
            }
            is Key -> {
                inner.put("kind", "key"); inner.put("eventType", eventType)
                inner.put("key", key); inner.put("code", code)
            }
        }
        outer.put("input", inner)
        return outer.toString()
    }
}
