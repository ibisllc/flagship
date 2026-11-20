// The one-time voi.ci intro after a new account is created (owner, 2026-11-20): "Get your own voi.ci page", once per
// account on this device, only on the create path (never after joining an account, a recovery sign-in or a demo), and
// only once the create flow's "Secure your account" step is done, so "Turn on" can't skip the backup nudge, and only
// on a device that can publish the page (an admin device): "Turn on" runs the Public switch's steps.
// The optional promo line is `.com` config (GET /api/voici/promo), not app text: absent or failed = no promo.

package com.flagshipserver.app.core.voici

import android.content.Context
import com.flagshipserver.app.core.Endpoints
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.Locale
import java.util.concurrent.TimeUnit

object VoiciIntro {
    /** How this device came to hold the account. Only [Created] gets the intro. */
    enum class Path { Created, Joined, Recovered, Demo }

    data class Promo(val text: String, val until: String?)

    const val PATH = "/api/voici/promo"
    private const val MAX_PROMO = 500

    fun prefsKey(username: String) = "flagship.voici.intro.shown.$username"

    /** The intro shows for an account this device just created, after its backup step, on a device that can publish, never twice. */
    fun shouldShow(path: Path?, username: String?, secureStepOpen: Boolean, alreadyShown: Boolean, canPublish: Boolean): Boolean =
        path == Path.Created && !username.isNullOrBlank() && !secureStepOpen && !alreadyShown && canPublish

    /** `{promo: {text, until} | null}`; anything else (or an empty text) is no promo. */
    fun parsePromo(body: String?): Promo? {
        val root = body?.let(VoiciJs::parseJson) as? JsonObject ?: return null
        val p = root["promo"] as? JsonObject ?: return null
        val text = (p["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
        if (text.isEmpty()) return null
        val until = (p["until"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return Promo(text.take(MAX_PROMO), until)
    }

    /** The app's language as `.com` names it (i18n/locales.json codes): zh → zh-Hans, pt → pt-BR. */
    fun langCode(locale: Locale = Locale.getDefault()): String = when (locale.language) {
        "zh" -> "zh-Hans"
        "pt" -> "pt-BR"
        "" -> "en"
        else -> locale.language
    }

    private val client by lazy {
        OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
            .callTimeout(6, TimeUnit.SECONDS).build()
    }

    /** One anonymous read of the promo; null on any failure. */
    suspend fun fetchPromo(baseUrl: String = Endpoints.controlBaseUrl, locale: Locale = Locale.getDefault()): Promo? = withContext(Dispatchers.IO) {
        try {
            val lang = langCode(locale)
            val req = Request.Builder().url("$baseUrl$PATH?lang=$lang").header("Accept-Language", locale.toLanguageTag()).get().build()
            client.newCall(req).execute().use { res -> if (res.code != 200) null else parsePromo(res.body?.string()) }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
    }
}

/** Which accounts have seen the intro on this device. */
class VoiciIntroStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("flagship.voici.intro", Context.MODE_PRIVATE)
    fun shown(username: String): Boolean = prefs.getBoolean(VoiciIntro.prefsKey(username), false)
    fun markShown(username: String) = prefs.edit().putBoolean(VoiciIntro.prefsKey(username), true).apply()
}
