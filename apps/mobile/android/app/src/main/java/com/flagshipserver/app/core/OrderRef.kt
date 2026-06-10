// Deterministic opaque reference for an install order — the value the
// UNAUTHENTICATED `/pods` `pending[]` carries instead of the raw auth-code
// serial. The serial is a capability (anyone who knows username+serial can
// POST fake provision phases to `/api/order/<serial>/status` +
// `/api/install-events/<serial>`), so it never rides an unauthenticated
// response. A device that minted the order knows the real serial and
// computes the SAME ref locally to reconcile against the directory; the
// deep-progress poll keeps using the locally-stored serial only.
//
// Mirrors control-plane `orderRefForSerial`
// (packages/control-plane/src/podInventory.ts) and iOS
// FlagshipCore.OrderRef byte-for-byte:
// `hex(sha256("flagship/order-ref/v1|" + serial))`.

package com.flagshipserver.app.core

import java.security.MessageDigest

object OrderRef {
    fun compute(serial: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("flagship/order-ref/v1|$serial".toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
