package com.flagshipserver.app.keystore

import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RecoveryRecordChain
import com.flagshipserver.app.core.RecoveryRecordState
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Hkdf

/** The account key a UMK derives at rotation version 1, as the app does. */
fun irkForUmk(umkSeed: ByteArray, version: Int = 1): Ed25519Sign =
    Ed25519Sign(irkSeedForUmk(umkSeed, version))

fun irkPubHexForUmk(umkSeed: ByteArray, version: Int = 1): String =
    HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeedForUmk(umkSeed, version)).publicKey)

private fun irkSeedForUmk(umkSeed: ByteArray, version: Int): ByteArray =
    Hkdf.computeHkdf("HMACSHA256", umkSeed, "flagship/irk/v$version".toByteArray(), "ed25519-seed".toByteArray(), 32)

/** A well-formed, signed first (`genesis`) recovery upload for the mock server. */
fun makeRecoveryUpload(
    username: String,
    credentialIdHex: String = "aabbccddeeff00112233445566778899",
    wrappedUmk: String = java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3, 4)),
    wrappedAdminRoot: String? = null,
    wrappedAcmeAccountKey: String? = null,
    fetchTokenHashHex: String = "ab".repeat(32),
    prfSaltHashHex: String = "cd".repeat(32),
    current: RecoveryRecordState? = null,
    umkSeed: ByteArray = ByteArray(32) { 7 },
): RecoveryEnvelopeRequest {
    val claim = RecoveryRecordChain.next(
        username = username,
        irkPubHex = irkPubHexForUmk(umkSeed),
        adminRootPubHex = null,
        current = current,
        credentialIdHex = credentialIdHex,
        wrappedUmk = wrappedUmk,
        wrappedAdminRoot = wrappedAdminRoot,
        wrappedAcmeAccountKey = wrappedAcmeAccountKey,
        fetchTokenHashHex = fetchTokenHashHex,
        prfSaltHashHex = prfSaltHashHex,
        issuedAt = 1_700_000_000_000L,
    )
    return RecoveryEnvelopeRequest(
        claim = claim,
        signature = HexUtil.encode(irkForUmk(umkSeed).sign(claim.canonicalBytes())),
        wrappedUmk = wrappedUmk,
        wrappedAdminRoot = wrappedAdminRoot,
        wrappedAcmeAccountKey = wrappedAcmeAccountKey,
    )
}
