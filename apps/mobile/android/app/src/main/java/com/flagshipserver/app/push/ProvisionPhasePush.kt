// Provisioning observability on Android — parse a `provision-phase`
// FCM push into a typed event and surface it via a closure bridge.
//
// Mirror of iOS ProvisionPhaseBridge (apps/mobile/ios/Sources/
// FlagshipCore/ProvisionPhaseBridge.swift) and the Worker fan-out
// payload's discrete fields (packages/control-plane/src/
// provisionEvents.ts `fanOutPhasePush`).

package com.flagshipserver.app.push

/** A provisioning PHASE checkpoint delivered by a `provision-phase`
 *  FCM push from .com. One arrives on every step the box pushes
 *  (boot/cloned/deps/built/identity/registered from the cloud-init
 *  bootstrap, tunnel-online/cert-issued/ready from the daemon, and a
 *  terminal `failed`). One of the @flagship/protocol PROVISION_PHASES. */
data class ProvisionPhaseEvent(
    val username: String,
    val fqdn: String,
    val phase: String,
    /** Present only when `phase == "failed"`. */
    val error: String? = null,
)

/** Pure parser for a `provision-phase` FCM `data` map. Returns null for
 *  any other category so the FCM service can fall through to its
 *  standard notification path. Pure + side-effect-free → unit-testable
 *  without a FirebaseMessagingService. */
object ProvisionPhasePush {
    fun parse(data: Map<String, String>): ProvisionPhaseEvent? {
        // The category lands either as the FCM `category` field or as the
        // `kind` meta field (the Worker sets both); accept either.
        val isPhase = data["category"] == "provision-phase" || data["kind"] == "provision-phase"
        if (!isPhase) return null
        val phase = data["phase"]?.takeIf { it.isNotEmpty() } ?: return null
        val error = data["error"]?.takeIf { it.isNotEmpty() }
        return ProvisionPhaseEvent(
            username = data["username"].orEmpty(),
            fqdn = data["fqdn"].orEmpty(),
            phase = phase,
            error = error,
        )
    }
}

/** Closure bridge between the FCM service and the install-progress UI.
 *  The app (MainActivity / shell) sets `onPhase` to advance its
 *  progress model + Live-Activity-equivalent; left null in tests so the
 *  parser stays side-effect-free. */
object ProvisionPhaseBridge {
    @Volatile var onPhase: ((ProvisionPhaseEvent) -> Unit)? = null
}
