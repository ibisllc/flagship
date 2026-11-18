// The share card (owner decision 2026-11-17, docs/voici-and-messages.md §2.10): the 1200×630 JPEG link previews show
// for a voi.ci page (og:image). The publishing device draws it and lists it as the page's "share" piece, like the photo,
// so `.com` needs no image pipeline. When to redraw and when to carry the listed card lives here (pure, JVM-tested);
// the drawing is behind [VoiciShareCardRenderer] (AndroidShareCardRenderer on a device).
package com.flagshipserver.app.core.voici

/** Draws a page's share card: a JPEG of at most VOICI_SHARE_IMAGE_MAX_BYTES with no metadata, or null when it can't. */
fun interface VoiciShareCardRenderer {
    fun render(profile: VoiciProfile, username: String, avatar: ByteArray?): ByteArray?
}

object VoiciShareCards {
    const val ROLE = "share"

    /** The share piece the index being replaced lists (none after a removal: its pieces are gone). */
    fun listed(published: List<VoiciPieceRef>): VoiciPieceRef? = published.firstOrNull { it.role == ROLE }

    /** The card shows the name, the photo and the theme: a change to any of them draws a new card. */
    fun sameLook(a: VoiciProfile, b: VoiciProfile): Boolean = a.displayName == b.displayName && a.avatar == b.avatar && a.theme == b.theme

    /** A JPEG the share role takes: the magic, the cap, and no APP1/APP2 metadata. */
    fun acceptable(bytes: ByteArray): Boolean =
        bytes.isNotEmpty() && bytes.size <= VoiciPage.VOICI_SHARE_IMAGE_MAX_BYTES && VoiciPage.isVoiciJpeg(bytes) && !VoiciPage.voiciJpegHasMetadata(bytes)

    /**
     * The share piece of a publish of [working]. [listed]: the card the replaced index lists; [publishedProfile] its
     * profile (null on a first publish). Carried as it is (same hash, no upload, bytes from [image] when this device
     * kept them) while the look is unchanged; otherwise drawn again and handed to [keep] (so a later publish can carry
     * it). Null when nothing could be drawn: the page publishes without a card rather than not at all.
     */
    fun plan(
        working: VoiciPageState,
        username: String,
        listed: VoiciPieceRef?,
        publishedProfile: VoiciProfile?,
        renderer: VoiciShareCardRenderer?,
        image: (String) -> ByteArray?,
        keep: (ByteArray) -> Unit = {},
    ): VoiciPlannedPiece? {
        if (listed != null && publishedProfile != null && sameLook(publishedProfile, working.profile)) {
            val kept = image(listed.sha256)?.takeIf { it.size.toLong() == listed.size && WebEnvelopes.sha256Hex(it) == listed.sha256 }
            return VoiciPlannedPiece(ROLE, listed.sha256, listed.size, kept, "image/jpeg")
        }
        val avatar = working.profile.avatar?.let(image)
        val bytes = runCatching { renderer?.render(working.profile, username, avatar) }.getOrNull()?.takeIf(::acceptable) ?: return null
        keep(bytes)
        return VoiciPlannedPiece(ROLE, WebEnvelopes.sha256Hex(bytes), bytes.size.toLong(), bytes, "image/jpeg")
    }

    /** The layout's colours by theme (§2.10): canvas, ink, muted ink, accent, hairline, as ARGB. */
    data class Palette(val canvas: Int, val ink: Int, val muted: Int, val accent: Int, val rule: Int)

    fun palette(theme: String): Palette = when (theme) {
        "ink" -> Palette(0xFF0A0A09.toInt(), 0xFFECE7D6.toInt(), 0xFFA39D8F.toInt(), 0xFF2DD4BF.toInt(), 0xFF26241D.toInt())
        "sea" -> Palette(0xFFF3F6F7.toInt(), 0xFF0E1A1F.toInt(), 0xFF4C5F67.toInt(), 0xFF14B8A6.toInt(), 0xFFE5E3DC.toInt())
        else -> Palette(0xFFF7F6F2.toInt(), 0xFF14140F.toInt(), 0xFF555149.toInt(), 0xFF14B8A6.toInt(), 0xFFE5E3DC.toInt())
    }

    /** The display name's first character, upper-cased (a whole code point), for the disc without a photo. */
    fun initial(displayName: String): String {
        val t = displayName.trim()
        if (t.isEmpty()) return ""
        return String(Character.toChars(t.codePointAt(0))).uppercase()
    }

    /** JPEG qualities tried in order (0.9 down to 0.4 by 0.1). */
    val QUALITIES = listOf(90, 80, 70, 60, 50, 40)
}
