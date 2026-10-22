package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppLinkState
import com.flagshipserver.app.api.MockVoiciNameClient
import com.flagshipserver.app.api.VoiciNameCheck
import com.flagshipserver.app.api.VoiciNameEntry
import com.flagshipserver.app.api.VoiciNameException
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.VoiciName
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirror of apps/web/tests/webappLinkField.test.ts, plus the view model around it. */
class LinkFieldViewModelTest {
    private fun link(
        name: String? = null,
        held: Int = 0,
        limit: Int = 5,
        changesLeft: Int = 3,
        nextChangeAt: Long? = null,
        releasesAt: Long? = null,
    ) = AppLinkState(name, held, limit, changesLeft, nextChangeAt, releasesAt)

    private fun msg(
        typed: String = "halloween",
        current: String = "k3j9a2",
        link: AppLinkState = link(),
        check: VoiciNameCheck? = null,
        admin: Boolean = true,
    ) = LinkField.message(typed, current, link, check, admin, now = 0L, formatDate = { "D$it" })

    private fun status(s: String, domain: String? = null) = VoiciNameCheck(s, domain)

    // ---- the pure state function ----------------------------------------------------------

    @Test fun isReadOnlyForADeviceThatIsNotAnAdmin() {
        val m = msg(admin = false)
        assertEquals("Only an admin device can change this", m.text)
        assertFalse(m.canSave)
    }

    @Test fun saysNothingWhileTheFieldStillShowsTheCurrentLink() {
        val m = msg(typed = "k3j9a2")
        assertEquals("", m.text)
        assertFalse(m.canSave)
    }

    @Test fun checksTheGrammarBeforeAskingCom() {
        assertEquals("At least 4 characters", msg(typed = "ab").text)
        assertEquals("Letters, numbers and hyphens only", msg(typed = "a_b_c_d").text)
        assertEquals("At most 40 characters", msg(typed = "x".repeat(41)).text)
    }

    @Test fun offersSaveOnlyForAnAvailableName() {
        val ok = msg(check = status("available"))
        assertEquals(LinkField.Tone.Ok, ok.tone)
        assertTrue(ok.canSave)
        assertEquals("Taken", msg(check = status("taken")).text)
        assertFalse(msg(check = status("taken")).canSave)
        assertEquals("Reserved", msg(check = status("reserved")).text)
        assertEquals("Couldn't check halloween. Try again.", msg(check = status("error")).text)
        assertEquals("", msg(check = null).text)
    }

    @Test fun handsADibsNameToTheDomainProof() {
        val m = msg(check = status("dibs", "halloween.com"))
        assertEquals("Reserved for the owner of halloween.com", m.text)
        assertEquals(LinkField.Action.Dibs, m.action)
    }

    @Test fun offersToFreeOneUpWhenEveryNameIsInUseButNotForAReplace() {
        val full = msg(link = link(held = 5))
        assertEquals("All 5 names in use", full.text)
        assertEquals(LinkField.Action.FreeUp, full.action)
        assertTrue(msg(link = link(held = 5, name = "mine-now"), check = status("available")).canSave)
    }

    @Test fun showsTheNextChangeWhenTheServiceHasUsedItsChanges() {
        val m = msg(link = link(changesLeft = 0, nextChangeAt = 1_234L))
        assertEquals("Next change D1234", m.text)
        assertFalse(m.canSave)
    }

    @Test fun turnsEachRefusalIntoOneShortLine() {
        fun e(code: String, vararg data: Pair<String, Any>) = VoiciNameException(
            409, code,
            JsonObject(data.associate { (k, v) -> k to (if (v is Number) JsonPrimitive(v) else JsonPrimitive(v.toString())) }),
            code,
        )
        assertEquals("Taken", LinkField.refusalMessage(e("taken"), "x"))
        assertEquals("Too many changes today", LinkField.refusalMessage(e("rate-limited"), "x"))
        assertEquals("All 25 names in use", LinkField.refusalMessage(e("name-limit", "limit" to 25), "x"))
        assertEquals("Reserved for the owner of a.com", LinkField.refusalMessage(e("dibs", "domain" to "a.com"), "x"))
        assertEquals("Next change D99", LinkField.refusalMessage(e("change-limit", "nextChangeAt" to 99L), "x") { "D$it" })
        assertEquals("Couldn't save. Try again.", LinkField.refusalMessage(e("surprise"), "x"))
    }

    // ---- the view model ---------------------------------------------------------------------

    private val pair = Ed25519Sign.KeyPair.newKeyPair()

    private fun vm(client: MockVoiciNameClient, link: AppLinkState = link(), admin: Boolean = true): LinkFieldViewModel {
        val model = LinkFieldViewModel(
            client = client,
            username = { "Fresh-Poppy" },
            serviceId = "fresh-poppy--halloween",
            signer = { Ed25519Sign(pair.privateKey) },
            now = { 1_000L },
            randomBytes = { n -> ByteArray(n) { 7 } },
            debounceMs = 0,
            scopeOverride = CoroutineScope(Dispatchers.Unconfined),
        )
        client.link = link
        model.bind("k3j9a2", link, admin)
        return model
    }

    @Test fun startsOnTheRandomCodeAndTheCustomNameWhenThereIsOne() {
        assertEquals("k3j9a2", vm(MockVoiciNameClient()).typed.value)
        assertEquals("mine-now", vm(MockVoiciNameClient(), link(name = "mine-now")).typed.value)
    }

    @Test fun typingAnAvailableNameAsksComThenOffersSave() = runBlocking {
        val client = MockVoiciNameClient()
        val model = vm(client)
        model.onTyped("HalloweenParty")
        assertEquals("halloweenparty", model.typed.value)
        assertEquals(listOf("halloweenparty"), client.checks)
        assertTrue(model.message.value.canSave)
    }

    @Test fun aNameTheGrammarRefusesNeverReachesCom() = runBlocking {
        val client = MockVoiciNameClient()
        val model = vm(client)
        model.onTyped("ab")
        assertTrue(client.checks.isEmpty())
        assertEquals("At least 4 characters", model.message.value.text)
    }

    @Test fun aFailedCheckReadsAsCouldntCheck() = runBlocking {
        val client = MockVoiciNameClient().apply { checkError = RuntimeException("offline") }
        val model = vm(client)
        model.onTyped("halloween")
        assertEquals("Couldn't check halloween. Try again.", model.message.value.text)
        assertFalse(model.message.value.canSave)
    }

    @Test fun savesTheFirstNameWithoutAskingAndSignsTheOrder() = runBlocking {
        val client = MockVoiciNameClient()
        val model = vm(client)
        model.onTyped("halloweenparty")
        model.requestSave()

        assertNull(model.confirm.value)
        val body = client.saves.single()
        assertEquals("fresh-poppy", body.order.user)
        assertEquals("halloweenparty", body.order.name)
        assertEquals("set", body.order.op)
        assertEquals("07".repeat(32), body.order.nonce)
        val bytes = VoiciName.canonicalBytes(
            body.order.user, body.order.serviceId, body.order.name, body.order.op, body.order.issuedAt, body.order.nonce,
        )
        Ed25519Verify(pair.publicKey).verify(HexUtil.decode(body.signature)!!, bytes) // throws on mismatch
        assertEquals("halloweenparty", model.linkState.value.name)
        assertEquals("halloweenparty", model.typed.value)
        assertEquals(1, model.linkState.value.held)
    }

    @Test fun replacingALiveNameAsksFirstAndOnlyThenSaves() = runBlocking {
        val client = MockVoiciNameClient()
        val model = vm(client, link(name = "mine-now", held = 1))
        model.onTyped("halloweenparty")
        model.requestSave()

        assertTrue(client.saves.isEmpty())
        assertEquals("mine-now", model.confirm.value?.replacing)
        model.dismissConfirm()
        assertTrue(client.saves.isEmpty())

        model.requestSave()
        model.confirmPending()
        assertEquals("halloweenparty", client.saves.single().order.name)
        assertNull(model.confirm.value)
    }

    @Test fun useDefaultClearsAfterTheConfirm() = runBlocking {
        val client = MockVoiciNameClient()
        val model = vm(client, link(name = "mine-now", held = 1, releasesAt = 5L))
        assertTrue(model.canUseDefault.value)
        model.requestClear()
        assertTrue(client.saves.isEmpty())
        model.confirmPending()

        val order = client.saves.single().order
        assertEquals("clear", order.op)
        assertEquals("", order.name)
        assertNull(model.linkState.value.name)
        assertEquals("k3j9a2", model.typed.value)
        assertFalse(model.canUseDefault.value)
    }

    @Test fun aRefusalFromSaveShowsItsLineAndKeepsTheLink() = runBlocking {
        val client = MockVoiciNameClient().apply {
            saveError = VoiciNameException(409, "taken", JsonObject(emptyMap()), "taken")
        }
        val model = vm(client)
        model.onTyped("halloweenparty")
        model.requestSave()
        assertEquals("Taken", model.message.value.text)
        assertEquals(LinkField.Tone.Bad, model.message.value.tone)
        assertNull(model.linkState.value.name)
        assertFalse(model.busy.value)
    }

    @Test fun freeOneUpListsTheNamesAndUseDefaultFreesAnotherServicesName() = runBlocking {
        val client = MockVoiciNameClient().apply {
            names += VoiciNameEntry("fresh-poppy--other", "other-name", 1)
        }
        val model = vm(client, link(held = 5, limit = 5))
        model.onTyped("halloweenparty")
        assertEquals(LinkField.Action.FreeUp, model.message.value.action)

        model.openFreeUp()
        val entry = model.freeUp.value!!.single()
        model.requestClear(entry)
        assertEquals("other-name", model.confirm.value?.replacing)
        model.confirmPending()

        val sent = client.saves.single()
        assertEquals("fresh-poppy--other", sent.order.serviceId)
        assertEquals("clear", sent.order.op)
        assertEquals(4, model.linkState.value.held)
        assertNull(model.freeUp.value)
    }

    @Test fun aNonAdminCannotSave() = runBlocking {
        val client = MockVoiciNameClient()
        val model = vm(client, admin = false)
        model.onTyped("halloweenparty")
        assertTrue(client.checks.isEmpty())
        model.requestSave()
        assertTrue(client.saves.isEmpty())
        assertEquals("Only an admin device can change this", model.message.value.text)
    }
}
