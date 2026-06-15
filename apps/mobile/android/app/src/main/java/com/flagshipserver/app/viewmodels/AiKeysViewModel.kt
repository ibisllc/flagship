// Drives the device-local AI-key surfaces: the build-flow key step and the
// Settings → AI keys manager. Reads/writes AiKeyStore; exposes saved entries
// as masked slugs only (the raw key never enters UI state beyond the entry
// field). Mirrors the webapp build-key.js + settings.js renderProviders.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.core.AiCredential
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.SavedAiKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A saved key projected for the list — id + masked slug only. */
data class SavedKeyRow(val id: String, val provider: String, val label: String, val maskedSlug: String)

/**
 * Process-scoped hand-off for a confirmed build credential. The AI-key step
 * stows the credential here; the next build screen (vibe-describe / generating)
 * picks it up and clears it. In memory only — never persisted, never logged.
 */
object PendingBuildCredential {
    @Volatile private var value: AiCredential? = null
    fun set(c: AiCredential?) { value = c }
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

    init {
        refresh()
    }

    fun refresh() {
        val all = AiKeyStore.list()
        _keys.value = all.map { it.toRow() }
        _activeId.value = AiKeyStore.active()?.id
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
    ): AiCredential? {
        val p = provider.trim()
        val k = apiKey.trim()
        if (p.isEmpty() || k.isEmpty()) return null
        val url = baseUrl?.trim()?.ifBlank { null }
        return if (save) {
            val saved = AiKeyStore.add(p, k, label, url)
            refresh()
            AiCredential(saved.provider, saved.apiKey, saved.baseUrl)
        } else {
            AiCredential(p, k, url)
        }
    }

    fun add(provider: String, apiKey: String, label: String, baseUrl: String?): Boolean {
        if (provider.isBlank() || apiKey.isBlank()) return false
        AiKeyStore.add(provider.trim(), apiKey.trim(), label, baseUrl?.trim()?.ifBlank { null })
        refresh()
        return true
    }

    fun delete(id: String) {
        AiKeyStore.delete(id)
        refresh()
    }

    private fun SavedAiKey.toRow() =
        SavedKeyRow(id = id, provider = provider, label = label, maskedSlug = AiKeyStore.maskedSlug(this))
}
