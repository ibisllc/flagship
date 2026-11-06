// A sample account's example page, read only (VoiciDemoPage): the device holds none of the account's keys, reads the
// page `.com` serves like a visitor, checks it against the account's own key, and signs or stores nothing.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class OperatorKeyring(private val umk: ByteArray, private val root: ByteArray) : VoiciKeyring {
    override fun username() = "sample-ash"
    override fun umk() = umk
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = true
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String) = root to "admin-root"
    override fun device() = VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(VoiciJs.edPub(ByteArray(32) { 7 })), Ed25519Sign(ByteArray(32) { 7 }))
    override suspend fun confirm(reason: String) {}
    override fun displayName() = "sample-ash"
}

/** A device that opened the sample account: no username for the owner path, no UMK, no keys. */
private object SampleDeviceKeyring : VoiciKeyring {
    override fun username(): String? = null
    override fun umk(): ByteArray? = null
    override fun holdsSensitiveKey(account: VoiciAccountKeys) = false
    override fun sensitiveNeedsPrompt() = false
    override suspend fun sensitiveSeed(reason: String): Pair<ByteArray, String> = error("a sample device signs nothing")
    override fun device(): VoiciDeviceSigner? = null
    override suspend fun confirm(reason: String) = error("a sample device signs nothing")
    override fun displayName() = ""
}

class VoiciDemoPageTest {
    private val root = ByteArray(32) { 2 }
    private val rootPub = VoiciJs.hex(VoiciJs.edPub(root))
    private val avatar = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 1, 2, 3)

    private fun center(mock: MockVoiciClient, k: VoiciKeyring) =
        VoiciCenter(mock, k, VoiciVault(MemoryVoiciVaultStore()), { listOf(mock.caPub) }, scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))

    /** The operator's example page (what `.com` publishes for a sample account). */
    private suspend fun operatorPublishes(mock: MockVoiciClient) {
        val op = center(mock, OperatorKeyring(ByteArray(32) { 1 }, root))
        op.refresh()
        val sha = requireNotNull(op.putImage(avatar))
        op.edit("profile", profile = VoiciOwner.defaultProfile("sample-ash").copy(bio = "An example page of a sample account.", avatar = sha))
        op.edit("post-add", post = VoiciPost(VoiciOwner.randomHex(16), 1_000, null, "Hello from an example page.", emptyList()))
        op.acceptRules()
        assertTrue(op.publish("operator"))
    }

    private fun mock() = MockVoiciClient().also { it.accounts["sample-ash"] = VoiciAccountKeys("ee".repeat(32), rootPub) }

    @Test fun readsTheExamplePageWithoutAnyAccountKey() = runBlocking {
        val mock = mock()
        operatorPublishes(mock)
        val published = mock.publishCount
        val c = center(mock, SampleDeviceKeyring)
        c.refreshDemoPage("Sample-Ash")
        val d = c.demoPage.value
        assertNotNull(d)
        d!!
        assertEquals("sample-ash", d.username)
        assertTrue(d.checked)
        assertTrue(d.isPublic)
        assertEquals("sample-ash", d.displayName)
        assertEquals("An example page of a sample account.", d.profile?.bio)
        assertArrayEquals(avatar, d.avatar)
        assertEquals("nothing is published from the device", published, mock.publishCount)
        assertEquals("the owner page stays empty", "", c.page.value.username)
    }

    @Test fun noPageReadsAsNotPublic() = runBlocking {
        val d = VoiciDemoPage.load(mock(), "sample-ash")!!
        assertTrue(d.checked)
        assertFalse(d.isPublic)
        assertNull(d.profile)
        assertEquals("sample-ash", d.displayName)
    }

    @Test fun aPageNotSignedByTheAccountKeyIsNotShown() = runBlocking {
        val mock = mock()
        operatorPublishes(mock)
        mock.accounts["sample-ash"] = VoiciAccountKeys("ee".repeat(32), "ab".repeat(32))
        val d = VoiciDemoPage.load(mock, "sample-ash")!!
        assertTrue(d.checked)
        assertFalse(d.isPublic)
        assertNull(d.profile)
    }

    @Test fun anUnknownAccountIsAFailedRead() = runBlocking {
        assertNull(VoiciDemoPage.load(MockVoiciClient(), "nobody"))
    }
}
