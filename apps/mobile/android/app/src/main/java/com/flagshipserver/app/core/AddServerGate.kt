// Adding a server to the account (create one, co-manage someone's running
// server, take over a box, import a backup) is for the account's admin devices
// only (owner rule 2026-10-15; docs/service-access-gating.md "Account
// members"): the device that holds the account's admin root. Every account is
// opened with one, so an account never lacks an admin device. A demo account's
// device stands in for its owner (it holds no keys; the operator runs the
// account). Home's button, every link into those flows and recipe minting all
// ask this one rule. Kotlin twin of iOS AddServerGate.swift and the webapp's
// lib/addServerGate.js.

package com.flagshipserver.app.core

import com.flagshipserver.app.keystore.Keystore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object AddServerGate {
    const val ADMIN_ONLY = "Only an admin device of this account can add servers."

    /** Adding a device over the pairing relay is admin-only too (owner rule
     *  2026-10-16; packages/protocol/test-vectors/device-pairing `adminOnlyLine`). */
    const val ADD_DEVICE_ADMIN_ONLY = "Only an admin device of this account can add devices."

    fun allowsAddDevice(app: AppState): Boolean = allows(app)

    /** Home's nav routes that bring a server into the account. */
    private val ROUTES = setOf("create-server", "share-accept", "transfer-acquirer")

    fun allows(holdsAdminRoot: Boolean, isDemoAccount: Boolean): Boolean = holdsAdminRoot || isDemoAccount

    fun allows(app: AppState): Boolean =
        allows(holdsAdminRoot = Variant.forceAdminRoot || Keystore.hasAdminRoot(), isDemoAccount = app.isDemoAccountNow())

    /** Whether a Home nav route (with or without its `?args`) adds a server. */
    fun addsServer(route: String?): Boolean = route?.substringBefore('?') in ROUTES

    /** The admin root a new server's recipe pins. Only opening the account
     *  mints one: a device without it is refused, never handed a fresh root
     *  the account's admins don't hold. A demo account pins none. */
    fun recipeAdminRootPin(adminRootPubHex: String?, isDemoAccount: Boolean): String? {
        if (adminRootPubHex != null) return adminRootPubHex
        if (isDemoAccount) return null
        throw AddServerRefused()
    }

    /** `.com` enforces the rule too (2026-10-16): its refusal is a 403
     *  `{"error": …, "code": "add-server-admin-only"}`, shown as [ADMIN_ONLY]. */
    const val SERVER_REFUSAL_CODE = "add-server-admin-only"

    fun isServerRefusal(t: Throwable): Boolean {
        if (t !is HttpException || t.status != 403) return false
        val code = runCatching {
            Json.parseToJsonElement(t.body).jsonObject["code"]?.jsonPrimitive?.content
        }.getOrNull()
        return code == SERVER_REFUSAL_CODE
    }
}

class AddServerRefused : IllegalStateException(AddServerGate.ADMIN_ONLY)
