// Text rules for voi.ci pages and Messages (docs/voici-and-messages.md §2.4, §2.6, §7.2, §12.1): NFC, length in code
// points after NFC, the refusals every client and .com apply alike; the strict link matcher for message text; the
// profile link URL grammar; the known-site table that picks a link's icon; the visitor pseudonym code. Kotlin twin of
// packages/protocol/src/voiciText.ts (+ voiciLinkSites.json, embedded below) and voiciPseudonymName.ts.
//
// Public API (object VoiciText): VoiciTextField (enum, rules), checkVoiciText, prepareVoiciText, VOICI_LINK_URL_MAX,
// checkVoiciLinkUrl, voiciUrlHost, VoiciLinkMatch, findVoiciLinks (UTF-16 offsets), VoiciLinkSite,
// VOICI_LINK_SITES, voiciLinkSite, voiciPseudonymCode, voiciPseudonymName.

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import java.text.Normalizer
import java.util.regex.Pattern

/** min/max in code points after NFC; `newline` = "\n" allowed. Names match the TS field names. */
@Suppress("EnumEntryName")
enum class VoiciTextField(val min: Int, val max: Int, val newline: Boolean) {
    displayName(1, 64, false),
    bio(0, 280, true),
    linkLabel(1, 40, false),
    postText(1, 2000, true),
    messageText(1, 2000, true),
    cardTitle(1, 120, false),
    cardSite(0, 60, false),
    cardDescription(0, 200, false),
    nickname(1, 40, false),
    reportNote(0, 500, true),
}

data class VoiciLinkMatch(val start: Int, val end: Int, val url: String, val host: String)
data class VoiciLinkSite(val id: String, val hosts: List<String>, val label: String)

object VoiciText {
    private val INVISIBLE = setOf(0x200b, 0x200c, 0x200d, 0x2060)

    /** Checks a stored (already NFC) value; null when accepted, else the refusal code. */
    fun checkVoiciText(field: VoiciTextField, s: String?): String? {
        if (s == null) return "not-string"
        val cps = ArrayList<Int>(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i].code
            if (c in 0xd800..0xdbff) {
                val d = if (i + 1 < s.length) s[i + 1].code else -1
                if (d !in 0xdc00..0xdfff) return "surrogate"
                cps.add(((c - 0xd800) shl 10) + (d - 0xdc00) + 0x10000)
                i += 2
                continue
            }
            if (c in 0xdc00..0xdfff) return "surrogate"
            cps.add(c)
            i++
        }
        for (c in cps) {
            if (c == 0x0a && field.newline) continue
            if (c < 0x20 || c == 0x7f || c in 0x80..0x9f) return "control"
            if (c in 0x202a..0x202e || c in 0x2066..0x2069) return "bidi"
            if (c == 0xfeff) return "bom"
        }
        if (cps.isNotEmpty() && (cps.first() in INVISIBLE || cps.last() in INVISIBLE)) return "edge-invisible"
        if (Normalizer.normalize(s, Normalizer.Form.NFC) != s) return "not-nfc"
        if (cps.size < field.min) return "too-short"
        if (cps.size > field.max) return "too-long"
        return null
    }

    /** The JSON value form: anything but a JSON string is "not-string". */
    fun checkVoiciText(field: VoiciTextField, e: JsonElement?): String? = checkVoiciText(field, VoiciJs.str(e))

    /** Normalizes to NFC, then checks: what an editor or the compose box calls on typed text. */
    fun prepareVoiciText(field: VoiciTextField, s: String): VoiciOutcome<String> {
        val n = try {
            Normalizer.normalize(s, Normalizer.Form.NFC)
        } catch (_: Exception) {
            return VoiciOutcome.Refused("surrogate")
        }
        val code = checkVoiciText(field, n)
        return if (code != null) VoiciOutcome.Refused(code) else VoiciOutcome.Ok(n)
    }

    // ── URLs ──

    const val VOICI_LINK_URL_MAX = 512
    private const val LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    private const val HOST = "$LABEL(?:\\.$LABEL)+"
    private const val PATH_CHARS = "A-Za-z0-9\\-._~/?#\\[\\]@!\$&'()*+,;=%"
    private val HTTPS_URL = Pattern.compile("https://($HOST)(?::([0-9]{1,5}))?([/?#][$PATH_CHARS]*)?")
    private val MAILTO = Pattern.compile(
        "mailto:[A-Za-z0-9.!#\$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)",
    )

    /**
     * A profile or post link: `https://<lowercase ASCII host>[:port][path]`, or, when allowMailto, `mailto:<addr>`.
     * At most 512 characters. Null when accepted, else "not-string", "too-long", "scheme" or "malformed".
     */
    fun checkVoiciLinkUrl(url: String?, allowMailto: Boolean = false): String? {
        if (url == null) return "not-string"
        if (url.length > VOICI_LINK_URL_MAX) return "too-long"
        if (url.startsWith("mailto:")) {
            return if (allowMailto && MAILTO.matcher(url).matches()) null else if (allowMailto) "malformed" else "scheme"
        }
        if (!url.startsWith("https://")) return "scheme"
        val m = HTTPS_URL.matcher(url)
        if (!m.matches()) return "malformed"
        val port = m.group(2)
        if (port != null && (port.toInt() < 1 || port.toInt() > 65535)) return "malformed"
        return null
    }

    fun checkVoiciLinkUrl(e: JsonElement?, allowMailto: Boolean = false): String? = checkVoiciLinkUrl(VoiciJs.str(e), allowMailto)

    /** The host shown under a link (the mail domain for mailto:), or null when the URL is refused. */
    fun voiciUrlHost(url: String): String? {
        if (checkVoiciLinkUrl(url, true) != null) return null
        val m = (if (url.startsWith("mailto:")) MAILTO else HTTPS_URL).matcher(url)
        m.matches()
        return m.group(1)
    }

    private val TRAILING = setOf('.', ',', ';', ':', '!', '?', ')', '\'', '"', ']')
    private val SCAN = Pattern.compile("https://($HOST)([/?#][$PATH_CHARS]*)?", Pattern.CASE_INSENSITIVE)
    private fun alnum(c: Char) = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9'

    /**
     * The links in message text: `https://` (any case) + a host of at least two labels + an optional path, after the
     * start or a non-alphanumeric character. A host followed by "@" or ":" is not a link; trailing `.,;:!?)'"]` are
     * left out; longer than 2,048 characters is not a link. Offsets are UTF-16 indexes like JS.
     */
    fun findVoiciLinks(text: String): List<VoiciLinkMatch> {
        val out = ArrayList<VoiciLinkMatch>()
        val m = SCAN.matcher(text)
        var pos = 0
        while (pos <= text.length && m.find(pos)) {
            val start = m.start()
            pos = m.end()
            if (start > 0 && alnum(text[start - 1])) continue
            val host0 = m.group(1)
            val hostEnd = start + 8 + host0.length
            val after = if (hostEnd < text.length) text[hostEnd] else null
            if (after == '@' || after == ':' || (after != null && (alnum(after) || after == '-'))) {
                if (after == '@' || after == ':') pos = maxOf(pos, hostEnd + 1)
                continue
            }
            var raw = m.group()
            while (raw.length > 8 + host0.length && raw.last() in TRAILING) raw = raw.dropLast(1)
            if (raw.length > 2048) continue
            val host = host0.lowercase()
            out.add(VoiciLinkMatch(start, start + raw.length, "https://" + host + raw.substring(8 + host0.length), host))
        }
        return out
    }

    // ── known sites (voiciLinkSites.json) ──

    val VOICI_LINK_SITES: List<VoiciLinkSite> = listOf(
        VoiciLinkSite("github", listOf("github.com"), "GitHub"),
        VoiciLinkSite("gitlab", listOf("gitlab.com"), "GitLab"),
        VoiciLinkSite("codeberg", listOf("codeberg.org"), "Codeberg"),
        VoiciLinkSite("mastodon", listOf("mastodon.social", "mastodon.online"), "Mastodon"),
        VoiciLinkSite("bluesky", listOf("bsky.app"), "Bluesky"),
        VoiciLinkSite("linkedin", listOf("linkedin.com"), "LinkedIn"),
        VoiciLinkSite("instagram", listOf("instagram.com"), "Instagram"),
        VoiciLinkSite("youtube", listOf("youtube.com", "youtu.be"), "YouTube"),
        VoiciLinkSite("tiktok", listOf("tiktok.com"), "TikTok"),
        VoiciLinkSite("x", listOf("x.com", "twitter.com"), "X"),
        VoiciLinkSite("threads", listOf("threads.net", "threads.com"), "Threads"),
        VoiciLinkSite("facebook", listOf("facebook.com", "fb.com"), "Facebook"),
        VoiciLinkSite("twitch", listOf("twitch.tv"), "Twitch"),
        VoiciLinkSite("substack", listOf("substack.com"), "Substack"),
        VoiciLinkSite("medium", listOf("medium.com"), "Medium"),
        VoiciLinkSite("patreon", listOf("patreon.com"), "Patreon"),
        VoiciLinkSite("kofi", listOf("ko-fi.com"), "Ko-fi"),
        VoiciLinkSite("buymeacoffee", listOf("buymeacoffee.com"), "Buy Me a Coffee"),
        VoiciLinkSite("spotify", listOf("open.spotify.com", "spotify.com"), "Spotify"),
        VoiciLinkSite("soundcloud", listOf("soundcloud.com"), "SoundCloud"),
        VoiciLinkSite("bandcamp", listOf("bandcamp.com"), "Bandcamp"),
        VoiciLinkSite("applemusic", listOf("music.apple.com"), "Apple Music"),
        VoiciLinkSite("behance", listOf("behance.net"), "Behance"),
        VoiciLinkSite("dribbble", listOf("dribbble.com"), "Dribbble"),
        VoiciLinkSite("stackoverflow", listOf("stackoverflow.com"), "Stack Overflow"),
        VoiciLinkSite("reddit", listOf("reddit.com"), "Reddit"),
        VoiciLinkSite("discord", listOf("discord.gg", "discord.com"), "Discord"),
        VoiciLinkSite("telegram", listOf("t.me", "telegram.me"), "Telegram"),
        VoiciLinkSite("signal", listOf("signal.me", "signal.group"), "Signal"),
        VoiciLinkSite("whatsapp", listOf("wa.me", "whatsapp.com"), "WhatsApp"),
        VoiciLinkSite("pinterest", listOf("pinterest.com"), "Pinterest"),
        VoiciLinkSite("tumblr", listOf("tumblr.com"), "Tumblr"),
        VoiciLinkSite("flickr", listOf("flickr.com"), "Flickr"),
        VoiciLinkSite("vimeo", listOf("vimeo.com"), "Vimeo"),
        VoiciLinkSite("etsy", listOf("etsy.com"), "Etsy"),
        VoiciLinkSite("goodreads", listOf("goodreads.com"), "Goodreads"),
        VoiciLinkSite("letterboxd", listOf("letterboxd.com"), "Letterboxd"),
        VoiciLinkSite("strava", listOf("strava.com"), "Strava"),
        VoiciLinkSite("orcid", listOf("orcid.org"), "ORCID"),
        VoiciLinkSite("keybase", listOf("keybase.io"), "Keybase"),
        VoiciLinkSite("flagship", listOf("flagship.services", "voi.ci"), "Flagship"),
        VoiciLinkSite("email", emptyList(), "Email"),
    )
    internal val SITE_IDS: Set<String> = VOICI_LINK_SITES.map { it.id }.toSet()
    private val MASTODON_PATH = Regex("^/@[A-Za-z0-9_]{1,30}(?:@[a-z0-9.-]+)?/?$")

    /**
     * The site id for a link's icon: "email" for mailto:, a table entry whose host equals the URL's host or is a
     * suffix of it at a dot, else "mastodon" for a `/@user` path on any host, else null. Null for a refused URL.
     */
    fun voiciLinkSite(url: String): String? {
        val host = voiciUrlHost(url) ?: return null
        if (url.startsWith("mailto:")) return "email"
        for (s in VOICI_LINK_SITES) if (s.hosts.any { host == it || host.endsWith(".$it") }) return s.id
        val m = HTTPS_URL.matcher(url)
        m.matches()
        val rest = m.group(3) ?: ""
        val path = rest.split('?', '#')[0]
        return if (MASTODON_PATH.matches(path)) "mastodon" else null
    }

    // ── pseudonym names (§6.2) ──

    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    /** Four RFC 4648 base32 characters of SHA-256 over the raw 32-byte pseudonym key. */
    fun voiciPseudonymCode(pseudonymPubHex: String): String {
        require(WebEnvelopes.isLowerHex(pseudonymPubHex, 32)) { "pseudonym key must be 32 bytes of lowercase hex" }
        val h = VoiciJs.sha256(WebEnvelopes.hexToBytes(pseudonymPubHex))
        val sb = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in h) {
            buffer = ((buffer shl 8) or (b.toInt() and 0xff)) and 0xffff
            bits += 8
            while (bits >= 5) {
                bits -= 5
                sb.append(B32[(buffer shr bits) and 0x1f])
            }
            if (sb.length >= 4) break
        }
        return sb.substring(0, 4)
    }

    fun voiciPseudonymName(pseudonymPubHex: String, prefix: String = "Visitor "): String = prefix + voiciPseudonymCode(pseudonymPubHex)
}
