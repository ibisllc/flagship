// The server page's "Direct access" (docs/direct-access-and-domains.md §5, §8):
// an admin device opts the server in (its home address becomes public in DNS),
// then gives each app one name on the direct domain. Every change is a signed
// sensitive order: the direct-access order goes to the box and to `.com`, a
// name order to `.com`, which publishes exactly what was signed. Other devices
// see the state read-only. Mirrors iOS `DirectAccessViewModel.swift` and the
// webapp's `views/direct-access.js`.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.DirectAccessRefusal
import com.flagshipserver.app.api.DirectAccessText
import com.flagshipserver.app.api.DirectAccountState
import com.flagshipserver.app.api.DirectNameState
import com.flagshipserver.app.api.DirectNamesClient
import com.flagshipserver.app.api.DirectProbe
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.api.displayName
import com.flagshipserver.app.core.DirectAccess
import com.flagshipserver.app.core.DirectName
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.DateFormat
import java.util.Date

class DirectAccessViewModel(
    serverDomain: String,
    username: String,
    private val box: ScreensClient,
    private val com: DirectNamesClient,
    /** Only an admin device signs (AdminOrderGate); others see the state. */
    val canManage: Boolean,
    /** A fresh biometric for every direct-access order, then the admin root (the IRK on an account that pins none). */
    private val accessSigner: suspend (reason: String) -> Ed25519Sign = { r ->
        BiometricAuthority.confirmNow(r)
        runCatching { Keystore.adminRootSeed() }.getOrNull()?.let { Ed25519Sign(it) } ?: Keystore.adminSigningKey(r)
    },
    /** A name order may ride the unlocked session. */
    private val nameSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    val serverDomain: String = serverDomain.lowercase()
    val username: String = username.lowercase()

    /** One app on this server and its direct name. */
    data class Row(
        val serviceId: String,
        val appName: String,
        /** `<slug>--<creator>.<apex>`; null when the app's creator isn't this account. */
        val fqdn: String?,
        val state: DirectNameState?,
    ) {
        val label: String? get() = fqdn?.let { DirectName.labelOf(it) }
        val isOn: Boolean get() = state?.enabled == true
    }

    /** The name settings being edited. */
    data class NameDraft(val serviceId: String, val fqdn: String, val pinCaa: Boolean, val addressesText: String)

    data class State(
        val supported: Boolean = true,
        val loaded: Boolean = false,
        val view: DirectAccess.View? = null,
        val account: DirectAccountState? = null,
        val apps: List<AppSummary> = emptyList(),
        val busy: Boolean = false,
        val error: String? = null,
        val notice: String? = null,
        val editing: Boolean = false,
        val addressesText: String = "",
        val prefixesText: String = "",
        val portText: String = "443",
        val nameDraft: NameDraft? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private fun update(f: (State) -> State) { _state.value = f(_state.value) }

    val apex: String get() = _state.value.account?.apex ?: DirectName.APEX

    private val server get() = _state.value.account?.server(serverDomain)

    /** The box's own word first; `.com`'s record when the box can't say. */
    val isOn: Boolean get() = _state.value.view?.on ?: server?.on ?: false
    val addresses: List<String> get() = _state.value.view?.addresses ?: server?.addresses ?: emptyList()
    val prefixes: List<String> get() = _state.value.view?.prefixes ?: server?.prefixes ?: emptyList()
    val port: Int get() = _state.value.view?.port ?: server?.port ?: 443

    /** Where the box says it can be reached now. */
    val reported: List<String>
        get() {
            val v = _state.value.view
            if (v != null && v.endpoints.isNotEmpty()) return v.endpoints.map { it.address }
            return server?.boxAddresses ?: emptyList()
        }

    val rows: List<Row>
        get() = _state.value.apps.filter { it.copying == null }.map { a ->
            val fqdn = if (a.creator.lowercase() == username) DirectName.derivedName(a.slug, a.creator, apex) else null
            Row(a.serviceId, a.displayName, fqdn, fqdn?.let { _state.value.account?.name(it) })
        }

    suspend fun load() {
        var supported = true
        val view = try {
            box.directAccess()
        } catch (_: ScreensError.NotImplemented) {
            supported = false
            null
        } catch (e: ScreensError.Http) {
            if (e.status == 404) supported = false
            null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        if (!supported) {
            update { it.copy(supported = false) }
            return
        }
        val account = runCatching { com.state(username) }.getOrNull()
        val apps = runCatching { box.appsList().apps }.getOrNull() ?: _state.value.apps
        update { it.copy(view = view, account = account, apps = apps, loaded = true) }
    }

    /** Open the opt-in (or change) form with what is in force. */
    fun startEditing() = update {
        it.copy(
            addressesText = addresses.joinToString("\n"),
            prefixesText = prefixes.joinToString("\n"),
            portText = port.toString(),
            error = null,
            notice = null,
            editing = true,
        )
    }

    fun cancelEditing() = update { it.copy(editing = false) }
    fun setAddressesText(t: String) = update { it.copy(addressesText = t) }
    fun setPrefixesText(t: String) = update { it.copy(prefixesText = t) }
    fun setPortText(t: String) = update { it.copy(portText = t) }

    /** Turn on, or change the addresses: sign once, send to the box, then to `.com`. */
    suspend fun saveAccess(): Boolean {
        val s = _state.value
        if (!canManage || s.busy) return false
        update { it.copy(error = null, notice = null) }
        val addrs = parseAddresses(s.addressesText) ?: return fail(DirectAccessText.refusal("bad-address"))
        val prefs = parsePrefixes(s.prefixesText) ?: return fail(DirectAccessText.refusal("bad-prefix"))
        val p = s.portText.trim().toIntOrNull() ?: return fail(DirectAccessText.refusal("bad-port"))
        val order = DirectAccess.Order(serverDomain, true, addrs, prefs, p, now())
        DirectAccess.problem(order)?.let { return fail(DirectAccessText.refusal(it)) }
        val wasOn = isOn
        val ok = send(order, FSStrings.get(if (wasOn) R.string.da_reason_change else R.string.da_reason_turn_on))
        if (ok) update { it.copy(editing = false, notice = FSStrings.get(if (wasOn) R.string.saved else R.string.da_is_on)) }
        return ok
    }

    suspend fun turnOff(): Boolean {
        if (!canManage || _state.value.busy) return false
        update { it.copy(error = null, notice = null) }
        val order = DirectAccess.Order(serverDomain, false, emptyList(), emptyList(), port, now())
        val ok = send(order, FSStrings.get(R.string.da_reason_turn_off))
        if (ok) update { it.copy(editing = false, notice = FSStrings.get(R.string.da_is_off)) }
        return ok
    }

    private suspend fun send(order: DirectAccess.Order, reason: String): Boolean {
        update { it.copy(busy = true) }
        return try {
            val key = accessSigner(reason)
            val signed = DirectAccess.SignedOrder(order, DirectAccess.sign(order, key))
            val view = box.setDirectAccess(signed).directAccess
            update { it.copy(view = view) }
            com.postAccessOrder(username, signed)
            val account = runCatching { com.state(username) }.getOrNull() ?: _state.value.account
            update { it.copy(account = account, busy = false) }
            true
        } catch (e: kotlinx.coroutines.CancellationException) {
            update { it.copy(busy = false) }
            throw e
        } catch (t: Throwable) {
            fail(message(t))
        }
    }

    // ---- names

    fun editName(row: Row) {
        val fqdn = row.fqdn ?: return
        update {
            it.copy(
                nameDraft = NameDraft(row.serviceId, fqdn, (row.state?.caa ?: DirectName.CAA_PIN) != DirectName.CAA_OFF, row.state?.addresses.orEmpty().joinToString("\n")),
                error = null,
                notice = null,
            )
        }
    }

    fun updateNameDraft(d: NameDraft?) = update { it.copy(nameDraft = d) }

    /** Turn a name on with the defaults (follow this server, CAA pinned). */
    suspend fun turnOnName(row: Row): Boolean {
        val fqdn = row.fqdn ?: return false
        return sendName(DirectName.Order(fqdn, serverDomain, true, emptyList(), DirectName.CAA_PIN, now()))
    }

    suspend fun turnOffName(row: Row): Boolean {
        val fqdn = row.fqdn ?: return false
        val caa = row.state?.caa?.takeIf { it == DirectName.CAA_OFF } ?: DirectName.CAA_PIN
        return sendName(DirectName.Order(fqdn, serverDomain, false, emptyList(), caa, now()))
    }

    suspend fun saveNameDraft(): Boolean {
        val d = _state.value.nameDraft ?: return false
        val addrs = parseAddresses(d.addressesText) ?: return fail(DirectAccessText.refusal("bad-address"))
        val ok = sendName(DirectName.Order(d.fqdn, serverDomain, true, addrs, if (d.pinCaa) DirectName.CAA_PIN else DirectName.CAA_OFF, now()))
        if (ok) update { it.copy(nameDraft = null) }
        return ok
    }

    private suspend fun sendName(order: DirectName.Order): Boolean {
        if (!canManage || _state.value.busy) return false
        update { it.copy(error = null, notice = null) }
        DirectName.problem(order, apex)?.let { return fail(DirectAccessText.refusal(it)) }
        update { it.copy(busy = true) }
        return try {
            val key = nameSigner(FSStrings.get(R.string.da_reason_change_name))
            val signed = DirectName.SignedOrder(order, DirectName.sign(order, key))
            com.postNameOrder(username, signed)
            val account = runCatching { com.state(username) }.getOrNull() ?: _state.value.account
            update { it.copy(account = account, busy = false, notice = FSStrings.get(R.string.saved)) }
            true
        } catch (e: kotlinx.coroutines.CancellationException) {
            update { it.copy(busy = false) }
            throw e
        } catch (t: Throwable) {
            fail(message(t))
        }
    }

    /** The outside check. Any device of the account may run it; it changes nothing. */
    suspend fun probe(row: Row): Boolean {
        val label = row.label ?: return false
        if (_state.value.busy) return false
        update { it.copy(error = null, notice = null, busy = true) }
        return try {
            val p = com.probe(username, label)
            val account = runCatching { com.state(username) }.getOrNull() ?: _state.value.account
            update { it.copy(account = account, busy = false, notice = DirectAccessText.probe(p)) }
            true
        } catch (e: kotlinx.coroutines.CancellationException) {
            update { it.copy(busy = false) }
            throw e
        } catch (t: Throwable) {
            fail(message(t))
        }
    }

    private fun fail(message: String): Boolean {
        update { it.copy(busy = false, error = message, notice = null) }
        return false
    }

    companion object {
        private fun words(text: String): List<String> =
            text.split(Regex("[\\s,]+")).filter { it.isNotEmpty() }.map { it.lowercase() }

        /** Words of a list field, in canonical text; null when one isn't an address. */
        fun parseAddresses(text: String): List<String>? {
            val out = LinkedHashSet<String>()
            for (w in words(text)) out += DirectAccess.canonicalIp(w) ?: return null
            return out.sorted()
        }

        fun parsePrefixes(text: String): List<String>? {
            val out = LinkedHashSet<String>()
            for (w in words(text)) out += DirectAccess.formatPrefix(DirectAccess.parsePrefix(w) ?: return null)
            return out.sorted()
        }

        /** A refusal's own sentence by its code, from `.com` or the box. */
        fun message(t: Throwable): String = when {
            t is BiometricCancelled -> FSStrings.get(R.string.da_not_changed)
            t is IllegalStateException && t.message == "Open Flagship to confirm this." -> t.message!!
            t is DirectAccessRefusal -> t.sentence
            t is IllegalArgumentException && t.message?.contains("refused: ") == true ->
                DirectAccessText.refusal(t.message!!.substringAfterLast("refused: "))
            t is ScreensError.Http -> DirectAccessRefusal.fromBody(t.status, t.body).sentence
            else -> t.userFacing()
        }

        private fun time(ms: Long): String =
            DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

        /** "Checked <time>: Reachable from outside." */
        fun probeLine(p: DirectProbe): String {
            val at = p.at ?: return DirectAccessText.probe(p)
            return FSStrings.get(R.string.da_checked_at, time(at), DirectAccessText.probe(p))
        }

        val WARNING: String get() = FSStrings.get(R.string.da_warning)
        val ADMIN_ONLY: String get() = FSStrings.get(R.string.da_admin_only)
        val OTHER_CREATOR: String get() = FSStrings.get(R.string.da_other_creator)
    }
}
