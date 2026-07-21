package com.flagshipserver.app.core

/**
 * Kotlin mirror of `packages/protocol/src/pairingOrder.ts` `pairingOrderToJson` —
 * the PLAINTEXT `add-paired-session` envelope JSON for the SECRET-FREE pairing
 * path (the twin of [SwkDelivery], for the paired-session token).
 *
 * The first recipe carries ZERO pairing secrets. The owner-IRK-signed
 * `add-paired-session` order is serialized into this plaintext `{request,
 * signature}` JSON, which the box parses verbatim. It is either EMBEDDED in the
 * recipe as the unsigned `pairingOrder` sibling (offline) or SEALED to the box's
 * directory identity + deposited on `.com`'s blind pairing-deposit lane
 * post-registration (default online).
 *
 * Built by hand (NOT kotlinx.serialization, whose escaping/ordering we don't want
 * to depend on) to be byte-identical to the TS `pairingOrderToJson` pinned vector
 * (`packages/protocol/tests/pairingOrder.test.ts`): key order
 * `{request:{type,serverId,token,issuedAt}, signature}`, no whitespace,
 * `issuedAt` a bare number.
 */
object PairingOrderEnvelope {
    fun toJson(
        serverId: String,
        token: String,
        issuedAt: Long,
        signatureHex: String,
    ): String {
        val req = "{\"type\":\"add-paired-session\"," +
            "\"serverId\":${jsonString(serverId)}," +
            "\"token\":${jsonString(token)}," +
            "\"issuedAt\":$issuedAt}"
        return "{\"request\":$req,\"signature\":${jsonString(signatureHex)}}"
    }

    /** Minimal JSON string encoder matching `JSON.stringify` for the characters
     *  that can appear in these fields (`"`, `\`, and control chars). */
    fun jsonString(s: String): String {
        val out = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (c.code < 0x20) out.append("\\u%04x".format(c.code)) else out.append(c)
            }
        }
        out.append("\"")
        return out.toString()
    }
}
