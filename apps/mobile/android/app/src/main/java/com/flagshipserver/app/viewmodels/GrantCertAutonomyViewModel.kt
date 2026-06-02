// #28 SEAL-TO-BOX — "grant this box cert-minting autonomy".
//
// Orchestrates the admin-device half: resolve the target box's STK from the
// DIRECTORY (/api/users/:u/pods — the same independently-verified anchor the
// boot-secret coordinator trusts, NOT the screens detail model, which doesn't
// surface it), seal this device's ACME account key FOR that STK via
// AcmeAccountKeyGrantProducer, IRK-sign the grant, and POST it to the
// domain-scoped delivery endpoint. The plaintext account key never leaves the
// producer; only the box-sealed ciphertext rides the wire.
//
// Every collaborator is injectable so the JVM test exercises the build+POST
// without the AndroidKeyStore, the biometric prompt, or a network. The
// production defaults bind to the Keystore + mailbox directory + the live
// delivery extension.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AcmeAccountKeyGrantMintRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.grantAcmeAccountKeyAutonomy
import com.flagshipserver.app.core.AcmeAccountKeyGrantProducer
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface GrantCertAutonomyPhase {
    data object Idle : GrantCertAutonomyPhase
    /** Resolving the box's STK from the directory. */
    data object Resolving : GrantCertAutonomyPhase
    /** Sealing the account key to the STK + IRK-signing the grant. */
    data object Sealing : GrantCertAutonomyPhase
    data object Posting : GrantCertAutonomyPhase
    data object Completed : GrantCertAutonomyPhase
    data class Failed(val message: String) : GrantCertAutonomyPhase
}

class GrantCertAutonomyViewModel(
    private val serverDomain: String,
    private val username: () -> String?,
    /** Resolve the box's STK (Ed25519 pubkey, hex) for [serverDomain] from the
     *  DIRECTORY. Default goes through the mailbox client's `/api/users/:u/pods`
     *  — the phone re-resolves the STK independently of any echo. Null ⇒ the
     *  directory can't vouch for this box. */
    private val boxStkResolver: suspend (username: String, serverDomain: String) -> String?,
    /** The admin device's raw ACME account-key scalar (32 bytes), or null when
     *  this device doesn't hold one. Default reads it WITHOUT minting. */
    private val scalarProvider: () -> ByteArray? = { Keystore.acmeAccountKeyScalar() },
    /** Biometric-gated IRK signer. Default derives the active-version IRK. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    /** POST the finished `{ grant, signature }` body to the domain-scoped
     *  delivery endpoint. Default binds the live client extension. */
    private val deliver: suspend (serverDomain: String, request: AcmeAccountKeyGrantMintRequest) -> Unit,
    private val grantIdGen: () -> String = { java.util.UUID.randomUUID().toString() },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<GrantCertAutonomyPhase>(GrantCertAutonomyPhase.Idle)
    val phase: StateFlow<GrantCertAutonomyPhase> = _phase.asStateFlow()

    companion object {
        /** Production binding of [deliver] — POSTs through the live client's
         *  domain-scoped delivery extension over the given transport. */
        fun liveDeliver(
            client: FlagshipServerClient,
            transport: JsonHttpTransport,
        ): suspend (String, AcmeAccountKeyGrantMintRequest) -> Unit =
            { domain, request -> client.grantAcmeAccountKeyAutonomy(transport, domain, request) }
    }

    /** Build + seal + sign + POST. Idempotent to re-tap: a fresh grantId is
     *  minted each run so a retry never collides. */
    suspend fun run() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = GrantCertAutonomyPhase.Failed("No active account on this device.")
            return
        }

        val scalar = scalarProvider()
        if (scalar == null || scalar.size != 32) {
            _phase.value = GrantCertAutonomyPhase.Failed(
                "This device doesn't hold the account's cert-minting key.",
            )
            return
        }

        _phase.value = GrantCertAutonomyPhase.Resolving
        val stkHex: String?
        try {
            stkHex = boxStkResolver(user, serverDomain)
        } catch (e: Throwable) {
            _phase.value = GrantCertAutonomyPhase.Failed("Couldn't reach the directory: ${e.message}")
            return
        }
        val boxStkPub = stkHex?.let { com.flagshipserver.app.core.HexUtil.decode(it) }
            ?.takeIf { it.size == 32 }
        if (boxStkPub == null) {
            _phase.value = GrantCertAutonomyPhase.Failed(
                "This box ($serverDomain) isn't registered to your account yet.",
            )
            return
        }

        _phase.value = GrantCertAutonomyPhase.Sealing
        val irk: Ed25519Sign
        try {
            irk = signer("Grant $serverDomain cert-minting autonomy")
        } catch (e: Throwable) {
            _phase.value = GrantCertAutonomyPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val request: AcmeAccountKeyGrantMintRequest
        try {
            val produced = AcmeAccountKeyGrantProducer.produce(
                irk = irk,
                username = user,
                scalar = scalar,
                boxStkPub = boxStkPub,
                grantId = grantIdGen(),
                issuedAt = now(),
            )
            request = AcmeAccountKeyGrantMintRequest.from(produced)
        } catch (e: Throwable) {
            _phase.value = GrantCertAutonomyPhase.Failed("Couldn't seal the key for this box: ${e.message}")
            return
        }

        _phase.value = GrantCertAutonomyPhase.Posting
        try {
            deliver(serverDomain, request)
        } catch (e: HttpException) {
            val friendly = when (e.status) {
                403 -> "The server rejected the grant. Sign in again and retry."
                404 -> "That box isn't reachable for delivery right now."
                else -> "Server error (${e.status}): ${e.body}"
            }
            _phase.value = GrantCertAutonomyPhase.Failed(friendly)
            return
        } catch (e: Throwable) {
            _phase.value = GrantCertAutonomyPhase.Failed("Couldn't deliver the grant: ${e.message}")
            return
        }
        _phase.value = GrantCertAutonomyPhase.Completed
    }
}
