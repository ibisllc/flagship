package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.OrgHttp
import com.flagshipserver.app.core.OrgJson
import com.flagshipserver.app.core.pq.OrgAdminEntry
import com.flagshipserver.app.core.pq.OrgAdminKind
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityRecord
import com.flagshipserver.app.core.pq.OrgBylaws
import com.flagshipserver.app.core.pq.OrgSeatRole
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.keystore.OrgSeatRecord
import com.flagshipserver.app.keystore.OrgSeatStore
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** In-memory seat keys: the secrets in plain memory (tests only). */
class FakeOrgSeats : OrgSeatStore {
    val stored = mutableMapOf<String, Pair<OrgSeatRecord, ByteArray?>>()
    var locked = false
    private val rng = SecureRandom()
    override fun seats() = stored.values.map { it.first }
    override fun makeKey(orgId: String, seatId: String, now: Long): Pair<PqTrust.Wire, ByteArray> =
        OrgTestWorld.adminKey(orgId, seatId, now, ByteArray(32).also(rng::nextBytes), ByteArray(32).also(rng::nextBytes))
    override fun remember(orgId: String, seatId: String, orgName: String, genesisHash: String, binding: PqTrust.Wire, secret: ByteArray) {
        stored["$orgId:$seatId"] = OrgSeatRecord(orgId, seatId, orgName, genesisHash, binding, false) to secret.copyOf()
    }
    override fun rememberMember(orgId: String, seatId: String, orgName: String, genesisHash: String, memberBinding: PqTrust.Wire) {
        stored["$orgId:$seatId"] = OrgSeatRecord(orgId, seatId, orgName, genesisHash, memberBinding, true) to null
    }
    override fun sign(seat: OrgSeatRecord, purpose: String, payload: ByteArray): ByteArray? {
        if (locked) return null
        val secret = stored[seat.id]?.second ?: return null
        return PqHybrid.hybridSign(secret, purpose, payload)
    }
}

/**
 * A one-admin org on a fake `.com` that stores what the phones post and serves it back, as
 * packages/control-plane/src/orgs.ts does (without re-verifying: the tests verify).
 */
class OrgTestWorld(val now: Long = 1_800_000_000_000L) {
    companion object {
        fun hex(n: Int) = PqHex.encode(ByteArray(n).also(SecureRandom()::nextBytes))

        fun adminKey(orgId: String, seatId: String, now: Long, ed: ByteArray, ml: ByteArray): Pair<PqTrust.Wire, ByteArray> {
            val kp = PqHybrid.hybridSigKeygen(ed, ml)
            val st = PqTrust.Statement("org-seat-admin", OrgAuthority.seatSubject(orgId, seatId), PqHex.encode(kp.publicKey.copyOfRange(0, 32)),
                PqHex.encode(kp.publicKey.copyOfRange(32, kp.publicKey.size)), now)
            return PqTrust.signPqKeyBinding(st) { m -> PqHybrid.hybridSign(kp.secretKey, PqTrust.TAG_PQ_KEY_BINDING, m) } to kp.secretKey
        }

        fun recordJson(r: OrgAuthorityRecord): JsonObject = buildJsonObject {
            put("orgId", r.orgId); put("version", r.version); put("prevHash", r.prevHash)
            put("admins", buildJsonArray { r.admins.forEach { a -> add(buildJsonObject { put("seatId", a.seatId); put("kind", a.kind.wire); put("binding", a.binding.toJson()) }) } })
            put("bylaws", buildJsonObject { put("overturnSeats", "*"); put("overturnK", r.bylaws.overturnK); put("vetoK", r.bylaws.vetoK) })
            put("founderSeatId", r.founderSeatId); put("kGov", r.kGov); put("kGrant", r.kGrant); put("kDestroy", r.kDestroy); put("kSite", r.kSite)
            put("issuedAt", r.issuedAt)
        }
    }

    val orgId = hex(16)
    val orgName = "acme"
    val founderSeat = hex(16)
    val founderSeats = FakeOrgSeats()
    val record: OrgAuthorityRecord
    val genesisHash: String
    val founder: OrgSeatRecord
    val entries = mutableListOf<JsonElement>()
    val invites = mutableMapOf<String, JsonObject>()
    val offers = mutableMapOf<String, String>()
    val accepts = mutableListOf<JsonObject>()
    val grants = mutableListOf<JsonObject>()
    val revokes = mutableListOf<JsonObject>()
    val ceremonies = mutableListOf<JsonObject>()
    val rings = mutableListOf<JsonObject>()
    val seatKems = mutableListOf<JsonObject>()
    val boxKems = mutableListOf<JsonObject>()
    val servers = mutableListOf<JsonObject>()
    var inviteExpired = false
    val directory = mutableMapOf<String, JsonObject>()
    val freezes = mutableListOf<JsonObject>()
    val created = mutableListOf<JsonObject>()
    val connectors = mutableListOf<JsonObject>()
    val proposals = mutableListOf<JsonObject>()
    val decisions = mutableListOf<JsonObject>()
    val slices = mutableMapOf<String, JsonObject>()
    val calls = mutableListOf<String>()

    init {
        val t0 = now - 3_600_000
        val (binding, secret) = adminKey(orgId, founderSeat, t0, ByteArray(32) { 1 }, ByteArray(32) { 2 })
        record = OrgAuthorityRecord(orgId, 0, OrgAuthority.GENESIS_PREV, listOf(OrgAdminEntry(founderSeat, OrgAdminKind.ADMIN, binding)),
            OrgBylaws(null, 0, 1), founderSeat, 1, 1, 1, 1, t0)
        genesisHash = OrgAuthority.authorityHash(record)
        val keyId = OrgAuthority.keyIdHex(binding.ed25519PubHex, binding.mldsaPubHex)
        val approval = OrgAuthority.signApproval(orgId, 0, OrgAuthority.canonicalAuthority(record), founderSeat, keyId, t0, t0 + 86_400_000) { p, m ->
            PqHybrid.hybridSign(secret, p, m)
        }
        entries += buildJsonObject {
            put("record", recordJson(record)); put("via", "genesis"); put("approvals", buildJsonArray { add(OrgJson.approval(approval)) })
        }
        founderSeats.remember(orgId, founderSeat, orgName, genesisHash, binding, secret)
        founder = founderSeats.seats().single()
    }

    /** An invitation as an admin makes it; returns the link key. */
    fun invite(seatId: String, roles: List<OrgSeatRole>, rolesJson: JsonArray, pseudonym: String = "Pat"): String {
        val linkKey = ByteArray(32).also(SecureRandom()::nextBytes)
        fun seal(b: ByteArray): ByteArray {
            val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(linkKey, "AES"), GCMParameterSpec(128, nonce))
            return nonce + c.doFinal(b)
        }
        val label = seal(pseudonym.toByteArray())
        val offer = buildJsonObject {
            put("orgId", orgId); put("orgName", orgName); put("genesisHash", genesisHash); put("seatId", seatId); put("roles", rolesJson); put("pseudonym", pseudonym)
        }
        val t = now - 60_000
        invites[seatId] = buildJsonObject {
            put("invite", buildJsonObject {
                put("orgId", orgId); put("seatId", seatId); put("labelSha256", OrgAuthority.sha256Hex(label)); put("rolesHash", OrgAuthority.rolesHash(roles))
                put("oarVersion", 0); put("issuedAt", t); put("expiresAt", t + 7 * 86_400_000L)
            })
            put("roles", rolesJson)
        }
        offers[seatId] = PqHex.encode(seal(offer.toString().toByteArray()))
        return PqHex.encode(linkKey)
    }

    private fun seatId(path: String) = path.split('/')[5]

    val http = OrgHttp { method, path, body ->
        calls += "$method $path"
        val base = "/api/orgs/$orgId"
        when {
            method == "GET" && path == "$base/authority" -> 200 to buildJsonObject {
                put("org", buildJsonObject { put("name", orgName) }); put("entries", JsonArray(entries)); put("freezes", JsonArray(emptyList()))
                put("overturns", JsonArray(emptyList())); put("vetoes", JsonArray(emptyList()))
            }
            method == "GET" && path == "$base/seats" -> 200 to buildJsonObject {
                put("grants", JsonArray(grants)); put("revokes", JsonArray(revokes)); put("invites", JsonArray(invites.values.toList())); put("accepts", JsonArray(accepts))
            }
            method == "GET" && path == "$base/ceremonies" -> 200 to buildJsonObject { put("ceremonies", JsonArray(ceremonies)) }
            method == "GET" && path.startsWith("$base/invites/") -> {
                val s = seatId(path)
                if (inviteExpired) 410 to buildJsonObject { put("code", "org-invite-expired") }
                else invites[s]?.let { inv ->
                    200 to JsonObject(inv + mapOf("offerHex" to JsonPrimitive(offers[s]), "accepted" to JsonPrimitive(accepts.any { (it["accept"] as JsonObject)["seatId"] == JsonPrimitive(s) })))
                } ?: (404 to JsonObject(emptyMap()))
            }
            method == "POST" && path.endsWith("/accept") -> { accepts += body!!; 200 to JsonObject(emptyMap()) }
            method == "POST" && path == "$base/seats" -> {
                grants += body!!
                // As .com does: the KEM key a seat sent with its accept becomes its KEM key when the grant lands.
                val sid = ((body["grant"] as JsonObject)["seatId"] as JsonPrimitive).content
                accepts.firstOrNull { ((it["accept"] as JsonObject)["seatId"] as JsonPrimitive).content == sid }?.get("seatKem")?.let { seatKems += it as JsonObject }
                200 to JsonObject(emptyMap())
            }
            method == "GET" && path == "$base/directory/slices" -> 200 to buildJsonObject { put("slices", JsonArray(slices.values.toList())) }
            method == "POST" && path == "$base/directory/slices" -> {
                slices[(((body!!["slice"] as JsonObject)["seatId"]) as JsonPrimitive).content] = body; 200 to JsonObject(emptyMap())
            }
            method == "POST" && path == "$base/ceremonies" -> {
                ceremonies += buildJsonObject {
                    put("sha256", OrgAuthority.sha256Hex((body!!["order"] as JsonPrimitive).content.toByteArray())); put("order", body["order"]!!)
                    put("payload", body["payload"]!!); put("approvals", body["approvals"]!!)
                }
                200 to JsonObject(emptyMap())
            }
            method == "GET" && path == "$base/keys" -> 200 to buildJsonObject {
                put("rings", JsonArray(rings)); put("seatKems", JsonArray(seatKems)); put("boxKems", JsonArray(boxKems))
            }
            method == "GET" && path == "$base/servers" -> 200 to buildJsonObject { put("servers", JsonArray(servers)) }
            method == "POST" && path == "$base/keys" -> { rings += body!!; 200 to JsonObject(emptyMap()) }
            method == "POST" && path == "$base/seat-kems" -> { seatKems += body!!; 200 to JsonObject(emptyMap()) }
            method == "GET" && path == "$base/directory" -> 200 to buildJsonObject { put("entries", JsonArray(directory.values.toList())) }
            method == "POST" && path == "$base/directory" -> {
                val e = body!!["entry"] as JsonObject
                directory[(e["entryId"] as JsonPrimitive).content] = e; 200 to JsonObject(emptyMap())
            }
            method == "POST" && path == "$base/invites" -> {
                val inv = body!!["invite"] as JsonObject
                val s = (inv["seatId"] as JsonPrimitive).content
                invites[s] = buildJsonObject { put("invite", inv); put("roles", body["roles"]!!) }
                offers[s] = (body["offerHex"] as JsonPrimitive).content
                200 to JsonObject(emptyMap())
            }
            method == "GET" && path == "$base/connectors" -> 200 to buildJsonObject { put("connectors", JsonArray(connectors)) }
            method == "POST" && path == "$base/connectors" -> { connectors += body!!; 200 to JsonObject(emptyMap()) }
            method == "GET" && path == "$base/proposals" -> 200 to buildJsonObject { put("proposals", JsonArray(proposals)) }
            method == "POST" && path == "$base/proposals/decisions" -> { decisions += body!!; 200 to JsonObject(emptyMap()) }
            method == "POST" && path == "$base/revokes" -> { revokes += body!!; 200 to JsonObject(emptyMap()) }
            method == "POST" && path == "$base/freezes" -> { freezes += body!!; 200 to JsonObject(emptyMap()) }
            method == "POST" && path == "/api/orgs" -> { created += body!!; 200 to JsonObject(emptyMap()) }
            else -> 404 to JsonObject(emptyMap())
        }
    }
}
