// GYM Android button sweep — Build: the chooser's help and Build sessions
// (open, discard), a git import (check, install; not ready → the AI; a build a
// box restart cut off → deploy it as it is or run the AI again), the IDE
// connection, the from-scratch path through Flagship Inference to Build, and
// the build chat: answer or decline an env var, continue a ready or failed
// chat, switch to a saved key's provider, the effort menu, Deploy. Each press
// is checked on the mock box (what it received). NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymBuildTest : GymBase() {

    private fun openChooser() {
        launch(tab = "apps", adminRoot = true)
        tap("services-build-cta", 20_000)
        waitUntilExists("build-src-git")
    }

    // ─── Chooser ─────────────────────────────────────────────────────────────

    @Test
    fun chooserHelpAndBuildSessions() {
        openChooser()
        tap("build-source-help")
        waitText("How building works")
        gymShot("build-help")
        tapText("Done")
        waitTextGone("How building works")
        tap("build-source-journal-link")
        waitText("Build sessions", 15_000)
        gymShot("build-sessions")
    }

    /** An open git build can be discarded after a confirmation. */
    @Test
    fun discardAnOpenBuild() {
        launch(tab = "apps", adminRoot = true)
        buildMock.sessionsFixture = com.flagshipserver.app.api.BuildSessionsResponse(
            builds = listOf(
                com.flagshipserver.app.api.BuildSummary(buildId = "bld-gymopen1", mode = "git", name = "gymrepo", startedAt = 1, lastAt = 2, entryCount = 2, lastKind = "fitness", open = true),
            ),
        )
        tap("services-build-cta", 20_000)
        tap("build-source-journal-link")
        tap("build-discard-bld-gymopen1", 15_000)
        waitText("Discard this build?")
        tapText("Cancel")
        assertTrue(buildMock.discardCalls.isEmpty())
        tap("build-discard-bld-gymopen1")
        composeRule.onAllNodes(hasText("Discard build") and hasClickAction()).onFirst().performClick()
        eventually(what = "discarded") { buildMock.discardCalls == listOf("bld-gymopen1") }
        gymShot("discarded")
    }

    /** A git build a box restart cut off: its page shows the box's sentence
     *  and deploys the build as it is. */
    @Test
    fun aBuildCutOffByARestartDeploysAsItIs() {
        launch(tab = "apps", adminRoot = true)
        val reason = "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy."
        buildMock.sessionsFixture = com.flagshipserver.app.api.BuildSessionsResponse(
            builds = listOf(
                com.flagshipserver.app.api.BuildSummary(buildId = "bld-restart1", mode = "git", name = "garden", startedAt = 1, lastAt = 2, entryCount = 3, lastKind = "adapt", open = true),
            ),
        )
        buildMock.stateFixture["bld-restart1"] = com.flagshipserver.app.api.BuildState(
            "bld-restart1", "git", adapt = com.flagshipserver.app.api.BuildAdaptStatus(status = "failed", reason = reason),
        )
        tap("services-build-cta", 20_000)
        tap("build-source-journal-link")
        tapText("garden", 15_000)
        waitUntilExists("build-journal-adapt-failed", 15_000)
        assertEquals(reason, textOfTag("build-journal-adapt-failed"))
        waitUntilExists("build-journal-run-ai")
        gymShot("restart-failed")
        tap("build-journal-deploy")
        waitUntilExists("build-journal-deployed", 15_000)
        assertEquals(listOf("bld-restart1"), buildMock.deployCalls)
        gymShot("restart-deployed")
    }

    /** …or runs the AI again, with the key step's choice. */
    @Test
    fun aBuildCutOffByARestartRunsTheAiAgain() {
        launch(tab = "apps", adminRoot = true)
        buildMock.sessionsFixture = com.flagshipserver.app.api.BuildSessionsResponse(
            builds = listOf(
                com.flagshipserver.app.api.BuildSummary(buildId = "bld-restart2", mode = "git", name = "garden", startedAt = 1, lastAt = 2, entryCount = 3, lastKind = "adapt", open = true),
            ),
        )
        buildMock.stateFixture["bld-restart2"] = com.flagshipserver.app.api.BuildState(
            "bld-restart2", "git",
            adapt = com.flagshipserver.app.api.BuildAdaptStatus(status = "failed", reason = "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy."),
        )
        buildMock.adaptStatusFixture = com.flagshipserver.app.api.BuildAdaptStatus(status = "done", fileCount = 7, deployed = true, deployedUrl = "https://garden.home.bright-maple.flagship.services/")
        tap("services-build-cta", 20_000)
        tap("build-source-journal-link")
        tapText("garden", 15_000)
        tap("build-journal-run-ai", 15_000)
        waitUntilExists("build-journal-deployed", 20_000)
        assertEquals("bld-restart2", buildMock.adaptStartCalls.single().first)
        gymShot("restart-ai-again")
    }

    // ─── Git ─────────────────────────────────────────────────────────────────

    @Test
    fun gitCheckThenInstall() {
        openChooser()
        tap("build-src-git")
        composeRule.onAllNodes(hasSetTextAction()).onFirst().performTextInput("https://github.com/gym/ready")
        tap("build-git-check")
        waitText("Flagship-ready ✓", 15_000)
        gymShot("git-ready")
        tapText("Install it")
        waitText("Installed ✓", 15_000)
        assertEquals(1, buildMock.deployCalls.size)
        assertEquals("https://github.com/gym/ready", buildMock.gitImportCalls.single().gitUrl)
    }

    /** Not ready: the share switch, Check again, then the AI with Flagship
     *  Inference; a restart cutting it off offers Deploy as well. */
    @Test
    fun gitNotReadyAdaptsWithTheAi() {
        openChooser()
        buildMock.gitFitFixture = false
        tap("build-src-git")
        composeRule.onAllNodes(hasSetTextAction()).onFirst().performTextInput("https://github.com/gym/plain")
        tap("build-git-check")
        waitUntilExists("build-git-adapt", 15_000)
        tap("build-git-share")
        tap("build-git-recheck")
        eventually(what = "checked twice") { buildMock.gitImportCalls.size == 2 }
        waitUntilExists("build-git-adapt", 15_000)
        buildMock.adaptStatusFixture = com.flagshipserver.app.api.BuildAdaptStatus(
            status = "failed",
            reason = "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy.",
        )
        tap("build-git-adapt")
        waitUntilExists("build-git-deploy-anyway", 30_000)
        gymShot("git-cut-off")
        tap("build-git-deploy-anyway")
        waitText("Installed ✓", 15_000)
        assertEquals(1, buildMock.adaptStartCalls.size)
    }

    // ─── IDE (MCP) ───────────────────────────────────────────────────────────

    @Test
    fun ideConnectionCopyAndRegenerate() {
        openChooser()
        tap("build-src-mcp")
        tap("build-mcp-create")
        waitText("Copy key", 15_000)
        tapText("Copy key")
        eventually(what = "the key on the clipboard") { clipboardText().isNotEmpty() }
        val first = clipboardText()
        tapText("Copy IDE config")
        eventually(what = "the config on the clipboard") { clipboardText() != first }
        tapText("Regenerate key")
        eventually(what = "rotated") { buildMock.mcpRotateCalls.size == 1 }
        gymShot("mcp")
        tapText("View journal")
        waitText("Build sessions", 15_000)
    }

    // ─── From scratch ────────────────────────────────────────────────────────

    @Test
    fun fromScratchWithFlagshipInference() {
        openChooser()
        tap("build-src-scratch")
        // An owner with no AI key goes straight to the describe step (Flagship Inference).
        waitUntilExists("vibe-describe-name", 15_000)
        gymShot("describe-step")
        type("vibe-describe-name", "gymtodo")
        type("vibe-describe-prompt", "A to-do list for the gym")
        composeRule.onAllNodes(tagPrefix("vibe-describe-visibility-")).onFirst().scrollIfNeeded().performClick()
        tap("vibe-describe-build")
        eventually(10_000, "the build started") { screensMock.vibeCodeStartCalls.isNotEmpty() }
        assertEquals("A to-do list for the gym", screensMock.vibeCodeStartCalls.last().prompt)
        gymShot("scratch-started")
    }

    // ─── The build chat ──────────────────────────────────────────────────────

    /** The AI asks for an env var: Send answers it as "set". */
    @Test
    fun chatAnswersAnEnvVar() {
        launch(tab = "home", ops = true)
        tap("global-operations-bar")
        type("vibecode-envvar-field", "abc123")
        tap("vibecode-envvar-send-btn")
        eventually(what = "the answer") { screensMock.chatReplies.lastOrNull()?.second?.envVarStatus == "set" }
        gymShot("env-sent")
    }

    @Test
    fun chatDeclinesAnEnvVar() {
        launch(tab = "home", ops = true)
        tap("global-operations-bar")
        tap("vibecode-envvar-decline-btn", 20_000)
        eventually(what = "declined") { screensMock.chatReplies.lastOrNull()?.second?.envVarStatus == "declined" }
    }

    /** A ready chat takes a new message, and Deploy sends it live. */
    @Test
    fun readyChatContinuesAndDeploys() {
        launch(tab = "home", ops = true, chat = "ready")
        tap("global-operations-bar")
        type("vibecode-continue-field", "Add a dark mode")
        tap("vibecode-continue-send-btn")
        eventually(what = "the message") { screensMock.chatReplies.lastOrNull()?.second?.text == "Add a dark mode" }
        tap("vibecode-deploy-btn", 15_000)
        eventually(what = "the deploy") { screensMock.chatDeploys.isNotEmpty() }
        gymShot("chat-deployed")
    }

    /** A failed chat takes a new message on another provider: the reply
     *  carries that key's credential and its model. */
    @Test
    fun failedChatContinuesOnAnotherProvider() {
        launch(tab = "settings", ops = true, chat = "failed")
        tap("settings-ai-keys", 20_000)
        tap("ai-key-add")
        tap("ai-key-provider-openai")
        type("ai-key-field", "sk-gym-1234567890")
        tapText("Save key")
        waitTextGone("Save key")
        tap("global-operations-bar")
        waitText("The app didn't start", 20_000)
        tap("model-menu")
        composeRule.waitUntil(15_000) { composeRule.onAllNodes(tagPrefix("model-item-")).fetchSemanticsNodes().isNotEmpty() }
        gymShot("model-menu")
        composeRule.onAllNodes(tagPrefix("model-item-")).fetchSemanticsNodes().first { n ->
            n.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.contains("gpt-5.4-mini") == true
        }.let { n ->
            composeRule.onNodeWithTagCompat(n.config[androidx.compose.ui.semantics.SemanticsProperties.TestTag]).performClick()
        }
        type("vibecode-continue-field", "Try again on port 3000")
        tap("vibecode-continue-send-btn")
        eventually(what = "the switched reply") {
            val r = screensMock.chatReplies.lastOrNull()?.second
            r?.credential?.provider == "openai" && r.model == "gpt-5.4-mini"
        }
        gymShot("provider-switched")
    }
}

private fun androidx.compose.ui.test.junit4.ComposeTestRule.onNodeWithTagCompat(tag: String) =
    onNode(androidx.compose.ui.test.hasTestTag(tag))
