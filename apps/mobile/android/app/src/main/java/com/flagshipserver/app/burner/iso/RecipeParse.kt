// Parse + light-validate a phone-signed recipe JSON for the on-device burner.
//
// The burner receives the recipe as a JSON string (the same artifact the
// website's "Copy/Download recipe" produces and the desktop burner's loadBlob
// consumes). This extracts the human-facing fields (server name/domain/username
// + auth-code serial) for the UI + the future injector. It does NOT re-verify
// the IRK signature — the phone is the trust root and the recipe came straight
// from it in-process; full signature verification is a property of the shared
// generator path that the injector will reuse.

package com.flagshipserver.app.burner.iso

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class RecipeParseException(message: String) : RuntimeException(message)

data class ParsedRecipe(
    val serial: String,
    val serverName: String,
    val serverDomain: String,
    val username: String,
    val blobSignatureHex: String,
    /** The expiry from authCode.expiresAt (epoch ms), or null if absent. */
    val expiresAt: Long?,
) {
    val expired: Boolean get() = expiresAt != null && System.currentTimeMillis() > expiresAt
}

object RecipeParse {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * Parse a recipe JSON string. Accepts both the flattened recipe and the
     * issued envelope `{ blob:{...}, blobSignature:"..." }`. Throws
     * [RecipeParseException] on malformed / incomplete input.
     */
    fun parse(raw: String): ParsedRecipe {
        if (raw.isBlank()) throw RecipeParseException("empty recipe")
        val root: JsonObject = try {
            json.parseToJsonElement(raw).jsonObject
        } catch (e: Throwable) {
            throw RecipeParseException("not a JSON object: ${e.message}")
        }

        // Flatten the envelope form into the blob object + lift the signature.
        val blobField = root["blob"]
        val (obj, sig) = if (blobField != null && blobField is JsonObject) {
            blobField to str(root, "blobSignature")
        } else {
            root to (str(root, "blobSignatureHex") ?: str(root, "blobSignature"))
        }
        if (sig.isNullOrEmpty()) throw RecipeParseException("missing blobSignatureHex")

        val authCode = (obj["authCode"] as? JsonObject)
            ?: throw RecipeParseException("missing authCode")

        val serial = str(authCode, "serial") ?: throw RecipeParseException("missing authCode.serial")
        val serverDomain = str(obj, "serverDomain") ?: str(authCode, "serverDomain")
            ?: throw RecipeParseException("missing serverDomain")
        val serverName = str(obj, "serverName") ?: str(authCode, "serverName") ?: serverDomain
        val username = str(obj, "username") ?: str(authCode, "username")
            ?: throw RecipeParseException("missing username")
        val expiresAt = longOrNull(authCode, "expiresAt")

        return ParsedRecipe(
            serial = serial,
            serverName = serverName,
            serverDomain = serverDomain,
            username = username,
            blobSignatureHex = sig,
            expiresAt = expiresAt,
        )
    }

    private fun str(o: JsonObject, key: String): String? =
        (o[key])?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }?.takeIf { it.isNotEmpty() }

    private fun longOrNull(o: JsonObject, key: String): Long? =
        (o[key])?.let { runCatching { it.jsonPrimitive.content.toLong() }.getOrNull() }
}
