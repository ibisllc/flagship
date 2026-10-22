// The "Your link" field on a service's page (docs/named-links.md). Kotlin mirror
// of the webapp's lib/linkField.js.
//
// The field shows `voi.ci/<name>`: the custom name an admin picked, else the
// service's random code, so the page never says "code". [LinkField.message] is
// pure (typed text + the link state + the last `.com` check -> one line and what
// may be done); [LinkFieldViewModel] is the state around it: the 400 ms debounced
// check, the confirm before a live name is replaced or cleared, "Free one up" and
// the signed save.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AppLinkState
import com.flagshipserver.app.api.VoiciNameCheck
import com.flagshipserver.app.api.VoiciNameClient
import com.flagshipserver.app.api.VoiciNameEntry
import com.flagshipserver.app.api.VoiciNameException
import com.flagshipserver.app.api.VoiciNameOrderBody
import com.flagshipserver.app.api.VoiciNameOrderFields
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.VoiciName
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.security.SecureRandom
import java.text.DateFormat
import java.util.Date

object LinkField {
    const val DEBOUNCE_MS = 400L
    private const val DAY_MS = 86_400_000L

    enum class Tone { None, Ok, Bad, Info }
    enum class Action { Dibs, FreeUp }

    data class Message(
        val tone: Tone = Tone.None,
        val text: String = "",
        val action: Action? = null,
        val canSave: Boolean = false,
    )

    fun formatWhen(ms: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))

    /**
     * @param typed   what the field holds, lower case and trimmed
     * @param current the name the service shows now (custom name or random code)
     * @param check   the last `.com` answer for [typed], or null while unknown
     */
    fun message(
        typed: String,
        current: String,
        link: AppLinkState,
        check: VoiciNameCheck?,
        admin: Boolean,
        now: Long = System.currentTimeMillis(),
        formatDate: (Long) -> String = ::formatWhen,
    ): Message {
        if (!admin) return Message(Tone.Info, FSStrings.get(R.string.only_an_admin_device_can_change_this))
        if (link.changesLeft <= 0) {
            return Message(Tone.Bad, FSStrings.get(R.string.next_change, formatDate(link.nextChangeAt ?: (now + DAY_MS))))
        }
        if (typed == current || typed.isEmpty()) return Message()
        when (VoiciName.problem(typed)) {
            VoiciName.Problem.Characters -> return Message(Tone.Bad, FSStrings.get(R.string.letters_numbers_and_hyphens_only))
            VoiciName.Problem.TooShort -> return Message(Tone.Bad, FSStrings.get(R.string.at_least_4_characters))
            VoiciName.Problem.TooLong -> return Message(Tone.Bad, FSStrings.get(R.string.at_most_40_characters))
            null -> Unit
        }
        if (link.held >= link.limit && link.name.isNullOrEmpty()) {
            return Message(Tone.Bad, FSStrings.get(R.string.all_names_in_use, link.limit), Action.FreeUp)
        }
        if (check == null) return Message()
        return when (check.status) {
            "available" -> Message(Tone.Ok, FSStrings.get(R.string.available), canSave = true)
            "current" -> Message()
            "invalid" -> Message(Tone.Bad, FSStrings.get(R.string.letters_numbers_and_hyphens_only))
            "reserved" -> Message(Tone.Bad, FSStrings.get(R.string.reserved))
            "taken" -> Message(Tone.Bad, FSStrings.get(R.string.taken))
            "dibs" -> Message(Tone.Info, FSStrings.get(R.string.reserved_for_the_owner_of, check.domain ?: ""), Action.Dibs)
            else -> Message(Tone.Bad, FSStrings.get(R.string.couldnt_check_try_again, typed))
        }
    }

    /** The sentence for a refusal from the save call. */
    fun refusalMessage(e: VoiciNameException, typed: String, formatDate: (Long) -> String = ::formatWhen): String =
        when (e.code) {
            "taken" -> FSStrings.get(R.string.taken)
            "reserved" -> FSStrings.get(R.string.reserved)
            "invalid" -> FSStrings.get(R.string.letters_numbers_and_hyphens_only)
            "dibs" -> FSStrings.get(R.string.reserved_for_the_owner_of, e.string("domain") ?: "")
            "dibs-unchecked" -> FSStrings.get(R.string.couldnt_check_try_again, typed)
            "change-limit" -> FSStrings.get(
                R.string.next_change,
                formatDate(e.long("nextChangeAt") ?: (System.currentTimeMillis() + DAY_MS)),
            )
            "name-limit" -> FSStrings.get(R.string.all_names_in_use, e.int("limit") ?: 0)
            "rate-limited" -> FSStrings.get(R.string.too_many_changes_today)
            "not-admin" -> FSStrings.get(R.string.only_an_admin_device_can_change_this)
            else -> FSStrings.get(R.string.couldnt_save_try_again)
        }
}

/** A replace or clear waiting for the person's yes: [name] is "" for a clear, [replacing] is the live name that stops working. */
data class LinkChange(val serviceId: String, val name: String, val replacing: String)

class LinkFieldViewModel(
    private val client: VoiciNameClient,
    private val username: () -> String?,
    private val serviceId: String,
    /** The sensitive-order key: the admin root when held, else the IRK. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val randomBytes: (Int) -> ByteArray = { n -> ByteArray(n).also(SecureRandom()::nextBytes) },
    private val debounceMs: Long = LinkField.DEBOUNCE_MS,
    /** Where the debounced check runs; the view model's own scope when null. */
    private val scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope: CoroutineScope get() = scopeOverride ?: viewModelScope

    private var bound = false
    private var admin = false
    private var shortCode = ""
    private var link = AppLinkState()
    private var last: Pair<String, VoiciNameCheck>? = null
    private var seq = 0
    private var checkJob: Job? = null

    private val _typed = MutableStateFlow("")
    val typed: StateFlow<String> = _typed.asStateFlow()
    private val _message = MutableStateFlow(LinkField.Message())
    val message: StateFlow<LinkField.Message> = _message.asStateFlow()
    private val _linkState = MutableStateFlow(AppLinkState())
    val linkState: StateFlow<AppLinkState> = _linkState.asStateFlow()
    private val _confirm = MutableStateFlow<LinkChange?>(null)
    val confirm: StateFlow<LinkChange?> = _confirm.asStateFlow()
    private val _freeUp = MutableStateFlow<List<VoiciNameEntry>?>(null)
    val freeUp: StateFlow<List<VoiciNameEntry>?> = _freeUp.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _canUseDefault = MutableStateFlow(false)
    val canUseDefault: StateFlow<Boolean> = _canUseDefault.asStateFlow()

    private val current: String get() = link.name?.takeIf { it.isNotEmpty() } ?: shortCode

    /** Take the links `.com` just returned. The field keeps what the person typed unless it still shows the old name. */
    fun bind(shortCode: String, link: AppLinkState, admin: Boolean) {
        val untouched = !bound || _typed.value == current
        this.shortCode = shortCode
        this.link = link
        this.admin = admin
        bound = true
        if (untouched) _typed.value = current
        refresh()
    }

    private fun refresh() {
        _linkState.value = link
        val t = _typed.value.trim()
        _message.value = LinkField.message(t, current, link, last?.takeIf { it.first == t }?.second, admin, now())
        _canUseDefault.value = admin && !link.name.isNullOrEmpty() && t == link.name
    }

    fun onTyped(raw: String) {
        _typed.value = raw.lowercase()
        last = null
        checkJob?.cancel()
        refresh()
        checkJob = scope.launch {
            delay(debounceMs)
            runCheck()
        }
    }

    /** Ask `.com` about the typed name, if the local rules already let it through. */
    suspend fun runCheck() {
        val user = username()?.lowercase() ?: return
        val t = _typed.value.trim()
        val base = LinkField.message(t, current, link, VoiciNameCheck("available"), admin, now())
        if (!base.canSave) return refresh()
        val mine = ++seq
        val result = try {
            client.check(user, serviceId, t)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            VoiciNameCheck("error")
        }
        if (mine != seq) return
        last = t to result
        refresh()
    }

    /** Save the typed name; asks first when a live custom name would stop working. */
    suspend fun requestSave() {
        val t = _typed.value.trim()
        if (!_message.value.canSave) return
        request(LinkChange(serviceId, t, link.name.orEmpty()))
    }

    /** Back to the random code ("Use default" under the field). */
    suspend fun requestClear() {
        if (link.name.isNullOrEmpty()) return
        request(LinkChange(serviceId, "", link.name.orEmpty()))
    }

    private suspend fun request(change: LinkChange) {
        if (change.replacing.isEmpty()) commit(change) else _confirm.value = change
    }

    fun dismissConfirm() {
        _confirm.value = null
    }

    suspend fun confirmPending() {
        val change = _confirm.value ?: return
        _confirm.value = null
        commit(change)
    }

    private suspend fun commit(change: LinkChange) {
        val user = username()?.lowercase() ?: return
        _busy.value = true
        try {
            val op = if (change.name.isEmpty()) VoiciName.OP_CLEAR else VoiciName.OP_SET
            val fields = VoiciNameOrderFields(
                user = user,
                serviceId = change.serviceId,
                name = change.name.lowercase(),
                op = op,
                issuedAt = now(),
                nonce = HexUtil.encode(randomBytes(32)),
            )
            val key = signer(FSStrings.get(R.string.change_your_link))
            val signature = key.sign(
                VoiciName.canonicalBytes(fields.user, fields.serviceId, fields.name, fields.op, fields.issuedAt, fields.nonce),
            )
            val next = client.save(user, change.serviceId, VoiciNameOrderBody(fields, HexUtil.encode(signature)))
            if (change.serviceId == serviceId) {
                link = next
                last = null
                _typed.value = current
            } else {
                link = link.copy(held = maxOf(0, link.held - 1))
            }
            _freeUp.value = null
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: BiometricCancelled) {
            refresh()
        } catch (e: VoiciNameException) {
            _message.value = LinkField.Message(LinkField.Tone.Bad, LinkField.refusalMessage(e, change.name))
        } catch (e: Exception) {
            _message.value = LinkField.Message(LinkField.Tone.Bad, FSStrings.get(R.string.couldnt_save_try_again))
        } finally {
            _busy.value = false
        }
    }

    /** "Free one up": the account's live names, each with "Use default". */
    suspend fun openFreeUp() {
        val user = username()?.lowercase() ?: return
        try {
            _freeUp.value = client.list(user)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _message.value = LinkField.Message(LinkField.Tone.Bad, FSStrings.get(R.string.couldnt_save_try_again))
        }
    }

    fun closeFreeUp() {
        _freeUp.value = null
    }

    suspend fun requestClear(entry: VoiciNameEntry) {
        if (entry.serviceId == serviceId) requestClear() else request(LinkChange(entry.serviceId, "", entry.name))
    }
}
