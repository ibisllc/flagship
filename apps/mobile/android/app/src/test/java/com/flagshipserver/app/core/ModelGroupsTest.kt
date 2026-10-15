// The build chat's grouped model menu. Mirrors the webapp
// lib/modelGroups.js tests and iOS ModelGroupsTests.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.InferenceCatalogResponse
import com.flagshipserver.app.api.InferenceModel
import com.flagshipserver.app.api.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelGroupsTest {
    private val keys = listOf(
        SavedAiKey("k1", "openai", "Work", "sk-one"),
        SavedAiKey("k2", "anthropic", "Home", "sk-two"),
        SavedAiKey("k3", "openai", "Spare", "sk-three"),
    )

    private val flagshipMenu = ModelMenu.Flagship(
        InferenceCatalogResponse(
            models = listOf(
                InferenceModel("low", "Low", "Qwen", 1.0, "Low 1× (Qwen)", "", 262_144, listOf("text"), true, default = true),
                InferenceModel(
                    "small", "Small", "Tiny", 1.0, "Small 1× (Tiny)", "", 32_768, listOf("text"), true,
                    efforts = listOf("low", "high"), defaultEffort = "low",
                ),
            ),
            defaultModel = "low",
        ),
    )
    private val ownMenu = ModelMenu.Own(
        "openai", listed = true, defaultModel = "gpt-5.4-mini", reason = null,
        options = listOf(
            ModelOption("gpt-5.4-mini", "GPT-5.4 Mini", 400_000, true, true, listOf("low", "medium", "high"), "medium", true),
            ModelOption("small-ctx", "Small context", 32_000, known = true),
            ModelOption("brand-new", "brand-new", known = false),
        ),
    )

    @Test fun flagshipComesFirstOnlyWhenUsableOrInUse() {
        val usable = ModelGroups.build(keys, flagshipUsable = true, currentProvider = "openai")
        assertEquals(listOf("flagship", "k1", "k2", "k3"), usable.map { it.id })
        assertEquals("Flagship Inference", usable[0].title)
        assertEquals("openai · Work", usable[1].title)
        assertEquals("Work", usable[1].keyLabel)
        assertNull(usable[0].keyLabel)

        val notUsable = ModelGroups.build(keys, flagshipUsable = false, currentProvider = "openai")
        assertEquals(listOf("k1", "k2", "k3"), notUsable.map { it.id })

        val inUse = ModelGroups.build(keys, flagshipUsable = false, currentProvider = "flagship")
        assertEquals("flagship", inUse.first().id)
    }

    @Test fun anUnsavedKeyThisChatStartedWithIsListedLast() {
        val g = ModelGroups.build(keys.take(1), flagshipUsable = false, currentProvider = "google", sessionKeyProvider = "google")
        assertEquals(listOf("k1", ModelGroups.SESSION_KEY), g.map { it.id })
        assertEquals("google · Unsaved key", g[1].title)
    }

    @Test fun reopenedChatPicksTheGroupOfTheProviderTheBoxSays() {
        val groups = ModelGroups.build(keys, flagshipUsable = true, currentProvider = null)
        assertEquals("flagship", ModelGroups.forProvider(groups, "flagship")?.id)
        assertEquals("k1", ModelGroups.forProvider(groups, "openai")?.id)
        assertEquals("k2", ModelGroups.forProvider(groups, "anthropic")?.id)
        assertNull(ModelGroups.forProvider(groups, "google"))
        assertNull(ModelGroups.forProvider(groups, null))
        // The key this app started the chat with wins over the provider's first key.
        val spare = AiCredential("openai", "sk-three", keyId = "k3")
        assertEquals("k3", ModelGroups.initial(groups, "openai", spare)?.id)
        // ...unless the box has since moved to another provider.
        assertEquals("k2", ModelGroups.initial(groups, "anthropic", spare)?.id)
        val pass = AiCredential("flagship", "pass", source = "promo")
        assertEquals("flagship", ModelGroups.initial(groups, "flagship", pass)?.id)
    }

    @Test fun theChatsProviderComesFromTheBoxFirst() {
        val own = AiCredential("openai", "sk", keyId = "k1")
        assertEquals("anthropic", ModelGroups.chatProvider("anthropic", own, onFlagship = true, modelInCatalog = true))
        assertEquals("flagship", ModelGroups.chatProvider(null, null, onFlagship = true, modelInCatalog = false))
        assertEquals("openai", ModelGroups.chatProvider(null, own, onFlagship = false, modelInCatalog = false))
        assertEquals("flagship", ModelGroups.chatProvider("", null, onFlagship = false, modelInCatalog = true))
        assertNull(ModelGroups.chatProvider(null, null, onFlagship = false, modelInCatalog = false))
    }

    @Test fun effortShowsOnlyForAModelThatListsEfforts() {
        assertTrue(ModelGroups.effortOptions(flagshipMenu, ModelChoice("low")).isEmpty())
        assertEquals(listOf("low", "high"), ModelGroups.effortOptions(flagshipMenu, ModelChoice("small")))
        assertEquals(listOf("low", "medium", "high"), ModelGroups.effortOptions(ownMenu, ModelChoice("gpt-5.4-mini")))
        assertTrue(ModelGroups.effortOptions(ownMenu, ModelChoice("brand-new")).isEmpty())
        assertTrue(ModelGroups.effortOptions(null, ModelChoice("gpt-5.4-mini")).isEmpty())
        // Picking a model starts on its own default effort.
        assertEquals(ModelChoice("small", "low"), ModelMenus.select(flagshipMenu, "small"))
        assertEquals(ModelChoice("gpt-5.4-mini", "medium"), ModelMenus.select(ownMenu, "gpt-5.4-mini"))
    }

    @Test fun contextNoticeMirrorsTheBoxCompactionThreshold() {
        // 32,768 context: budget 32,768 - 8,192 = 24,576; 75% = 18,432.
        assertFalse(ModelGroups.mayDropContext(18_432, 32_768))
        assertTrue(ModelGroups.mayDropContext(18_433, 32_768))
        // 262,144 context: budget 246,144; 75% = 184,608.
        assertFalse(ModelGroups.mayDropContext(184_608, 262_144))
        assertTrue(ModelGroups.mayDropContext(184_609, 262_144))
        assertFalse(ModelGroups.mayDropContext(null, 32_768))
        assertFalse(ModelGroups.mayDropContext(50_000, null))
        assertFalse(ModelGroups.mayDropContext(0, 32_768))

        val big = 40_000L
        assertEquals(
            ModelGroups.CONTEXT_NOTICE,
            ModelGroups.contextNotice(flagshipMenu, ModelChoice("small"), sessionModel = "low", conversationTokens = big),
        )
        assertEquals("Older messages will be summarised to fit this model.", ModelGroups.CONTEXT_NOTICE)
        // The model the chat already uses, a roomy model, or an unknown size: no line.
        assertNull(ModelGroups.contextNotice(flagshipMenu, ModelChoice("small"), sessionModel = "small", conversationTokens = big))
        assertNull(ModelGroups.contextNotice(flagshipMenu, ModelChoice("low"), sessionModel = "small", conversationTokens = big))
        assertNull(ModelGroups.contextNotice(ownMenu, ModelChoice("brand-new"), sessionModel = "x", conversationTokens = big))
        assertNull(ModelGroups.contextNotice(ownMenu, ModelChoice("small-ctx"), sessionModel = "x", conversationTokens = null))
        assertEquals(
            ModelGroups.CONTEXT_NOTICE,
            ModelGroups.contextNotice(ownMenu, ModelChoice("small-ctx"), sessionModel = "gpt-5.4-mini", conversationTokens = big),
        )
    }

    @Test fun triggerNamesTheModelAndTheKey() {
        val groups = ModelGroups.build(keys, flagshipUsable = true, currentProvider = null)
        assertEquals("Low 1×", ModelGroups.triggerText(groups[0], flagshipMenu, ModelChoice("low")))
        assertEquals("Flagship Inference", ModelGroups.triggerText(groups[0], null, ModelChoice("low")))
        assertEquals("GPT-5.4 Mini · Work", ModelGroups.triggerText(groups[1], ownMenu, ModelChoice("gpt-5.4-mini", "high")))
        assertEquals("typed · Work", ModelGroups.triggerText(groups[1], null, ModelChoice("typed")))
        assertEquals("gpt-5", ModelGroups.triggerText(null, null, ModelChoice("gpt-5")))
    }

    @Test fun whichCredentialAMessageCarries() {
        val groups = ModelGroups.build(keys, flagshipUsable = true, currentProvider = null)
        val flagship = groups[0]
        val work = groups[1]
        // Flagship Inference: always a fresh pass.
        assertEquals(MessageCredential.FLAGSHIP_PASS, ModelGroups.messageCredential(flagship, picked = false, needsCredential = false))
        assertEquals(MessageCredential.FLAGSHIP_PASS, ModelGroups.messageCredential(flagship, picked = true, needsCredential = false))
        // An own key: only when picked here or the box holds none.
        assertEquals(MessageCredential.NONE, ModelGroups.messageCredential(work, picked = false, needsCredential = false))
        assertEquals(MessageCredential.OWN_KEY, ModelGroups.messageCredential(work, picked = true, needsCredential = false))
        assertEquals(MessageCredential.OWN_KEY, ModelGroups.messageCredential(work, picked = false, needsCredential = true))
        assertEquals(MessageCredential.NONE, ModelGroups.messageCredential(null, picked = true, needsCredential = true))
    }

    @Test fun aCredentialMapsBackToItsGroup() {
        val groups = ModelGroups.build(keys, flagshipUsable = true, currentProvider = null, sessionKeyProvider = "google")
        assertEquals("flagship", ModelGroups.forCredential(groups, AiCredential("openai", "p", source = "promo"))?.id)
        assertEquals("k2", ModelGroups.forCredential(groups, AiCredential("anthropic", "sk-two", keyId = "k2"))?.id)
        assertEquals(ModelGroups.SESSION_KEY, ModelGroups.forCredential(groups, AiCredential("google", "g"))?.id)
        assertNull(ModelGroups.forCredential(groups, null))
    }
}
