// Kotlin mirror of FlagshipAPI/Endpoints.swift + the webapp's lib/apex.js.
//
// The SINGLE source of truth for the backend apexes the app talks to: the
// control plane (`flagshipserver.com` + its `boot.` / `webapp.` / `remote.` / `recovery.`
// sub-origins) and the data plane (`flagship.services`). These used to be
// hardcoded as a literal in ~8 client / screen sites; consolidating them
// makes the gym test env (gym.flagshipserver.com / gym.flagship.services,
// docs/ui-test-gym.md §12-G2) one knob.
//
// Prod is byte-identical: with no override set, every accessor resolves to
// today's literal exactly as before. The test-build seam is an explicit
// override — `setOverride(...)` — that the app applies at launch from a
// persisted DeveloperSettings field. PROD never sets it.

package com.flagshipserver.app.core

object Endpoints {
    /** Today's prod control apex host (no scheme). */
    const val PROD_CONTROL_HOST = "flagshipserver.com"
    /** Today's prod data-plane apex suffix (no leading dot). */
    const val PROD_DATA_APEX = "flagship.services"

    data class Override(
        val controlHost: String,
        val dataApex: String,
        val secure: Boolean = true,
    )

    @Volatile
    private var override: Override? = null

    /** Install the override (test build only). Pass null to clear. */
    @Synchronized
    fun setOverride(value: Override?) {
        override = value
    }

    /** Derive the override from one apex host (`gym.flagshipserver.com`),
     *  mirroring the data apex's `gym.` prefix the way the webapp + iOS do. */
    fun setOverride(controlHost: String, secure: Boolean = true) {
        setOverride(Override(controlHost, dataApexFor(controlHost), secure))
    }

    /** Map a control host to its sibling data apex: `gym.flagshipserver.com`
     *  → `gym.flagship.services`; the prod host → `flagship.services`. */
    fun dataApexFor(controlHost: String): String = when {
        controlHost == PROD_CONTROL_HOST -> PROD_DATA_APEX
        controlHost.endsWith(".$PROD_CONTROL_HOST") -> {
            // keep the leading prefix incl. its trailing dot
            val prefix = controlHost.dropLast(PROD_CONTROL_HOST.length)
            "$prefix$PROD_DATA_APEX"
        }
        else -> PROD_DATA_APEX
    }

    private val scheme: String
        get() = if (override?.secure != false) "https" else "http"

    // ----- Control plane -----

    /** The control-plane apex host (no scheme): `flagshipserver.com` (prod). */
    val controlHost: String
        get() = override?.controlHost ?: PROD_CONTROL_HOST

    /** The control-plane apex base URL: `https://flagshipserver.com` (prod). */
    val controlBaseUrl: String
        get() = "$scheme://$controlHost"

    /** A sub-origin of the control apex, e.g. `https://boot.flagshipserver.com`. */
    fun subOrigin(prefix: String): String = "$scheme://$prefix.$controlHost"

    /** The boot-worker base URL (`boot.<apex>`). */
    val bootBaseUrl: String
        get() = subOrigin("boot")

    /** The cloud-recovery sub-origin (`recovery.<apex>`). */
    val recoveryBaseUrl: String
        get() = subOrigin("recovery")

    /** The owner webapp origin (`https://webapp.<apex>/`) — companion-ticket
     *  receiver. */
    val webappOrigin: String
        get() = "$scheme://webapp.$controlHost/"

    /** The browser-remote host (`remote.<apex>`) — where a desktop starts a
     *  phone-approved remote session. Split out of the old shared `web.`
     *  origin on 2026-07-23 so a keyless remote session's browser storage is
     *  isolated from the owner webapp's by the same-origin policy. */
    val remoteHost: String
        get() = "remote.$controlHost"

    /** The server-register endpoint baked into a fresh recipe / InstallBlob. */
    val registrationUrl: String
        get() = "$scheme://$controlHost/api/server/register"

    // ----- Data plane -----

    /** The data-plane apex suffix (no leading dot): `flagship.services` (prod). */
    val dataApex: String
        get() = override?.dataApex ?: PROD_DATA_APEX

    /** A server's canonical FQDN: `<server>.<user>.flagship.services`. */
    fun serverFqdn(server: String, user: String): String = "$server.$user.$dataApex"

    /** A user's data-plane zone host: `<user>.flagship.services`. */
    fun userZoneHost(user: String): String = "$user.$dataApex"

    /** True when the configured apex is the PROD apex (no override / prod host).
     *  Cert pinning applies only here — a gym build at a non-prod apex skips
     *  the prod SPKI pins (which would fail TLS pinning). */
    val isProdControlApex: Boolean
        get() = controlHost == PROD_CONTROL_HOST
}
