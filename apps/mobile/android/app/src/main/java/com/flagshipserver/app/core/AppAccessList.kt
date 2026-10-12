package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.MessageDigest

/**
 * A live app's access list (docs/ai-privacy-and-staging.md §3a): one
 * `allow`/`deny` rule per line, first match decides, no match is denied. The
 * box enforces only a list the owner signed:
 *
 *   flagship/app-access/v1|<serverDomain>|<serviceId>|<sha256 hex of the normalized list>|<issuedAt>
 *
 * packages/protocol/test-vectors/app-access/vectors.json is the reference;
 * AppAccessListVectorsTest runs every case.
 */
object AppAccessList {
    const val CANONICAL_TAG = "flagship/app-access/v1"
    const val MAX_RULES = 200

    const val ALLOW = "allow"
    const val DENY = "deny"
    const val ALL = "all"

    /** A new app's list: denies everything and shows how to open it up. */
    const val DEFAULT_LIST = "# Uncomment the following line to allow all hosts\n#allow all\n"

    data class Rule(val line: Int, val action: String, val target: String)

    data class LineError(val line: Int, val message: String)

    data class Parsed(val rules: List<Rule>, val errors: List<LineError>) {
        val ok: Boolean get() = errors.isEmpty()
    }

    /** [rule] is the deciding rule's 1-based position among the parsed rules
     *  (comments and blank lines don't count), null when no rule matched. */
    data class Decision(val result: String, val rule: Int?)

    fun normalize(text: String): String {
        val lines = text.replace("\r\n", "\n").replace('\r', '\n')
            .split('\n')
            .map { it.trimEnd(' ', '\t') }
            .toMutableList()
        while (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.lastIndex)
        return if (lines.isEmpty()) "" else lines.joinToString("\n") + "\n"
    }

    fun parse(text: String): Parsed {
        val rules = ArrayList<Rule>()
        val errors = ArrayList<LineError>()
        var tooMany = false
        lines(normalize(text)).forEachIndexed { i, raw ->
            val n = i + 1
            when (val r = parseLine(raw, n)) {
                null -> {}
                is LineResult.Ok -> {
                    if (rules.size >= MAX_RULES) {
                        // Reported once, on the first rule past the limit.
                        if (!tooMany) errors += LineError(n, "an access list can have at most $MAX_RULES rules")
                        tooMany = true
                    } else {
                        rules += r.rule
                    }
                }
                is LineResult.Err -> errors += r.error
            }
        }
        return Parsed(rules, errors)
    }

    fun decide(list: String, host: String): Decision {
        val h = canonicalHost(host)
        parse(list).rules.forEachIndexed { i, rule ->
            if (matches(rule.target, h)) return Decision(rule.action, i + 1)
        }
        return Decision(DENY, null)
    }

    /** Drop any rule for exactly [host], then put `<action> <host>` on top so it
     *  decides. Throws IllegalArgumentException for a host a list can't hold. */
    fun withRule(list: String, action: String, host: String): String {
        val h = when (val t = target(host.trim())) {
            is Target.Ok -> t.value
            is Target.Bad -> throw IllegalArgumentException(t.message)
        }
        val a = action.lowercase()
        require(a == ALLOW || a == DENY) { "action must be allow or deny" }
        val kept = lines(normalize(list)).filterIndexed { i, raw ->
            val r = parseLine(raw, i + 1)
            !(r is LineResult.Ok && r.rule.target == h)
        }
        return normalize((listOf("$a $h") + kept).joinToString("\n"))
    }

    fun sha256Hex(list: String): String =
        HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(list.toByteArray(Charsets.UTF_8)))

    fun canonicalBytes(serverDomain: String, serviceId: String, listSha256: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, serverDomain, serviceId, listSha256, issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)

    data class SignedList(
        val list: String,
        val listSha256: String,
        val issuedAt: Long,
        val signatureHex: String,
    )

    /** Normalizes [list], hashes it and signs the order with [key]. */
    fun sign(key: Ed25519Sign, serverDomain: String, serviceId: String, list: String, issuedAt: Long): SignedList {
        val normalized = normalize(list)
        val sha = sha256Hex(normalized)
        val sig = key.sign(canonicalBytes(serverDomain, serviceId, sha, issuedAt))
        return SignedList(normalized, sha, issuedAt, HexUtil.encode(sig))
    }

    private fun lines(normalized: String): List<String> =
        if (normalized.isEmpty()) emptyList() else normalized.removeSuffix("\n").split('\n')

    /** Lowercase and drop one trailing dot. */
    private fun canonicalHost(host: String): String = host.trim().lowercase().removeSuffix(".")

    private fun matches(target: String, host: String): Boolean = when {
        target == ALL -> true
        target.startsWith("*.") -> target.substring(1).let { suffix -> host.length > suffix.length && host.endsWith(suffix) }
        else -> host == target
    }

    private sealed interface LineResult {
        data class Ok(val rule: Rule) : LineResult
        data class Err(val error: LineError) : LineResult
    }

    private val WHITESPACE = Regex("[ \t]+")
    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://")
    private val IPV4 = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")
    private val IPV6ISH = Regex("^[0-9a-f:.]+$")
    private const val LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
    private val HOST = Regex("^$LABEL(\\.$LABEL)+$")
    private val NUMERIC = Regex("^[0-9.]+$")

    private fun isIpLiteral(t: String): Boolean {
        if (IPV4.matches(t)) return true
        val v6 = t.removePrefix("[").replace(Regex("\\](:[0-9]+)?$"), "")
        return IPV6ISH.matches(v6) && v6.count { it == ':' } >= 2
    }

    /** Null for a blank or comment-only line. */
    private fun parseLine(raw: String, line: Int): LineResult? {
        val body = raw.substringBefore('#').trim()
        if (body.isEmpty()) return null
        fun err(message: String) = LineResult.Err(LineError(line, message))
        val words = body.split(WHITESPACE)
        val action = words[0].lowercase()
        if (action != ALLOW && action != DENY) return err("start the line with \"allow\" or \"deny\"")
        if (words.size < 2) return err("say what to allow or deny, e.g. \"allow example.com\"")
        if (words.size > 2) return err("one host per line")
        return when (val t = target(words[1])) {
            is Target.Ok -> LineResult.Ok(Rule(line, action, t.value))
            is Target.Bad -> err(t.message)
        }
    }

    private sealed interface Target {
        data class Ok(val value: String) : Target
        data class Bad(val message: String) : Target
    }

    private fun target(typed: String): Target {
        val t = typed.lowercase()
        if (t == ALL) return Target.Ok(ALL)
        if (SCHEME.containsMatchIn(t)) return Target.Bad("write the host only, without http:// or https://")
        if (t.contains('/')) return Target.Bad("write the host only, without a path")
        if (isIpLiteral(t)) return Target.Bad("IP addresses can't be allowed or denied; use a host name")
        if (t.contains(':')) return Target.Bad("write the host only, without a port")
        if (t == "*") return Target.Bad("write \"all\" instead of \"*\"")
        val wildcard = t.startsWith("*.")
        var host = if (wildcard) t.substring(2) else t
        if (host.contains('*')) return Target.Bad("a * may only start a host, as in *.example.com")
        // One trailing dot is the DNS root: "example.com." is "example.com".
        host = host.removeSuffix(".")
        if (host == "localhost" || host.endsWith(".localhost")) {
            return Target.Bad("\"localhost\" is not a public host name")
        }
        if (host.length > 253 || !HOST.matches(host) || NUMERIC.matches(host)) {
            return Target.Bad("\"$typed\" is not a valid host name")
        }
        return Target.Ok(if (wildcard) "*.$host" else host)
    }
}
