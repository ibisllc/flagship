// The phone's TURN responder for the call in progress (docs/voici-calls.md §4): `rust/crates/flagship-turn-lite` through
// `flagship-turn-ffi` (libflagship_turn_ffi.so, built by .github/workflows/libwebrtc.yml), plus the loopback UDP socket
// its relayed traffic leaves from. The caller's TLS stream comes in through CallTurnGate; the datagrams go to and from
// this phone's own peer connection, which gathers only a loopback host candidate. Same rules as iOS TurnResponder.swift.

package com.flagshipserver.app.calls

import com.flagshipserver.app.phoneroute.CallTurnConnection
import com.flagshipserver.app.phoneroute.CallTurnGate
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.security.SecureRandom

class TurnResponder private constructor(private val socket: DatagramSocket, private var handle: Long) : CallTurnConnection {
    private val lock = Any()
    @Volatile private var toClient: ((ByteArray) -> Unit)? = null
    @Volatile private var end: (() -> Unit)? = null
    private val reader = Thread({ readLoop() }, "flagship-turn").apply { isDaemon = true }

    override fun attach(toClient: (ByteArray) -> Unit, end: () -> Unit) {
        this.toClient = toClient
        this.end = end
        if (!reader.isAlive) reader.start()
    }

    override fun onClientBytes(data: ByteArray): List<ByteArray>? {
        val out = synchronized(lock) {
            if (handle == 0L) return null
            nativeClientBytes(handle, data, System.currentTimeMillis())
        } ?: return null
        val r = Result.decode(out) ?: return null
        if (r.status != 0) return null
        for ((port, d) in r.peers) {
            runCatching { socket.send(DatagramPacket(d, d.size, LOOPBACK, port)) }
        }
        return if (r.client.isEmpty()) emptyList() else listOf(r.client)
    }

    private fun readLoop() {
        val buf = ByteArray(MAX_DATAGRAM)
        while (!socket.isClosed) {
            val p = DatagramPacket(buf, buf.size)
            try {
                socket.receive(p)
            } catch (_: Exception) {
                break
            }
            if (p.address?.isLoopbackAddress != true) continue
            val data = buf.copyOf(p.length)
            // The native call runs under the lock; the TLS write does not, since the TLS stream calls onClientBytes
            // under its own monitor.
            val out = synchronized(lock) {
                if (handle == 0L) null else nativePeerDatagram(handle, p.port, data, System.currentTimeMillis())
            } ?: continue
            val r = Result.decode(out) ?: continue
            if (r.client.isNotEmpty()) toClient?.invoke(r.client)
        }
        end?.invoke()
    }

    override fun close() {
        synchronized(lock) {
            if (handle != 0L) nativeFree(handle)
            handle = 0L
        }
        socket.close()
    }

    /** include/flagship_turn.h: status, client bytes, then peer datagrams. */
    internal class Result(val status: Int, val client: ByteArray, val peers: List<Pair<Int, ByteArray>>) {
        companion object {
            fun decode(b: ByteArray): Result? = runCatching {
                val bb = ByteBuffer.wrap(b)
                val status = bb.get().toInt() and 0xff
                val n = bb.int
                if (n < 0 || n > bb.remaining()) return null
                val client = ByteArray(n).also { bb.get(it) }
                val count = bb.short.toInt() and 0xffff
                val peers = ArrayList<Pair<Int, ByteArray>>(count)
                repeat(count) {
                    val port = bb.short.toInt() and 0xffff
                    val len = bb.short.toInt() and 0xffff
                    peers.add(port to ByteArray(len).also { bb.get(it) })
                }
                Result(status, client, peers)
            }.getOrNull()
        }
    }

    companion object {
        private val LOOPBACK: InetAddress = InetAddress.getByName("127.0.0.1")
        private const val MAX_DATAGRAM = 4096
        /** 64 kbit/s each way (docs/voici-calls.md §4); a video call 2.56 Mbit/s: the 1.2 Mbit/s ceiling of
         *  voici-calls-v2.md §1.3, doubled by the frame padding (§1.6). */
        const val AUDIO_RATE_BYTES_PER_S = 8_000
        const val VIDEO_RATE_BYTES_PER_S = 320_000
        private const val REALM = "flagship"

        /** False in a build without libflagship_turn_ffi.so: CallTurnGate then has no factory and closes TURN streams. */
        val available: Boolean by lazy { runCatching { System.loadLibrary("flagship_turn_ffi") }.isSuccess }

        /** The relay socket and a native responder for one armed call; null when the library is missing. */
        fun open(c: CallTurnGate.Credential, rateBytesPerS: Int): TurnResponder? {
            if (!available) return null
            val socket = DatagramSocket(InetSocketAddress(LOOPBACK, 0))
            val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
            val config = listOf(REALM, c.user, c.secret, nonce, "127.0.0.1:${socket.localPort}", "127.0.0.1", rateBytesPerS.toString())
                .joinToString("\n").toByteArray(Charsets.UTF_8)
            val h = nativeNew(config)
            if (h == 0L) {
                socket.close()
                return null
            }
            return TurnResponder(socket, h)
        }

        @JvmStatic private external fun nativeNew(config: ByteArray): Long
        @JvmStatic private external fun nativeFree(handle: Long)
        @JvmStatic private external fun nativeClientBytes(handle: Long, data: ByteArray, nowMs: Long): ByteArray?
        @JvmStatic private external fun nativePeerDatagram(handle: Long, port: Int, data: ByteArray, nowMs: Long): ByteArray?
    }
}
