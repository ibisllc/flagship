// Cross-language conformance replay for the maintainers trust port (#10,
// Android half — mirror of iOS MaintainersConformanceTests.swift).
//
// This loads the SHARED, dependency-free conformance artifact from disk
// AT RUNTIME. The artifact ships inside the published `@ibisllc/maintainers`
// npm package, so it is resolved from
// `<repoRoot>/node_modules/@ibisllc/maintainers/conformance/manifest.json`
// + `vectors/*.json` — the exact same set the TypeScript and Swift sides
// replay. The vectors are NOT transcribed into Kotlin literals; they are
// read and parsed from the real files. For EVERY vector we run the native
// Kotlin verifier for that subject and assert the verdict (accepted, and
// on rejection the EXACT rejectReason) equals the manifest entry.
//
// "Conformant iff it produces the expected verdict for EVERY vector,
// including every fail-closed negative."

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class MaintainersConformanceTest {

    private val json = Json { ignoreUnknownKeys = true }

    // ----- Locate the shared conformance artifact on disk --------------

    /** Walk up from the JVM unit-test working dir (and this class's
     *  location) to find the published npm package's conformance artifact
     *  at `node_modules/@ibisllc/maintainers/conformance/manifest.json`.
     *  Read at runtime — never transcribed. An unlocatable artifact is a
     *  real FAILURE here (never a skip). */
    private fun conformanceDir(): File {
        val rel = "node_modules/@ibisllc/maintainers/conformance"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        try {
            val loc = javaClass.protectionDomain?.codeSource?.location
            if (loc != null) candidates.add(File(loc.toURI()))
        } catch (_: Throwable) {
            // ignore — user.dir walk is the primary path
        }

        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 12) {
                val manifest = File(dir, "$rel/manifest.json")
                if (manifest.isFile) return File(dir, rel)
                dir = dir.parentFile
                hops += 1
            }
        }
        fail(
            "could not locate $rel/manifest.json from " +
                candidates.joinToString { it.absolutePath },
        )
        error("unreachable")
    }

    // ----- Portable vector shape (lenient tree decoding) ---------------

    private fun JsonObject.str(key: String): String =
        (this[key] as JsonPrimitive).content

    private fun JsonObject.strOrNull(key: String): String? {
        val v = this[key] ?: return null
        if (v is JsonNull) return null
        return (v as JsonPrimitive).contentOrNull
    }

    private fun JsonObject.int(key: String): Int =
        (this[key] as JsonPrimitive).jsonPrimitive.intOrNull
            ?: error("field $key is not an int")

    private fun JsonObject.bool(key: String): Boolean =
        (this[key] as JsonPrimitive).content.toBoolean()

    private fun JsonObject.strList(key: String): List<String> {
        val a = this[key] as? JsonArray ?: return emptyList()
        return a.map { (it as JsonPrimitive).content }
    }

    private fun JsonObject.strListOrNull(key: String): List<String>? {
        val v = this[key] ?: return null
        if (v is JsonNull) return null
        return (v as JsonArray).map { (it as JsonPrimitive).content }
    }

    private fun parseSignatures(arr: JsonElement?): List<MaintainersSignature> {
        if (arr == null || arr is JsonNull) return emptyList()
        return arr.jsonArray.map {
            val o = it.jsonObject
            MaintainersSignature(o.str("pubkey"), o.str("sig"))
        }
    }

    private fun parseMandate(o: JsonObject): Mandate {
        val ar = o["approvalRule"]!!.jsonObject
        val proj = o["project"]?.let { if (it is JsonNull) null else it.jsonObject }
        return Mandate(
            kind = o.str("kind"),
            version = o.int("version"),
            mandateId = o.str("mandateId"),
            track = o.str("track"),
            holder = o.str("holder"),
            issuedAt = o.str("issuedAt"),
            expiresAt = o.str("expiresAt"),
            successors = o.strList("successors"),
            approvalRule = MaintainersApprovalRule(ar.str("kind"), ar.int("threshold")),
            minSuccessors = o.int("minSuccessors"),
            maxDurationSeconds = o.int("maxDurationSeconds"),
            defaultDurationSeconds = o.int("defaultDurationSeconds"),
            project = proj?.let {
                MaintainersProject(
                    name = it.strOrNull("name"),
                    contact = it.strOrNull("contact"),
                    homepage = it.strOrNull("homepage"),
                    tracks = it.strListOrNull("tracks"),
                )
            },
            signedBy = o.str("signedBy"),
            signatures = parseSignatures(o["signatures"]),
        )
    }

    private fun parseReleaseEndorsement(o: JsonObject): ReleaseEndorsement =
        ReleaseEndorsement(
            kind = o.str("kind"),
            version = o.int("version"),
            releaseId = o.str("releaseId"),
            semverTag = o.str("semverTag"),
            commitHash = o.str("commitHash"),
            previousReleaseId = o.strOrNull("previousReleaseId"),
            previousCommitHash = o.strOrNull("previousCommitHash"),
            intermediateCommits = o.strList("intermediateCommits"),
            intermediateMerkleRoot = o.str("intermediateMerkleRoot"),
            endorsedNotes = o.strOrNull("endorsedNotes"),
            issuedAt = o.str("issuedAt"),
            signedBy = o.str("signedBy"),
            signatures = parseSignatures(o["signatures"]),
        )

    private fun parseCaEndorsement(o: JsonObject): CaEndorsement =
        CaEndorsement(
            kind = o.str("kind"),
            version = o.int("version"),
            endorsementId = o.str("endorsementId"),
            track = o.str("track"),
            caPubkey = o.str("caPubkey"),
            scope = o.str("scope"),
            notBefore = o.str("notBefore"),
            notAfter = o.str("notAfter"),
            issuedAt = o.str("issuedAt"),
            signedBy = o.str("signedBy"),
            signatures = parseSignatures(o["signatures"]),
        )

    private data class Verdict(val accepted: Boolean, val rejectReason: String?)

    private fun parseIsoMs(s: String): Long =
        MaintainersTime.epochMs(s) ?: 0L

    /** Exact mirror of the TS/Swift `replay(vec)`: same functions, same
     *  order, the consumer's own `now`. Totality: must never throw. */
    private fun replay(vec: JsonObject): Verdict {
        val input = vec["input"]!!.jsonObject
        val expect = vec["expect"]!!.jsonObject
        val pin = input.str("pin")
        val nowMs = parseIsoMs(input.str("now"))
        val track = input.str("track")
        val subject = expect.str("subject")

        val mandatesByTrack = input["mandatesByTrack"]!!.jsonObject
        val list = (mandatesByTrack[track] as? JsonArray)?.map {
            parseMandate(it.jsonObject)
        } ?: emptyList()
        val chain = MaintainersVerifier.verifyMandateChainFromPin(pin, list)

        return when (subject) {
            "mandate-chain" -> {
                if (MaintainersVerifier.currentAuthority(chain, nowMs) != null) {
                    Verdict(true, null)
                } else {
                    val reason = if (chain.root == null) {
                        chain.rootError?.raw ?: "pin-not-in-log"
                    } else {
                        chain.rejections.firstOrNull()?.reason?.raw ?: "no-authority-at-now"
                    }
                    Verdict(false, reason)
                }
            }

            "release-endorsement" -> {
                val endorsements = (input["endorsements"] as? JsonArray)?.map {
                    parseReleaseEndorsement(it.jsonObject)
                } ?: emptyList()
                val r = MaintainersReleaseVerifier.verifyChainOfEndorsements(
                    endorsements, chain,
                )
                if (r.rejections.isEmpty() && r.validEndorsements.isNotEmpty()) {
                    Verdict(true, null)
                } else {
                    Verdict(
                        false,
                        r.rejections.firstOrNull()?.second?.raw
                            ?: "no-authority-at-issuance",
                    )
                }
            }

            else -> { // ca-endorsement
                val caEndorsements = (input["caEndorsements"] as? JsonArray)?.map {
                    parseCaEndorsement(it.jsonObject)
                } ?: emptyList()
                val r = MaintainersCaVerifier.verifyCaEndorsements(
                    caEndorsements, chain, nowMs,
                )
                if (r.rejections.isEmpty() && r.validEndorsements.isNotEmpty()) {
                    Verdict(true, null)
                } else {
                    Verdict(
                        false,
                        r.rejections.firstOrNull()?.second?.raw
                            ?: "no-ca-authority-at-now",
                    )
                }
            }
        }
    }

    // ----- Tests -------------------------------------------------------

    /** The baked pin equals the published MAINTAINER_PINNED_MANDATE_HASH
     *  and an empty pin fails closed with `no-pin` (never falls back). */
    @Test
    fun pinnedConstant_isExactPublishedValue_andEmptyPinFailsClosed() {
        // ⚠️ GYM TEST BRANCH ONLY — the gym self-contained chain pin. On `main`
        // this is the prod pin "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae".
        assertEquals(
            "87f5ae60cd1cfc0629fdf10ab97a547d33bca68bf3a1426614096a3054d57ae7",
            MaintainersTrust.pinnedMandateHash,
        )
        val chain = MaintainersVerifier.verifyMandateChainFromPin("", emptyList())
        assertNull(chain.root)
        assertEquals(V2RootFailReason.NoPin, chain.rootError)
        assertTrue(chain.validMandates.isEmpty())
        assertNull(MaintainersVerifier.currentAuthority(chain, System.currentTimeMillis()))
    }

    /** EVERY manifest vector replays to its declared verdict. This is the
     *  objective correctness gate — a green run that skipped a negative
     *  is a failed task, so this asserts the full set with no exclusions
     *  and cross-checks each vector's own embedded `expect`. */
    @Test
    fun allConformanceVectors_replayToManifestVerdict() {
        val dir = conformanceDir()
        val manifestFile = File(dir, "manifest.json")
        assertTrue(
            "manifest.json must exist at ${manifestFile.absolutePath}",
            manifestFile.isFile,
        )
        val manifest = json.parseToJsonElement(manifestFile.readText()).jsonObject

        assertEquals(1, manifest.int("schemaVersion"))
        val vectors = manifest["vectors"]!!.jsonArray
        assertEquals(manifest.int("count"), vectors.size)
        assertEquals(
            "expected the full 17-vector cross-language set",
            17,
            vectors.size,
        )

        var replayed = 0
        for (entryEl in vectors) {
            val entry = entryEl.jsonObject
            val name = entry.str("name")
            val file = entry.str("file")
            val subject = entry.str("subject")
            val accepted = entry.bool("accepted")
            val rejectReason = entry.strOrNull("rejectReason")

            val vecFile = File(dir, file)
            assertTrue(
                "[$name] vector file must exist at ${vecFile.absolutePath}",
                vecFile.isFile,
            )
            val vec = json.parseToJsonElement(vecFile.readText()).jsonObject

            assertEquals(
                "vector file name mismatch for $name",
                name,
                vec.str("name"),
            )
            val expect = vec["expect"]!!.jsonObject
            assertEquals(
                "subject drift between manifest and vector for $name",
                subject,
                expect.str("subject"),
            )
            assertEquals(
                "accepted drift between manifest and vector for $name",
                accepted,
                expect.bool("accepted"),
            )
            assertEquals(
                "rejectReason drift between manifest and vector for $name",
                rejectReason,
                expect.strOrNull("rejectReason"),
            )

            // Totality: replay must never throw on any (incl. adversarial) vector.
            val verdict = replay(vec)

            assertEquals(
                "[$name] accepted: got ${verdict.accepted} want $accepted",
                accepted,
                verdict.accepted,
            )
            assertEquals(
                "[$name] rejectReason: got ${verdict.rejectReason} want $rejectReason",
                rejectReason,
                verdict.rejectReason,
            )
            replayed += 1
        }
        assertEquals("every manifest vector must be replayed", 17, replayed)
        assertNotNull(manifest)
    }
}
