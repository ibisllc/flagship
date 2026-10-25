// Finding the owner's box on this Wi-Fi with no DNS and no `.com` (docs/data-sovereignty.md 4.2):
// boxes answer multicast DNS for `_flagship._tcp` under an opaque id (Rescue.discoveryId, a keyed
// hash of the server's name under its STK) that only the owner's devices can recompute. What the
// announcement says is only ever a hint; the hello decides. MIRRORS the iOS RescueDiscovery.swift.

package com.flagshipserver.app.core

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.util.concurrent.ConcurrentHashMap

interface RescueDiscovery {
    /** Calls [onChange] with every box seen so far: announced id -> where it answers. */
    fun start(onChange: (Map<String, RescueEndpoint>) -> Unit)
    fun stop()
}

class NsdRescueDiscovery(context: Context) : RescueDiscovery {
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val found = ConcurrentHashMap<String, RescueEndpoint>()
    private var listener: NsdManager.DiscoveryListener? = null
    @Volatile private var onChange: ((Map<String, RescueEndpoint>) -> Unit)? = null

    override fun start(onChange: (Map<String, RescueEndpoint>) -> Unit) {
        stop()
        this.onChange = onChange
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceLost(info: NsdServiceInfo) = Unit
            override fun onServiceFound(info: NsdServiceInfo) {
                val id = info.serviceName.lowercase()
                if (id.length != 16 || found.containsKey(id)) return
                @Suppress("DEPRECATION")
                runCatching {
                    nsd.resolveService(info, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = Unit
                        override fun onServiceResolved(info: NsdServiceInfo) {
                            val host = info.host?.hostAddress?.substringBefore('%') ?: return
                            // Only a private-network address is a box on this Wi-Fi.
                            if (!LanHint.isLanAddress(host)) return
                            found[id] = RescueEndpoint(host, if (info.port > 0) info.port else 443)
                            this@NsdRescueDiscovery.onChange?.invoke(found.toMap())
                        }
                    })
                }
            }
        }
        listener = l
        runCatching { nsd.discoverServices(Rescue.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l) }
    }

    override fun stop() {
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
        onChange = null
    }
}
