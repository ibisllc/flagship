// Connect your IDE: each IDE's own config from the box (Claude Code with its
// one-line command, Cursor, VS Code's `servers`, Cline's `streamableHttp`),
// the generic one from an older box, and URLs that copy unescaped.

package com.flagshipserver.app.api

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildMcpIdeConfigTest {
    private val pretty = Json { prettyPrint = true }
    private fun text(e: JsonElement) = pretty.encodeToString(JsonElement.serializer(), e)

    @Test fun perIdeConfigs() = runBlocking {
        val conn = MockBuildClient(simulatedLatencyMs = 0).mcpCreate(BuildMcpRequest(label = "android")).connection
        val choices = conn.ideChoices()
        assertEquals(listOf("claude-code", "cursor", "vscode", "cline"), choices.map { it.id })
        val claude = choices.first()
        assertTrue(claude.command!!.startsWith("claude mcp add --scope user --transport http flagship-"))
        assertTrue(text(claude.config).contains("https://"))
        assertFalse(text(claude.config).contains("\\/"))
        assertTrue(text(choices.first { it.id == "vscode" }.config).contains("\"servers\""))
        assertNull(choices.first { it.id == "vscode" }.command)
        assertTrue(text(choices.first { it.id == "cline" }.config).contains("streamableHttp"))
        assertEquals("Cline → MCP Servers → Configure MCP Servers", choices.first { it.id == "cline" }.where)
    }

    @Test fun olderBoxGetsTheGenericConfig() = runBlocking {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { legacyMcpConfig = true }
        val choices = client.mcpCreate(BuildMcpRequest(label = "android")).connection.ideChoices()
        assertEquals(listOf("generic"), choices.map { it.id })
        assertTrue(text(choices.single().config).contains("mcpServers"))
    }

    @Test fun decodesTheBoxWire() {
        val json = Json { ignoreUnknownKeys = true }
        val c = json.decodeFromString(
            BuildMcpConnection.serializer(),
            """{"url":"https://a/mcp/build/b","key":"k","ideConfig":{"mcpServers":{}},"ideConfigs":[{"id":"cursor","name":"Cursor","where":"~/.cursor/mcp.json","config":{"mcpServers":{}}}]}""",
        )
        assertEquals("Cursor", c.ideConfigs!!.single().name)
        assertNull(c.ideConfigs!!.single().command)
        assertNull(json.decodeFromString(BuildMcpConnection.serializer(), """{"url":"u","key":"k","ideConfig":{}}""").ideConfigs)
    }
}
