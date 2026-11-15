package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.OrgClientException
import com.flagshipserver.app.core.memberKey
import com.flagshipserver.app.core.num
import com.flagshipserver.app.core.str
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityException
import com.flagshipserver.app.core.pq.OrgAuthorityWire
import com.flagshipserver.app.core.pq.OrgSeatRole
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.keystore.OrgSeatStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Joining an organization from an `/org-join` link (docs/enterprise-accounts.md §7); the Kotlin twin
 * of iOS `OrgJoinViewModel`. The link key opens the offer the inviter sealed; the org's chain must
 * verify from the genesis in it; Join derives the seat member key from the UMK (and makes a random
 * admin key for an admin role), signs the acceptance and shows the 6-digit code to compare.
 */
class OrgJoinViewModel(
    private val orgId: String,
    private val seatId: String,
    private val keyHex: String,
    private val client: OrgClient,
    private val keys: OrgSeatStore,
    /** The UMK, behind the unlock prompt. */
    private val umk: suspend (reason: String) -> ByteArray,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Phase {
        data object Loading : Phase
        data class Ready(val orgName: String, val pseudonym: String, val isAdminRole: Boolean) : Phase
        data class Accepted(val code: String) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Loading)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private var offer: JsonObject = JsonObject(emptyMap())
    private var invite: JsonObject = JsonObject(emptyMap())
    private var roles: List<OrgSeatRole> = emptyList()

    private fun openOffer(sealed: ByteArray, key: ByteArray): ByteArray {
        require(sealed.size > 28 && key.size == 32)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
        return c.doFinal(sealed.copyOfRange(12, sealed.size))
    }

    suspend fun load() {
        _phase.value = Phase.Loading
        try {
            val r = client.inviteOffer(orgId, seatId)
            val sealed = str(r, "offerHex")?.let { PqHex.decode(it) } ?: throw OrgAuthorityException("malformed")
            val key = PqHex.decode(keyHex) ?: throw OrgAuthorityException("malformed")
            val inv = r["invite"] as? JsonObject ?: throw OrgAuthorityException("malformed")
            if ((r["accepted"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true") {
                _phase.value = Phase.Failed(FSStrings.get(R.string.org_join_already))
                return
            }
            val o = Json.parseToJsonElement(String(openOffer(sealed, key), Charsets.UTF_8)) as? JsonObject ?: throw OrgAuthorityException("malformed")
            if (str(o, "orgId") != orgId || str(o, "seatId") != seatId) throw OrgAuthorityException("malformed")
            val genesis = str(o, "genesisHash") ?: throw OrgAuthorityException("malformed")
            // The org's chain must verify from the genesis the inviter sealed into the offer.
            client.snapshot(orgId, genesis, now())
            offer = o; invite = inv
            roles = OrgAuthorityWire.roles(r["roles"])
            _phase.value = Phase.Ready(str(o, "orgName") ?: "", str(o, "pseudonym") ?: "", roles.any { it.raisesAdmin })
        } catch (e: OrgClientException) {
            _phase.value = Phase.Failed(
                if (e.code == "org-invite-expired") FSStrings.get(R.string.org_join_expired) else FSStrings.get(R.string.org_join_bad_link),
            )
        } catch (e: Exception) {
            _phase.value = Phase.Failed(FSStrings.get(R.string.org_join_bad_link))
        }
    }

    suspend fun accept() {
        if (_phase.value !is Phase.Ready) return
        val genesis = str(offer, "genesisHash") ?: return
        _busy.value = true
        val t = now()
        try {
            val seed = umk(FSStrings.get(R.string.org_join_reason))
            val kemSeed: ByteArray
            val (memberBinding, memberSecret) = try {
                kemSeed = com.flagshipserver.app.core.pq.OrgServers.seatKemSeed(seed, orgId)
                OrgAuthority.memberKey(seed, orgId, seatId, t)
            } finally { seed.fill(0) }
            // The seat's X-Wing key rides with the accept; `.com` records it when the grant lands, so this
            // seat receives new key-ring versions without opening the org page first.
            val kem = try { PqHybrid.hybridSealKeygen(kemSeed) } finally { kemSeed.fill(0) }
            val kemKeyId = com.flagshipserver.app.core.pq.OrgServers.kemKeyIdHex(kem.publicKey)
            val kemMsg = com.flagshipserver.app.core.pq.OrgServers.canonicalSeatKem(orgId, seatId, kemKeyId, t)
            val memberKeyId = OrgAuthority.keyIdHex(memberBinding.ed25519PubHex, memberBinding.mldsaPubHex)
            val admin = if (roles.any { it.raisesAdmin }) keys.makeKey(orgId, seatId, t) else null
            val adminKeyId = admin?.let { OrgAuthority.keyIdHex(it.first.ed25519PubHex, it.first.mldsaPubHex) } ?: ""
            val inviteSha = OrgAuthority.sha256Hex(
                OrgAuthority.canonicalSeatInvite(
                    orgId, seatId, str(invite, "labelSha256") ?: throw OrgAuthorityException("malformed"),
                    str(invite, "rolesHash") ?: throw OrgAuthorityException("malformed"),
                    num(invite, "oarVersion") ?: throw OrgAuthorityException("malformed"),
                    num(invite, "issuedAt") ?: throw OrgAuthorityException("malformed"),
                    num(invite, "expiresAt") ?: throw OrgAuthorityException("malformed"),
                ),
            )
            val msg = OrgAuthority.canonicalSeatAccept(orgId, seatId, inviteSha, memberKeyId, adminKeyId, t)
            val sig: ByteArray
            val kemSig: ByteArray
            try {
                sig = PqHybrid.hybridSign(memberSecret, OrgAuthority.TAG_SEAT_ACCEPT, msg)
                kemSig = PqHybrid.hybridSign(memberSecret, com.flagshipserver.app.core.pq.OrgServers.TAG_SEAT_KEM, kemMsg)
            } finally { memberSecret.fill(0) }
            client.accept(orgId, seatId, buildJsonObject {
                put("accept", buildJsonObject {
                    put("orgId", orgId); put("seatId", seatId); put("inviteSha256", inviteSha)
                    put("memberKeyId", memberKeyId); put("adminKeyId", adminKeyId); put("issuedAt", t)
                })
                put("memberBinding", memberBinding.toJson())
                put("adminBinding", admin?.first?.toJson() ?: JsonNull)
                put("signature", PqHex.encode(sig))
                put("seatKem", buildJsonObject {
                    put("statement", buildJsonObject { put("orgId", orgId); put("seatId", seatId); put("kemKeyId", kemKeyId); put("issuedAt", t) })
                    put("kemPubHex", PqHex.encode(kem.publicKey))
                    put("signature", PqHex.encode(kemSig))
                })
            })
            val name = str(offer, "orgName") ?: ""
            if (admin != null) {
                try { keys.remember(orgId, seatId, name, genesis, admin.first, admin.second) } finally { admin.second.fill(0) }
            } else {
                keys.rememberMember(orgId, seatId, name, genesis, memberBinding)
            }
            val code = OrgAuthority.seatSas(inviteSha, memberKeyId, adminKeyId)
            _phase.value = Phase.Accepted("${code.take(3)} ${code.takeLast(3)}")
        } catch (e: Exception) {
            _phase.value = Phase.Failed(FSStrings.get(R.string.org_try_again))
        } finally {
            _busy.value = false
        }
    }
}
