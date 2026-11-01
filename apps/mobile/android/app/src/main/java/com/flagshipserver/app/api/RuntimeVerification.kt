// The server page's "Runtime" section (release plan G2): which Node.js the box runs, its official source, the
// checksum Flagship publishes for it and the state of Node's and Flagship's signatures. The box reports it on
// server-detail (`runtime`, packages/server-daemon/src/runtimeVerification.ts); this only presents it, like the
// webapp's lib/runtimeVerification.js, and passes the same vectors
// (packages/protocol/test-vectors/runtime-verification/).

package com.flagshipserver.app.api

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class RuntimeVerificationView(
    val runtime: String = "node",
    val version: String,
    val activeVersion: String = "",
    val target: String = "",
    val officialUrl: String = "",
    val sourceUrl: String = "",
    val shasumsUrl: String = "",
    val archiveFile: String = "",
    val expectedArchiveSha256: String = "",
    val expectedExecutableSha256: String = "",
    val executablePath: String = "",
    val localExecutableSha256: String? = null,
    val matchesLock: Boolean = false,
    val upstream: Upstream? = null,
    val flagship: Flagship,
    val lockSha256: String = "",
    val pageUrl: String = "",
    val manifestUrl: String = "",
) {
    @Serializable
    data class Upstream(val status: String = "unknown", val signer: String? = null)

    /** [status]: verified, not-published, unavailable, expired, or a refusal reason. */
    @Serializable
    data class Flagship(
        val status: String,
        val expectedArchiveSha256: String? = null,
        val sequence: Long? = null,
        val release: String? = null,
        val version: String? = null,
        val validUntil: Long? = null,
        val matchesLock: Boolean? = null,
        val checkedAt: Long? = null,
    )

    enum class Tone { GOOD, NEUTRAL, BAD }
    data class Pill(val tone: Tone, val label: String)
    data class Note(val tone: Tone, val text: String)
    data class Command(val title: String, val text: String)

    val platform: String get() = platformLabel(target)

    val flagshipStatus: Pill
        get() = when (flagship.status) {
            "verified" -> Pill(Tone.GOOD, FSStrings.get(R.string.runtime_verified))
            "not-published" -> Pill(Tone.NEUTRAL, FSStrings.get(R.string.runtime_not_published))
            "unavailable" -> Pill(Tone.NEUTRAL, FSStrings.get(R.string.runtime_unavailable))
            "expired" -> Pill(Tone.BAD, FSStrings.get(R.string.runtime_expired))
            else -> Pill(Tone.BAD, FSStrings.get(R.string.runtime_refused))
        }

    val upstreamStatus: Pill
        get() = if (upstream?.status == "verified-at-release") Pill(Tone.GOOD, FSStrings.get(R.string.runtime_checked_at_release))
        else Pill(Tone.NEUTRAL, FSStrings.get(R.string.runtime_not_checked))

    private val hasLocal: Boolean get() = !localExecutableSha256.isNullOrEmpty()

    val localStatus: Pill
        get() = when {
            !hasLocal -> Pill(Tone.NEUTRAL, FSStrings.get(R.string.runtime_not_checked))
            matchesLock -> Pill(Tone.GOOD, FSStrings.get(R.string.runtime_matches))
            else -> Pill(Tone.BAD, FSStrings.get(R.string.runtime_does_not_match))
        }

    val notes: List<Note>
        get() {
            val out = ArrayList<Note>()
            if (hasLocal && !matchesLock) out += Note(Tone.BAD, FSStrings.get(R.string.runtime_note_swapped))
            val s = flagship.status
            if (s !in setOf("verified", "not-published", "unavailable", "expired")) {
                out += Note(Tone.BAD, FSStrings.get(R.string.runtime_note_refused, s))
            }
            if (s == "verified" && flagship.matchesLock == false) out += Note(Tone.NEUTRAL, FSStrings.get(R.string.runtime_note_newer_lock))
            return out
        }

    /** The checksum Flagship published, falling back to the release's own lock. */
    val expectedChecksum: String get() = flagship.expectedArchiveSha256 ?: expectedArchiveSha256

    /** "Check it yourself": plain shell, the same on every client. */
    val commands: List<Command>
        get() {
            val sums = shasumsUrl.substringAfterLast('/')
            return listOf(
                Command(
                    FSStrings.get(R.string.runtime_cmd_node),
                    listOf(
                        "curl -fsSLO $officialUrl",
                        "curl -fsSLO $shasumsUrl",
                        "curl -fsSLO $shasumsUrl.sig",
                        "gpg --verify $sums.sig $sums",
                        "grep ' $archiveFile\$' $sums",
                        "sha256sum $archiveFile",
                        "# $expectedArchiveSha256",
                    ).joinToString("\n"),
                ),
                Command(
                    FSStrings.get(R.string.runtime_cmd_manifest),
                    listOf(
                        "curl -fsS $manifestUrl -o runtime-manifest.json",
                        "jq -j .lockJson runtime-manifest.json | sha256sum",
                        "# $lockSha256",
                        "git clone https://github.com/ibisllc/flagship && cd flagship && npm ci",
                        "npx tsx tools/box-artifact/runtime-manifest.ts verify --manifest ../runtime-manifest.json",
                    ).joinToString("\n"),
                ),
                Command(
                    FSStrings.get(R.string.runtime_cmd_server),
                    listOf(
                        "sha256sum $executablePath",
                        "# $expectedExecutableSha256",
                        "$executablePath --version",
                        "# v$version",
                    ).joinToString("\n"),
                ),
            )
        }

    companion object {
        private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

        fun platformLabel(target: String): String = when (target) {
            "linux-amd64" -> "Linux x86-64"
            "linux-arm64" -> "Linux ARM64"
            else -> target
        }

        /** A usable view, or null. Never throws: a malformed section must not stop the server page from loading. */
        fun from(obj: JsonObject?): RuntimeVerificationView? {
            if (obj == null) return null
            val version = obj["version"] as? JsonPrimitive
            if (version == null || !version.isString) return null
            return runCatching { json.decodeFromJsonElement(serializer(), obj) }.getOrNull()
        }
    }
}
