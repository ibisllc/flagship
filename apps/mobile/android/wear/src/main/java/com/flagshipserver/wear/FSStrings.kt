package com.flagshipserver.wear

import android.content.Context
import androidx.annotation.StringRes

/**
 * String lookup for watch code that has no Composable or Context at hand (the same helper as the phone
 * app's core/FSStrings). Initialised by [WearApplication]. Read the text when it is needed; do not cache it.
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
}

/** Plain-JVM unit tests: English from res/values/strings.xml when the build passes `fs.test.strings`. */
internal object JvmTestStrings {
    private val file: String? get() = System.getProperty("fs.test.strings")
    private val names: Map<Int, String> by lazy {
        Class.forName("com.flagshipserver.wear.R\$string").fields
            .filter { it.type == Int::class.javaPrimitiveType }
            .associate { it.getInt(null) to it.name }
    }
    private val table: Map<String, String> by lazy {
        val doc = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(java.io.File(file!!))
        val nodes = doc.getElementsByTagName("string")
        (0 until nodes.length).associate {
            val n = nodes.item(it)
            n.attributes.getNamedItem("name").nodeValue to
                Regex("""\\(u[0-9a-fA-F]{4}|.)""").replace(n.textContent) { m ->
                    val c = m.groupValues[1]
                    if (c.startsWith("u") && c.length == 5) c.substring(1).toInt(16).toChar().toString() else if (c == "n") "\n" else c
                }
        }
    }

    fun get(id: Int, args: Array<out Any?>): String {
        check(file != null) { "FSStrings.init was not called before the first lookup" }
        val template = table[names[id] ?: error("unknown string id $id")] ?: error("no string ${names[id]}")
        return if (args.isEmpty()) template else String.format(java.util.Locale.ROOT, template, *args)
    }
}

/** Compose lookup for a resource that takes arguments (null prints as "null", as a string template did). */
@androidx.compose.runtime.Composable
fun fsString(@StringRes id: Int, vararg args: Any?): String {
    val context = androidx.compose.ui.platform.LocalContext.current
    androidx.compose.ui.platform.LocalConfiguration.current // re-read when the language changes
    return context.resources.getString(id, *args)
}
