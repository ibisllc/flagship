package com.flagshipserver.app.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** TalkBack rules read from the source: an icon-only button must carry a spoken
 *  label. A static check, since a Compose test would have to open every screen. */
class AccessibilityRulesTest {
    private val root = File("src/main/java").takeIf { it.exists() } ?: File("app/src/main/java")

    /** The text of the call's trailing lambda starting at [from] (the index of "IconButton("). */
    private fun block(src: String, from: Int): String {
        var i = src.indexOf('(', from)
        var depth = 0
        while (i < src.length) {
            when (src[i]) { '(' -> depth++; ')' -> { depth--; if (depth == 0) break } }
            i++
        }
        val open = src.indexOf('{', i)
        if (open < 0 || src.substring(i + 1, open).isNotBlank()) return src.substring(from, i)
        var d = 0
        var j = open
        while (j < src.length) {
            when (src[j]) { '{' -> d++; '}' -> { d--; if (d == 0) return src.substring(from, j + 1) } }
            j++
        }
        return src.substring(from)
    }

    @Test
    fun everyIconButtonIsLabelled() {
        val bad = mutableListOf<String>()
        root.walkTopDown().filter { it.extension == "kt" }.forEach { f ->
            val src = f.readText()
            Regex("""\bIconButton\(""").findAll(src).forEach { m ->
                val b = block(src, m.range.first)
                val labelled = Regex("""contentDescription\s*=\s*(?!null\b)\S""").containsMatchIn(b) ||
                    "clearAndSetSemantics" in b
                if (!labelled) bad += "${f.name}:${src.substring(0, m.range.first).count { it == '\n' } + 1}"
            }
        }
        assertTrue("icon-only buttons without a contentDescription: $bad", bad.isEmpty())
    }

    @Test
    fun theCheckSeesAnUnlabelledButton() {
        val src = "IconButton(onClick = {}) { Icon(Icons.Close, contentDescription = null) }"
        val b = block(src, 0)
        assertTrue(!Regex("""contentDescription\s*=\s*(?!null\b)\S""").containsMatchIn(b))
    }
}
