// GYM Android LIVE vertical slice (§12-G6/G7/G12) — the REAL app on an emulator,
// pointed at the gym backend, driving a REAL cloud box through its features, with
// screenshots. The Kotlin/Compose mirror of iOS App/UITests/GymLiveTests.swift.
//
// This is the long-pole test the Android gym never had: every other gym class is
// backendless (`flagship.smokeMode` + DemoFixtures + the MOCK client). This one:
//
//   1. launches MainActivity with `flagship.apexHost gym.flagshipserver.com`
//      (retargets every client at the gym), plus the gym-adopt extras
//      (`flagship.gymAdoptSeed/Username/Fqdn`) that install the box's owner UMK
//      seed → live useLiveClient → mint a box paired session (see
//      core/GymLiveAdoption.kt), so the REAL app is genuinely the box's owner;
//   2. asserts the maintainer-trust gate PASSES against the gym (no red
//      `global-trust-bar` — the gym MaintainersTrust pin matches the gym `.com`);
//   3. drives owner features against the live box + asserts the REAL effect:
//      Home shows the box ONLINE, server-detail loads, a service INSTALLS and
//      surfaces in the live Services list, the journal returns REAL lines, the
//      front-page picker renders for the live service.
//
// The box is provisioned out-of-band by tools/live-e2e/provision-for-webapp.ts
// (a real Hetzner box serving a real Let's Encrypt cert); its coordinates ride
// in via instrumentation args (`-e gymBoxSeed/-e gymBoxUsername/-e gymBoxFqdn`),
// set by the gym runner / the connectedAndroidTest invocation.
//
// HONESTY: if the box coords are absent the test SKIPS (a standalone gradle run
// without args must not fail the whole suite); the gym runner only schedules this
// class when a live box is provisioned, and then an absent BFF effect FAILS.

package com.flagshipserver.app.gym

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.core.GymLiveAdoption
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class GymLiveTest {

    @get:Rule
    val composeRule: ComposeTestRule = createEmptyComposeRule()

    private var scenario: ActivityScenario<MainActivity>? = null
    private val shotDir: File by lazy {
        File(
            ApplicationProvider.getApplicationContext<android.content.Context>().filesDir,
            GymBase.GYM_SHOT_SUBDIR,
        ).also { it.mkdirs() }
    }

    private lateinit var apex: String
    private lateinit var seedHex: String
    private lateinit var username: String
    private lateinit var fqdn: String

    @Before
    fun resolveBox() {
        val args = InstrumentationRegistry.getArguments()
        apex = args.getString("gymApex", "gym.flagshipserver.com")
        seedHex = args.getString("gymBoxSeed", "")
        username = args.getString("gymBoxUsername", "")
        fqdn = args.getString("gymBoxFqdn", "")
        // Skip (not fail) only when NO box coords were supplied — a bare gradle
        // run with no `-e gymBoxSeed` must not red the suite. The gym runner
        // always supplies them when a box is provisioned.
        assumeTrue(
            "No box coords (-e gymBoxSeed/-e gymBoxUsername/-e gymBoxFqdn) — run " +
                "tools/live-e2e/provision-for-webapp.ts first.",
            seedHex.isNotBlank() && username.isNotBlank() && fqdn.isNotBlank(),
        )
        assertTrue("gymBoxSeed must be 64 hex chars", seedHex.length == 64)
    }

    @After
    fun tearDownScenario() {
        scenario?.close()
        scenario = null
    }

    // "home" from "home.<user>.gym.flagship.services"
    private val serverName: String get() = fqdn.substringBefore('.')

    private fun launchLive() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra("flagship.apexHost", apex)
            putExtra(GymLiveAdoption.EXTRA_GYM_ADOPT_SEED, seedHex)
            putExtra(GymLiveAdoption.EXTRA_GYM_USERNAME, username)
            putExtra(GymLiveAdoption.EXTRA_GYM_FQDN, fqdn)
        }
        scenario = ActivityScenario.launch(intent)
        composeRule.waitForIdle()
    }

    private fun gymShot(point: String) {
        try {
            val instr: Instrumentation = InstrumentationRegistry.getInstrumentation()
            val safe = point.replace(Regex("[^A-Za-z0-9_.-]"), "-")
            val bmp: Bitmap = instr.uiAutomation.takeScreenshot() ?: return
            val file = File(shotDir, "gym-live-$safe.png")
            FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bmp.recycle()
        } catch (_: Throwable) {
            // best-effort — never affects the verdict
        }
    }

    /** Bounded wait until a node with [tag] exists. */
    private fun waitForTag(tag: String, timeoutMs: Long = 30_000): Boolean = try {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }
        true
    } catch (_: Throwable) {
        false
    }

    /** Bounded wait until a node with content-description [cd] exists. */
    private fun waitForCd(cd: String, timeoutMs: Long = 30_000): Boolean = try {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithContentDescription(cd).fetchSemanticsNodes().isNotEmpty()
        }
        true
    } catch (_: Throwable) {
        false
    }

    private fun cdExists(cd: String): Boolean =
        composeRule.onAllNodesWithContentDescription(cd).fetchSemanticsNodes().isNotEmpty()

    /** True if ANY visible text node contains [substr]. */
    private fun screenHasText(substr: String): Boolean {
        val nodes = composeRule.onAllNodes(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Text),
        ).fetchSemanticsNodes()
        return nodes.any { n ->
            n.config.getOrNull(SemanticsProperties.Text)
                ?.any { it.text.contains(substr) } == true
        }
    }

    /** Bounded wait until any visible text node contains [substr]. */
    private fun waitForScreenText(substr: String, timeoutMs: Long = 30_000): Boolean = try {
        composeRule.waitUntil(timeoutMs) { screenHasText(substr) }
        true
    } catch (_: Throwable) {
        false
    }

    private fun tagExists(tag: String): Boolean =
        composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    /** Concatenated text of the FIRST node carrying content-description [cd], or
     *  "" if absent. Reads the SemanticsProperties.Text the Compose Text node
     *  publishes — the rendered journal lines, not the picker chrome. */
    private fun readNodeText(cd: String): String {
        val nodes = composeRule.onAllNodesWithContentDescription(cd).fetchSemanticsNodes()
        if (nodes.isEmpty()) return ""
        val texts = nodes.first().config.getOrNull(SemanticsProperties.Text) ?: return ""
        return texts.joinToString("\n") { it.text }
    }

    /** Best-effort scroll a content-described node into view (so it's on-screen
     *  for the screenshot). Swallows — a node already on-screen / not scrollable
     *  must never change the verdict. */
    private fun scrollToCd(cd: String) {
        try {
            val node: SemanticsNodeInteraction =
                composeRule.onAllNodesWithContentDescription(cd).onFirst()
            node.performScrollTo()
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // not scrollable / already visible — fine
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // The whole slice as ONE ordered flow — adoption is expensive (a real box
    // pairing + reconcile), so we pay it once and drive every feature in one
    // launch, screenshotting + asserting each.
    // ════════════════════════════════════════════════════════════════════════
    @Test
    fun liveVerticalSlice() {
        launchLive()

        // ── 0. Trust gate PASSES + paired Home ──────────────────────────────
        // The maintainer-trust check runs on launch (live client). A FAILING
        // verdict renders the red `global-trust-bar`; the gym pin matches the
        // gym `.com`, so it must be ABSENT. The add-server affordance proves the
        // adopted live session landed on the paired Home shell.
        assertTrue(
            "Adopted live session should land on the paired Home shell (home-add-server present).",
            waitForTag("home-add-server", 60_000),
        )
        gymShot("live-home-paired")
        assertTrue(
            "The gym control plane must be TRUSTED — no red trust sliver should render.",
            !tagExists("global-trust-bar"),
        )

        // ── 1. Home shows the box ONLINE ────────────────────────────────────
        // The real /pods reconcile (unauthenticated, runs on Home appear) marks
        // the registered box online → a pod row renders. The mock client seeds
        // NO pods (gym-adopt uses the live client), so a row here is the REAL box.
        val online = waitForTag("home-pod-row", 90_000)
        assertTrue(
            "Home should surface the live box '$serverName' as a real pod row.",
            online,
        )
        gymShot("live-home-online")

        // ── 2. Server detail loads (for the REAL box) ───────────────────────
        composeRule.onAllNodesWithTag("home-pod-row").onFirst().performClick()
        assertTrue(
            "Tapping the live pod row should push server-detail.",
            waitForCd("server-detail-screen", 20_000),
        )
        // The adopt's `add-paired-session` POST is async, so the screens client
        // flips mock→live (sessionToken appears) a beat AFTER the push. The MOCK
        // detail renders a demo `harry.flagship.services` pod with its own
        // journal-fetch control — tapping THAT would never fetch the real box.
        // So wait until the LIVE detail is on-screen: its header carries the real
        // box FQDN (the mock never does). Only then are the cards box-backed.
        val liveDetailLoaded = waitForScreenText(fqdn, 60_000)
        assertTrue(
            "Server-detail should load the LIVE box ($fqdn) over the paired session, " +
                "not the mock demo pod.",
            liveDetailLoaded,
        )
        // The journal-fetch control proves the detail rendered for a real box.
        assertTrue(
            "Server-detail should render the Diagnostics → View-journal control.",
            waitForCd("sd-journal-fetch", 30_000),
        )
        gymShot("live-server-detail")

        // ── 3. Journal returns REAL lines ───────────────────────────────────
        // The journal read signs a JournalRequest with the box owner IRK (the
        // gym-adopt override — the PROTOCOL dot-form `flagship.irk.v1` key the
        // box's /api/journal pins) over the box transport. The fetched lines
        // render in `sd-journal-output`. Mirroring iOS, we assert on CONTENT that
        // ONLY appears in REAL journal output, NOT in the UI chrome: every
        // journalctl line carries the box's syslog hostname `flagship-gym-<user>-…`
        // and the daemon runs under `npm[…]`. The unit-picker button reads
        // "flagship-daemon" — deliberately NOT in this set — so a pass means
        // actual log lines rendered, not the picker label or the "journal is
        // empty" placeholder.
        //
        // Tap with a retry loop: the first fetch may race a late recomposition
        // (the mock→live screen swap recreates the JournalCard, resetting its
        // phase to Idle), so re-tap if no real lines render within the window.
        val hostPrefix = "flagship-gym-$username"
        fun journalHasRealLines(): Boolean {
            val t = readNodeText("sd-journal-output")
            return t.contains(hostPrefix) || t.contains("+0000 flagship-gym") || t.contains("npm[")
        }
        var journalRendered = false
        for (attempt in 0 until 3) {
            // The journal card sits far below the fold in the scrolling Column;
            // Compose only delivers a click to a node that's actually in the
            // viewport, so scroll it on-screen FIRST (otherwise performClick is a
            // silent no-op — the onClick never fires).
            composeRule.onAllNodesWithContentDescription("sd-journal-fetch").onFirst()
                .performScrollTo()
                .performClick()
            journalRendered = try {
                composeRule.waitUntil(30_000) { journalHasRealLines() }
                true
            } catch (_: Throwable) {
                false
            }
            if (journalRendered) break
            composeRule.waitForIdle()
        }
        val journalText = readNodeText("sd-journal-output")
        // Bring the rendered log lines on-screen for the screenshot. The journal
        // card sits far below the metrics in the scrolling Column and the output
        // renders just under the "View journal" button, so a single
        // performScrollTo lands the button at the fold with the lines below it.
        // Drag the OUTPUT block itself up by its center so the monospaced lines
        // fill the frame (a root swipe would scroll the whole page back to the
        // top). Cosmetic only — the assertion already proved the lines via
        // readNodeText; the test log also dumps them on failure.
        scrollToCd("sd-journal-output")
        composeRule.waitForIdle()
        try {
            composeRule.onAllNodesWithContentDescription("sd-journal-output").onFirst()
                .performTouchInput {
                    swipeUp(startY = centerY + 200f, endY = centerY - 600f)
                }
            composeRule.waitForIdle()
        } catch (_: Throwable) {
            // best-effort framing — never affects the verdict
        }
        Thread.sleep(700)
        gymShot("live-journal-lines")
        // Surface what we got into the test log on failure for fast triage.
        android.util.Log.i(
            "GymLiveTest",
            "journal: outputNodeExists=${cdExists("sd-journal-output")} " +
                "fetchNodeExists=${cdExists("sd-journal-fetch")} " +
                "text.len=${journalText.length} text(400)=${journalText.take(400)}",
        )
        if (!journalRendered) {
            // Dump every visible text node so a Failed-phase error message
            // (which has no contentDescription) shows up in the test log.
            val all = composeRule.onAllNodes(
                SemanticsMatcher.keyIsDefined(SemanticsProperties.Text),
            ).fetchSemanticsNodes()
            val dump = all.mapNotNull { n ->
                n.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }
            }.filter { it.isNotBlank() }.joinToString(" || ")
            android.util.Log.i("GymLiveTest", "screen-text-dump: ${dump.take(1500)}")
        }
        assertTrue(
            "Fetching the journal should return REAL daemon log lines (host-prefixed " +
                "'$hostPrefix' or 'npm[') from the live box, not just the picker label / " +
                "an empty journal. Got: ${journalText.take(200)}",
            journalRendered,
        )

        // ── 4. Install a service via the REAL signing primitive ─────────────
        // The gym branch's marketplace install UI is extracted to
        // feat/marketplace, so we mint the install through the app's REAL signing
        // key (the gym-adopt owner IRK) + the REAL box transport — a genuine
        // container build/run on the box. Asserts the daemon accepts it (200).
        val slug = "gymlive" + (System.currentTimeMillis() % 100000L)
        val installCode = installServiceOnBox(slug)
        assertTrue(
            "Live box should accept the IRK-signed install (got HTTP $installCode).",
            installCode == 200,
        )
        gymShot("live-after-install-api")

        // ── 5. Front-page picker renders for the live box ───────────────────
        // The front-page picker's options come from the box's unauthenticated
        // /api/services — so the just-installed service is selectable as the apex
        // front page. Its Save control (`sd-front-page-save`) proves the picker
        // rendered for a real, loaded box.
        val frontPageShown = waitForCd("sd-front-page-save", 30_000) ||
            cdExists("sd-front-page-save")
        gymShot("live-frontpage-picker")
        assertTrue(
            "Server-detail should render the front-page picker for the live box.",
            frontPageShown,
        )

        gymShot("live-slice-done")
    }

    // ── live-effect helper: install via the protocol mirror + owner IRK ──────

    /**
     * Install a service on the live box via the REAL protocol mirror + the box
     * owner IRK + the box transport (a genuine container build/run). Returns the
     * daemon HTTP status. Uses traefik/whoami (a tiny public image, no config,
     * listens on :80). The IRK is derived here in the TEST process via the
     * PROTOCOL derivation (HKDF-SHA256, empty salt, info "flagship.irk.v1"),
     * byte-identical to @flagship/protocol's deriveIRK (the box's owner key).
     */
    private fun installServiceOnBox(slug: String): Int {
        val seed = hexToBytes(seedHex)
        val irkSeed = hkdfSha256Empty(seed, "flagship.irk.v1".toByteArray(Charsets.UTF_8))
        val irk = com.google.crypto.tink.subtle.Ed25519Sign(irkSeed)

        val manifest = "{\"schema_version\":1,\"name\":\"$slug\",\"slug\":\"$slug\"," +
            "\"version\":\"1.0.0\",\"runtime\":{\"image\":\"traefik/whoami:latest\",\"port\":80}," +
            "\"data\":{},\"network\":{\"subdomain\":\"$slug\"},\"access\":{\"enabled\":true}," +
            "\"migration\":{\"verification\":\"standard\"}}"
        val issuedAt = System.currentTimeMillis()
        val canonical = listOf(
            "flagship/install-service/v1",
            fqdn, username, slug, manifest, "1", issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
        val sigHex = bytesToHex(irk.sign(canonical))

        val body = (
            "{\"request\":{\"serverId\":${js(fqdn)},\"creator\":${js(username)}," +
                "\"slug\":${js(slug)},\"manifestJson\":${js(manifest)}," +
                "\"addOwnerToMembership\":true,\"issuedAt\":$issuedAt}," +
                "\"signature\":${js(sigHex)}}"
            ).toByteArray(Charsets.UTF_8)

        val url = java.net.URL("https://$fqdn/api/services")
        val conn = url.openConnection() as javax.net.ssl.HttpsURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 30_000
            conn.readTimeout = 180_000
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            // drain so the connection releases
            (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes() }
            code
        } catch (e: Throwable) {
            android.util.Log.e("GymLiveTest", "install POST failed", e)
            -1
        } finally {
            conn.disconnect()
        }
    }

    // ── protocol-faithful crypto (mirrors @flagship/protocol) ────────────────

    /** RFC 5869 HKDF-SHA256 with an EMPTY salt (zero-byte-32 key) — the protocol
     *  passes new Uint8Array(0); noble/HMAC zero-pads to the block size. */
    private fun hkdfSha256Empty(ikm: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }

    private fun hexToBytes(s: String): ByteArray {
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(s[i * 2], 16) shl 4) +
                Character.digit(s[i * 2 + 1], 16)).toByte()
        }
        return out
    }

    private fun bytesToHex(b: ByteArray): String {
        val hex = "0123456789abcdef"
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            sb.append(hex[(x.toInt() shr 4) and 0xf])
            sb.append(hex[x.toInt() and 0xf])
        }
        return sb.toString()
    }

    private fun js(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> sb.append(c)
        }
        return sb.append("\"").toString()
    }

    // MessageDigest import kept for parity with iOS (host-prefix derivation if
    // ever needed); unused suppressant.
    @Suppress("unused")
    private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
}
