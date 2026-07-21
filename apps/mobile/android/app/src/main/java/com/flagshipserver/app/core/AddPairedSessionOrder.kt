// Pod ↔ device pairing — the Kotlin mirror of iOS
// `FlagshipCore/PodPairOrder.swift` (`AddPairedSessionOrder`), the webapp's
// `apps/web/public/webapp/lib/podPair.js`, and the `add-paired-session`
// `PhoneOrder` variant in `packages/protocol/src/orders.ts`.
//
// The box's `/api/screens/*` BFF is gated on a paired-session token carried in
// the `x-flagship-session` header. The phone mints that token by signing an
// `add-paired-session` order with the OWNER IRK and POSTing it to the box's
// `/api/orders-from-user` — the same root authority `/api/power` already
// verifies against (on a real box the daemon falls back to the config-pinned
// owner IRK because the per-server PSK private half is discarded at create-time).
//
// The canonical bytes + `|`-joined field order MUST stay byte-identical to the
// TS generator (`canonicalPhoneOrder` in `orders.ts`), the Swift pin
// (`AddPairedSessionCanonicalTests`), and the webapp (`canonicalAddPairedSession`):
//
//   flagship/order/add-paired-session/v2|<serverId>|<token>|<issuedAt>
//
// `serverId` is the pod FQDN (the daemon enforces serverId === its own FQDN);
// `token` is fresh 32-byte hex.

package com.flagshipserver.app.core

import java.security.SecureRandom

object AddPairedSessionOrder {
    const val CANONICAL_TAG = "flagship/order/add-paired-session/v2"

    private val rng = SecureRandom()

    fun canonicalBytes(serverId: String, token: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, serverId, token, issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)

    /** Fresh 32-byte session token, lowercased hex — the width the webapp
     *  (`randomTokenHex`) + iOS (`freshToken`) generate and the daemon stores
     *  verbatim. */
    fun freshToken(): String {
        val b = ByteArray(32)
        rng.nextBytes(b)
        return HexUtil.encode(b)
    }
}
