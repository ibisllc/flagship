package com.flagshipserver.app.burner.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the exact byte layout of the USB Mass Storage Bulk-Only Transport
 * wrappers + SCSI CDBs. The two endiannesses (LE wrapper, BE SCSI) are the
 * classic bug source, so both are asserted.
 */
class ScsiCommandsTest {
    @Test
    fun cbwHasCorrectLayoutAndLittleEndianFields() {
        val cdb = ScsiCommands.cdbWrite10(lba = 0x01020304L, blocks = 0x0506)
        val cbw = ScsiCommands.buildCbw(
            tag = 0x11223344,
            dataLength = 0x00ABCDEF,
            flagsIn = false,
            lun = 0,
            cdb = cdb,
        )
        assertEquals(31, cbw.size)
        // dCBWSignature "USBC" little-endian (0x43425355) → 55 53 42 43
        assertEquals(0x55, cbw[0].toInt() and 0xFF)
        assertEquals(0x53, cbw[1].toInt() and 0xFF)
        assertEquals(0x42, cbw[2].toInt() and 0xFF)
        assertEquals(0x43, cbw[3].toInt() and 0xFF)
        // dCBWTag little-endian (0x11223344) → 44 33 22 11
        assertEquals(0x44, cbw[4].toInt() and 0xFF)
        assertEquals(0x33, cbw[5].toInt() and 0xFF)
        assertEquals(0x22, cbw[6].toInt() and 0xFF)
        assertEquals(0x11, cbw[7].toInt() and 0xFF)
        // dCBWDataTransferLength little-endian (0x00ABCDEF) → EF CD AB 00
        assertEquals(0xEF, cbw[8].toInt() and 0xFF)
        assertEquals(0xCD, cbw[9].toInt() and 0xFF)
        assertEquals(0xAB, cbw[10].toInt() and 0xFF)
        assertEquals(0x00, cbw[11].toInt() and 0xFF)
        // bmCBWFlags OUT = 0x00
        assertEquals(0x00, cbw[12].toInt() and 0xFF)
        assertEquals(0x00, cbw[13].toInt() and 0xFF) // LUN 0
        assertEquals(10, cbw[14].toInt() and 0xFF) // WRITE(10) CDB length
        // CDB copied at offset 15.
        val cdbInCbw = cbw.copyOfRange(15, 15 + 10)
        assertArrayEquals(cdb, cdbInCbw)
    }

    @Test
    fun cbwInFlagSet() {
        val cbw = ScsiCommands.buildCbw(1, 36, flagsIn = true, lun = 0, cdb = ScsiCommands.cdbInquiry())
        assertEquals(0x80, cbw[12].toInt() and 0xFF)
    }

    @Test
    fun write10IsBigEndian() {
        val cdb = ScsiCommands.cdbWrite10(lba = 0x01020304L, blocks = 0x0506)
        assertEquals(10, cdb.size)
        assertEquals(ScsiCommands.OP_WRITE_10, cdb[0].toInt() and 0xFF)
        // LBA big-endian at bytes 2..5
        assertEquals(0x01, cdb[2].toInt() and 0xFF)
        assertEquals(0x02, cdb[3].toInt() and 0xFF)
        assertEquals(0x03, cdb[4].toInt() and 0xFF)
        assertEquals(0x04, cdb[5].toInt() and 0xFF)
        // transfer length big-endian at bytes 7..8
        assertEquals(0x05, cdb[7].toInt() and 0xFF)
        assertEquals(0x06, cdb[8].toInt() and 0xFF)
    }

    @Test
    fun read10ReusesLayoutWithReadOpcode() {
        val cdb = ScsiCommands.cdbRead10(lba = 5, blocks = 2)
        assertEquals(ScsiCommands.OP_READ_10, cdb[0].toInt() and 0xFF)
        assertEquals(5, ScsiCommands.getBeU32(cdb, 2))
    }

    @Test
    fun inquiryAllocLengthBigEndian() {
        val cdb = ScsiCommands.cdbInquiry(0x1234)
        assertEquals(ScsiCommands.OP_INQUIRY, cdb[0].toInt() and 0xFF)
        assertEquals(0x12, cdb[3].toInt() and 0xFF)
        assertEquals(0x34, cdb[4].toInt() and 0xFF)
    }

    @Test
    fun testUnitReadyAllZeroExceptOpcode() {
        val cdb = ScsiCommands.cdbTestUnitReady()
        assertEquals(6, cdb.size)
        assertEquals(0, cdb[0].toInt() and 0xFF)
        for (i in 1 until 6) assertEquals(0, cdb[i].toInt() and 0xFF)
    }

    @Test
    fun readCapacityParsesBigEndian() {
        // lastLBA = 0x00100000 (1,048,576), blockSize = 512 (0x00000200)
        val data = byteArrayOf(0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00)
        val cap = ScsiCommands.parseCapacity10(data)
        assertEquals(0x00100000L, cap.lastLba)
        assertEquals(512, cap.blockSize)
        assertEquals(0x00100001L, cap.blockCount)
        assertEquals(0x00100001L * 512, cap.totalBytes)
    }

    @Test
    fun cswParseAndValidate() {
        val good = ByteArray(13)
        ScsiCommands.putLeU32(good, 0, ScsiCommands.CSW_SIGNATURE)
        ScsiCommands.putLeU32(good, 4, 0xDEADBEEF.toInt())
        ScsiCommands.putLeU32(good, 8, 7)
        good[12] = 0
        val csw = ScsiCommands.parseCsw(good)
        assertTrue(csw.signatureValid)
        assertTrue(csw.passed)
        assertEquals(0xDEADBEEF.toInt(), csw.tag)
        assertEquals(7, csw.dataResidue)

        good[12] = 1
        assertFalse(ScsiCommands.parseCsw(good).passed)
    }

    @Test
    fun beU32IsUnsignedAcrossHighBit() {
        val b = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte())
        assertEquals(0xFFFFFFFFL, ScsiCommands.getBeU32(b, 0))
    }

    @Test(expected = IllegalArgumentException::class)
    fun cdbTooLongRejected() {
        ScsiCommands.buildCbw(1, 0, false, 0, ByteArray(17))
    }
}
