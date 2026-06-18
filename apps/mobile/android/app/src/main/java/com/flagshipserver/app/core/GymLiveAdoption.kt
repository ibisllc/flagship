// GYM-ONLY identity-adoption seam for the live Android e2e (the Kotlin mirror of
// iOS App/Sources/GymLiveAdoption.swift + the webapp's window.__gymAdopt).
//
// A normal sign-in mints a brand-new UMK in Android Keystore and pairs by
// scanning a QR / running the entitlement relay — neither of which a headless
// instrumentation test can do. `tools/live-e2e/provision-for-webapp.ts` already
// provisions a real gym box whose OWNER IRK is `deriveIRK(<umkSeed>)` (the
// PROTOCOL dot-form `flagship.irk.v1`); it prints that seed + username + fqdn.
// This seam takes those launch-intent extras and:
//
//   1. installs the printed UMK seed into the Keystore — for consistency of the
//      persisted-session machinery (hasUmkSeed());
//   2. sets `Keystore.gymAdoptedIrkOverride` to the box's owner key — the
//      PROTOCOL (dot-form) IRK, NOT this Keystore's slash-form — so every box-op
//      signer (journal / power / front-page / add-paired-session) signs with the
//      ACTUAL owner key the daemon pins;
//   3. marks the app paired for that username + flips `useLiveClient` on so the
//      real /pods reconcile + the live screens client engage;
//   4. mints a box-side paired session: signs an `add-paired-session` PhoneOrder
//      with that IRK, POSTs it to `<fqdn>/api/orders-from-user`, and persists
//      `(podBaseUrl, sessionToken)` so the screens BFF (`/api/screens/*`,
//      `x-flagship-session`-authed) is reachable.
//
// GATING — this runs ONLY when the launch intent carries `flagship.gymAdoptSeed`
// AND the build is debuggable. A production launch never passes it (and a release
// build skips the call site entirely), so the live app is byte-identical and this
// path is dead. It is the symmetric inverse of the existing `flagship.apexHost` /
// `flagship.smokeMode` launch-extra seams already in MainActivity.

package com.flagshipserver.app.core

import android.content.Intent
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.keystore.Keystore
import okhttp3.OkHttpClient

object GymLiveAdoption {

    const val EXTRA_GYM_ADOPT_SEED = "flagship.gymAdoptSeed"
    const val EXTRA_GYM_USERNAME = "flagship.gymUsername"
    const val EXTRA_GYM_FQDN = "flagship.gymFqdn"

    data class Args(val umkSeedHex: String, val username: String, val fqdn: String)

    /** Parse the gym-adopt launch extras, or null if `flagship.gymAdoptSeed` is
     *  absent / any required field is blank. */
    fun parse(intent: Intent?): Args? {
        val seed = intent?.getStringExtra(EXTRA_GYM_ADOPT_SEED)?.takeIf { it.isNotBlank() }
            ?: return null
        val user = intent.getStringExtra(EXTRA_GYM_USERNAME)?.takeIf { it.isNotBlank() } ?: return null
        val fqdn = intent.getStringExtra(EXTRA_GYM_FQDN)?.takeIf { it.isNotBlank() } ?: return null
        return Args(umkSeedHex = seed, username = user, fqdn = fqdn)
    }

    class AdoptException(message: String) : Exception(message)

    /**
     * Phase A — the SYNCHRONOUS local-state setup: install the UMK, set the IRK
     * override, mark paired + live + unlocked. Done before the first composition
     * so the shell renders the paired Home shell immediately. Throws on a bad
     * seed (the test asserts on paired state, so a failed adopt fails the test).
     */
    fun adoptLocal(
        args: Args,
        appState: AppState,
        dev: com.flagshipserver.app.core.DeveloperSettings,
    ) {
        val seed = HexUtil.decode(args.umkSeedHex)
            ?: throw AdoptException("gym-adopt: seed must be valid hex")
        if (seed.size != 32) throw AdoptException("gym-adopt: seed must be 64 hex chars (32 bytes)")

        // The box's owner IRK is the PROTOCOL (dot-form) IRK — the gym box is
        // provisioned by @flagship/protocol's deriveIRK, NOT the Keystore's
        // slash-form. Set it as the gym IRK override so every box-op signer
        // signs with the right key.
        Keystore.gymAdoptedIrkOverride = ServerKeys.deriveProtocolIrk(seed)

        // Install the UMK seed too — so Keystore.hasUmkSeed() is true and the
        // persisted-session machinery is consistent. (The IRK that signs box
        // ops is the override above, not the slash-form this would yield.)
        Keystore.installUmk(seed)

        // Paired + live + unlocked, like a restored real session — but with the
        // live client so the real /pods reconcile + screens client drive against
        // the box.
        appState.setHasCloudRecovery(true)
        appState.setRequireBiometricAtLaunch(false)
        if (!appState.isPaired.value) {
            appState.completeOnboarding(username = args.username, pods = emptyList())
        }
        dev.setUseLiveClient(true)
    }

    /**
     * Phase B — mint the box paired session (IRK-signed `add-paired-session`
     * order) and persist `(podBaseUrl, sessionToken)`. Suspend (network). The
     * [client] should be the SAME OkHttp the live screens client uses, so the
     * pairing POST rides the exact production transport. Throws on a pairing
     * failure so the caller can surface it to the test log.
     */
    suspend fun adoptRemote(
        args: Args,
        seedHex: String,
        store: SessionStoring,
        client: OkHttpClient,
    ) {
        val seed = HexUtil.decode(seedHex) ?: throw AdoptException("gym-adopt: bad seed")
        val irk = ServerKeys.deriveProtocolIrk(seed)
        val serverId = args.fqdn.trim().trim('/')

        // 32-byte hex session token (the phone supplies the bytes; the daemon
        // stores it in its PairedSessionStore so later x-flagship-session calls
        // are accepted).
        val tokenBytes = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        val token = HexUtil.encode(tokenBytes)
        val label = "android-gym-live"
        val issuedAt = System.currentTimeMillis()

        // Canonical bytes — byte-identical to @flagship/protocol's
        // canonicalPhoneOrder(add-paired-session):
        //   flagship/order/add-paired-session/v1|<serverId>|<token>|<label>|<issuedAt>
        val canonical = listOf(
            "flagship/order/add-paired-session/v1",
            serverId, token, label, issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
        val signatureHex = HexUtil.encode(irk.sign(canonical))

        // The daemon envelope is { request: {type,serverId,token,label,issuedAt},
        // signature }. issuedAt is a NUMBER in JSON (a string only in the
        // canonical bytes above).
        val body = buildString {
            append("{\"request\":{")
            append("\"type\":\"add-paired-session\",")
            append("\"serverId\":").append(jsonStr(serverId)).append(",")
            append("\"token\":").append(jsonStr(token)).append(",")
            append("\"label\":").append(jsonStr(label)).append(",")
            append("\"issuedAt\":").append(issuedAt)
            append("},\"signature\":").append(jsonStr(signatureHex)).append("}")
        }.toByteArray(Charsets.UTF_8)

        val baseUrl = "https://$serverId"
        val transport = OkHttpJsonTransport(client)
        val resp = transport.execute(
            method = "POST",
            url = "$baseUrl/api/orders-from-user",
            body = body,
            contentType = "application/json",
            accept = setOf(200, 201, 204),
        )
        if (resp.status !in 200..299) {
            throw AdoptException(
                "gym-adopt: box refused add-paired-session: ${resp.status} " +
                    String(resp.body, Charsets.UTF_8),
            )
        }

        // Persist (podBaseUrl, sessionToken) so the screens client is usable
        // immediately. PodSessionSync would also write the base URL once the
        // online pod reconciles, but setting it here is immediate + idempotent.
        store.setPodBaseUrl(baseUrl)
        store.setSessionToken(token)
    }

    private fun jsonStr(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> sb.append(c)
        }
        return sb.append("\"").toString()
    }
}
