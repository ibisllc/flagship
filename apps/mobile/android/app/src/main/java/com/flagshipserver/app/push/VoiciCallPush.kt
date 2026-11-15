// A voi.ci call ringing this admin device (docs/voici-calls.md §4, §6): `.com` sends a high-priority FCM data message
// (or UnifiedPush) with category "voici-call" and the call's id, the room host, the caller sealed to the page's inbox
// key and the ring's start. Nothing else: Google sees no caller. The call layer (calls/VoiciCallCenter) rings it
// through a self-managed Telecom connection.

package com.flagshipserver.app.push

object VoiciCallPush {
    const val CATEGORY = "voici-call"

    data class Payload(val callId: String, val room: String, val sealed: String, val issuedAt: Long)

    private val CALL_ID = Regex("^[0-9a-f]{32}$")
    private val HOST = Regex("^[a-z0-9.-]{1,253}$")

    fun matches(data: Map<String, String>): Boolean = data["category"] == CATEGORY || data["kind"] == CATEGORY

    fun parse(data: Map<String, String>): Payload? {
        if (!matches(data)) return null
        val callId = data["callId"]?.takeIf { CALL_ID.matches(it) } ?: return null
        val room = data["room"]?.lowercase()?.takeIf { HOST.matches(it) } ?: return null
        val sealed = data["sealed"]?.takeIf { it.isNotEmpty() && it.length <= 8192 } ?: return null
        val issuedAt = data["issuedAt"]?.toLongOrNull() ?: return null
        return Payload(callId, room, sealed, issuedAt)
    }
}
