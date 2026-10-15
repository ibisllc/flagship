// Boot-secret RELAY push on Android — recognise a `secret-request` FCM push
// and surface it via a closure bridge.
//
// `.com` sends FCM only the category plus `{ kind: "secret-request",
// deepLink: https://<apex>/app/secret-requests }`: nothing that names the
// server or what it asks for. A liveness signal ONLY — the phone fetches the
// pending request(s) from `.com`'s mailbox on open and re-verifies them
// against the directory before doing any crypto. See
// docs/security-phone-as-unlock-endpoint.md.

package com.flagshipserver.app.push

/** A `secret-request` push: one of the user's boxes posted a SecretRequest to
 *  its `.com` mailbox and `.com` woke the phone to come finish the handshake. */
data class SecretRequestEvent(
    /** The approvals app link `.com` sent, if any. */
    val deepLink: String?,
)

object SecretRequestPush {
    const val TITLE = "Flagship"
    const val BODY = "A server is waiting for your approval."

    /** Null for any other push, including a shared server's start-up notice,
     *  which rides the same category but opens Home instead. */
    fun parse(data: Map<String, String>): SecretRequestEvent? {
        val kind = data["kind"]
        if (kind != null && kind != "secret-request") return null
        if (kind == null && data["category"] != "secret-request") return null
        return SecretRequestEvent(deepLink = data["deepLink"]?.takeIf { it.isNotEmpty() })
    }
}

/** Closure bridge between the FCM service and the approval UI. The app
 *  (MainActivity / shell) sets `onSecretRequest` to deep-link into the
 *  pending-approvals surface; left null in tests so the parser stays
 *  side-effect-free. */
object SecretRequestBridge {
    @Volatile var onSecretRequest: ((SecretRequestEvent) -> Unit)? = null
}
