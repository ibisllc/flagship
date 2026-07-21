// Android USB Host glue: enumerate attached USB mass-storage devices, request
// permission, open the bulk endpoints, and expose them as a [BulkTransport].
//
// HARDWARE-DEPENDENT (compiles + type-checked, but not unit-tested — it needs a
// physical OTG drive). All the *protocol* logic lives in ScsiCommands +
// MassStorageWriter, which ARE unit-tested over the [BulkTransport] seam.

package com.flagshipserver.app.builder.usb

import android.app.PendingIntent
import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/** A USB device that looks like a SCSI/Bulk-Only mass-storage stick. */
data class UsbMassStorageDevice(
    val device: UsbDevice,
    val iface: UsbInterface,
    val bulkIn: UsbEndpoint,
    val bulkOut: UsbEndpoint,
) {
    val displayName: String
        get() = listOfNotNull(
            device.manufacturerName?.takeIf { it.isNotBlank() },
            device.productName?.takeIf { it.isNotBlank() },
        ).joinToString(" ").ifBlank { "USB drive ${device.deviceId}" }
}

object UsbHost {
    const val ACTION_USB_PERMISSION = "com.flagshipserver.app.USB_PERMISSION"

    /** USB Mass Storage class / SCSI transparent subclass / Bulk-Only protocol. */
    private const val CLASS_MASS_STORAGE = UsbConstants.USB_CLASS_MASS_STORAGE // 0x08
    private const val SUBCLASS_SCSI = 0x06
    private const val PROTOCOL_BULK_ONLY = 0x50

    fun manager(context: Context): UsbManager =
        context.getSystemService(Context.USB_SERVICE) as UsbManager

    /** All attached devices that expose a SCSI/BOT mass-storage interface. */
    fun enumerate(manager: UsbManager): List<UsbMassStorageDevice> =
        manager.deviceList.values.mapNotNull { dev -> matchMassStorage(dev) }

    /** Inspect one device for a usable SCSI/BOT interface + bulk endpoint pair. */
    fun matchMassStorage(dev: UsbDevice): UsbMassStorageDevice? {
        for (i in 0 until dev.interfaceCount) {
            val iface = dev.getInterface(i)
            if (iface.interfaceClass != CLASS_MASS_STORAGE) continue
            // SCSI transparent + Bulk-Only is the overwhelmingly-common case; be
            // lenient on subclass (some sticks report 0x05/0x01) but require BOT.
            if (iface.interfaceProtocol != PROTOCOL_BULK_ONLY) continue
            var bulkIn: UsbEndpoint? = null
            var bulkOut: UsbEndpoint? = null
            for (e in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(e)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (ep.direction == UsbConstants.USB_DIR_IN) bulkIn = ep else bulkOut = ep
            }
            if (bulkIn != null && bulkOut != null) {
                return UsbMassStorageDevice(dev, iface, bulkIn, bulkOut)
            }
        }
        return null
    }

    fun hasPermission(manager: UsbManager, device: UsbDevice): Boolean =
        manager.hasPermission(device)

    /** Fire the system permission dialog for [device]; result arrives via [pendingIntent]. */
    fun requestPermission(manager: UsbManager, device: UsbDevice, pendingIntent: PendingIntent) {
        manager.requestPermission(device, pendingIntent)
    }

    /**
     * Open [target] and claim its interface, returning a live [BulkTransport] +
     * the underlying connection (close it when done). Returns null if the open
     * or claim fails (or permission is missing).
     */
    fun open(manager: UsbManager, target: UsbMassStorageDevice): OpenDevice? {
        if (!manager.hasPermission(target.device)) return null
        val conn = manager.openDevice(target.device) ?: return null
        if (!conn.claimInterface(target.iface, true)) {
            conn.close()
            return null
        }
        return OpenDevice(conn, UsbBulkTransport(conn, target.bulkIn, target.bulkOut))
    }

    class OpenDevice(
        private val connection: UsbDeviceConnection,
        val transport: BulkTransport,
    ) : AutoCloseable {
        override fun close() {
            try {
                connection.close()
            } catch (_: Throwable) {
            }
        }
    }
}

/** Real [BulkTransport] over a claimed UsbDeviceConnection. */
class UsbBulkTransport(
    private val connection: UsbDeviceConnection,
    private val bulkIn: UsbEndpoint,
    private val bulkOut: UsbEndpoint,
) : BulkTransport {
    override fun bulkOut(buf: ByteArray, len: Int, timeoutMs: Int): Int =
        connection.bulkTransfer(bulkOut, buf, len, timeoutMs)

    override fun bulkIn(buf: ByteArray, len: Int, timeoutMs: Int): Int =
        connection.bulkTransfer(bulkIn, buf, len, timeoutMs)
}
