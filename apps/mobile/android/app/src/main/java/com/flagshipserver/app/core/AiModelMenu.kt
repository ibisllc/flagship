// The build chat's model menu: which model a session uses and at what effort.
// Two sources feed it (packages/protocol/src/aiModels.ts): Flagship
// Inference's catalog from `.com`, and the owner's own key's live list, which
// the box reads with the key. Mirror of the webapp and iOS model menus.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AiModelsResponse
import com.flagshipserver.app.api.BuildCredential
import com.flagshipserver.app.api.InferenceCatalogResponse
import com.flagshipserver.app.api.InferenceModel
import com.flagshipserver.app.api.ModelOption
import com.flagshipserver.app.api.ScreensClient
import kotlinx.serialization.Serializable
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** What a session runs on: a catalog id or the provider's model id, and an effort. */
@Serializable
data class ModelChoice(val model: String, val effort: String? = null)

sealed class ModelMenu {
    /** Flagship Inference; [catalog] null when `.com` couldn't be read. */
    data class Flagship(val catalog: InferenceCatalogResponse?) : ModelMenu()

    /** The owner's own key. [listed] false: a free-text model field. */
    data class Own(
        val provider: String,
        val listed: Boolean,
        val options: List<ModelOption>,
        val defaultModel: String?,
        val reason: String?,
    ) : ModelMenu()

    /** Nothing known about the session's AI: the menu only names the model. */
    object Unknown : ModelMenu()
}

/** What sending images to the current model needs first. */
sealed class VisionCheck {
    object Send : VisionCheck()
    data class Switch(val to: ModelChoice, val message: String) : VisionCheck()
    data class Blocked(val message: String) : VisionCheck()
}

object ModelMenus {
    const val FLAGSHIP_TITLE = "Flagship Inference"
    const val DEFAULT_TITLE = "Default model"
    const val THINK_HARDER = "Think harder"
    const val UNKNOWN_CAPS = "capabilities unknown"
    const val KEY_REFUSED = "The key was refused"
    const val MODEL_FIELD = "Model"
    const val EFFORT = "Effort"
    const val THINK_HARDER_EFFORT = "high"

    fun from(r: AiModelsResponse): ModelMenu =
        if (r.kind == "flagship") ModelMenu.Flagship(r.catalog)
        else ModelMenu.Own(r.provider, r.listed, r.models, r.defaultModel, r.reason)

    /** An effort in the provider's own words, capitalised ("xhigh" → "Extra high"). */
    fun effortLabel(effort: String): String = when (effort.lowercase()) {
        "xhigh" -> "Extra high"
        else -> effort.lowercase().replaceFirstChar { it.uppercase() }
    }

    /** 2.0 → "2×", 3.5 → "3.5×". */
    fun multiplier(m: Double): String = "${trimNumber(m)}×"

    /** "Low 1× (Qwen3.6-35B-A3B)" → "Low 1×". */
    fun shortLabel(m: InferenceModel): String =
        m.label.substringBefore(" (").trim().ifEmpty { "${m.tier} ${multiplier(m.multiplier)}".trim() }

    fun flagshipModel(menu: ModelMenu, id: String?): InferenceModel? {
        val c = (menu as? ModelMenu.Flagship)?.catalog ?: return null
        return c.models.firstOrNull { it.id == id }
    }

    fun option(menu: ModelMenu, id: String?): ModelOption? =
        (menu as? ModelMenu.Own)?.options?.firstOrNull { it.id == id }

    /**
     * The choice a chat or Settings opens on: what the session uses now
     * ([current]) when the menu knows it, else the saved default, else the
     * menu's own default. Null: send no model (the box picks).
     */
    fun initial(menu: ModelMenu, saved: ModelChoice?, current: ModelChoice? = null): ModelChoice? = when (menu) {
        is ModelMenu.Flagship -> {
            val c = menu.catalog
            if (c == null) null
            else listOfNotNull(current, saved).firstOrNull { ch -> c.models.any { it.id == ch.model } }
                ?: (c.models.firstOrNull { it.id == c.defaultModel } ?: c.models.firstOrNull { it.default == true })
                    ?.let { ModelChoice(it.id) }
        }
        is ModelMenu.Own -> {
            val pick = listOfNotNull(current, saved).firstOrNull { it.model.isNotBlank() }
            when {
                pick != null -> pick
                menu.listed -> (menu.options.firstOrNull { it.id == menu.defaultModel } ?: menu.options.firstOrNull())
                    ?.let { ModelChoice(it.id, it.defaultEffort?.takeIf { _ -> !it.efforts.isNullOrEmpty() }) }
                else -> menu.defaultModel?.takeIf { it.isNotBlank() }?.let { ModelChoice(it) }
            }
        }
        ModelMenu.Unknown -> current
    }

    /** Pick [id]: an own-key model starts on its default effort; a Flagship
     *  model keeps "Think harder" when it can. */
    fun select(menu: ModelMenu, id: String, previous: ModelChoice?): ModelChoice = when (menu) {
        is ModelMenu.Flagship -> {
            val keep = previous?.effort == THINK_HARDER_EFFORT && flagshipModel(menu, id)?.reasoning == true
            ModelChoice(id, if (keep) THINK_HARDER_EFFORT else null)
        }
        is ModelMenu.Own -> {
            val o = option(menu, id)
            ModelChoice(id, o?.defaultEffort?.takeIf { !o.efforts.isNullOrEmpty() })
        }
        ModelMenu.Unknown -> ModelChoice(id)
    }

    /** The chip's text: the model's short name. */
    fun title(menu: ModelMenu, choice: ModelChoice?): String = when (menu) {
        is ModelMenu.Flagship -> flagshipModel(menu, choice?.model)?.let(::shortLabel) ?: FLAGSHIP_TITLE
        is ModelMenu.Own -> option(menu, choice?.model)?.label ?: choice?.model?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE
        ModelMenu.Unknown -> choice?.model?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE
    }

    /** The own-key model's efforts; empty: no effort control. */
    fun efforts(menu: ModelMenu, choice: ModelChoice?): List<String> =
        option(menu, choice?.model)?.efforts.orEmpty()

    fun thinkHarderOffered(menu: ModelMenu, choice: ModelChoice?): Boolean =
        flagshipModel(menu, choice?.model)?.reasoning == true

    fun thinkHarder(choice: ModelChoice?): Boolean = choice?.effort == THINK_HARDER_EFFORT

    fun withThinkHarder(choice: ModelChoice, on: Boolean): ModelChoice =
        choice.copy(effort = if (on) THINK_HARDER_EFFORT else null)

    /** `model`/`effort` for start: nothing is sent when there's no choice. */
    fun startWire(choice: ModelChoice?): Pair<String?, String?> =
        choice?.model?.takeIf { it.isNotBlank() } to choice?.effort?.takeIf { it.isNotBlank() }

    /** `model`/`effort` for a reply: effort "" is the provider's default. */
    fun replyWire(choice: ModelChoice?): Pair<String?, String?> {
        val model = choice?.model?.takeIf { it.isNotBlank() } ?: return null to null
        return model to (choice.effort ?: "")
    }

    /** Whether the current model can take the images about to be sent. */
    fun visionCheck(menu: ModelMenu, choice: ModelChoice?, hasImage: Boolean): VisionCheck {
        if (!hasImage) return VisionCheck.Send
        when (menu) {
            is ModelMenu.Flagship -> {
                val m = flagshipModel(menu, choice?.model) ?: return VisionCheck.Send
                if ("image" in m.modalities) return VisionCheck.Send
                val alt = flagshipModel(menu, m.visionAlternative)
                return if (alt != null) {
                    VisionCheck.Switch(
                        select(menu, alt.id, choice),
                        "I'll have to switch to ${alt.model} (${multiplier(alt.multiplier)}) for this.",
                    )
                } else {
                    VisionCheck.Blocked(cantSee(m.model.ifBlank { shortLabel(m) }))
                }
            }
            is ModelMenu.Own -> {
                val o = option(menu, choice?.model) ?: return VisionCheck.Send
                if (o.vision != false) return VisionCheck.Send
                val alt = option(menu, o.visionAlternative)
                return if (alt != null) {
                    VisionCheck.Switch(select(menu, alt.id, choice), "I'll have to switch to ${alt.label} for this.")
                } else {
                    VisionCheck.Blocked(cantSee(o.label))
                }
            }
            ModelMenu.Unknown -> return VisionCheck.Send
        }
    }

    private fun cantSee(name: String) = "$name can't see images. Remove them or pick another model."

    /** "used 2.8 credits", "used 1 credit": one decimal at most. */
    fun creditsLine(credits: Double): String {
        val shown = trimNumber(credits)
        return if (shown == "1") "used 1 credit" else "used $shown credits"
    }

    private fun trimNumber(n: Double): String {
        val r = Math.round(n * 10.0) / 10.0
        return if (r == Math.floor(r)) r.toLong().toString() else r.toString()
    }
}

/**
 * The menus, cached for the app session: Flagship Inference's catalog for 5
 * minutes, and each own key's answer for as long as the app runs (keyed by a
 * hash, so the map never holds a raw key).
 */
object ModelCatalogs {
    private const val CATALOG_TTL_MS = 5 * 60_000L

    @Volatile private var catalog: InferenceCatalogResponse? = null
    @Volatile private var catalogAt = 0L
    private val own = ConcurrentHashMap<String, AiModelsResponse>()

    /** Test seam: the catalog fetch. */
    @Volatile var fetchCatalog: suspend () -> InferenceCatalogResponse = {
        OkHttpJsonTransport().getJson(
            "${Endpoints.controlBaseUrl}/api/inference/models",
            InferenceCatalogResponse.serializer(),
        )
    }

    /** `.com`'s catalog, or null when it can't be read. */
    suspend fun inference(now: Long = System.currentTimeMillis()): InferenceCatalogResponse? {
        catalog?.let { if (now - catalogAt < CATALOG_TTL_MS) return it }
        return try {
            fetchCatalog().also {
                catalog = it
                catalogAt = now
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            catalog
        }
    }

    /** The menu for a credential: Flagship Inference's catalog, or the
     *  box's answer for an own key (a free-text field when it can't say). */
    suspend fun menuFor(credential: AiCredential?, screens: ScreensClient): ModelMenu {
        if (credential == null || credential.isFreeAi) return ModelMenu.Flagship(inference())
        val key = keyOf(credential)
        own[key]?.let { return ModelMenus.from(it) }
        return try {
            val r = screens.aiModels(BuildCredential.from(credential))
            own[key] = r
            ModelMenus.from(r)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            ModelMenu.Own(credential.provider, listed = false, options = emptyList(), defaultModel = null, reason = "failed")
        }
    }

    fun clear() {
        catalog = null
        catalogAt = 0
        own.clear()
    }

    private fun keyOf(c: AiCredential): String {
        val d = MessageDigest.getInstance("SHA-256")
            .digest("${c.provider}|${c.baseUrl.orEmpty()}|${c.apiKey}".toByteArray(Charsets.UTF_8))
        return d.joinToString("") { "%02x".format(it) }
    }
}

/**
 * The credential each build session started with, so its chat can show the
 * right model menu. In memory only, like the credential hand-off itself.
 */
object BuildSessionAi {
    private val byId = ConcurrentHashMap<String, AiCredential>()

    fun remember(sessionId: String, credential: AiCredential?) {
        if (credential != null && sessionId.isNotEmpty()) byId[sessionId] = credential
    }

    fun credentialFor(sessionId: String): AiCredential? = byId[sessionId]

    fun clear() = byId.clear()
}
