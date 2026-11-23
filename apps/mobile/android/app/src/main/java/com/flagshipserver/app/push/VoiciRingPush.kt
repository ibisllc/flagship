// A page owner rings this account back (docs/voici-calls.md, ringing a caller back): `.com` sends a high-priority FCM
// data message (or UnifiedPush) with category "voici-ring", the ring's id and a hint sealed to this account's thread key
// for that page. No text: Google sees no page or caller. calls/VoiciRingCenter opens the hint and rings.

package com.flagshipserver.app.push

object VoiciRingPush {
    const val CATEGORY = "voici-ring"

    /** [tag]: HMAC of the ring id under the caller's ring tag key, so a locked phone can name the page (absent without a key). */
    data class Payload(val ringId: String, val hint: String, val tag: String? = null)

    private val RING_ID = Regex("^[0-9a-f]{32}$")
    private val TAG = Regex("^[0-9a-f]{32}$")

    fun matches(data: Map<String, String>): Boolean = data["category"] == CATEGORY || data["kind"] == CATEGORY

    fun parse(data: Map<String, String>): Payload? {
        if (!matches(data)) return null
        val ringId = data["ringId"]?.takeIf { RING_ID.matches(it) } ?: return null
        val hint = data["hint"]?.takeIf { it.isNotEmpty() && it.length <= 4096 } ?: return null
        val tag = data["tag"]?.takeIf { TAG.matches(it) }
        return Payload(ringId, hint, tag)
    }
}
