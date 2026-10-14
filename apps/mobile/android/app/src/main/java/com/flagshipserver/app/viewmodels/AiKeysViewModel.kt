// Drives the device-local AI-key surfaces: the build-flow key step and the
// Settings → AI keys manager. Reads/writes AiKeyStore; exposes saved entries
// as masked slugs only (the raw key never enters UI state beyond the entry
// field). Mirrors the webapp build-key.js + settings.js renderProviders.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.core.AiCredential
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.AiRelay
import com.flagshipserver.app.core.FreeAiCreditsInfo
import com.flagshipserver.app.core.FreeAiCopy
import com.flagshipserver.app.core.FreeAiMint
import com.flagshipserver.app.core.FreeAiService
import com.flagshipserver.app.core.FreeAiState
import com.flagshipserver.app.core.SavedAiKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A saved key projected for the list — id + masked slug only. */
data class SavedKeyRow(
    val id: String,
    val provider: String,
    val label: String,
    val maskedSlug: String,
    val relay: Boolean = true,
)

/**
 * Process-scoped hand-off for a confirmed build credential. The AI-key step
 * stows the credential here; the next build screen (vibe-describe / generating)
 * picks it up and clears it. In memory only — never persisted, never logged.
 */
object PendingBuildCredential {
    @Volatile private var value: AiCredential? = null
    fun set(c: AiCredential?) {
        value = c
        // The key a relay failure is about, for "Turn the relay off for this key".
        if (c != null) AiRelay.lastUsedKeyId = c.keyId
    }
    fun take(): AiCredential? {
        val v = value
        value = null
        return v
    }
    fun peek(): AiCredential? = value
}

class AiKeysViewModel : ViewModel() {

    private val _keys = MutableStateFlow<List<SavedKeyRow>>(emptyList())
    val keys: StateFlow<List<SavedKeyRow>> = _keys.asStateFlow()

    /** The active (confirm-default) entry's id, if any saved keys exist. */
    private val _activeId = MutableStateFlow<String?>(null)
    val activeId: StateFlow<String?> = _activeId.asStateFlow()

    /** Flagship Inference: the first entry in Settings and in the key step. */
    private val _freeAi = MutableStateFlow<FreeAiState>(FreeAiState.Hidden)
    val freeAi: StateFlow<FreeAiState> = _freeAi.asStateFlow()

    init {
        refresh()
    }

    /** Read the account's free-credits balance (unavailable on any failure). */
    suspend fun loadFreeAi(service: FreeAiService): FreeAiState {
        val s = service.status()
        _freeAi.value = s
        return s
    }

    /**
     * "Use this" on the free-credits row: a fresh credential for the box the
     * build runs on. Updates the balance from the answer; a refusal flips
     * the row to its message (disabled, still listed, once the promotion has ended).
     */
    suspend fun useFreeAi(service: FreeAiService, serverFqdn: String): FreeAiMint {
        val r = service.mint(serverFqdn)
        when (r) {
            is FreeAiMint.Ok -> r.credits?.let { _freeAi.value = FreeAiState.Available(it) }
            is FreeAiMint.UsedUp -> _freeAi.value = FreeAiState.Available(
                (r.credits ?: (_freeAi.value as? FreeAiState.Available)?.credits ?: FreeAiCreditsInfo())
                    .copy(remainingTokens = 0),
            )
            is FreeAiMint.Refused -> _freeAi.value =
                if (r.code == FreeAiCopy.CODE_ENDED) FreeAiState.Ended
                else FreeAiState.Blocked(r.code.removePrefix("free-ai-"))
            is FreeAiMint.Unavailable -> _freeAi.value = FreeAiState.Unavailable
        }
        if (r is FreeAiMint.Ok) {
            AiRelay.lastUsedKeyId = null
            AiKeyStore.setActive(AiKeyStore.FLAGSHIP_INFERENCE_ID)
            refresh()
        }
        return r
    }

    /** Whether the key step should pick free credits on its own (no own keys). */
    fun shouldAutoUseFreeAi(): Boolean = FreeAiService.shouldAutoUse(_keys.value.size, _freeAi.value)

    fun refresh() {
        val all = AiKeyStore.list()
        _keys.value = all.map { it.toRow() }
        _activeId.value = AiKeyStore.activeId()
    }

    /** Pin a saved entry (or [AiKeyStore.FLAGSHIP_INFERENCE_ID]) as the active (confirm-default) key. */
    fun setActive(id: String) {
        AiKeyStore.setActive(id)
        refresh()
    }

    /** Recall a saved entry's full credential to hand to a build. */
    fun credentialFor(id: String): AiCredential? = AiKeyStore.credentialFor(id)

    /**
     * Validate + optionally persist a freshly-entered key. When `save` is true
     * the entry is stored on-device and its credential returned; otherwise an
     * in-memory credential is returned WITHOUT persisting. Returns null when
     * the inputs are invalid.
     */
    fun useEnteredKey(
        provider: String,
        apiKey: String,
        label: String,
        baseUrl: String?,
        save: Boolean,
        relay: Boolean = true,
    ): AiCredential? {
        val p = provider.trim()
        val k = apiKey.trim()
        if (p.isEmpty() || k.isEmpty()) return null
        val url = baseUrl?.trim()?.ifBlank { null }
        return if (save) {
            val saved = AiKeyStore.add(p, k, label, url, relay)
            refresh()
            AiCredential(saved.provider, saved.apiKey, saved.baseUrl, relay = saved.relay, keyId = saved.id)
        } else {
            AiCredential(p, k, url, relay = relay)
        }
    }

    fun add(provider: String, apiKey: String, label: String, baseUrl: String?, relay: Boolean = true): Boolean {
        if (provider.isBlank() || apiKey.isBlank()) return false
        AiKeyStore.add(provider.trim(), apiKey.trim(), label, baseUrl?.trim()?.ifBlank { null }, relay)
        refresh()
        return true
    }

    /** Save a key from the AI Key step's form and make it the last-used one.
     *  Choosing a key is a separate step, so adding never moves the build on. */
    fun addAndSelect(provider: String, apiKey: String, label: String, baseUrl: String?, relay: Boolean = true): Boolean {
        if (provider.isBlank() || apiKey.isBlank()) return false
        val added = AiKeyStore.add(provider.trim(), apiKey.trim(), label, baseUrl?.trim()?.ifBlank { null }, relay)
        AiKeyStore.setActive(added.id)
        refresh()
        return true
    }

    /** "Use this": the chosen key becomes the last-used one. */
    fun choose(id: String): AiCredential? {
        val cred = AiKeyStore.credentialFor(id) ?: return null
        AiKeyStore.setActive(id)
        refresh()
        return cred
    }

    /** Flagship Inference is built in: it can't be removed. */
    fun delete(id: String) {
        if (id == AiKeyStore.FLAGSHIP_INFERENCE_ID) return
        AiKeyStore.delete(id)
        refresh()
    }

    /** Send this saved key's calls through the Flagship relay, or directly. */
    fun setRelay(id: String, on: Boolean) {
        AiKeyStore.setRelay(id, on)
        refresh()
    }

    companion object {
        /** The saved keys, the last-used one first. */
        fun ordered(rows: List<SavedKeyRow>, activeId: String?): List<SavedKeyRow> {
            val active = rows.firstOrNull { it.id == activeId } ?: return rows
            return listOf(active) + rows.filter { it.id != active.id }
        }
    }

    private fun SavedAiKey.toRow() =
        SavedKeyRow(id = id, provider = provider, label = label, maskedSlug = AiKeyStore.maskedSlug(this), relay = relay)
}
