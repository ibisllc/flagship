// "Choose your own account name" (core/AccountNameChoice.kt): the flow against a fake `.com` that speaks the rename's
// refusal codes (packages/control-plane/src/nameChange.ts, nameGrant.ts), the crash record and its resume, and the
// name-grant link.

package com.flagshipserver.app.core

import com.flagshipserver.app.viewmodels.CreatedAccount
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChooseNameFlowTest {
    private class FakeCom(var balance: Int = 0) : NameChoiceOps {
        val calls = mutableListOf<String>()
        var owner = mutableMapOf<String, Boolean?>()
        var quoteRefusal: NameQuote.Refused? = null
        var quotePaid = false
        var renameRefusal: String? = null
        var renameTimesOut = false
        var renamed: String? = null
        var pack: PackOutcome = PackOutcome.Bought
        var vouchersSpent = 0
        var codeUsed: String? = null
        var lastGrant: NameGrant? = null
        var storeAtPq: PendingNameChoice? = null
        lateinit var store: PendingNameChoiceStore

        override suspend fun createAccount(suggested: String): CreatedAccount {
            calls += "create:$suggested"
            return CreatedAccount(suggested, "d".repeat(32), "grant-1", "Plucky Avocet", "Pixel")
        }
        override suspend fun quote(oldName: String, newName: String, grant: NameGrant?): NameQuote {
            calls += "quote:$newName"
            lastGrant = grant
            return quoteRefusal ?: NameQuote.Available(10, paid = quotePaid)
        }
        override suspend fun walletBalance() = balance
        override suspend fun buyPack(units: Int): PackOutcome {
            calls += "buy:$units"
            if (pack == PackOutcome.Bought) balance += units
            return pack
        }
        override suspend fun rename(oldName: String, newName: String, payment: NameChoicePayment, units: Int, grant: NameGrant?) {
            calls += "rename:$newName:${payment::class.simpleName}"
            assertNotNull("the crash record is written before the rename", store.get())
            if (renameTimesOut) throw java.io.IOException("timeout")
            renameRefusal?.let { throw NameChangeRefused(it) }
            when (payment) {
                NameChoicePayment.Card -> { balance -= units; vouchersSpent += units }
                is NameChoicePayment.Code -> codeUsed = payment.code
                NameChoicePayment.Granted -> Unit
            }
            renamed = newName
        }
        override suspend fun ownsName(name: String): Boolean? = if (name in owner) owner[name] else name == renamed
        override suspend fun settle(p: PendingNameChoice) { calls += "settle:${p.oldName}>${p.newName}" }
        override suspend fun onboard(name: String, previous: String?, account: CreatedAccount) {
            calls += "onboard:$name" + (previous?.let { "<$it" } ?: "")
        }
        override fun bindPq() {
            calls += "pq"
            storeAtPq = store.get()
        }
    }

    private fun flow(com: FakeCom, store: PendingNameChoiceStore = MemoryPendingNameChoiceStore(), grant: NameGrant? = null): ChooseNameFlow {
        com.store = store
        return ChooseNameFlow("plucky-avocet", com, grant, store) { "grant-2" }
    }

    @Test fun payWithCardBuysThePackRenamesAndOnlyThenBindsPq() = runBlocking {
        val com = FakeCom()
        val store = MemoryPendingNameChoiceStore()
        val f = flow(com, store)
        f.submit("Bob", NameChoicePayment.Card)
        assertEquals(ChooseNameFlow.Phase.Done("bob"), f.phase.value)
        assertEquals(10, com.vouchersSpent)
        assertEquals(PendingNameChoice.SETTLED, store.get()!!.stage)
        assertFalse("no PQ binding before the account opens", "pq" in com.calls)
        f.open()
        assertEquals(ChooseNameFlow.Phase.Opened, f.phase.value)
        assertEquals(
            listOf("create:plucky-avocet", "quote:bob", "buy:10", "rename:bob:Card", "settle:plucky-avocet>bob", "onboard:bob", "pq"),
            com.calls,
        )
        assertNull("the PQ binding runs only once no choice is pending", com.storeAtPq)
        assertNull(store.get())
    }

    @Test fun vouchersAlreadyInTheWalletAreUsedWithoutBuyingAgain() = runBlocking {
        val com = FakeCom(balance = 10)
        val f = flow(com)
        f.submit("bob", NameChoicePayment.Card)
        assertEquals(ChooseNameFlow.Phase.Done("bob"), f.phase.value)
        assertFalse(com.calls.any { it.startsWith("buy") })
    }

    @Test fun aVoucherCodePays() = runBlocking {
        val com = FakeCom()
        val f = flow(com)
        f.submit("bob", NameChoicePayment.Code("  ABCD-EFGH "))
        assertEquals(ChooseNameFlow.Phase.Done("bob"), f.phase.value)
        assertEquals("ABCD-EFGH", com.codeUsed)
        assertFalse(com.calls.any { it.startsWith("buy") })
    }

    @Test fun aTakenNameStaysOnTheScreenWithTheAccountCreated() = runBlocking {
        val com = FakeCom().apply { quoteRefusal = NameQuote.Refused("taken") }
        val f = flow(com)
        f.submit("bob", NameChoicePayment.Card)
        assertEquals(ChooseNameFlow.Phase.Editing, f.phase.value)
        assertEquals(NameChoiceNotice.Taken, f.notice.value)
        assertEquals("plucky-avocet", f.account.value!!.username)
        assertFalse(com.calls.any { it.startsWith("buy") || it.startsWith("rename") })
        // Keep plucky-avocet: the account opens under the suggested name, then binds.
        f.open()
        assertEquals(listOf("onboard:plucky-avocet", "pq"), com.calls.takeLast(2))
        // Another try does not create a second account.
        assertEquals(1, com.calls.count { it.startsWith("create") })
    }

    @Test fun aHeldNameSaysWhoseAndUntilWhen() = runBlocking {
        val com = FakeCom().apply { quoteRefusal = NameQuote.Refused("dibs-held", heldUntil = 1_800_000_000_000) }
        val f = flow(com)
        f.submit("google", NameChoicePayment.Card)
        assertEquals(NameChoiceNotice.Held("google", 1_800_000_000_000), f.notice.value)
    }

    @Test fun aBadOrUsedCodeLetsThePersonFixIt() = runBlocking {
        val com = FakeCom().apply { renameRefusal = "code-invalid" }
        val store = MemoryPendingNameChoiceStore()
        val f = flow(com, store)
        f.submit("bob", NameChoicePayment.Code("NOPE"))
        assertEquals(NameChoiceNotice.CodeInvalid, f.notice.value)
        assertEquals(ChooseNameFlow.Phase.Editing, f.phase.value)
        assertNull(store.get())
        com.renameRefusal = "code-wrong-kind"
        f.submit("bob", NameChoicePayment.Code("NOPE"))
        assertEquals(NameChoiceNotice.CodeInvalid, f.notice.value)
        com.renameRefusal = "code-used"
        f.submit("bob", NameChoicePayment.Code("USED"))
        assertEquals(NameChoiceNotice.CodeUsed, f.notice.value)
    }

    @Test fun aRefusedRenameKeepsTheSuggestedNameAndThePayment() = runBlocking {
        val com = FakeCom().apply { renameRefusal = "rename-failed" }
        val store = MemoryPendingNameChoiceStore()
        val f = flow(com, store)
        f.submit("bob", NameChoicePayment.Card)
        assertEquals(NameChoiceNotice.FailedVouchers("plucky-avocet"), f.notice.value)
        assertEquals(10, com.balance) // bought, not spent: the $10 stays as vouchers
        assertEquals("plucky-avocet", f.account.value!!.username)
        assertNull(store.get())
        f.submit("bob", NameChoicePayment.Code("CODE"))
        assertEquals(NameChoiceNotice.FailedCode("plucky-avocet"), f.notice.value)
    }

    @Test fun aCancelledOrFailedPurchaseKeepsTheSuggestedName() = runBlocking {
        val com = FakeCom().apply { pack = PackOutcome.Cancelled }
        val f = flow(com)
        f.submit("bob", NameChoicePayment.Card)
        assertEquals(NameChoiceNotice.PaymentCancelled("plucky-avocet"), f.notice.value)
        com.pack = PackOutcome.Failed
        f.submit("bob", NameChoicePayment.Card)
        assertEquals(NameChoiceNotice.PaymentFailed("plucky-avocet"), f.notice.value)
        assertFalse(com.calls.any { it.startsWith("rename") })
    }

    @Test fun aNameWithAFormatProblemIsCheckedLocally() = runBlocking {
        val com = FakeCom()
        val f = flow(com)
        f.submit("-bob", NameChoicePayment.Card)
        assertEquals(NameChoiceNotice.Problem(VoiciName.Problem.Hyphens), f.notice.value)
        assertTrue(com.calls.isEmpty())
    }

    @Test fun aLostAnswerAfterARenameThatHappenedStillFinishes() = runBlocking {
        val com = FakeCom().apply { renameTimesOut = true; owner["bob"] = true }
        val f = flow(com)
        f.submit("bob", NameChoicePayment.Card)
        assertEquals(ChooseNameFlow.Phase.Done("bob"), f.phase.value)
        assertTrue("settle:plucky-avocet>bob" in com.calls)
    }

    @Test fun resumeFinishesARenameDotComMade() = runBlocking {
        val store = MemoryPendingNameChoiceStore(
            PendingNameChoice("plucky-avocet", "bob", "d".repeat(32), "grant-1", "grant-2", "Bob", "Pixel"),
        )
        val com = FakeCom().apply { owner["bob"] = true; this.store = store }
        assertEquals("bob", ChooseNameFlow.resume(store, com))
        assertEquals(listOf("settle:plucky-avocet>bob", "onboard:bob<plucky-avocet", "pq"), com.calls)
        assertNull(store.get())
        assertNull(com.storeAtPq)
    }

    @Test fun resumeDropsARenameThatNeverHappened() = runBlocking {
        val store = MemoryPendingNameChoiceStore(
            PendingNameChoice("plucky-avocet", "bob", "d".repeat(32), "grant-1", "grant-2", "Bob", "Pixel"),
        )
        val com = FakeCom().apply { owner["bob"] = false; this.store = store }
        assertNull(ChooseNameFlow.resume(store, com))
        assertTrue(com.calls.isEmpty())
        assertNull(store.get())
    }

    @Test fun resumeWaitsWhenDotComCantBeAsked() = runBlocking {
        val p = PendingNameChoice("plucky-avocet", "bob", "d".repeat(32), "grant-1", "grant-2", "Bob", "Pixel")
        val store = MemoryPendingNameChoiceStore(p)
        val com = FakeCom().apply { owner["bob"] = null; this.store = store }
        assertNull(ChooseNameFlow.resume(store, com))
        assertEquals(p, store.get())
    }

    @Test fun aPendingChoiceGuardsBothNames() {
        val saved = AccountNameChoice.store
        try {
            AccountNameChoice.store = MemoryPendingNameChoiceStore(
                PendingNameChoice("plucky-avocet", "bob", "d".repeat(32), "grant-1", "grant-2", "Bob", "Pixel"),
            )
            assertTrue(AccountNameChoice.pendingFor("Plucky-Avocet"))
            assertTrue(AccountNameChoice.pendingFor("bob"))
            assertFalse(AccountNameChoice.pendingFor("alice"))
            // The old name's 404 is not "This account was removed" while the choice is pending.
            val own = AccountGone.ownNames
            AccountGone.ownNames = { listOf("plucky-avocet") }
            assertFalse(AccountGone.note("/api/users/plucky-avocet/pods", 404) { AccountGone.responseBody() })
            assertFalse(AccountGone.isGone)
            AccountGone.ownNames = own
            // And the PQ upgrade waits.
            assertTrue(com.flagshipserver.app.keystore.PqIdentityUpgrade.choosingName())
        } finally {
            AccountNameChoice.store = saved
        }
    }

    // ---- name grants ----

    @Test fun aGrantLinkParses() {
        val g = NameGrant.parseFragment("n=Bob&g=ABCD-EFGH-JKLM&e=1800000000000&f=1")!!
        assertEquals(NameGrant("bob", "ABCD-EFGH-JKLM", 1_800_000_000_000, true), g)
        assertFalse(NameGrant.parseFragment("n=bob&g=X&e=1800000000000")!!.free)
        assertNull(NameGrant.parseFragment("n=-bob&g=X&e=1"))
        assertNull(NameGrant.parseFragment("n=bob&e=1"))
        assertNull(NameGrant.parseFragment("n=bob&g=X&e=soon"))
        assertNull(NameGrant.parseFragment(null))
        assertEquals("NameGrant(bob)", g.toString())
    }

    @Test fun aFreeGrantNeedsNoPayment() = runBlocking {
        val grant = NameGrant("bob", "CODE", 1_800_000_000_000, free = true)
        val com = FakeCom().apply { quotePaid = true }
        val f = flow(com, grant = grant)
        f.submit("bob", NameChoicePayment.Granted)
        assertEquals(ChooseNameFlow.Phase.Done("bob"), f.phase.value)
        assertEquals(grant, com.lastGrant)
        assertTrue("rename:bob:Granted" in com.calls)
        assertFalse(com.calls.any { it.startsWith("buy") })
        assertEquals(0, com.vouchersSpent)
    }

    @Test fun aGrantForAnotherNameIsNotSent() = runBlocking {
        val com = FakeCom()
        val f = flow(com, grant = NameGrant("bob", "CODE", 1_800_000_000_000, free = false))
        f.submit("alice", NameChoicePayment.Card)
        assertNull(com.lastGrant)
    }

    @Test fun anExpiredOrUsedGrantSaysSo() = runBlocking {
        val grant = NameGrant("bob", "CODE", 1, free = true)
        val com = FakeCom().apply { quoteRefusal = NameQuote.Refused("grant-expired") }
        val f = flow(com, grant = grant)
        f.submit("bob", NameChoicePayment.Granted)
        assertEquals(NameChoiceNotice.GrantExpired, f.notice.value)
        com.quoteRefusal = NameQuote.Refused("grant-used")
        f.submit("bob", NameChoicePayment.Granted)
        assertEquals(NameChoiceNotice.GrantInvalid, f.notice.value)
        com.quoteRefusal = NameQuote.Refused("grant-invalid")
        f.submit("bob", NameChoicePayment.Granted)
        assertEquals(NameChoiceNotice.GrantInvalid, f.notice.value)
    }
}
