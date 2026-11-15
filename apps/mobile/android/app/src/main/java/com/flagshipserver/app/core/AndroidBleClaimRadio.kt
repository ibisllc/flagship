// The retail claim over Bluetooth LE (docs/retail-box-setup.md §11.2). BluetoothLeScanner, not the
// Companion Device Manager: its chooser hides how many boxes advertise, and the presence rule needs
// every advert. Twin of iOS CoreBluetoothClaimRadio.

package com.flagshipserver.app.core

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import com.flagshipserver.app.core.pq.BoxClaim
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import java.util.UUID

/** The permissions a claim needs on this Android version (§11.2): scan + connect from Android 12,
 *  fine location (and location turned on) before it. */
object RetailBlePermissions {
    val needed: Array<String>
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /** Android 10 and 11 find Bluetooth devices only with location on, and say so first. */
    val needsLocation: Boolean get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.S

    fun granted(context: Context): Boolean =
        needed.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    fun locationOn(context: Context): Boolean {
        if (!needsLocation) return true
        val lm = context.getSystemService(LocationManager::class.java) ?: return false
        return lm.isLocationEnabled
    }
}

@SuppressLint("MissingPermission")
class AndroidBleClaimRadio(context: Context) : BoxClaimRadio {
    private val app = context.applicationContext
    private val manager = app.getSystemService(BluetoothManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val seen = HashMap<String, Pair<BoxClaimAdvert, Long>>()
    private val devices = HashMap<String, BluetoothDevice>()
    @Volatile private var onAdverts: ((List<BoxClaimAdvert>) -> Unit)? = null
    private var scanning = false

    companion object {
        val SERVICE: UUID = UUID.fromString(BoxClaim.BLE_SERVICE_UUID)
        val INBOX: UUID = UUID.fromString(BoxClaim.BLE_INBOX_UUID)
        val OUTBOX: UUID = UUID.fromString(BoxClaim.BLE_OUTBOX_UUID)
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        /** An advert not heard again within this long counts as gone. */
        const val STALE_AFTER_MS = 5_000L
        const val REPORT_EVERY_MS = 1_000L
    }

    private fun checkReady() {
        val adapter = manager?.adapter ?: throw BoxClaimRadioException(BoxClaimRadioException.Kind.UNSUPPORTED)
        if (!app.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            throw BoxClaimRadioException(BoxClaimRadioException.Kind.UNSUPPORTED)
        }
        if (!RetailBlePermissions.granted(app)) throw BoxClaimRadioException(BoxClaimRadioException.Kind.NOT_ALLOWED)
        if (!adapter.isEnabled) throw BoxClaimRadioException(BoxClaimRadioException.Kind.BLUETOOTH_OFF)
        if (!RetailBlePermissions.locationOn(app)) throw BoxClaimRadioException(BoxClaimRadioException.Kind.NOT_ALLOWED)
    }

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) = heard(result)
        override fun onBatchScanResults(results: MutableList<ScanResult>) { results.forEach(::heard) }
    }

    private fun heard(r: ScanResult) {
        val addr = r.device.address
        val data = r.scanRecord?.getServiceData(ParcelUuid(SERVICE))
        val parsed = data?.let { BoxClaim.parseAdvert(it) }
        val advert = BoxClaimAdvert(addr, parsed?.second ?: addr, parsed?.first ?: BoxClaim.AdvertState.UNCLAIMED)
        main.post {
            devices[addr] = r.device
            val had = seen[addr]?.first
            seen[addr] = advert to System.currentTimeMillis()
            if (had != advert) report()
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (!scanning) return
            report()
            main.postDelayed(this, REPORT_EVERY_MS)
        }
    }

    private fun report() {
        val now = System.currentTimeMillis()
        seen.entries.removeAll { now - it.value.second >= STALE_AFTER_MS }
        onAdverts?.invoke(seen.values.map { it.first }.sortedBy { it.advertId })
    }

    override suspend fun startScan(onAdverts: (List<BoxClaimAdvert>) -> Unit) {
        checkReady()
        val scanner = manager?.adapter?.bluetoothLeScanner ?: throw BoxClaimRadioException(BoxClaimRadioException.Kind.BLUETOOTH_OFF)
        val started = CompletableDeferred<Unit>()
        main.post {
            this.onAdverts = onAdverts
            seen.clear()
            try {
                scanner.startScan(
                    listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()),
                    ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                    callback,
                )
                scanning = true
                main.postDelayed(ticker, REPORT_EVERY_MS)
                report()
                started.complete(Unit)
            } catch (e: SecurityException) {
                started.completeExceptionally(BoxClaimRadioException(BoxClaimRadioException.Kind.NOT_ALLOWED))
            } catch (e: Throwable) {
                started.completeExceptionally(BoxClaimRadioException(BoxClaimRadioException.Kind.UNSUPPORTED))
            }
        }
        started.await()
    }

    override fun stopScan() {
        main.post {
            if (scanning) runCatching { manager?.adapter?.bluetoothLeScanner?.stopScan(callback) }
            scanning = false
            main.removeCallbacks(ticker)
            onAdverts = null
        }
    }

    override suspend fun connect(advert: BoxClaimAdvert): BoxClaimLink {
        val device = devices[advert.peripheral] ?: manager?.adapter?.getRemoteDevice(advert.peripheral)
            ?: throw BoxClaimRadioException(BoxClaimRadioException.Kind.CONNECT_FAILED)
        val link = GattClaimLink()
        link.open(app, device)
        return link
    }
}

/** One GATT link: frames out on the inbox characteristic, frames in as outbox notifications. */
@SuppressLint("MissingPermission")
private class GattClaimLink : BoxClaimLink {
    private var gatt: BluetoothGatt? = null
    private var inbox: BluetoothGattCharacteristic? = null
    private var mtu = 23
    private val opened = CompletableDeferred<Unit>()
    @Volatile private var written: CompletableDeferred<Boolean>? = null
    private val messages = Channel<ByteArray>(Channel.UNLIMITED)
    private val reassembler = BoxClaim.Reassembler()
    @Volatile private var closed = false

    private val cb = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                if (!g.requestMtu(517)) g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                fail()
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) mtu = newMtu
            g.discoverServices()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val s = g.getService(AndroidBleClaimRadio.SERVICE)
            val i = s?.getCharacteristic(AndroidBleClaimRadio.INBOX)
            val o = s?.getCharacteristic(AndroidBleClaimRadio.OUTBOX)
            if (status != BluetoothGatt.GATT_SUCCESS || i == null || o == null) return fail()
            inbox = i
            val d = o.getDescriptor(AndroidBleClaimRadio.CCCD) ?: return fail()
            if (!g.setCharacteristicNotification(o, true)) return fail()
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                g.writeDescriptor(d)
            }
            if (!ok) fail()
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) opened.complete(Unit) else fail()
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            written?.complete(status == BluetoothGatt.GATT_SUCCESS)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) = notified(c, value)

        @Deprecated("Android 12 and older")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) notified(c, c.value ?: return)
        }
    }

    private fun notified(c: BluetoothGattCharacteristic, value: ByteArray) {
        if (c.uuid != AndroidBleClaimRadio.OUTBOX) return
        try {
            reassembler.push(value)?.let { messages.trySend(it) }
        } catch (_: Throwable) {
            close()
        }
    }

    suspend fun open(context: Context, device: BluetoothDevice) {
        gatt = device.connectGatt(context, false, cb, BluetoothDevice.TRANSPORT_LE)
            ?: throw BoxClaimRadioException(BoxClaimRadioException.Kind.CONNECT_FAILED)
        try {
            withTimeout(20_000) { opened.await() }
        } catch (_: Throwable) {
            close()
            throw BoxClaimRadioException(BoxClaimRadioException.Kind.CONNECT_FAILED)
        }
    }

    override suspend fun send(message: ByteArray) {
        val g = gatt
        val ch = inbox
        if (closed || g == null || ch == null) throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)
        for (frame in BoxClaim.fragment(message, (mtu - 3).coerceIn(20, 512))) {
            val done = CompletableDeferred<Boolean>()
            written = done
            val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(ch, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                ch.value = frame
                @Suppress("DEPRECATION")
                g.writeCharacteristic(ch)
            }
            val ok = started && runCatching { withTimeout(10_000) { done.await() } }.getOrDefault(false)
            if (!ok) {
                close()
                throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)
            }
        }
    }

    override suspend fun receive(): ByteArray =
        messages.receiveCatching().getOrNull() ?: throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)

    private fun fail() {
        closed = true
        opened.completeExceptionally(BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED))
        written?.complete(false)
        messages.close()
    }

    override fun close() {
        if (closed && gatt == null) return
        fail()
        runCatching { gatt?.disconnect(); gatt?.close() }
        gatt = null
    }
}
