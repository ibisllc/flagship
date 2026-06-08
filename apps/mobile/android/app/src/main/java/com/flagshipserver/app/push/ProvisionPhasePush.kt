// Provisioning observability on Android — parse a canonical
// `provision-status` FCM push into a typed event.
//
// CANONICAL PAYLOAD (LOCKED DESIGN §2.3). The Worker's `fanOutStatusPush`
// (packages/control-plane/src/provisionStatus.ts) emits:
//
//   { category:"provision-status", title, body, deepLink:"flagship://…",
//     meta: { kind:"provision-status", serial, phase, detail? } }
//
// FCM `data` maps are flat string→string, and the Worker's pushBridge
// (sendFcm) flattens this so the Android service sees:
//   data["category"] = "provision-status"
//   data["kind"]     = "provision-status"   (from meta.kind)
//   data["serial"]   = "<serial>"           (from meta.serial)
//   data["phase"]    = "<ProvisionStatusPhase>"  (from meta.phase)
//   data["detail"]   = "<optional>"         (from meta.detail)
//   data["title"] / data["body"] / data["deepLink"]
//
// Per the "foregrounded apps poll" design, push is WAKE-ONLY: the FCM
// service renders the generic title/body/deepLink notification and the
// install-progress screen's poller drives the UI. This parser stays as a
// pure, tested recognizer (contract point 3 — byte-matched to iOS +
// webapp) and is side-effect-free so it's unit-testable without a
// FirebaseMessagingService. The old `provision-phase` push (channel C) is
// RETIRED — this is the ONE provisioning push.

package com.flagshipserver.app.push

/** A provisioning status checkpoint delivered by a `provision-status`
 *  FCM push. `phase` is one of the canonical ProvisionStatusPhase wire
 *  strings (booting…live, terminal `error`). */
data class ProvisionStatusPushEvent(
    val serial: String,
    val phase: String,
    /** Present on `error` (and any phase the Worker chose to annotate). */
    val detail: String? = null,
)

/** Pure parser for a canonical `provision-status` FCM `data` map. Returns
 *  null for any other category so the FCM service can fall through to its
 *  standard notification path. */
object ProvisionStatusPush {
    fun parse(data: Map<String, String>): ProvisionStatusPushEvent? {
        // Recognition key: `category == "provision-status"` OR
        // `kind == "provision-status"` (the Worker sets both — category at
        // the FCM top level, kind flattened from meta).
        val isStatus =
            data["category"] == "provision-status" || data["kind"] == "provision-status"
        if (!isStatus) return null
        // meta.phase is flattened to data["phase"].
        val phase = data["phase"]?.takeIf { it.isNotEmpty() } ?: return null
        val detail = data["detail"]?.takeIf { it.isNotEmpty() }
        return ProvisionStatusPushEvent(
            serial = data["serial"].orEmpty(),
            phase = phase,
            detail = detail,
        )
    }
}
