package com.flagshipserver.app.core

import android.content.Context
import androidx.annotation.StringRes

/**
 * Looks up a string resource from code that has no Composable or Context at hand (view models, text
 * helpers, notification builders, constants). Inside a Composable use `stringResource` instead.
 *
 * It reads the application context, which follows the per-app language chosen in the system settings
 * (Settings > Apps > Flagship > Language), so a lookup made at the time the text is needed is in the
 * language the person is using. Do not cache the result in a long-lived field; read it when needed.
 */
object FSStrings {
    @Volatile private var app: Context? = null

    fun init(context: Context) {
        app = context.applicationContext
    }

    fun get(@StringRes id: Int, vararg args: Any?): String {
        val ctx = app ?: return JvmTestStrings.get(id, args)
        return if (args.isEmpty()) ctx.getString(id) else ctx.getString(id, *args)
    }

    fun plural(id: Int, count: Int, vararg args: Any?): String {
        val ctx = app ?: return JvmTestStrings.plural(id, count, args)
        return ctx.resources.getQuantityString(id, count, *args)
    }
}

/**
 * Plain-JVM unit tests have no Android resources. When the build passes `fs.test.strings` (the path of
 * res/values/strings.xml, set in app/build.gradle.kts for the unit-test task only) this resolves English
 * text from that file, so a view model's message can be asserted without Robolectric. In a running app the
 * property is absent and a lookup before FSStrings.init is a bug that fails loudly.
 */
internal object JvmTestStrings {
    private val file: String? get() = System.getProperty("fs.test.strings")
    private val names: Map<Int, String> by lazy {
        Class.forName("com.flagshipserver.app.R\$string").fields
            .filter { it.type == Int::class.javaPrimitiveType }
            .associate { it.getInt(null) to it.name }
    }
    private val table: Map<String, String> by lazy {
        val doc = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(java.io.File(file!!))
        val out = HashMap<String, String>()
        val nodes = doc.getElementsByTagName("string")
        for (i in 0 until nodes.length) {
            val n = nodes.item(i)
            out[n.attributes.getNamedItem("name").nodeValue] = unescape(n.textContent)
        }
        out
    }

    private fun unescape(s: String): String =
        Regex("""\\(u[0-9a-fA-F]{4}|.)""").replace(s) { m ->
            val c = m.groupValues[1]
            when {
                c.startsWith("u") && c.length == 5 -> c.substring(1).toInt(16).toChar().toString()
                c == "n" -> "\n"
                c == "t" -> "\t"
                else -> c
            }
        }

    fun get(id: Int, args: Array<out Any?>): String {
        check(file != null) { "FSStrings.init was not called before the first lookup" }
        val template = table[names[id] ?: error("unknown string id $id")] ?: error("no string ${names[id]}")
        return if (args.isEmpty()) template else String.format(java.util.Locale.ROOT, template, *args)
    }

    private val pluralNames: Map<Int, String> by lazy {
        Class.forName("com.flagshipserver.app.R\$plurals").fields
            .filter { it.type == Int::class.javaPrimitiveType }
            .associate { it.getInt(null) to it.name }
    }
    private val pluralTable: Map<String, Map<String, String>> by lazy {
        val doc = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(java.io.File(file!!))
        val out = HashMap<String, Map<String, String>>()
        val nodes = doc.getElementsByTagName("plurals")
        for (i in 0 until nodes.length) {
            val n = nodes.item(i)
            val items = HashMap<String, String>()
            val kids = n.childNodes
            for (j in 0 until kids.length) {
                val k = kids.item(j)
                if (k.nodeName == "item") items[k.attributes.getNamedItem("quantity").nodeValue] = unescape(k.textContent)
            }
            out[n.attributes.getNamedItem("name").nodeValue] = items
        }
        out
    }

    /** English plural rule: "one" for exactly 1, otherwise "other". */
    fun plural(id: Int, count: Int, args: Array<out Any?>): String {
        check(file != null) { "FSStrings.init was not called before the first lookup" }
        val forms = pluralTable[pluralNames[id] ?: error("unknown plurals id $id")] ?: error("no plurals ${pluralNames[id]}")
        val template = (if (count == 1) forms["one"] else null) ?: forms.getValue("other")
        return String.format(java.util.Locale.ROOT, template, *args)
    }
}

/**
 * Compose lookup for a resource that takes arguments. Unlike `stringResource`, the arguments may be
 * null (a null prints as "null", exactly what a string template did before the text moved to a resource).
 */
@androidx.compose.runtime.Composable
fun fsString(@StringRes id: Int, vararg args: Any?): String {
    val context = androidx.compose.ui.platform.LocalContext.current
    androidx.compose.ui.platform.LocalConfiguration.current // re-read when the language changes
    return context.resources.getString(id, *args)
}
