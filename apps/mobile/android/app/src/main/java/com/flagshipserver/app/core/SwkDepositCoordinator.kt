// Secret-free-recipe SWK delivery, phone side
// (docs/recipe-delivery-and-remote-install.md). Kotlin mirror of the iOS
// FlagshipUI/ViewModels/SwkDepositCoordinator.swift.
//
// When a server is created WITHOUT embedding the SWK in the recipe (the
// default), the recipe is secret-free of the SWK; the box boots platform-less
// and registers. This coordinator, fired when the box appears registered in
// `/pods` (with its identity pub), derives the box's deterministic SWK
// (ServerKeys.deriveSwk — the same DOTS box key as create) under ONE biometric,
// seals it to the box's REGISTERED identity, IRK-signs the wrapper, and deposits
// the sealed carrier on `.com`'s blind swk-deposit lane. The box claims it on
// boot and turns on its service/build platform.
//
// Best-effort + idempotent: it no-ops unless a deposit is owed
// (PendingSwkDepositStore.isPending), and marks `deposited` only after a 200 so
// a later reconcile never double-deposits. A failure leaves the `pending` marker
// in place so the next reconcile retries — the box just stays platform-less
// meanwhile, never bricked. Mirrors the entitlement-deposit pattern (one
// biometric at deposit time is acceptable).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign

class SwkDepositCoordinator(
    private val username: String,
    private val mailbox: SecretMailboxClient,
    private val store: PendingSwkDepositStore,
    /** Stash of the create-time pairing order owed per server (secret-free
     *  pairing). Deposited on the SAME pass as the SWK (one biometric → both). */
    private val pairingStore: PendingPairingDepositStore,
    /** Stash of the CGK deposit owed per server (per-service leadership). The CGK
     *  is the per-CLOUD gossip key, delivered post-boot exactly like the SWK and
     *  on the SAME biometric pass. */
    private val cgkStore: PendingCgkDepositStore,
    /** Derives (IRK signer, IRK pub hex, box SWK hex) for the given serverId
     *  under one biometric. Injectable so tests don't hit the Keystore. */
    private val deriveIrkAndSwk: suspend (serverId: String) -> Triple<Ed25519Sign, String, String>,
    /** Derives the per-cloud CGK hex (no serverId). Injectable so tests don't hit
     *  the Keystore. The IRK from [deriveIrkAndSwk] is reused for the CGK deposit's
     *  owner signature, so this returns only the CGK material. */
    private val deriveCgkHex: suspend () -> String,
) {
    /** Deposit what's OWED for a box that has registered (carrying
     *  `identityPubKeyHex`): the SWK (turns on the service platform) AND/OR the
     *  secret-free PAIRING order (pairs the creating device with no manual tap).
     *  Both ride ONE biometric (the IRK derived once) and are sealed to the box
     *  identity. No-op when nothing is owed. */
    suspend fun depositIfNeeded(serverDomain: String, identityPubKeyHex: String) {
        val swkOwed = store.isPending(serverDomain)
        val pairingOrderJson = pairingStore.pendingOrder(serverDomain)
        val cgkOwed = cgkStore.isPending(serverDomain)
        if (!swkOwed && pairingOrderJson == null && !cgkOwed) return
        val boxIdentityPub = HexUtil.decode(identityPubKeyHex) ?: return
        if (boxIdentityPub.size != 32) return
        try {
            val (irk, irkPubHex, swkHex) = deriveIrkAndSwk(serverDomain)

            if (swkOwed) {
                val swk = HexUtil.decode(swkHex)
                if (swk != null && swk.size == 32) {
                    val body = SwkDelivery.buildDeposit(
                        username = username,
                        serverDomain = serverDomain,
                        swk = swk,
                        boxIdentityPub = boxIdentityPub,
                        irk = irk,
                        irkPubHex = irkPubHex,
                    )
                    mailbox.depositSwk(serverDomain, body)
                    // Only flip to `deposited` AFTER `.com` accepted it.
                    store.markDeposited(serverDomain)
                }
            }

            if (pairingOrderJson != null) {
                val body = PairingOrderDeposit.buildDeposit(
                    username = username,
                    serverDomain = serverDomain,
                    pairingOrderJson = pairingOrderJson,
                    boxIdentityPub = boxIdentityPub,
                    irk = irk,
                    irkPubHex = irkPubHex,
                )
                mailbox.depositPairing(serverDomain, body)
                pairingStore.markDeposited(serverDomain)
            }

            // CGK delivery — the EXACT twin of the SWK deposit, on the same
            // biometric (the IRK is already in hand). The CGK is per-CLOUD (no
            // serverId), sealed to THIS box's registered identity. Best-effort:
            // a box without a CGK just doesn't gossip yet (never bricked).
            if (cgkOwed) {
                val cgkHex = deriveCgkHex()
                val cgk = HexUtil.decode(cgkHex)
                if (cgk != null && cgk.size == 32) {
                    val body = CgkDelivery.buildDeposit(
                        username = username,
                        serverDomain = serverDomain,
                        cgk = cgk,
                        boxIdentityPub = boxIdentityPub,
                        irk = irk,
                        irkPubHex = irkPubHex,
                    )
                    mailbox.depositCgk(serverDomain, body)
                    cgkStore.markDeposited(serverDomain)
                }
            }
        } catch (_: Throwable) {
            // Leave the `pending` marker(s) so the next reconcile retries.
        }
    }

    companion object {
        /** Production factory: derive via the Keystore IRK (the owner IRK a
         *  mobile-created box pins) + ServerKeys.deriveSwk (the box SWK). */
        fun live(
            username: String,
            mailbox: SecretMailboxClient,
            store: PendingSwkDepositStore,
            pairingStore: PendingPairingDepositStore,
            cgkStore: PendingCgkDepositStore,
        ): SwkDepositCoordinator = SwkDepositCoordinator(
            username = username,
            mailbox = mailbox,
            store = store,
            pairingStore = pairingStore,
            cgkStore = cgkStore,
            deriveIrkAndSwk = { serverId ->
                val irk = Keystore.deriveIRK("Authorize $serverId to run apps")
                val irkPubHex = Keystore.irkPubHex()
                val swkHex = HexUtil.encode(ServerKeys.deriveSwk(Keystore.currentUmkSeed(), serverId))
                Triple(irk, irkPubHex, swkHex)
            },
            // The CGK is per CLOUD (no serverId) — CloudGossip.deriveCGK(umk.seed).
            // The in-hand UMK seed is reused (no extra biometric).
            deriveCgkHex = {
                HexUtil.encode(CloudGossip.deriveCGK(Keystore.currentUmkSeed()))
            },
        )
    }
}
