package com.flagshipserver.app.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AccountMetadataTest {
    private val umk = ByteArray(32) { it.toByte() }
    private val nonce = ByteArray(12) { (0xa0 + it).toByte() }

    @Test
    fun `matches account metadata golden vectors`() {
        val accountKey = AccountMetadata.deriveAccountProfileKey(umk)
        assertEquals(
            "6704c17878d90b3c9767fecbcbc969c55c4683674c76a6e5f7143fc2f2b5b674",
            HexUtil.encode(accountKey),
        )
        assertEquals(
            "0f64692831c58829479951cca532646137a61c168b9ec9f079bb121694ba0d7f",
            HexUtil.encode(AccountMetadata.deriveDeviceDirectoryKey(umk)),
        )
        val coordinates = AccountMetadataCoordinates(
            accountId = "jolly-ranger",
            recordType = AccountMetadataRecordType.ACCOUNT_PROFILE,
            revision = 1,
            keyVersion = 1,
        )
        val encrypted = AccountMetadata.encrypt(" Johnson Family ", accountKey, coordinates, nonce)
        assertEquals("a0a1a2a3a4a5a6a7a8a9aaab", encrypted.nonceHex)
        assertEquals(
            "a33dbbf36474c8cc0eacb0333f89e5d3c9067a7e37cc4f6c105e74901e86d71ac10dbb14587035116edd016459679ca1dfdffeb23e71bf15f9b95238",
            encrypted.ciphertextHex,
        )
        assertEquals("Johnson Family", AccountMetadata.decrypt(encrypted, accountKey, coordinates))
    }

    @Test
    fun `AAD rejects account device and record swaps`() {
        val key = AccountMetadata.deriveDeviceDirectoryKey(umk)
        val coordinates = AccountMetadataCoordinates(
            accountId = "jolly-ranger",
            deviceId = "00112233445566778899aabbccddeeff",
            recordType = AccountMetadataRecordType.DEVICE_SELF_PROFILE,
            revision = 1,
            keyVersion = 1,
        )
        val encrypted = AccountMetadata.encrypt("Erica", key, coordinates, nonce)
        assertThrows(Exception::class.java) {
            AccountMetadata.decrypt(encrypted, key, coordinates.copy(accountId = "other-account"))
        }
        assertThrows(Exception::class.java) {
            AccountMetadata.decrypt(
                encrypted,
                key,
                coordinates.copy(recordType = AccountMetadataRecordType.DEVICE_MANAGED_PROFILE),
            )
        }
        assertArrayEquals(key, AccountMetadata.deriveDeviceDirectoryKey(umk))
    }

    @Test
    fun `validates international grapheme names`() {
        assertEquals("José 👨‍👩‍👧", AccountMetadata.validateDisplayName("  Jose\u0301 👨‍👩‍👧  "))
        assertThrows(IllegalArgumentException::class.java) { AccountMetadata.validateDisplayName("unsafe\nname") }
        assertThrows(IllegalArgumentException::class.java) { AccountMetadata.validateDisplayName("unsafe\u202ename") }
    }
}
