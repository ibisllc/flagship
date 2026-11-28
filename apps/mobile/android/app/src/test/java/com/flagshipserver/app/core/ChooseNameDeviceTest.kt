// "Choose your own account name" on the device: the Keystore profile moves to the new name with its sealed seeds
// opened again under their new slot, and the screen's sentences are the spec's exact English.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.PqSessionKek
import com.flagshipserver.app.ui.screens.NameChoiceCopy
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChooseNameDeviceTest {
    private lateinit var ctx: Context

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        FSStrings.init(ctx)
        Keystore.attachForTest(ctx.getSharedPreferences("choose-name-keystore", Context.MODE_PRIVATE).also { it.edit().clear().commit() })
        PqSessionKek.openForTest(ByteArray(32) { 7 })
    }

    @After fun tearDown() {
        PqSessionKek.openForTest(null)
        Keystore.setActiveProfile(null)
    }

    @Test fun theKeystoreProfileMovesToTheNewName() {
        Keystore.setActiveProfile("plucky-avocet")
        val umk = Keystore.loadOrCreateUmkSeed().copyOf()
        val rootPub = Keystore.generateAdminRoot()
        val root = Keystore.adminRootSeed()!!.copyOf()
        val deviceId = "a".repeat(32)
        Keystore.storeAccountDeviceId(deviceId)
        val oldKey = AccountMetadata.deriveAccountDevicePub(umk, "plucky-avocet", deviceId)
        assertTrue(Keystore.seedsAreSealed())

        Keystore.moveProfile("plucky-avocet", "bob")
        assertEquals("bob", Keystore.activeProfile())
        assertArrayEquals(umk, Keystore.currentUmkSeed())
        assertArrayEquals(root, Keystore.adminRootSeed())
        assertEquals(rootPub, Keystore.adminRootPubHex())
        assertEquals(deviceId, Keystore.accountDeviceId())

        // The device key `.com` registered (derived from the old name) is kept under the new one.
        Keystore.storeAccountDeviceSeed(deviceId, AccountMetadata.deriveAccountDeviceSeed(umk, "plucky-avocet", deviceId))
        assertArrayEquals(oldKey, Keystore.accountDevicePublicKey(umk, "bob", deviceId))

        // Nothing is left under the old name, and a second move changes nothing.
        Keystore.setActiveProfile("plucky-avocet")
        assertFalse(Keystore.hasUmkSeed())
        Keystore.setActiveProfile("bob")
        Keystore.moveProfile("plucky-avocet", "bob")
        assertArrayEquals(umk, Keystore.currentUmkSeed())
    }

    @Test fun aNameGrantLinkRoutesToTheChooseScreen() {
        val link = DeepLink.parse(android.net.Uri.parse("https://${Endpoints.controlHost}/app/choose-name#n=bob&g=ABCD-EFGH&e=1800000000000&f=1"))
        assertEquals(DeepLink.ChooseName(NameGrant("bob", "ABCD-EFGH", 1_800_000_000_000, true)), link)
        val damaged = DeepLink.parse(android.net.Uri.parse("https://${Endpoints.controlHost}/app/choose-name#n=bob"))
        assertEquals(DeepLink.ChooseName(null), damaged)
    }

    @Test fun theSentencesAreTheSpecsEnglish() {
        assertEquals("Taken or too similar to an existing name", NameChoiceCopy.text(NameChoiceNotice.Taken))
        assertEquals("That voucher code isn't valid for an account name.", NameChoiceCopy.text(NameChoiceNotice.CodeInvalid))
        assertEquals("That voucher code was already used.", NameChoiceCopy.text(NameChoiceNotice.CodeUsed))
        assertEquals("Payment cancelled. Your account keeps the name plucky-avocet.", NameChoiceCopy.text(NameChoiceNotice.PaymentCancelled("plucky-avocet")))
        assertEquals("The payment didn't go through. Your account keeps the name plucky-avocet.", NameChoiceCopy.text(NameChoiceNotice.PaymentFailed("plucky-avocet")))
        assertEquals(
            "The name change didn't go through. Your account keeps the name plucky-avocet, and your \$10 stays in your account as vouchers.",
            NameChoiceCopy.text(NameChoiceNotice.FailedVouchers("plucky-avocet")),
        )
        assertEquals(
            "The name change didn't go through. Your account keeps the name plucky-avocet, and your voucher code still works.",
            NameChoiceCopy.text(NameChoiceNotice.FailedCode("plucky-avocet")),
        )
        assertTrue(NameChoiceCopy.text(NameChoiceNotice.Held("google", "google.com", 1_800_000_000_000)).startsWith("Held for the owner of google.com until "))
        assertEquals("Held for the owner of cloudflare.com.", NameChoiceCopy.text(NameChoiceNotice.Held("clou-dflare", "cloudflare.com", null)))
        assertEquals(
            "Couldn't check acme.com just now. Try again in a minute.",
            NameChoiceCopy.held("acme.com", 1_800_000_000_000, checked = false),
        )
        assertTrue(NameChoiceCopy.rule(null).startsWith("For a limited time, a Flagship name that matches a registered .com"))
        assertTrue(NameChoiceCopy.rule(1_800_000_000_000).startsWith("Until "))
        assertEquals("https://flagshipserver.com/dibs", NameChoiceCopy.dibsPage(java.util.Locale.ENGLISH))
        assertEquals("https://flagshipserver.com/pt-br/dibs", NameChoiceCopy.dibsPage(java.util.Locale.forLanguageTag("pt-BR")))
        assertEquals("https://flagshipserver.com/zh-hans/dibs", NameChoiceCopy.dibsPage(java.util.Locale.forLanguageTag("zh-Hans-CN")))
        assertEquals("This link has expired. Ask for a new one.", NameChoiceCopy.text(NameChoiceNotice.GrantExpired))
        assertEquals("This link doesn't work any more. Ask for a new one.", NameChoiceCopy.text(NameChoiceNotice.GrantInvalid))
        // An existing account opening a name-grant link (RootShell).
        assertEquals("Open this link when you create your account.", FSStrings.get(com.flagshipserver.app.R.string.choose_name_open_when_creating))
        assertEquals("Your account is now bob.", FSStrings.get(com.flagshipserver.app.R.string.choose_name_done, "bob"))
    }
}
