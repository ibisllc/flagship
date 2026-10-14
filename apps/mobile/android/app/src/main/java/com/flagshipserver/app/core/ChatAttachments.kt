// What the build chat lets the owner attach, and the limits the box enforces
// (packages/server-daemon/src/llm/vibeCodeAttachments.ts). Checked here first
// so an over-limit file gets a friendly line instead of a refused send.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.VibeCodeAttachment
import java.util.Base64

enum class AttachKind { IMAGE, TEXT, DATA, DOCUMENT }

object ChatAttachments {
    const val MAX_PER_MESSAGE = 6
    const val NOTICE = "The AI will see what you attach."
    const val SAMPLE_DATA_NOTE = "Sample data goes only to the private test copy."
    const val TOO_MANY = "You can attach up to $MAX_PER_MESSAGE files to a message."

    /** What the file picker offers. */
    val DOCUMENT_MIME_TYPES = arrayOf(
        "text/*", "application/json", "application/pdf", "application/xml",
        "application/x-yaml", "application/yaml", "application/toml", "application/javascript",
        "application/x-sh", "application/sql",
    )

    private val IMAGE_TYPES = mapOf(
        "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
        "gif" to "image/gif", "webp" to "image/webp",
    )

    private val TEXT_EXTENSIONS = setOf(
        "txt", "md", "markdown", "log", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml",
        "html", "htm", "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs",
        "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
        "sql", "graphql", "proto", "vue", "svelte", "dockerfile", "gradle", "properties", "tsv",
    )

    fun maxBytes(kind: AttachKind): Long = when (kind) {
        AttachKind.IMAGE -> 4L * 1024 * 1024
        AttachKind.TEXT -> 256L * 1024
        AttachKind.DATA -> 2L * 1024 * 1024
        AttachKind.DOCUMENT -> 10L * 1024 * 1024
    }

    fun limitLabel(kind: AttachKind): String = when (kind) {
        AttachKind.IMAGE -> "4 MB"
        AttachKind.TEXT -> "256 KB"
        AttachKind.DATA -> "2 MB"
        AttachKind.DOCUMENT -> "10 MB"
    }

    private fun extension(name: String): String =
        name.substringAfterLast('/').let { n -> if ('.' in n) n.substringAfterLast('.').lowercase() else n.lowercase() }

    /** The kind for a picked file, or null when it can't be attached. */
    fun kindFor(name: String, mime: String?): AttachKind? {
        val ext = extension(name)
        val mt = mime?.lowercase()?.substringBefore(';')?.trim()
        return when {
            ext in IMAGE_TYPES || mt in IMAGE_TYPES.values || mt == "image/jpg" -> AttachKind.IMAGE
            ext == "pdf" || mt == "application/pdf" -> AttachKind.DOCUMENT
            ext == "csv" || ext == "json" || mt == "text/csv" || mt == "application/json" -> AttachKind.DATA
            ext in TEXT_EXTENSIONS || mt?.startsWith("text/") == true -> AttachKind.TEXT
            else -> null
        }
    }

    /** Why [name] can't be staged, or null when it can. */
    fun problem(kind: AttachKind?, name: String, size: Long, staged: Int): String? = when {
        staged >= MAX_PER_MESSAGE -> TOO_MANY
        kind == null -> "$name can't be attached. Try an image, a text or code file, CSV, JSON or PDF."
        size > maxBytes(kind) -> "$name is over ${limitLabel(kind)}, so it wasn't attached."
        else -> null
    }

    /** The wire form of a checked file. */
    fun build(kind: AttachKind, name: String, mime: String?, bytes: ByteArray): VibeCodeAttachment = when (kind) {
        AttachKind.IMAGE -> VibeCodeAttachment.Image(
            mediaType = IMAGE_TYPES[extension(name)]
                ?: mime?.lowercase()?.let { if (it == "image/jpg") "image/jpeg" else it }
                ?: "image/png",
            dataBase64 = Base64.getEncoder().encodeToString(bytes),
            name = name,
        )
        AttachKind.TEXT -> VibeCodeAttachment.Text(text = String(bytes, Charsets.UTF_8), name = name)
        AttachKind.DATA -> VibeCodeAttachment.Data(
            name = name,
            mediaType = if (extension(name) == "json" || mime?.lowercase() == "application/json") "application/json" else "text/csv",
            text = String(bytes, Charsets.UTF_8),
        )
        AttachKind.DOCUMENT -> VibeCodeAttachment.Document(
            name = name,
            mediaType = "application/pdf",
            dataBase64 = Base64.getEncoder().encodeToString(bytes),
        )
    }

    fun kindOf(a: VibeCodeAttachment): AttachKind = when (a) {
        is VibeCodeAttachment.Image -> AttachKind.IMAGE
        is VibeCodeAttachment.Text -> AttachKind.TEXT
        is VibeCodeAttachment.Data -> AttachKind.DATA
        is VibeCodeAttachment.Document -> AttachKind.DOCUMENT
    }

    fun displayName(a: VibeCodeAttachment): String = a.name?.takeIf { it.isNotBlank() } ?: when (kindOf(a)) {
        AttachKind.IMAGE -> "Image"
        AttachKind.TEXT -> "Text"
        AttachKind.DATA -> "Data"
        AttachKind.DOCUMENT -> "PDF"
    }

    fun hasImage(list: List<VibeCodeAttachment>): Boolean = list.any { it is VibeCodeAttachment.Image }

    fun hasSampleData(list: List<VibeCodeAttachment>): Boolean = list.any { it is VibeCodeAttachment.Data }
}
