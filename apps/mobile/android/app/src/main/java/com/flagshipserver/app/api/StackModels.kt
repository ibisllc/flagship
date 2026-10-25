// Wire shapes of the box's container-stack screen (packages/server-daemon/src/archV2Switch.ts):
// GET /api/stack and POST /api/stack/switch. Mirror of the webapp and iOS models.

package com.flagshipserver.app.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class StackStatus(
    /** `classic` or `arch-v2`. */
    val stack: String,
    /** `docker` or `podman`. */
    val engine: String? = null,
    @SerialName("switch") val switchRecord: StackSwitchRecord? = null,
    val plan: StackPlan,
)

@Serializable
data class StackSwitchRecord(
    /** `installing`, `trial`, `done` or `reverted`. */
    val state: String,
    val target: String,
    val startedAt: Long,
    val trialUntil: Long? = null,
    val finishedAt: Long? = null,
    /** The box's sentence when it went back. */
    val reason: String? = null,
)

@Serializable
data class StackPlan(
    val from: String,
    val target: String,
    /** The box's own sentences, one per step. */
    val steps: List<String> = emptyList(),
    val images: Int = 0,
    val volumes: Int = 0,
    val needBytes: Long = 0,
    val freeBytes: Long = 0,
    val blockers: List<StackBlocker> = emptyList(),
)

@Serializable
data class StackBlocker(val code: String, val error: String)

@Serializable
data class StackSwitchOrderWire(val serverDomain: String, val target: String, val nonce: String, val issuedAt: Long)

/** `POST /api/stack/switch`. */
@Serializable
data class StackSwitchBody(val order: StackSwitchOrderWire, val signature: String, val dryRun: Boolean? = null)

@Serializable
data class StackSwitchReply(val ok: Boolean? = null, val dryRun: Boolean? = null, val state: String? = null, val plan: StackPlan? = null)
