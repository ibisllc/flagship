// Pure (JVM-testable) builder for the "Replace this server" graceful-decommission
// flow (docs/server-replacement-graceful-decommission.md). The Compose VM derives
// the owner IRK behind the biometric, then calls this to produce the exact wire
// body the `.com` decommission deposit accepts — `{ auth, authSignature, order,
// signature }`, byte-identical to the TS handlePostDecommission body + iOS
// FlagshipCore/ReplaceServerFlow.swift.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DecommissionDepositBody
import com.google.crypto.tink.subtle.Ed25519Sign

object ReplaceServerFlow {

    /** Disk disposition for the closeout (§6a). [WipeAfterHandoff] is the
     *  recommended default — it only wipes after the replacement proves a good
     *  restore; [WipeNow] accepts the backup as the sole copy (irreversible);
     *  [Keep] leaves the data intact on a powered-off box. The wire value matches
     *  the TS/Swift enum literal. */
    enum class Disposition(val wire: String) {
        Keep("keep"),
        WipeAfterHandoff("wipe-after-handoff"),
        WipeNow("wipe-now"),
    }

    /** Mint + sign a `ServerDecommission` order for the retiring box instance and
     *  wrap it with the IRK mailbox-auth into the deposit body.
     *
     *  - [serverFqdn] is both `podCanonical` and the deposit path domain.
     *  - [retiredStkPubHex] is the retiring box's CURRENT STK pubkey hex (the
     *    load-bearing replay guard, I2). Sourced from the pod directory.
     *  - [finalBackup] should be true only when peer-backup is enrolled (the VM
     *    gates this); `keep` has nothing to flush so it is forced off.
     *  - [backupEpoch] is a fresh monotonic target (defaults to [issuedAt]).
     *  - [nonce] is a fresh random 32-byte value (hex-encoded here). */
    fun buildDeposit(
        serverFqdn: String,
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        // Slice D — the decommission ORDER is SENSITIVE: sign with the admin
        // master root (`orderKey`) when supplied, else the IRK. The mailbox AUTH
        // below stays IRK-signed (the owner deposit credential).
        orderKey: Ed25519Sign? = null,
        retiredStkPubHex: String,
        finalBackup: Boolean,
        disposition: Disposition,
        issuedAt: Long,
        nonce: ByteArray = ServerTransferFlow.random32(),
        authNonce: ByteArray = ServerTransferFlow.random32(),
        backupEpoch: Long? = null,
    ): DecommissionDepositBody {
        val nonceHex = HexUtil.encode(nonce)
        val epoch = backupEpoch ?: issuedAt
        val sig = (orderKey ?: irk).sign(
            ServerDecommissionOrder.canonicalBytes(
                podCanonical = serverFqdn,
                retiredStkPubHex = retiredStkPubHex,
                finalBackup = finalBackup,
                diskDisposition = disposition.wire,
                backupEpoch = epoch,
                nonce = nonceHex,
                issuedAt = issuedAt,
            )
        )
        val auth = ServerTransferFlow.buildMailboxAuth(username, irk, irkPubHex, issuedAt, authNonce)
        return DecommissionDepositBody(
            auth = auth.auth,
            authSignature = auth.authSignature,
            // The wire `order` carries the RAW (non-lowercased) field values; the
            // canonical bytes the signature commits to lowercase pod/stk/nonce
            // internally, and the backend re-derives those exact bytes.
            order = DecommissionDepositBody.Order(
                podCanonical = serverFqdn,
                retiredStkPubHex = retiredStkPubHex,
                finalBackup = finalBackup,
                diskDisposition = disposition.wire,
                backupEpoch = epoch,
                nonce = nonceHex,
                issuedAt = issuedAt,
            ),
            signature = HexUtil.encode(sig),
        )
    }
}
