// Boot-secret RELAY push on Android — parse a `secret-request` FCM push
// into a typed event and surface it via a closure bridge.
//
// Mirror of the Worker fan-out payload (the box's SecretRequest woke the
// phone): { kind: "secret-request", serverFqdn, purpose, requestNonceHex }.
// A liveness signal ONLY — it carries no secret; the phone fetches the
// pending request(s) from `.com`'s mailbox on open (the reliable path) and
// re-verifies against the directory before doing any crypto. See
// docs/security-phone-as-unlock-endpoint.md.

package com.flagshipserver.app.push

/** A `secret-request` push: the user's box posted a SecretRequest to its
 *  `.com` mailbox and `.com` woke the phone to come finish the handshake.
 *  PURE routing/matching hints — NOT the security boundary (the phone
 *  re-verifies the box's STK-signed request against the directory). */
data class SecretRequestEvent(
    /** The box's canonical FQDN, e.g. `home.alice.flagship.services`. */
    val serverFqdn: String,
    /** "unlock-key" | "entitlement" — what the box is asking for. */
    val purpose: String,
    /** Echo of the request nonce (matching hint). */
    val requestNonceHex: String,
)

/** Pure parser for a `secret-request` FCM `data` map. Returns null for any
 *  other category so the FCM service can fall through to its standard
 *  notification path. Pure + side-effect-free → unit-testable without a
 *  FirebaseMessagingService. */
object SecretRequestPush {
    fun parse(data: Map<String, String>): SecretRequestEvent? {
        // The category lands either as the FCM `category`/`kind` field; the
        // Worker sets `kind`. Accept either for robustness.
        val isSecret = data["kind"] == "secret-request" || data["category"] == "secret-request"
        if (!isSecret) return null
        val fqdn = data["serverFqdn"]?.takeIf { it.isNotEmpty() } ?: return null
        val purpose = data["purpose"]?.takeIf { it.isNotEmpty() } ?: return null
        return SecretRequestEvent(
            serverFqdn = fqdn,
            purpose = purpose,
            requestNonceHex = data["requestNonceHex"].orEmpty(),
        )
    }
}

/** Closure bridge between the FCM service and the approval UI. The app
 *  (MainActivity / shell) sets `onSecretRequest` to deep-link into the
 *  pending-approvals surface; left null in tests so the parser stays
 *  side-effect-free. */
object SecretRequestBridge {
    @Volatile var onSecretRequest: ((SecretRequestEvent) -> Unit)? = null
}
