package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AccountDirectoryDevice
import com.flagshipserver.app.api.AccountDirectoryManagedProfile
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.AccountDirectorySelfProfile
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AccountMetadataCoordinates
import com.flagshipserver.app.core.AccountMetadataRecordType
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AccountDeviceNamesTest {
    private val user = "jolly-ranger"
    private val umk = ByteArray(32) { 0x21 }
    private val key = AccountMetadata.deriveDeviceDirectoryKey(umk)
    private val phone = "00112233445566778899aabbccddeeff"
    private val tablet = "ffeeddccbbaa99887766554433221100"
    private val laptop = "0f0e0d0c0b0a09080706050403020100"

    private fun device(id: String, platform: String, revokedAt: Long? = null) =
        AccountDirectoryDevice(user, id, "aa".repeat(32), platform, 1, 1, revokedAt, "AB12")

    private fun self(id: String, name: String): AccountDirectorySelfProfile {
        val c = AccountMetadata.encrypt(name, key, AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_SELF_PROFILE, 1, 1, id))
        return AccountDirectorySelfProfile(user, id, 1, 1, c.nonceHex, c.ciphertextHex, "", "", 1, 1)
    }

    private fun managed(id: String, name: String): AccountDirectoryManagedProfile {
        val c = AccountMetadata.encrypt(name, key, AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_MANAGED_PROFILE, 2, 1, id))
        return AccountDirectoryManagedProfile(user, id, 2, 1, c.nonceHex, c.ciphertextHex, false, "", "", 1, 1)
    }

    @Before fun setUp() {
        Keystore.attachForTest(ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("device-names-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
        AccountDeviceNames.clear()
    }

    private fun directory() = AccountDirectoryResponse(
        accountId = user,
        devices = listOf(device(phone, "android"), device(tablet, "ios", revokedAt = 5), device(laptop, "web")),
        selfProfiles = listOf(self(phone, "Erica's phone"), self(tablet, "Old iPad")),
        managedProfiles = listOf(managed(tablet, "Kitchen iPad")),
    )

    @Test fun namesComeFromTheDirectoryTheOwnerNameWinning() {
        val names = AccountDeviceNames.names(directory(), user, umk)
        assertEquals("Erica's phone", names[phone])
        assertEquals("Kitchen iPad", names[tablet])
        assertEquals("Web browser · Device AB12", names[laptop])
    }

    @Test fun loadReadsTheDirectoryOnce_andAnUnreadableOneGivesNoNames() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        server.shouldFail = true
        assertNull(AccountDeviceNames.load(server, user, phone, umk = { umk }))
        assertNull(AccountDeviceNames.load(server, user, "short", umk = { umk }))
        server.shouldFail = false
        server.accountDirectories = mapOf(user to directory())
        assertEquals("Kitchen iPad", AccountDeviceNames.load(server, user, phone, umk = { umk })?.get(tablet))
        server.shouldFail = true
        assertEquals("cached", "Erica's phone", AccountDeviceNames.load(server, user, phone, umk = { umk })?.get(phone))
    }
}
