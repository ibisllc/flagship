// Wire shapes of the serving authority (the owner's dead-man setting; serving-wiring.md
// sections 1 and 3). The records and their signing rules are in core/ServingAuthority.kt.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.RenewalKeyDelegation
import com.flagshipserver.app.core.ServingGrace
import com.flagshipserver.app.core.ServingLease
import com.flagshipserver.app.core.ServingOnLapse
import com.flagshipserver.app.core.ServingPolicy
import com.flagshipserver.app.core.SignedRenewalDelegation
import com.flagshipserver.app.core.SignedServingPolicy
import kotlinx.serialization.Serializable

/** server-detail `serving`: the line on the server page, and what a policy edit is signed against. */
@Serializable
data class ServingView(
    val grace: String = "indefinite",
    val onLapse: String = "stop-apps",
    /** When app routes stop without a newer lease; null: no time limit. */
    val until: Long? = null,
    val policyGen: Long = 0,
    val regGen: Long = 0,
    val scopeSha256: String = "",
    /** The box identity key a policy names. */
    val boxPub: String? = null,
) {
    val graceValue: ServingGrace get() = ServingGrace.fromWire(grace) ?: ServingGrace.INDEFINITE
    val onLapseValue: ServingOnLapse get() = ServingOnLapse.fromWire(onLapse) ?: ServingOnLapse.STOP_APPS
}

/** `POST /api/accounts/:u/serving-policy`. */
@Serializable
data class ServingPolicyPost(val policy: ServingPolicy, val signature: String)

/** `POST /api/accounts/:u/renewal-delegations`. */
@Serializable
data class RenewalDelegationPost(val delegation: RenewalKeyDelegation, val signature: String)

/** `POST /api/accounts/:u/serving-leases`: `{leases: [{lease, signature, delegationPub?}]}`. */
@Serializable
data class ServingLeasesPost(val leases: List<Item>) {
    @Serializable
    data class Item(val lease: ServingLease, val signature: String, val delegationPub: String? = null)
}

@Serializable
data class ServingLeasesResult(val accepted: Int = 0, val refused: List<Refused> = emptyList()) {
    @Serializable
    data class Refused(val leaseId: String = "", val code: String = "")
}

/** A lease as the box takes it: the renewal key that signed it is named, its delegation sent alongside. */
@Serializable
data class BoxServingLease(val record: ServingLease, val signature: String, val delegationPub: String? = null)

/** `POST /api/screens/serving` on the box: any of the records, each verified there before it is kept. */
@Serializable
data class BoxServingPost(
    val policy: SignedServingPolicy? = null,
    val leases: List<BoxServingLease>? = null,
    val delegations: List<SignedRenewalDelegation>? = null,
)

/** The box's answer: `{ok, policyAdopted, leasesAccepted, refused, serving}`. */
@Serializable
data class BoxServingAck(
    val ok: Boolean = false,
    val policyAdopted: Boolean = false,
    val leasesAccepted: Int = 0,
    val serving: ServingView? = null,
)

/** `GET /api/accounts/:u/serving`, one entry per server of the account. */
@Serializable
data class AccountServingEntry(
    val serverDomain: String,
    val boxPub: String,
    val regGen: Long = 1,
    val policy: SignedServingPolicy? = null,
    val until: Long? = null,
    val onLapse: String? = null,
    val grace: String? = null,
    val confirmedByRelays: Boolean? = null,
)

@Serializable
data class AccountServingResponse(val servers: List<AccountServingEntry> = emptyList())
