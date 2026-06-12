// Kotlin mirror of the `set-front-page` PhoneOrder canonical bytes in
// packages/protocol/src/auth.ts (canonicalPhoneOrder "set-front-page").
//
// Owner-assignable apex: the box's root domain 302s to the named installed
// service's tier-1 canonical, or serves the default Flagship page when the
// label is "" (clear).
//
//   flagship/order/set-front-page/v1|<serverId>|<label>|<issuedAt>
//
// MUST stay byte-identical to the TS implementation — pinned by the vector
// in packages/protocol/tests/setFrontPage.test.ts and mirrored in
// FrontPageTest here.

package com.flagshipserver.app.core

object SetFrontPageOrder {
    const val CANONICAL_TAG = "flagship/order/set-front-page/v1"

    fun canonicalBytes(serverId: String, label: String, issuedAt: Long): ByteArray = listOf(
        CANONICAL_TAG,
        serverId,
        label,
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)
}
