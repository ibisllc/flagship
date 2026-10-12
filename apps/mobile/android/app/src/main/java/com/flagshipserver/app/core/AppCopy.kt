package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * The owner's order to copy an app to another server (docs/app-placement.md §5),
 * signed with the sensitive-order key and sent to the TARGET box:
 *
 *   flagship/app-copy/v1|<sourceServer>|<targetServer>|<serviceId>|<issuedAt>
 *
 * packages/protocol/test-vectors/app-copy/vectors.json is the reference;
 * AppCopyVectorsTest runs every case.
 */
object AppCopy {
    const val CANONICAL_TAG = "flagship/app-copy/v1"

    data class Grant(
        val sourceServer: String,
        val targetServer: String,
        val serviceId: String,
        val issuedAt: Long,
    )

    data class SignedGrant(val grant: Grant, val signatureHex: String)

    fun canonicalBytes(g: Grant): ByteArray {
        for (f in listOf(g.sourceServer, g.targetServer, g.serviceId)) {
            require(f.isNotEmpty()) { "an empty field" }
            require(f.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "a field contains | or a control character" }
        }
        require(!g.sourceServer.equals(g.targetServer, ignoreCase = true)) { "source and target are the same server" }
        require(g.issuedAt >= 0) { "bad issuedAt" }
        return listOf(CANONICAL_TAG, g.sourceServer, g.targetServer, g.serviceId, g.issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
    }

    fun sign(key: Ed25519Sign, sourceServer: String, targetServer: String, serviceId: String, issuedAt: Long): SignedGrant {
        val g = Grant(sourceServer, targetServer, serviceId, issuedAt)
        return SignedGrant(g, HexUtil.encode(key.sign(canonicalBytes(g))))
    }
}

/**
 * The owner-signed service uninstall, verified by the box against its owner
 * IRK (`DELETE /api/services/:serviceId`). Mirror of `UninstallServiceRequest`
 * in packages/protocol/src/serviceLifecycle.ts and iOS UninstallServiceOrder:
 *
 *   flagship/uninstall-service/v1|<serverId>|<creator>|<slug>|<issuedAt>
 */
object UninstallServiceOrder {
    const val CANONICAL_TAG = "flagship/uninstall-service/v1"

    fun canonicalBytes(serverId: String, creator: String, slug: String, issuedAt: Long): ByteArray {
        for (f in listOf(serverId, creator, slug)) {
            require(f.isNotEmpty()) { "an empty field" }
            require(f.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "a field contains | or a control character" }
        }
        return listOf(CANONICAL_TAG, serverId, creator, slug, issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
    }

    fun body(key: Ed25519Sign, serverId: String, creator: String, slug: String, issuedAt: Long): com.flagshipserver.app.api.UninstallServiceBody {
        val sig = key.sign(canonicalBytes(serverId, creator, slug, issuedAt))
        return com.flagshipserver.app.api.UninstallServiceBody(
            request = com.flagshipserver.app.api.UninstallServiceRequestBody(serverId, creator, slug, issuedAt),
            signature = HexUtil.encode(sig),
        )
    }

    /** `<creator>--<slug>`; both halves may carry single dashes. */
    fun split(serviceId: String): Pair<String, String>? {
        val i = serviceId.indexOf("--")
        if (i <= 0 || i + 2 >= serviceId.length) return null
        return serviceId.substring(0, i) to serviceId.substring(i + 2)
    }
}
