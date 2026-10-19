// The security-notice scenarios' throwaway authority (debug builds only): a
// ca-track mandate chain whose root hashes to a pin of its own, and notices
// signed by its key. The app's own poller keeps the baked pin unless a gym run
// stands this one in (GymSeams.noticePin), so a forged lock is refused the way
// production refuses it. A real notice needs the maintainers' YubiKey.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

class NoticeGymAuthority(seedByte: Int = 0x77, now: Long = System.currentTimeMillis()) {
    private val seed = ByteArray(32) { seedByte.toByte() }
    private val signer = Ed25519Sign(seed)
    val pubHex: String = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)

    private val mandate = Mandate(
        kind = "Mandate",
        version = 1,
        mandateId = "gym-ca-root-$seedByte",
        track = "ca",
        holder = pubHex,
        issuedAt = Instant.ofEpochMilli(now - 86_400_000L).toString(),
        expiresAt = Instant.ofEpochMilli(now + 5L * 365 * 86_400_000L).toString(),
        successors = listOf(pubHex),
        approvalRule = MaintainersApprovalRule("threshold", 1),
        minSuccessors = 1,
        maxDurationSeconds = 157_680_000,
        defaultDurationSeconds = 31_536_000,
        project = null,
        signedBy = pubHex,
        signatures = emptyList(),
    ).let { m ->
        m.copy(signatures = listOf(MaintainersSignature(pubHex, HexUtil.encode(signer.sign(MaintainersCanonical.canonicalMandate(m))))))
    }

    /** The mandate pin a client must be given to trust this authority. */
    val pin: String = MaintainersCanonical.mandatePinHash(mandate)

    val mandates: JsonArray = buildJsonArray {
        add(buildJsonObject {
            put("kind", mandate.kind)
            put("version", mandate.version)
            put("mandateId", mandate.mandateId)
            put("track", mandate.track)
            put("holder", mandate.holder)
            put("issuedAt", mandate.issuedAt)
            put("expiresAt", mandate.expiresAt)
            put("successors", buildJsonArray { mandate.successors.forEach { add(JsonPrimitive(it)) } })
            put("approvalRule", buildJsonObject { put("kind", "threshold"); put("threshold", 1) })
            put("minSuccessors", mandate.minSuccessors)
            put("maxDurationSeconds", mandate.maxDurationSeconds)
            put("defaultDurationSeconds", mandate.defaultDurationSeconds)
            put("signedBy", mandate.signedBy)
            put("signatures", buildJsonArray {
                mandate.signatures.forEach { add(buildJsonObject { put("pubkey", it.pubkey); put("sig", it.sig) }) }
            })
        })
    }

    /** One notice, signed by this authority (the rules are enforced: an unsignable body throws). */
    fun notice(
        seq: Long,
        kind: String,
        validFrom: Long,
        validUntil: Long,
        message: String,
        eventAt: Long = 0,
        lockFrom: Long = 0,
        platforms: Map<String, Pair<Long, Long>> = emptyMap(),
        advisoryId: String = "",
        deprecatesProtocol: Long = 0,
        reason: String = "",
    ): JsonObject {
        val body = buildJsonObject {
            put("seq", seq)
            put("kind", kind)
            put("validFrom", validFrom)
            put("validUntil", validUntil)
            put("eventAt", eventAt)
            put("lockFrom", lockFrom)
            put("platforms", buildJsonObject {
                platforms.forEach { (n, m) -> put(n, buildJsonObject { put("minBuild", m.first); put("minProtocol", m.second) }) }
            })
            put("advisoryId", advisoryId)
            put("deprecatesProtocol", deprecatesProtocol)
            put("reason", reason)
            put("message", message)
        }
        val sig = HexUtil.encode(signer.sign(SecurityNoticeProtocol.canonical(body, pubHex)))
        return buildJsonObject {
            put("type", "SecurityNotice")
            put("version", 1)
            body.forEach { (k, v) -> put(k, v) }
            put("signedBy", pubHex)
            put("signature", sig)
        }
    }

    /** The body `GET /api/notices` answers with. */
    fun response(notice: JsonElement): String = buildJsonObject {
        put("version", 1)
        put("notice", notice)
        put("mandates", mandates)
    }.toString()

    /** One relay hint, signed by this authority (the rules are enforced: an unsignable body throws). */
    fun relayHint(seq: Long, validFrom: Long, validUntil: Long, addresses: List<String>): JsonObject {
        val body = buildJsonObject {
            put("seq", seq)
            put("validFrom", validFrom)
            put("validUntil", validUntil)
            put("addresses", buildJsonArray { addresses.forEach { add(JsonPrimitive(it)) } })
        }
        val sig = HexUtil.encode(signer.sign(RelayHintProtocol.canonical(body, pubHex)))
        return buildJsonObject {
            put("type", "RelayHint")
            put("version", 1)
            body.forEach { (k, v) -> put(k, v) }
            put("signedBy", pubHex)
            put("signature", sig)
        }
    }

    /** The body `GET /api/relay-hints` answers with. */
    fun hintResponse(hint: JsonElement): String = buildJsonObject {
        put("version", 1)
        put("hint", hint)
        put("mandates", mandates)
    }.toString()
}
