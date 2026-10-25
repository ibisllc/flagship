package com.flagshipserver.app.core

import com.flagshipserver.app.api.StackSwitchBody
import com.flagshipserver.app.api.StackSwitchOrderWire
import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * The owner's order to move one box between its container stacks: `arch-v2` (Podman, and the Rust
 * keyd, broker and core) or back to `classic` (Docker and the TS path). Signed with the
 * sensitive-order key (the admin root where the box pins one), sent to the box, used once. Wire parity
 * with packages/protocol/src/archV2Switch.ts; pinned by packages/protocol/test-vectors/arch-v2-switch.
 *
 *   flagship/arch-v2-switch/v1|<serverDomain lowercase>|<target>|<nonce>|<issuedAt>
 */
object StackSwitchOrder {
    const val TAG = "flagship/arch-v2-switch/v1"
    private val NONCE = Regex("^[0-9a-f]{32}$")

    fun canonical(o: StackSwitchOrderWire): ByteArray {
        require(o.serverDomain.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "serverDomain" }
        require(o.target == "arch-v2" || o.target == "classic") { "unknown target stack" }
        require(NONCE.matches(o.nonce)) { "nonce must be 32 lowercase hex" }
        require(o.issuedAt in 0..9_007_199_254_740_991L) { "bad issuedAt" }
        return listOf(TAG, o.serverDomain.lowercase(), o.target, o.nonce, o.issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun newNonce(): String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    fun sign(o: StackSwitchOrderWire, signer: Ed25519Sign, dryRun: Boolean): StackSwitchBody =
        StackSwitchBody(o, HexUtil.encode(signer.sign(canonical(o))), if (dryRun) true else null)
}
