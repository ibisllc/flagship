// The build chat's model menu, grouped by provider: Flagship Inference first
// (when the owner can use it, or the chat already does), then every AI key
// saved on this device, each with its own models. Picking a model from
// another group switches the chat's provider: that group's key rides the next
// message and the box replaces the chat's key with it. Mirror of the webapp
// lib/modelGroups.js and iOS ModelMenu.swift.

package com.flagshipserver.app.core

/** One group of the menu. Holds a key's name, never the key. */
data class ModelGroup(
    val id: String,
    val title: String,
    val provider: String,
    /** The saved key's own name; null for Flagship Inference. */
    val keyLabel: String? = null,
) {
    val isFlagship: Boolean get() = id == ModelGroups.FLAGSHIP
}

/** Which credential a chat message carries. */
enum class MessageCredential {
    /** None: the box keeps the key it holds. */
    NONE,
    /** A fresh Flagship Inference pass. */
    FLAGSHIP_PASS,
    /** The chosen group's own key. */
    OWN_KEY,
}

object ModelGroups {
    const val FLAGSHIP = "flagship"
    /** A key this chat started with that isn't saved on this phone. */
    const val SESSION_KEY = "session-key"
    const val UNSAVED_KEY = "Unsaved key"
    const val CONTEXT_NOTICE = "Older messages will be summarised to fit this model."

    /** How a saved key is named in the menu, as the AI-keys list names it. */
    fun keyTitle(provider: String, label: String): String = "$provider · $label"

    /**
     * The groups, in menu order. [sessionKeyProvider]: the provider of an
     * unsaved key this chat started with, listed after the saved ones.
     */
    fun build(
        keys: List<SavedAiKey>,
        flagshipUsable: Boolean,
        currentProvider: String?,
        sessionKeyProvider: String? = null,
    ): List<ModelGroup> {
        val out = mutableListOf<ModelGroup>()
        if (flagshipUsable || currentProvider == FreeAiRequest.PROVIDER) {
            out += ModelGroup(FLAGSHIP, FreeAiCopy.PROVIDER_TITLE, FreeAiRequest.PROVIDER)
        }
        keys.filter { it.provider != FreeAiRequest.PROVIDER }.forEach {
            out += ModelGroup(it.id, keyTitle(it.provider, it.label), it.provider, it.label)
        }
        if (sessionKeyProvider != null) {
            out += ModelGroup(SESSION_KEY, keyTitle(sessionKeyProvider, UNSAVED_KEY), sessionKeyProvider, UNSAVED_KEY)
        }
        return out
    }

    fun byId(groups: List<ModelGroup>, id: String?): ModelGroup? = groups.firstOrNull { it.id == id }

    /** The group a credential belongs to: Flagship Inference, the saved key
     *  it came from, or this chat's unsaved key. */
    fun forCredential(groups: List<ModelGroup>, credential: AiCredential?): ModelGroup? = when {
        credential == null -> null
        credential.isFreeAi || credential.provider == FreeAiRequest.PROVIDER -> byId(groups, FLAGSHIP)
        credential.keyId != null -> byId(groups, credential.keyId)
        else -> byId(groups, SESSION_KEY)
    }

    /** For a reopened chat: the group of the provider the box says it uses
     *  (Flagship Inference, else the first saved key of that provider). */
    fun forProvider(groups: List<ModelGroup>, provider: String?): ModelGroup? = when (provider) {
        null, "" -> null
        FreeAiRequest.PROVIDER -> byId(groups, FLAGSHIP)
        else -> groups.firstOrNull { !it.isFlagship && it.provider == provider }
    }

    /**
     * The provider a chat uses: what the box says, else what this app knows
     * (the key it started with, a Flagship Inference build, or a catalog
     * model id from an older box). Null: unknown.
     */
    fun chatProvider(
        stateProvider: String?,
        sessionCredential: AiCredential?,
        onFlagship: Boolean,
        modelInCatalog: Boolean,
    ): String? = stateProvider?.takeIf { it.isNotBlank() } ?: when {
        sessionCredential?.isFreeAi == true || onFlagship -> FreeAiRequest.PROVIDER
        sessionCredential != null -> sessionCredential.provider
        modelInCatalog -> FreeAiRequest.PROVIDER
        else -> null
    }

    /** The group a chat opens on: the key it started with when the box still
     *  uses that provider, else the provider's group. */
    fun initial(groups: List<ModelGroup>, provider: String?, sessionCredential: AiCredential?): ModelGroup? =
        forCredential(groups, sessionCredential)?.takeIf { it.provider == provider }
            ?: forProvider(groups, provider)

    /** The effort levels the chosen model offers; empty: no effort control. */
    fun effortOptions(menu: ModelMenu?, choice: ModelChoice?): List<String> =
        menu?.let { ModelMenus.efforts(it, choice) }.orEmpty()

    /**
     * Whether a model may drop older context: the conversation is past the
     * box's compaction threshold for its context (75% of what is left after
     * the reply's room, as the box's contextCompaction.ts).
     */
    fun mayDropContext(conversationTokens: Long?, contextTokens: Long?): Boolean {
        val t = conversationTokens ?: return false
        val ctx = contextTokens ?: return false
        if (t <= 0 || ctx <= 0) return false
        val budget = ctx - minOf(16_000L, ctx / 4)
        return t > budget * 0.75
    }

    /** The one-line notice under the menu, or null. */
    fun contextNotice(menu: ModelMenu?, choice: ModelChoice?, sessionModel: String?, conversationTokens: Long?): String? {
        val model = choice?.model?.takeIf { it.isNotBlank() } ?: return null
        if (model == sessionModel || menu == null) return null
        return if (mayDropContext(conversationTokens, ModelMenus.contextTokens(menu, model))) CONTEXT_NOTICE else null
    }

    /** The trigger's text: the model's short name, then the key's name for an own key. */
    fun triggerText(group: ModelGroup?, menu: ModelMenu?, choice: ModelChoice?): String {
        val shown = menu ?: if (group?.isFlagship == true) ModelMenu.Flagship(null) else ModelMenu.Unknown
        val model = ModelMenus.title(shown, choice)
        val label = group?.keyLabel ?: return model
        return "$model · $label"
    }

    /**
     * What the next message carries. Flagship Inference: always a fresh pass.
     * An own key: when the owner picked it here (it differs from the key the
     * box holds) or the box says it holds none. Otherwise nothing.
     */
    fun messageCredential(group: ModelGroup?, picked: Boolean, needsCredential: Boolean): MessageCredential = when {
        group == null -> MessageCredential.NONE
        group.isFlagship -> MessageCredential.FLAGSHIP_PASS
        picked || needsCredential -> MessageCredential.OWN_KEY
        else -> MessageCredential.NONE
    }
}
