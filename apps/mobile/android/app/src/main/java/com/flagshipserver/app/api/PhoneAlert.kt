// #91 — the daemon→phone alert outbox (`GET /api/phone/alerts`).
//
// Flagship's trust model has the phone always *initiating* contact — the box
// never pushes. So an "alert" is an event the daemon queued, waiting for the
// next time the phone-paired session drains the queue. The app polls
// `/api/phone/alerts?since=<cursor>` on a foreground interval and ACKs the
// drained range via `POST /api/phone/alerts/ack { throughId }`.
//
// Kotlin mirror of packages/server-daemon/src/phoneAlerts.ts +
// apps/mobile/shared/.../FlagshipAPI/Models/PhoneAlert.swift. We model only the
// AI-chat variant the app acts on today (`ai-chat-needs-you`); other kinds are
// surfaced by their own features. Decoding is lenient (a JsonObject pull, not a
// sealed-class discriminator) so an unknown/forward-compatible alert in the
// queue never fails the whole response.

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** What the AI build chat is waiting on. */
enum class AiChatRequest { REQUEST_ENV_VAR, TALK_TO_USER }

/** A daemon→phone alert. Only the AI-chat variant is modelled with structure;
 *  everything else collapses to [Other] so the response decode never fails. */
sealed interface PhoneAlert {
    /** The AI build chat paused and is waiting on the owner. Value-free: the
     *  session id, what the AI is waiting on, and the pending tool-use id. */
    data class AiChatNeedsYou(
        val sessionId: String,
        val request: AiChatRequest,
        val toolUseId: String,
    ) : PhoneAlert

    /** Any other daemon alert kind — surfaced by its own feature, not here. */
    data class Other(val kind: String) : PhoneAlert
}

/** One envelope in the alert queue: the monotonic id (the ACK cursor) + when
 *  it was queued + the alert. */
data class PhoneAlertEnvelope(
    val id: Int,
    val emittedAt: Int,
    val alert: PhoneAlert,
)

/** `GET /api/phone/alerts` response. */
data class PhoneAlertsResponse(
    val events: List<PhoneAlertEnvelope>,
    val size: Int,
) {
    companion object {
        /** Lenient parse: tolerates unknown alert kinds + missing fields so a
         *  forward-compatible queue never throws. */
        fun parse(body: String, json: Json = Json { ignoreUnknownKeys = true }): PhoneAlertsResponse {
            val root = json.parseToJsonElement(body).jsonObject
            val rawEvents = root["events"]
            val events = if (rawEvents != null && rawEvents is kotlinx.serialization.json.JsonArray) {
                rawEvents.mapNotNull { el -> parseEnvelope(el.jsonObject) }
            } else {
                emptyList()
            }
            val size = root["size"]?.jsonPrimitive?.intOrNull ?: events.size
            return PhoneAlertsResponse(events, size)
        }

        private fun parseEnvelope(obj: JsonObject): PhoneAlertEnvelope? {
            val id = obj["id"]?.jsonPrimitive?.intOrNull ?: return null
            val emittedAt = obj["emittedAt"]?.jsonPrimitive?.intOrNull ?: 0
            val alertObj = obj["alert"]?.jsonObject ?: return null
            return PhoneAlertEnvelope(id, emittedAt, parseAlert(alertObj))
        }

        private fun parseAlert(obj: JsonObject): PhoneAlert {
            val kind = obj["kind"]?.jsonPrimitive?.contentOrNull ?: ""
            return when (kind) {
                "ai-chat-needs-you" -> {
                    val sessionId = obj["serviceId"]?.jsonPrimitive?.contentOrNull ?: ""
                    val requestRaw = obj["request"]?.jsonPrimitive?.contentOrNull ?: ""
                    val toolUseId = obj["toolUseId"]?.jsonPrimitive?.contentOrNull ?: ""
                    val request = when (requestRaw) {
                        "requestEnvVar" -> AiChatRequest.REQUEST_ENV_VAR
                        else -> AiChatRequest.TALK_TO_USER
                    }
                    PhoneAlert.AiChatNeedsYou(sessionId, request, toolUseId)
                }
                else -> PhoneAlert.Other(kind)
            }
        }
    }
}
