// The UnifiedPush counterpart of FlagshipFcmService. `.com` sends each push
// RFC 8291-encrypted to the keys the connector made for this endpoint, so a
// message the connector couldn't decrypt was not sent by `.com` (anyone who
// learns the endpoint URL can post to it) and is dropped.

package com.flagshipserver.app.push

import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class FlagshipUnifiedPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val store = PushTransportStore.from(this)
        val token = UnifiedPushSubscription.providerToken(endpoint.url, endpoint.pubKeySet?.pubKey, endpoint.pubKeySet?.auth)
        if (token == null) {
            fallBack()
            return
        }
        store.unifiedPushToken = token
        PushHolder.registrar?.syncUnifiedPush()
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) return
        val data = decode(message.content) ?: return
        PushMessageHandler.handle(this, data, messageId = null)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        fallBack()
    }

    override fun onUnregistered(instance: String) {
        PushTransportStore.from(this).unifiedPushToken = null
        UnifiedPushTransport.resolve(this) { transport, distributor ->
            PushTransportStore.from(this).setTransport(transport, distributor)
            PushHolder.registrar?.registerCurrentTokenAsync()
        }
    }

    private fun fallBack() {
        val store = PushTransportStore.from(this)
        store.unifiedPushToken = null
        UnifiedPushTransport.unregister(this)
        val transport = PushTransport.choose(false, UnifiedPushTransport.hasPlayServices(this))
        store.setTransport(transport, null)
        PushHolder.registrar?.registerCurrentTokenAsync()
    }

    companion object {
        /** The push's data map; null for anything that isn't a flat JSON object of strings. */
        fun decode(content: ByteArray): MutableMap<String, String>? = runCatching {
            val o = JSONObject(String(content, Charsets.UTF_8))
            val out = mutableMapOf<String, String>()
            for (key in o.keys()) {
                val v = o.get(key)
                if (v is String) out[key] = v
            }
            out.takeIf { it["category"] != null }
        }.getOrNull()
    }
}
