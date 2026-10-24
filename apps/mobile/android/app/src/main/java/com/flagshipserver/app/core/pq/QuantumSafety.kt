package com.flagshipserver.app.core.pq

import java.security.MessageDigest

/**
 * Architecture v2 milestone 4 on Android, the port in spirit of iOS's QuantumSafety
 * (docs/architecture-v2/pq-suites.md §13.6): served-chain replay with anti-rollback, the
 * owner's strict and leave-strict changes (the browser answer signed into the change), the
 * readiness check and the connector list.
 */
object QuantumSafety {
    const val BROWSER_LOSS = "browser-without-pq-authentication"
    const val CONNECTOR_LOSS = "connector-classical-last-leg"
    val LEAVING_STRICT_LOSS = listOf("classical-signatures-accepted", "classical-key-exchange-accepted", BROWSER_LOSS)

    fun lossText(code: String): String = when (code) {
        "classical-signatures-accepted" -> "Orders signed only with today's (classical) signatures will be accepted again."
        "classical-key-exchange-accepted" -> "Connections that use only classical key exchange will be accepted again."
        BROWSER_LOSS -> "Browsers can reach it. A browser's connection uses post-quantum key exchange, but the server's identity is still proven with a classical certificate."
        CONNECTOR_LOSS -> "This service's own connection is classical, so what it is sent could be read by a future quantum computer."
        else -> code
    }

    /** SHA-256 of the sorted, distinct, lower-case peers joined by `|` (as every port computes it). */
    fun affectedPeersDigest(peers: List<String>): String =
        PqHex.encode(MessageDigest.getInstance("SHA-256").digest(peers.map { it.lowercase() }.distinct().sorted().joinToString("|").toByteArray()))

    data class Replayed(val state: AssurancePolicy.PolicyState, val headLoss: List<String>) {
        val strict: Boolean get() = AssurancePolicy.strictInForce(state)
        val browsersAllowed: Boolean get() = !strict || BROWSER_LOSS in headLoss
    }

    /**
     * Replays a served chain from legacy under the keys this phone trusts (`trustedSigner` returns
     * the signer's Ed25519 key and verified binding, or null), and adopts it over `current`.
     */
    fun replay(
        scope: AssurancePolicy.Scope,
        account: String,
        chain: List<AssurancePolicy.SignedChange>,
        current: AssurancePolicy.PolicyState?,
        trustedSigner: (AssurancePolicy.Change) -> Pair<String, PqTrust.VerifiedBinding?>?,
    ): Replayed {
        var s = AssurancePolicy.legacyState(scope)
        var loss = emptyList<String>()
        val ready = AssurancePolicy.RolloutEvidence(capabilityAdvertised = true, boundPublicKeys = true, recipientsVerified = true, recoveryChecked = true)
        for (link in chain) {
            if (link.change.account != account.lowercase() || link.change.scope != scope) throw PolicyException("wrong-scope", "the change is for another scope")
            if (link.change.next == "strict") {
                if (s.rollout == "legacy") s = AssurancePolicy.advanceRollout(s, "capable", ready)
                if (s.rollout == "capable") s = AssurancePolicy.advanceRollout(s, "prepared", ready)
            }
            val before = s
            s = AssurancePolicy.applyChange(before, link.change) { _, _ -> AssurancePolicy.gateCheck(link, before, trustedSigner) }
            loss = link.change.acknowledgedLoss
        }
        return Replayed(AssurancePolicy.adoptStoredState(current, s), loss)
    }

    /** Key-value persistence (SharedPreferences "flagship.assurance.v1" in the app). */
    interface Persistence {
        fun load(key: String): String?
        fun save(key: String, value: String)
        fun keys(): Set<String>
        fun remove(key: String)
    }

    /** What this phone holds per scope; never replaced by an older state. */
    class Store(private val p: Persistence, private val profile: () -> String? = { null }) {
        private fun prefix(account: String) = "assurance.v1.${profile() ?: "-"}|${account.lowercase()}|"
        private fun key(account: String, s: AssurancePolicy.Scope) = "${prefix(account)}${s.kind}|${s.id}"

        private fun encode(r: Replayed): String = listOf(r.state.profile, r.state.rollout, r.state.generation.toString(), r.state.headDigest,
            r.state.enforcedEver.toString(), r.headLoss.joinToString(",")).joinToString(";")

        private fun decode(scope: AssurancePolicy.Scope, v: String): Replayed? {
            val f = v.split(";")
            if (f.size != 6) return null
            val g = f[2].toLongOrNull() ?: return null
            return Replayed(AssurancePolicy.PolicyState(scope, f[0], f[1], g, f[3], f[4] == "true"), if (f[5].isEmpty()) emptyList() else f[5].split(","))
        }

        @Synchronized
        fun replayed(account: String, scope: AssurancePolicy.Scope): Replayed? = p.load(key(account, scope))?.let { decode(scope, it) }

        @Synchronized
        fun adopt(account: String, r: Replayed) {
            replayed(account, r.state.scope)?.let { AssurancePolicy.adoptStoredState(it.state, r.state) }
            p.save(key(account, r.state.scope), encode(r))
        }

        @Synchronized
        fun forget(account: String) {
            val pre = prefix(account)
            for (k in p.keys()) if (k.startsWith(pre)) p.remove(k)
        }

        @Synchronized
        fun anyStrict(account: String): Boolean {
            val pre = prefix(account)
            return p.keys().filter { it.startsWith(pre) }.any { k ->
                val parts = k.removePrefix(pre).split("|", limit = 2)
                parts.size == 2 && p.load(k)?.let { decode(AssurancePolicy.Scope(parts[0], parts[1]), it)?.strict } == true
            }
        }
    }

    fun strictChange(
        account: String, scope: AssurancePolicy.Scope, from: AssurancePolicy.PolicyState, browsersAllowed: Boolean,
        peers: List<String>, signerKind: String, signerKeyId: String, now: Long,
    ) = AssurancePolicy.Change(account.lowercase(), scope, from.profile, "strict", from.generation + 1, from.headDigest, affectedPeersDigest(peers),
        if (browsersAllowed) listOf(BROWSER_LOSS) else emptyList(), null, signerKind, signerKeyId.lowercase(), PqTrust.SUITE_HYBRID, now)

    fun compatibilityChange(
        account: String, scope: AssurancePolicy.Scope, from: AssurancePolicy.PolicyState, loss: List<String>,
        peers: List<String>, signerKind: String, signerKeyId: String, now: Long,
    ) = AssurancePolicy.Change(account.lowercase(), scope, from.profile, "compatibility", from.generation + 1, from.headDigest, affectedPeersDigest(peers),
        loss.distinct().sorted(), null, signerKind, signerKeyId.lowercase(), PqTrust.SUITE_HYBRID, now)

    data class Readiness(
        val devicesBound: Int,
        val devices: Int,
        val thisDeviceBound: Boolean,
        val thisDeviceIsAdmin: Boolean,
        val recoveryChecked: Boolean,
        val serverBound: Boolean,
    ) {
        val ready: Boolean get() = thisDeviceIsAdmin && thisDeviceBound && devices > 0 && devicesBound == devices && recoveryChecked && serverBound
        val missing: List<String> get() = buildList {
            if (!thisDeviceIsAdmin) add("Only an admin device of this account can turn this on.")
            if (!thisDeviceBound) add("This device's post-quantum key isn't registered yet. Unlock the app once while online.")
            if (devicesBound < devices) add("${devices - devicesBound} of your devices have no post-quantum key yet. Open Flagship on each of them, or remove the ones you no longer use.")
            if (!recoveryChecked) add("Save and test your account recovery first.")
            if (!serverBound) add("This server hasn't registered its post-quantum key yet. Update it first.")
        }
    }

    enum class Protection(val label: String) { PQ_END_TO_END("Quantum-safe"), CLASSICAL("Classical connection"), CONTENT_FREE("Content-free") }

    data class Connector(val id: String, val name: String, val detail: String, val protection: Protection) {
        val needsChoice: Boolean get() = protection == Protection.CLASSICAL
    }

    fun connectors(aiProviders: List<String>): List<Connector> = buildList {
        add(Connector("ai-flagship-inference", "Flagship Inference", "Builds your apps with a hosted model. Prompts and code go over the provider's own TLS.", Protection.CLASSICAL))
        for (p in aiProviders.map { it.lowercase() }.distinct().sorted()) if (p != "flagship-inference") {
            add(Connector("ai-$p", p.replaceFirstChar { it.uppercase() }, "Your own AI key. Prompts and code go over the provider's own TLS.", Protection.CLASSICAL))
        }
        add(Connector("push-fcm", "Google push", "Wakes the app. Carries no content; the app then asks the server over the quantum-safe channel.", Protection.CONTENT_FREE))
    }

    fun connectorScope(server: String, connector: String) = AssurancePolicy.Scope("connector", "${server.lowercase()}:$connector")
}
