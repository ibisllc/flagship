// V3 — Replace service URL stem. Kotlin mirror of FlagshipUI's
// AppDetailViewModel.renameApp.
//
//   1. Derive the user's IRK locally.
//   2. Sign canonical flagship/service-rename/v1 bytes.
//   3. POST /api/users/:u/apps/:serviceId/rename.
//   4. Reflect the new canonical + short URL in `links`.
//
// Failure modes:
//   - empty draft → reject before deriving keys (no biometric prompt).
//   - 409 collision → friendly "another service uses that name" hint.
//   - 400 invalid label → friendly format hint.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppRenameRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.SetCustomDomainRequest
import com.flagshipserver.app.core.ServiceRenameClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.SetCustomDomainClaim
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface RenameServicePhase {
    data object Idle : RenameServicePhase
    data object Signing : RenameServicePhase
    data object Posting : RenameServicePhase
    data class Completed(val displayLabel: String, val shortUrl: String?) : RenameServicePhase
    data class Failed(val message: String) : RenameServicePhase
}

/** On-device custom-domain rate-limit mirror. The .com last_changed
 *  column is the real backstop (429) — this is just the UX cooldown,
 *  so a lost local stamp simply means the server 429s instead. */
interface CustomDomainCooldownStore {
    /** Last successful change for the service, epoch ms (0 = none). */
    fun lastChangedMs(serviceId: String): Long
    fun recordNow(serviceId: String)

    object Noop : CustomDomainCooldownStore {
        override fun lastChangedMs(serviceId: String): Long = 0L
        override fun recordNow(serviceId: String) {}
    }

    companion object {
        /** SharedPreferences-backed store. Key shape mirrors iOS
         *  UserDefaults: flagship.customDomain.lastChanged.<serviceId>. */
        fun fromContext(ctx: android.content.Context): CustomDomainCooldownStore {
            val prefs = ctx.getSharedPreferences(
                "flagship.customDomain", android.content.Context.MODE_PRIVATE,
            )
            return object : CustomDomainCooldownStore {
                private fun key(serviceId: String) = "flagship.customDomain.lastChanged.$serviceId"
                override fun lastChangedMs(serviceId: String): Long =
                    prefs.getLong(key(serviceId), 0L)
                override fun recordNow(serviceId: String) {
                    prefs.edit().putLong(key(serviceId), System.currentTimeMillis()).apply()
                }
            }
        }
    }
}

/** One-at-a-time alert driving the set-custom-domain flow. Mirrors
 *  AppDetailViewModel.CustomDomainPrompt: a confirm+cancel when
 *  [onConfirm] is set, else an informational single-dismiss alert. */
data class CustomDomainPrompt(
    val title: String,
    val message: String,
    val confirmLabel: String?,
    val destructive: Boolean,
    val onConfirm: (suspend () -> Unit)?,
)

/** 300s — identical to .com (CUSTOM_DOMAIN_RATE_LIMIT_MS) + iOS. */
const val CUSTOM_DOMAIN_COOLDOWN_MS: Long = 300_000

class RenameServiceViewModel(
    private val server: FlagshipServerClient,
    private val serviceId: String,
    private val username: () -> String?,
    private val cooldownStore: CustomDomainCooldownStore = CustomDomainCooldownStore.Noop,
) : ViewModel() {
    private val _phase = MutableStateFlow<RenameServicePhase>(RenameServicePhase.Idle)
    val phase: StateFlow<RenameServicePhase> = _phase.asStateFlow()

    private val _links = MutableStateFlow<AppLinksResponse?>(null)
    val links: StateFlow<AppLinksResponse?> = _links.asStateFlow()

    private val _customDomainPrompt = MutableStateFlow<CustomDomainPrompt?>(null)
    val customDomainPrompt: StateFlow<CustomDomainPrompt?> = _customDomainPrompt.asStateFlow()

    /** Cooldown deadline (epoch ms) or null when not cooling. The UI
     *  ticks a 1s countdown against this + disables Add until it
     *  elapses. Rebuilt from the on-device stamp on every load. */
    private val _customDomainCooldownUntilMs = MutableStateFlow<Long?>(null)
    val customDomainCooldownUntilMs: StateFlow<Long?> = _customDomainCooldownUntilMs.asStateFlow()

    suspend fun loadLinks() {
        val u = username() ?: return
        runCatching { server.getAppLinks(u, serviceId) }
            .onSuccess { _links.value = it }
        // Rebuild the countdown from the on-device timestamp so it
        // survives an app reload / VM recreation (mirrors iOS
        // loadAppLinks → restoreCooldownFromLocal).
        restoreCooldownFromLocal()
    }

    fun dismissCustomDomainPrompt() {
        _customDomainPrompt.value = null
    }

    /** Validate the draft and either raise an explanatory prompt or
     *  issue the binding request. Byte-faithful to iOS
     *  AppDetailViewModel.submitCustomDomain. */
    suspend fun submitCustomDomain(rawDraft: String) {
        val fqdn = rawDraft.trim().lowercase()
            .removePrefix("https://").removePrefix("http://")
            .trim('/')
        if (fqdn.isEmpty()) return

        // Client mirror of the server's last_changed rate limit.
        val until = _customDomainCooldownUntilMs.value
        if (until != null && until > System.currentTimeMillis()) return

        // (a) Apex / no subdomain — <3 labels means there's no
        // subdomain to CNAME. Offer the www form. Structural (not a
        // DNS check) so it stays instant + local.
        if (fqdn.split(".").size < 3) {
            val suggested = "www.$fqdn"
            _customDomainPrompt.value = CustomDomainPrompt(
                title = FSStrings.get(R.string.subdomains_only),
                message = FSStrings.get(R.string.this_only_supports_subdomains_an_apex, fqdn, suggested),
                confirmLabel = FSStrings.get(R.string.use, suggested),
                destructive = false,
                onConfirm = { submitCustomDomain(suggested) },
            )
            return
        }

        // No phone-side CNAME check: .com re-validates authoritatively;
        // a failed CNAME comes back asynchronously, not here.

        // (b) Replacing an existing binding — confirm first. The swap
        // is destructive + irreversible: this device drops its memory
        // of the old domain immediately, even if the new one never
        // confirms (there's no "forget a domain" affordance otherwise).
        val existing = _links.value?.customDomain
        if (existing != null && existing != fqdn) {
            _customDomainPrompt.value = CustomDomainPrompt(
                title = FSStrings.get(R.string.replace_custom_domain),
                message = FSStrings.get(R.string.this_will_permanently_replace_the_current, existing),
                confirmLabel = FSStrings.get(R.string.replace),
                destructive = true,
                onConfirm = { bindCustomDomain(fqdn) },
            )
            return
        }

        // (c) Clean path — decoupled request: a 200 only RECORDS it.
        bindCustomDomain(fqdn)
    }

    private suspend fun bindCustomDomain(fqdn: String) {
        _customDomainPrompt.value = null
        val user = username()
        if (user.isNullOrEmpty()) {
            _customDomainPrompt.value = CustomDomainPrompt(
                FSStrings.get(R.string.couldnt_request_custom_domain), FSStrings.get(R.string.no_active_account_on_this_device), null, false, null,
            )
            return
        }
        val signer = try {
            // Slice D — attaching a custom domain is SENSITIVE (customDomain.ts
            // gates it on the admin master root): sign with the admin root when
            // this device holds one, else the owner IRK (legacy). Canonical bytes
            // unchanged. (The service URL-stem rename below stays owner-IRK — not
            // in the sensitive set.)
            Keystore.adminSigningKey(FSStrings.get(R.string.attach_custom_domain))
        } catch (e: Throwable) {
            _customDomainPrompt.value = CustomDomainPrompt(
                FSStrings.get(R.string.couldnt_request_custom_domain),
                FSStrings.get(R.string.couldnt_access_your_account_keys, e.message), null, false, null,
            )
            return
        }
        val issuedAt = System.currentTimeMillis()
        val canonical = SetCustomDomainClaim.canonicalBytes(
            username = user, serviceId = serviceId, fqdn = fqdn, issuedAt = issuedAt,
        )
        val signature = signer.sign(canonical)
        try {
            // 200 = recorded (NOT yet confirmed). Surface the domain
            // optimistically from the refreshed links; the set/fail
            // outcome arrives later as a pushed alert (backend #79B).
            val resp = server.setCustomDomain(
                username = user,
                serviceId = serviceId,
                body = SetCustomDomainRequest(
                    request = SetCustomDomainRequest.Inner(
                        username = user, serviceId = serviceId, fqdn = fqdn, issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            _links.value = resp
            cooldownStore.recordNow(serviceId)
            restoreCooldownFromLocal()
        } catch (e: Throwable) {
            // Non-200 is the ONLY synchronous denial — rate-limit /
            // busy, never a CNAME verdict (that's async). Show .com's
            // reason verbatim; for 429 it is the byte-identical
            // "Too soon — try again in Ns." string the Mock uses.
            val msg = (e as? HttpException)?.let { extractError(it.body) }
                ?: e.message ?: FSStrings.get(R.string.couldnt_request_custom_domain_2)
            _customDomainPrompt.value = CustomDomainPrompt(
                FSStrings.get(R.string.couldnt_request_custom_domain), msg, null, false, null,
            )
        }
    }

    /** Live's HttpException.body is `{"error":"…"}`; the Mock's is the
     *  bare reason string. Both yield the same user-facing text. */
    private fun extractError(body: String): String =
        Regex("\"error\"\\s*:\\s*\"([^\"]*)\"").find(body)?.groupValues?.get(1) ?: body

    private fun restoreCooldownFromLocal() {
        val ts = cooldownStore.lastChangedMs(serviceId)
        if (ts <= 0L) {
            _customDomainCooldownUntilMs.value = null
            return
        }
        val deadline = ts + CUSTOM_DOMAIN_COOLDOWN_MS
        _customDomainCooldownUntilMs.value =
            if (deadline > System.currentTimeMillis()) deadline else null
    }

    suspend fun rename(draft: String): Boolean {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = RenameServicePhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return false
        }
        val trimmed = draft.trim().lowercase()
        if (trimmed.isEmpty()) {
            _phase.value = RenameServicePhase.Failed(FSStrings.get(R.string.pick_a_non_empty_label))
            return false
        }
        _phase.value = RenameServicePhase.Signing
        val signer = try {
            Keystore.deriveIRK(FSStrings.get(R.string.rename_service_url_stem))
        } catch (e: Throwable) {
            _phase.value = RenameServicePhase.Failed(FSStrings.get(R.string.couldnt_access_your_account_keys, UserErrorText.reason(e)))
            return false
        }
        val issuedAt = System.currentTimeMillis()
        val canonical = ServiceRenameClaim.canonicalBytes(
            username = user,
            serviceId = serviceId,
            newDisplayLabel = trimmed,
            issuedAt = issuedAt,
        )
        val signature = signer.sign(canonical)
        _phase.value = RenameServicePhase.Posting
        return try {
            val resp = server.renameApp(
                username = user,
                serviceId = serviceId,
                body = AppRenameRequest(
                    request = AppRenameRequest.Inner(
                        username = user,
                        serviceId = serviceId,
                        newDisplayLabel = trimmed,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            if (resp.displayLabel != null && resp.canonicalUrl != null) {
                _links.value = AppLinksResponse(
                    serviceId = serviceId,
                    displayLabel = resp.displayLabel,
                    canonicalUrl = resp.canonicalUrl,
                    instances = _links.value?.instances ?: emptyList(),
                    shortUrl = resp.shortUrl,
                    shortCode = _links.value?.shortCode,
                    link = _links.value?.link,
                )
            }
            _phase.value = RenameServicePhase.Completed(
                displayLabel = resp.displayLabel ?: trimmed,
                shortUrl = resp.shortUrl,
            )
            loadLinks()
            true
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("409") -> FSStrings.get(R.string.another_service_already_uses_that_name)
                msg.contains("400") -> FSStrings.get(R.string.that_name_isnt_valid_use_lowercase)
                msg.contains("403") -> FSStrings.get(R.string.sign_in_is_needed_re_open)
                else -> FSStrings.get(R.string.couldnt_rename, msg)
            }
            _phase.value = RenameServicePhase.Failed(friendly)
            false
        }
    }
}
