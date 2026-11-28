// "Choose your own account name" at sign-up (owner decision 2026-11-23; iOS is the reference, the webapp twin is
// webapp/lib/chooseName.js).
//
// `.com` opens an account only under a name it suggested. So the phone creates the account under the suggested name
// as always (without the PQ binding or the voi.ci intro yet), quotes the chosen name, pays (the $10 pack of ten
// vouchers through Google Play, or a name code), and runs the paid rename (`POST /api/account/name-change`). `.com`
// moves the account's rows; what it can't move is anything signed over the old name, so this device then keeps its
// device key (derived from the old name) under the new one, mints its grant again and revokes the old one, writes
// both profiles again, moves its Keystore profile and only then onboards: read token, PQ binding, voi.ci intro.
//
// A small record survives a crash: on the next unlock the choice is finished when `.com` says the new name is this
// account's, or dropped (the account keeps the suggested name). While it exists nothing binds the account's keys
// and a 404 for the old name is not "This account was removed". Nothing paid is lost: `.com` puts a code or the
// vouchers back when the rename fails, and bought vouchers stay in the account's wallet.

package com.flagshipserver.app.core

import android.content.Context
import com.flagshipserver.app.viewmodels.CreatedAccount
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The choice in flight. [stage]: RENAMING (asked `.com`), RENAMED (`.com` renamed), SETTLED (this device too). */
@Serializable
data class PendingNameChoice(
    val oldName: String,
    val newName: String,
    val deviceId: String,
    val oldGrantId: String,
    val newGrantId: String,
    val accountDisplayName: String,
    val deviceDisplayName: String,
    val stage: String = RENAMING,
) {
    companion object {
        const val RENAMING = "renaming"
        const val RENAMED = "renamed"
        const val SETTLED = "settled"
    }
}

interface PendingNameChoiceStore {
    fun get(): PendingNameChoice?
    fun put(p: PendingNameChoice)
    fun clear()
}

class MemoryPendingNameChoiceStore(private var value: PendingNameChoice? = null) : PendingNameChoiceStore {
    override fun get() = value
    override fun put(p: PendingNameChoice) { value = p }
    override fun clear() { value = null }
}

/** Plain prefs: the record names no secret (a name code is never kept), and it must be readable before an unlock. */
class PrefsPendingNameChoiceStore(context: Context) : PendingNameChoiceStore {
    private val prefs = context.getSharedPreferences("flagship.name-choice.v1", Context.MODE_PRIVATE)
    override fun get(): PendingNameChoice? = prefs.getString(KEY, null)?.let {
        runCatching { Json.decodeFromString(PendingNameChoice.serializer(), it) }.getOrNull()
    }
    override fun put(p: PendingNameChoice) {
        prefs.edit().putString(KEY, Json.encodeToString(PendingNameChoice.serializer(), p)).commit()
    }
    override fun clear() { prefs.edit().remove(KEY).commit() }
    private companion object { const val KEY = "pending" }
}

object AccountNameChoice {
    /** The ten-voucher pack: $10, the price of a name. */
    const val PACK_UNITS = 10

    @Volatile var store: PendingNameChoiceStore = MemoryPendingNameChoiceStore()

    /** Set by MainActivity: the live side of a choice (null in a gym run on mocks: no choose button there). */
    @Volatile var ops: (() -> NameChoiceOps)? = null

    /** The account made on the choose screen, before onboarding: payments and read tokens work for it already. */
    data class SignUp(val username: String, val deviceId: String)
    @Volatile var signUp: SignUp? = null

    /** A name the owner set aside for this person (a name-grant link), held until the account exists. Memory only. */
    @Volatile var grant: NameGrant? = null

    private val _finishing = MutableStateFlow(false)
    /** True while a choice found at an unlock is being finished ("Finishing your account name…"). */
    val finishing: StateFlow<Boolean> = _finishing.asStateFlow()

    /** A choice for [name] (either name) isn't finished: nothing may bind its keys or call it gone. */
    fun pendingFor(name: String?): Boolean {
        val p = runCatching { store.get() }.getOrNull() ?: return false
        val n = name?.lowercase() ?: return false
        return n == p.oldName || n == p.newName
    }

    fun pending(): Boolean = runCatching { store.get() }.getOrNull() != null

    /** At an unlock: finish or drop a choice a crash left behind. Never throws. */
    suspend fun resumeIfPending() {
        if (!pending() || _finishing.value) return
        val ops = ops?.invoke() ?: return
        _finishing.value = true
        try {
            runCatching { ChooseNameFlow.resume(store, ops) }
        } finally {
            _finishing.value = false
        }
    }
}

/**
 * A name the owner set aside for a friend (`scripts/name-grant.mjs`): the link
 * `https://<control host>/app/choose-name#n=<name>&g=<code>&e=<expiresAt ms>[&f=1]` lifts the dibs hold on exactly
 * that name until [expiresAt]; [free] grants also pay. The code is a bearer secret: memory only, never logged.
 */
data class NameGrant(val name: String, val code: String, val expiresAt: Long, val free: Boolean) {
    override fun toString(): String = "NameGrant($name)"

    companion object {
        const val ROUTE = "choose-name"

        /** The link's fragment (`n=…&g=…&e=…[&f=1]`), or null when it isn't one. */
        fun parseFragment(fragment: String?): NameGrant? {
            val p = (fragment ?: return null).split('&').mapNotNull { kv ->
                val i = kv.indexOf('=')
                if (i <= 0) null else kv.substring(0, i) to runCatching { java.net.URLDecoder.decode(kv.substring(i + 1), "UTF-8") }.getOrNull()
            }.toMap()
            val name = p["n"]?.trim()?.lowercase()?.takeIf { it.isNotEmpty() && VoiciName.problem(it) == null } ?: return null
            val code = p["g"]?.trim()?.takeIf { it.isNotEmpty() && it.length <= 128 && it.none { c -> c.isWhitespace() || c == '|' } } ?: return null
            val expiresAt = p["e"]?.toLongOrNull()?.takeIf { it > 0 } ?: return null
            return NameGrant(name, code, expiresAt, p["f"] == "1")
        }
    }
}

sealed interface NameChoicePayment {
    /** Pay $10: the ten-voucher pack through the store, then ten vouchers pay the rename. */
    data object Card : NameChoicePayment
    data class Code(val code: String) : NameChoicePayment
    /** A free name grant pays: nothing else is sent. */
    data object Granted : NameChoicePayment
}

sealed interface NameQuote {
    /** [paid]: a free name grant already pays for it. */
    data class Available(val units: Int, val paid: Boolean = false) : NameQuote
    /** `dibs-held`: [domain] is the `.com` that holds the name (maybe the de-hyphenated label; null from an older
     *  `.com`), [checked] false when `.com`'s lookup of it failed. */
    data class Refused(
        val code: String,
        val problem: String? = null,
        val heldUntil: Long? = null,
        val domain: String? = null,
        val checked: Boolean = true,
    ) : NameQuote
}

sealed interface PackOutcome {
    data object Bought : PackOutcome
    data object Cancelled : PackOutcome
    data object Failed : PackOutcome
}

/** `.com` refused the rename (or a step of paying for it) with [code]. */
class NameChangeRefused(
    val code: String,
    val problem: String? = null,
    val heldUntil: Long? = null,
    val domain: String? = null,
    val checked: Boolean = true,
) : Exception(code)

/** What `.com` said about the name in the field while it was typed (the precheck). */
sealed interface NameCheck {
    val name: String?

    /** Nothing asked: an empty or badly formed name, or one not yet asked about. */
    data object Idle : NameCheck { override val name: String? = null }
    data class Open(override val name: String) : NameCheck
    /** Held for the holder of [domain] ([checked] false: its lookup failed). Pay and Use a voucher stay off. */
    data class Held(override val name: String, val domain: String, val until: Long?, val checked: Boolean) : NameCheck
    /** Taken, or a link that no longer works. */
    data class Refused(override val name: String, val notice: NameChoiceNotice) : NameCheck
    /** `.com` couldn't answer (an older `.com`, no network): Pay checks, as before. */
    data class Unknown(override val name: String) : NameCheck

    companion object {
        /** The `.com` `.com` named, else `<name>.com`. */
        fun domain(domain: String?, name: String): String =
            domain?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "${name.lowercase()}.com"
    }
}

/** What the screen says (NameChoiceCopy turns it into a sentence). */
sealed interface NameChoiceNotice {
    data class Problem(val problem: VoiciName.Problem) : NameChoiceNotice
    data object Taken : NameChoiceNotice
    data class Held(val name: String, val domain: String, val until: Long?, val checked: Boolean = true) : NameChoiceNotice
    data object CodeInvalid : NameChoiceNotice
    data object CodeUsed : NameChoiceNotice
    data class PaymentCancelled(val kept: String) : NameChoiceNotice
    data class PaymentFailed(val kept: String) : NameChoiceNotice
    data class FailedVouchers(val kept: String) : NameChoiceNotice
    data class FailedCode(val kept: String) : NameChoiceNotice
    data object GrantExpired : NameChoiceNotice
    data object GrantInvalid : NameChoiceNotice
    /** Creating the account itself failed: the usual sign-up sentence for [error]. */
    data class CreateFailed(val error: Throwable) : NameChoiceNotice
}

/** Everything the flow does outside itself; LiveNameChoiceOps in the app, a fake in the tests. */
interface NameChoiceOps {
    /** Create the account under [suggested] (keys, claim, grant, profiles), not onboarded. Safe to repeat. */
    suspend fun createAccount(suggested: String): CreatedAccount
    /** [grant]: the owner's grant for exactly [newName], when the person came with one. */
    suspend fun quote(oldName: String, newName: String, grant: NameGrant?): NameQuote
    /** The quote without an account: the check while typing, before anything is opened. Null when `.com` couldn't
     *  answer (an older `.com` refuses the shape, or no network): Pay checks then. */
    suspend fun precheck(newName: String, grant: NameGrant?): NameQuote? = null
    /** Vouchers in the account's wallet now. */
    suspend fun walletBalance(): Int
    suspend fun buyPack(units: Int): PackOutcome
    /**
     * The rename, paid by [payment] ([units] vouchers from the wallet for Card, marked spent on success).
     * [NameChangeRefused] on a refusal, anything else when the answer never came.
     */
    suspend fun rename(oldName: String, newName: String, payment: NameChoicePayment, units: Int, grant: NameGrant?)
    /** Does `.com` say [name] is this account's (its IRK)? Null when it couldn't be asked. */
    suspend fun ownsName(name: String): Boolean?
    /** This device's half of the rename: device key, grant swap, profiles, Keystore profile. Safe to repeat. */
    suspend fun settle(p: PendingNameChoice)
    /** Open the account as [name] (from [previous] when the app already shows it): AppState, read token, PQ binding,
     *  voi.ci intro. */
    suspend fun onboard(name: String, previous: String?, account: CreatedAccount)
    /** The account is open and no choice is pending: bind its keys to their PQ halves. */
    fun bindPq()
}

/**
 * The choose screen's logic. [suggested] is the name `.com` offered; the account is created under it on the first
 * Pay / Use and stays under it whatever happens next until a rename goes through.
 */
class ChooseNameFlow(
    val suggested: String,
    private val ops: NameChoiceOps,
    /** A name-grant link's grant: the name is filled in, and a free one needs no payment. */
    val grant: NameGrant? = null,
    private val store: PendingNameChoiceStore = AccountNameChoice.store,
    private val newGrantId: () -> String = { java.util.UUID.randomUUID().toString().lowercase() },
) {
    sealed interface Phase {
        data object Editing : Phase
        /** "Setting up your account name…" */
        data object Working : Phase
        /** "Your account is now {0}." The account opens on Continue. */
        data class Done(val name: String) : Phase
        data object Opened : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Editing)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private val _notice = MutableStateFlow<NameChoiceNotice?>(null)
    val notice: StateFlow<NameChoiceNotice?> = _notice.asStateFlow()
    private val _check = MutableStateFlow<NameCheck>(NameCheck.Idle)
    /** The precheck's answer for the name in the field. */
    val check: StateFlow<NameCheck> = _check.asStateFlow()
    private val _account = MutableStateFlow<CreatedAccount?>(null)
    /** The account once it exists (under the suggested name until a rename goes through). */
    val account: StateFlow<CreatedAccount?> = _account.asStateFlow()

    /** The local check while typing (`.com` has the last word on submit). */
    fun problem(typed: String): VoiciName.Problem? = typed.trim().takeIf { it.isNotEmpty() }?.let { VoiciName.problem(it) }

    /** The hold on [typed], when `.com` said it is held: nothing may be opened or charged for it. */
    fun heldFor(typed: String): NameCheck.Held? = (_check.value as? NameCheck.Held)?.takeIf { it.name == typed.trim().lowercase() }

    /** The precheck's refusal (taken, a link that no longer works) for [typed]. */
    fun refusedFor(typed: String): NameChoiceNotice? = (_check.value as? NameCheck.Refused)?.takeIf { it.name == typed.trim().lowercase() }?.notice

    /**
     * Ask `.com` about [typed] (after the screen's debounce, Done on the keyboard, or Pay). A name already answered
     * is not asked again, except a hold whose lookup failed.
     */
    suspend fun check(typed: String) {
        val n = typed.trim().lowercase()
        if (n.isEmpty() || VoiciName.problem(n) != null) { _check.value = NameCheck.Idle; return }
        val known = _check.value
        if (known.name == n && !(known is NameCheck.Held && !known.checked)) return
        if (known.name != n && known is NameCheck.Held) _check.value = NameCheck.Idle
        asking = n
        val answer = try {
            ops.precheck(n, grant?.takeIf { it.name == n })
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        // A later name was asked about meanwhile: this answer is stale.
        if (asking != n) return
        _check.value = checkFor(n, answer)
    }

    private var asking: String? = null

    suspend fun submit(typed: String, payment: NameChoicePayment) {
        if (_phase.value != Phase.Editing) return
        val wanted = typed.trim().lowercase()
        VoiciName.problem(wanted)?.let { _notice.value = NameChoiceNotice.Problem(it); return }
        if (payment is NameChoicePayment.Code && payment.code.isBlank()) return
        if (heldFor(wanted) != null) return
        _notice.value = null
        _phase.value = Phase.Working
        try {
            run(wanted, payment)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            // A quote, a purchase or this device's half failing to reach `.com`: nothing is lost, the choice is
            // kept (when the rename went through) for the next unlock.
            val kept = _account.value?.username ?: suggested
            _notice.value = if (payment is NameChoicePayment.Card) NameChoiceNotice.FailedVouchers(kept) else NameChoiceNotice.FailedCode(kept)
        } finally {
            if (_phase.value == Phase.Working) _phase.value = Phase.Editing
        }
    }

    private suspend fun run(wanted: String, payment: NameChoicePayment) {
        // Nothing is opened or charged for a name `.com` already refuses.
        check(wanted)
        when (_check.value.takeIf { it.name == wanted }) {
            is NameCheck.Held, is NameCheck.Refused -> return
            else -> Unit
        }
        val account = _account.value ?: try {
            ops.createAccount(suggested).also { _account.value = it }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            _notice.value = NameChoiceNotice.CreateFailed(t)
            return
        }
        val kept = account.username
        if (wanted == kept) return settled(account, null)
        val g = grant?.takeIf { it.name == wanted }
        val q = ops.quote(kept, wanted, g)
        if (q is NameQuote.Refused) { _notice.value = refused(q.code, q.problem, q.heldUntil, q.domain, q.checked, wanted, kept, payment); return }
        q as NameQuote.Available
        // A free grant pays (and only it): the screen then offers only Continue.
        val pay = if (q.paid) NameChoicePayment.Granted else payment
        if (pay == NameChoicePayment.Granted && !q.paid) { _notice.value = refusal("payment-required", null, null, wanted, kept, pay); return }
        val units = q.units
        if (pay is NameChoicePayment.Card && ops.walletBalance() < units) {
            when (ops.buyPack(units)) {
                PackOutcome.Cancelled -> { _notice.value = NameChoiceNotice.PaymentCancelled(kept); return }
                PackOutcome.Failed -> { _notice.value = NameChoiceNotice.PaymentFailed(kept); return }
                PackOutcome.Bought -> if (ops.walletBalance() < units) { _notice.value = NameChoiceNotice.PaymentFailed(kept); return }
            }
        }
        val pending = PendingNameChoice(
            oldName = kept, newName = wanted, deviceId = account.deviceId, oldGrantId = account.grantId,
            newGrantId = newGrantId(), accountDisplayName = displayName(wanted), deviceDisplayName = account.deviceDisplayName,
        )
        store.put(pending)
        try {
            ops.rename(kept, wanted, if (pay is NameChoicePayment.Code) pay.copy(code = pay.code.trim()) else pay, units, g)
        } catch (e: NameChangeRefused) {
            store.clear()
            _notice.value = refused(e.code, e.problem, e.heldUntil, e.domain, e.checked, wanted, kept, pay)
            return
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            // No answer: the rename may or may not have happened. Ask whose the name is now; when `.com` can't say,
            // the record stays and the next unlock (or Keep) settles it.
            val owner = ops.ownsName(wanted)
            if (owner != true) {
                if (owner == false) store.clear()
                _notice.value = if (payment is NameChoicePayment.Card) NameChoiceNotice.FailedVouchers(kept) else NameChoiceNotice.FailedCode(kept)
                return
            }
        }
        store.put(pending.copy(stage = PendingNameChoice.RENAMED))
        // `.com` renamed the account: from here it is the new name, whatever this device still has to do.
        settled(account, pending)
        try {
            ops.settle(pending)
            store.put(pending.copy(stage = PendingNameChoice.SETTLED))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            // Continue (or the next unlock) settles it: the record says RENAMED.
        }
    }

    /** A refusal's sentence; a hold shows as the status line under the field instead (the precheck's). */
    private fun refused(
        code: String, problem: String?, heldUntil: Long?, domain: String?, checked: Boolean,
        wanted: String, kept: String, payment: NameChoicePayment,
    ): NameChoiceNotice? {
        val n = refusal(code, problem, heldUntil, wanted, kept, payment, domain, checked)
        if (n is NameChoiceNotice.Held) {
            _check.value = NameCheck.Held(wanted, n.domain, n.until, n.checked)
            return null
        }
        return n
    }

    private fun settled(account: CreatedAccount, p: PendingNameChoice?) {
        val renamed = if (p == null) account else account.copy(username = p.newName, accountDisplayName = p.accountDisplayName)
        _account.value = renamed
        _phase.value = Phase.Done(renamed.username)
    }

    /** Continue after "Your account is now …", or "Keep {suggested}": open the account under the name it has. */
    suspend fun open() {
        val a = _account.value ?: return
        if (_phase.value == Phase.Working || _phase.value == Phase.Opened) return
        try {
            openNow(a)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            // `.com` out of reach: the screen stays, Continue tries again.
        }
    }

    private suspend fun openNow(a: CreatedAccount) {
        val p = store.get()
        if (p != null && p.stage != PendingNameChoice.SETTLED) {
            // A rename whose answer never came: settle it first, so the app never opens a name `.com` moved away.
            val name = resume(store, ops)
            if (name != null) {
                _account.value = a.copy(username = name, accountDisplayName = p.accountDisplayName)
                _phase.value = Phase.Opened
                return
            }
            if (store.get() != null) return
        }
        ops.onboard(a.username, null, a)
        store.clear()
        ops.bindPq()
        _phase.value = Phase.Opened
    }

    companion object {
        /** "Bob" for bob, "Mary Ann" for mary-ann: the account's display name until the owner changes it. */
        fun displayName(name: String) = name.split("-").joinToString(" ") { it.replaceFirstChar(Char::uppercase) }

        /** The precheck's answer as the screen shows it. */
        fun checkFor(n: String, q: NameQuote?): NameCheck = when {
            q == null -> NameCheck.Unknown(n)
            q is NameQuote.Available -> NameCheck.Open(n)
            q is NameQuote.Refused && q.code == "dibs-held" -> NameCheck.Held(n, NameCheck.domain(q.domain, n), q.heldUntil, q.checked)
            q is NameQuote.Refused && q.code in setOf("taken", "offered", "reserved", "dibs-used", "invalid", "grant-expired", "grant-invalid", "grant-used") ->
                NameCheck.Refused(n, refusal(q.code, q.problem, q.heldUntil, n, n, NameChoicePayment.Card))
            else -> NameCheck.Unknown(n)
        }

        fun refusal(
            code: String, problem: String?, heldUntil: Long?, wanted: String, kept: String, payment: NameChoicePayment,
            domain: String? = null, checked: Boolean = true,
        ): NameChoiceNotice =
            when (code) {
                "invalid" -> VoiciName.Problem.of(problem)?.let { NameChoiceNotice.Problem(it) } ?: NameChoiceNotice.Taken
                "taken", "offered", "same-name", "reserved", "dibs-used" -> NameChoiceNotice.Taken
                "dibs-held" -> NameChoiceNotice.Held(wanted, NameCheck.domain(domain, wanted), heldUntil, checked)
                "code-invalid", "code-wrong-kind", "code-needs-dibs" -> NameChoiceNotice.CodeInvalid
                "code-used" -> NameChoiceNotice.CodeUsed
                "grant-expired" -> NameChoiceNotice.GrantExpired
                "grant-invalid", "grant-used" -> NameChoiceNotice.GrantInvalid
                else -> if (payment is NameChoicePayment.Card) NameChoiceNotice.FailedVouchers(kept) else NameChoiceNotice.FailedCode(kept)
            }

        /**
         * A choice a crash left behind (the app has reopened the account under its old name). Finished when `.com`
         * says the new name is this account's, dropped when it says it isn't; kept for the next unlock when `.com`
         * can't be asked. Returns the name the account has afterwards, or null when nothing changed.
         */
        suspend fun resume(store: PendingNameChoiceStore, ops: NameChoiceOps): String? {
            val p = store.get() ?: return null
            if (p.stage == PendingNameChoice.RENAMING) {
                when (ops.ownsName(p.newName)) {
                    true -> store.put(p.copy(stage = PendingNameChoice.RENAMED))
                    false -> { store.clear(); return null }
                    null -> return null
                }
            }
            if (store.get()?.stage != PendingNameChoice.SETTLED) {
                ops.settle(p)
                store.put(p.copy(stage = PendingNameChoice.SETTLED))
            }
            ops.onboard(
                p.newName, p.oldName,
                CreatedAccount(p.newName, p.deviceId, p.newGrantId, p.accountDisplayName, p.deviceDisplayName),
            )
            store.clear()
            ops.bindPq()
            return p.newName
        }
    }
}
