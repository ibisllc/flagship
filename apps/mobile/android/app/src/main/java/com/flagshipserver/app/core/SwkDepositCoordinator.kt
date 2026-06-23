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
    /** Derives (IRK signer, IRK pub hex, box SWK hex) for the given serverId
     *  under one biometric. Injectable so tests don't hit the Keystore. */
    private val deriveIrkAndSwk: suspend (serverId: String) -> Triple<Ed25519Sign, String, String>,
) {
    /** Deposit the SWK for a box that has registered (carrying
     *  `identityPubKeyHex`) — IF a deposit is still owed for it. No-op otherwise. */
    suspend fun depositIfNeeded(serverDomain: String, identityPubKeyHex: String) {
        if (!store.isPending(serverDomain)) return
        val boxIdentityPub = HexUtil.decode(identityPubKeyHex) ?: return
        if (boxIdentityPub.size != 32) return
        try {
            val (irk, irkPubHex, swkHex) = deriveIrkAndSwk(serverDomain)
            val swk = HexUtil.decode(swkHex) ?: return
            if (swk.size != 32) return
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
        } catch (_: Throwable) {
            // Leave the `pending` marker so the next reconcile retries.
        }
    }

    companion object {
        /** Production factory: derive via the Keystore IRK (the owner IRK a
         *  mobile-created box pins) + ServerKeys.deriveSwk (the box SWK). */
        fun live(
            username: String,
            mailbox: SecretMailboxClient,
            store: PendingSwkDepositStore,
        ): SwkDepositCoordinator = SwkDepositCoordinator(
            username = username,
            mailbox = mailbox,
            store = store,
            deriveIrkAndSwk = { serverId ->
                val irk = Keystore.deriveIRK("Authorize $serverId to run apps")
                val irkPubHex = Keystore.irkPubHex()
                val swkHex = HexUtil.encode(ServerKeys.deriveSwk(Keystore.currentUmkSeed(), serverId))
                Triple(irk, irkPubHex, swkHex)
            },
        )
    }
}
