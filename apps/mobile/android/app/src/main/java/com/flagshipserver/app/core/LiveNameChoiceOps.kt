// The live side of "Choose your own account name" (core/AccountNameChoice.kt has the flow and the why).
//
//   POST /api/account/name-change/quote          none                 → {available, units} | {available:false, code, ...}
//   POST /api/account/name-change                none (admin-signed)  → {ok, ...} | {error, code, ...}
//   GET  /api/username/<u>                       none                 → {irkPub, ...}
//   POST /api/users/<u>/device-grants            none (admin-signed)  → the grant
//   POST /api/users/<u>/device-grants/revoke     none (IRK-signed)    → {ok}
//   PUT  /api/accounts/<u>/profile, /devices/<id>/profile   device headers

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.AccountDirectoryAuthorization
import com.flagshipserver.app.api.DirectoryProfileEnvelope
import com.flagshipserver.app.api.DirectoryProfileWriteRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.core.payments.PaymentsCenter
import com.flagshipserver.app.core.payments.ShopNotice
import com.flagshipserver.app.core.payments.VoucherShop
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.viewmodels.CreatedAccount
import com.flagshipserver.app.viewmodels.OpenAccountViewModel
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

class LiveNameChoiceOps(
    private val app: AppState,
    private val server: FlagshipServerClient,
    private val transport: JsonHttpTransport,
    private val deviceModel: () -> String?,
    private val base: () -> String = { Endpoints.controlBaseUrl.trimEnd('/') },
    private val now: () -> Long = System::currentTimeMillis,
) : NameChoiceOps {
    private var opener: OpenAccountViewModel? = null
    private fun enc(s: String) = java.net.URLEncoder.encode(s.lowercase(), "UTF-8")
    private fun parse(b: ByteArray): JsonObject? = runCatching { transport.json.parseToJsonElement(b.decodeToString()) as? JsonObject }.getOrNull()
    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull
    private fun reason() = FSStrings.get(R.string.authorize_your_private_account_name)

    private suspend fun post(path: String, body: JsonObject, accept: Set<Int> = setOf(200)): Pair<Int, JsonObject> = try {
        val r = transport.execute("POST", base() + path, body.toString().toByteArray(), "application/json; charset=utf-8", emptyMap(), accept)
        r.status to (parse(r.body) ?: JsonObject(emptyMap()))
    } catch (e: HttpException) {
        val o = runCatching { transport.json.parseToJsonElement(e.body) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        throw PaymentsHttpError(e.status, o.str("code"), o)
    }

    private fun refused(e: PaymentsHttpError) = NameChangeRefused(
        e.code ?: "rename-failed", e.body.str("problem"), (e.body["heldUntil"] as? JsonPrimitive)?.longOrNull,
    )

    override suspend fun createAccount(suggested: String): CreatedAccount {
        val vm = opener?.takeIf { it.username == suggested } ?: OpenAccountViewModel(server, app, suggested).also { opener = it }
        val created = vm.createAccount(vm.defaultDeviceName(deviceModel()), vm.defaultAccountName())
        AccountNameChoice.signUp = AccountNameChoice.SignUp(created.username, created.deviceId)
        return created
    }

    private fun grantJson(g: NameGrant) = JsonObject(mapOf("code" to JsonPrimitive(g.code), "expiresAt" to JsonPrimitive(g.expiresAt)))

    override suspend fun quote(oldName: String, newName: String, grant: NameGrant?): NameQuote {
        val body = JsonObject(
            linkedMapOf<String, JsonElement>("username" to JsonPrimitive(oldName), "newUsername" to JsonPrimitive(newName))
                .apply { grant?.let { put("nameGrant", grantJson(it)) } },
        )
        val o = try {
            post("/api/account/name-change/quote", body).second
        } catch (e: PaymentsHttpError) {
            return NameQuote.Refused(e.code ?: "rename-failed")
        }
        if ((o["available"] as? JsonPrimitive)?.contentOrNull == "true") {
            return NameQuote.Available(
                ((o["units"] as? JsonPrimitive)?.longOrNull ?: AccountNameChoice.PACK_UNITS.toLong()).toInt(),
                paid = (o["paid"] as? JsonPrimitive)?.contentOrNull == "true",
            )
        }
        return NameQuote.Refused(o.str("code") ?: "rename-failed", o.str("problem"), (o["heldUntil"] as? JsonPrimitive)?.longOrNull)
    }

    override suspend fun walletBalance(): Int {
        val c = PaymentsCenter.shared ?: return 0
        c.refresh()
        return if (c.state.value.canSpend) c.state.value.balance else 0
    }

    override suspend fun buyPack(units: Int): PackOutcome {
        val shop = VoucherShop.shared ?: return PackOutcome.Failed
        if (PaymentsCenter.shared?.state?.value?.canSpend != true) return PackOutcome.Failed
        shop.load()
        val product = shop.state.value.products.firstOrNull { it.units == units.toLong() } ?: return PackOutcome.Failed
        shop.buy(product)
        return when (shop.state.value.notice?.kind) {
            ShopNotice.Kind.ADDED -> PackOutcome.Bought
            null -> PackOutcome.Cancelled
            else -> PackOutcome.Failed
        }
    }

    private suspend fun postRename(oldName: String, newName: String, payment: Pair<String, JsonElement>?, grant: NameGrant?) {
        val umk = Keystore.currentUmkSeed()
        val aid = HexUtil.encode(ServerKeys.deriveAccountIdPub(umk))
        val issuedAt = now()
        val sig = Keystore.adminRootKey(reason()).sign(NameChangeEnvelope.canonicalBytes(aid, oldName, newName, issuedAt))
        val request = JsonObject(
            linkedMapOf(
                "aidPubHex" to JsonPrimitive(aid), "oldUsername" to JsonPrimitive(oldName),
                "newUsername" to JsonPrimitive(newName), "issuedAt" to JsonPrimitive(issuedAt),
            ),
        )
        val body = linkedMapOf<String, JsonElement>("request" to request, "signature" to JsonPrimitive(HexUtil.encode(sig)))
        payment?.let { body[it.first] = it.second }
        grant?.let { body["nameGrant"] = grantJson(it) }
        post("/api/account/name-change", JsonObject(body))
    }

    override suspend fun rename(oldName: String, newName: String, payment: NameChoicePayment, units: Int, grant: NameGrant?) {
        try {
            when (payment) {
                is NameChoicePayment.Code -> postRename(oldName, newName, "voucherCode" to JsonPrimitive(payment.code), grant)
                NameChoicePayment.Granted -> postRename(oldName, newName, null, grant)
                NameChoicePayment.Card -> {
                    val center = PaymentsCenter.shared ?: throw NameChangeRefused("vouchers-off")
                    center.spendExactly(units) { vouchers -> postRename(oldName, newName, "vouchers" to JsonArray(vouchers), grant) }
                        ?: throw NameChangeRefused("wrong-amount")
                }
            }
        } catch (e: PaymentsHttpError) {
            throw refused(e)
        }
    }

    override suspend fun ownsName(name: String): Boolean? = runCatching {
        val r = transport.execute("GET", "${base()}/api/username/${enc(name)}", accept = setOf(200, 404))
        if (r.status == 404) return@runCatching false
        val irk = parse(r.body)?.str("irkPub")?.lowercase() ?: return@runCatching null
        irk == KeystoreIrkAccess().resolve(reason()).pubHex.lowercase()
    }.getOrNull()

    override suspend fun settle(p: PendingNameChoice) {
        val old = p.oldName.lowercase()
        val new = p.newName.lowercase()
        val umk = Keystore.currentUmkSeed()
        // 1. The device key `.com` registered moves with the profile (a random one is stored; an older build's was
        //    derived from the old name, so it is kept under the new one).
        Keystore.moveProfile(old, new)
        Keystore.setActiveProfile(new)
        val seed = Keystore.storedAccountDeviceSeed(p.deviceId)
            ?: AccountMetadata.deriveAccountDeviceSeed(umk, old, p.deviceId).also { Keystore.storeAccountDeviceSeed(p.deviceId, it) }
        Keystore.storeAccountDeviceId(p.deviceId)
        AccountNameChoice.signUp?.let { AccountNameChoice.signUp = it.copy(username = new) }
        val device = Ed25519Sign(seed)
        val devicePub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)

        // 2. A grant that verifies under the new name (admin root), then the old one revoked (IRK): `.com`'s admin
        //    check takes the first grant it finds for the device key, so the broken one must go. Mint first.
        val issuedAt = now()
        val expiresAt = issuedAt + 90L * 24 * 3_600_000
        val scopes = OpenAccountViewModel.SIGNUP_SCOPES
        val grantBytes = listOf(
            "flagship/device-capability-grant/v2", p.newGrantId, new, p.deviceId, devicePub,
            scopes.joinToString(","), issuedAt.toString(), expiresAt.toString(),
        ).joinToString("|").toByteArray()
        val grant = JsonObject(
            linkedMapOf(
                "grantId" to JsonPrimitive(p.newGrantId), "username" to JsonPrimitive(new),
                "deviceId" to JsonPrimitive(p.deviceId), "devicePubKey" to JsonPrimitive(devicePub),
                "scopes" to JsonArray(scopes.map(::JsonPrimitive)),
                "issuedAt" to JsonPrimitive(issuedAt), "expiresAt" to JsonPrimitive(expiresAt),
            ),
        )
        val adminRoot = Keystore.adminRootKey(reason())
        // 409: this grant id is already there (a resume after the mint).
        post("/api/users/${enc(new)}/device-grants", JsonObject(mapOf("grant" to grant, "signature" to JsonPrimitive(HexUtil.encode(adminRoot.sign(grantBytes))))), setOf(200, 201, 409))
        val revokedAt = now()
        val revokeBytes = listOf("flagship/revoke-device-capability-grant/v1", p.oldGrantId, new, "replaced", revokedAt.toString())
            .joinToString("|").toByteArray()
        val irk = KeystoreIrkAccess().resolve(reason())
        val revoke = JsonObject(
            linkedMapOf(
                "grantId" to JsonPrimitive(p.oldGrantId), "username" to JsonPrimitive(new),
                "reason" to JsonPrimitive("replaced"), "issuedAt" to JsonPrimitive(revokedAt),
            ),
        )
        post("/api/users/${enc(new)}/device-grants/revoke", JsonObject(mapOf("request" to revoke, "signature" to JsonPrimitive(HexUtil.encode(irk.signer.sign(revokeBytes))))), setOf(200, 404))

        // 3. The two profiles, readable and signed under the new name (revision 2; a 409 means already written).
        val adminPub = requireNotNull(Keystore.adminRootPubHex())
        val at = now()
        val accountCt = AccountMetadata.encrypt(
            p.accountDisplayName, AccountMetadata.deriveAccountProfileKey(umk),
            AccountMetadataCoordinates(new, AccountMetadataRecordType.ACCOUNT_PROFILE, 2, 1),
        )
        val accountSig = adminRoot.sign(AccountMetadata.canonicalAccountProfile(new, 2, 1, accountCt, at, adminPub))
        val accountPath = "/api/accounts/$new/profile"
        ignoreConflict {
            server.putAccountProfile(
                new, directoryAuth(new, p.deviceId, devicePub, device, "PUT", accountPath),
                DirectoryProfileWriteRequest(
                    DirectoryProfileEnvelope(new, null, 2, 1, accountCt.nonceHex, accountCt.ciphertextHex, at, adminPub, HexUtil.encode(accountSig)), 1,
                ),
            )
        }
        val deviceCt = AccountMetadata.encrypt(
            p.deviceDisplayName, AccountMetadata.deriveDeviceDirectoryKey(umk),
            AccountMetadataCoordinates(new, AccountMetadataRecordType.DEVICE_SELF_PROFILE, 2, 1, p.deviceId),
        )
        val deviceSig = device.sign(AccountMetadata.canonicalDeviceSelfProfile(new, p.deviceId, 2, 1, deviceCt, at, devicePub))
        val devicePath = "/api/accounts/$new/devices/${p.deviceId}/profile"
        ignoreConflict {
            server.putDeviceSelfProfile(
                new, p.deviceId, directoryAuth(new, p.deviceId, devicePub, device, "PUT", devicePath),
                DirectoryProfileWriteRequest(
                    DirectoryProfileEnvelope(new, p.deviceId, 2, 1, deviceCt.nonceHex, deviceCt.ciphertextHex, at, devicePub, HexUtil.encode(deviceSig)), 1,
                ),
            )
        }
    }

    private suspend fun ignoreConflict(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: HttpException) {
            if (e.status != 409) throw e
        }
    }

    private fun directoryAuth(user: String, deviceId: String, pub: String, key: Ed25519Sign, method: String, path: String): AccountDirectoryAuthorization {
        val requestId = AccountMetadata.generateDeviceId()
        val at = now()
        val sig = key.sign(AccountMetadata.canonicalDirectoryRequest(user, deviceId, pub, method, path, requestId, at))
        return AccountDirectoryAuthorization(deviceId, pub, requestId, at, HexUtil.encode(sig))
    }

    override suspend fun onboard(name: String, previous: String?, account: CreatedAccount) {
        val current = app.currentUser.value
        when {
            previous != null && current.equals(previous, ignoreCase = true) -> {
                app.renameAccount(previous, name, account.accountDisplayName)
                app.armVoiciIntro(name)
            }
            current.equals(name, ignoreCase = true) && app.isPaired.value -> app.armVoiciIntro(name)
            else -> OpenAccountViewModel.finishOnboarding(app, account)
        }
        AccountNameChoice.signUp = null
        // A read token for the name the account has now (device-signed, no prompt).
        runCatching { AccountReadTokens.shared?.authorized(name) { } }
    }

    override fun bindPq() {
        com.flagshipserver.app.keystore.PqIdentityUpgrade.trigger()
    }
}
