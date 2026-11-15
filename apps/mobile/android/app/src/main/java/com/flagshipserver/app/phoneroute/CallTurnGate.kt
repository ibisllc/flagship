// The phone side of a voi.ci call's transport (docs/voici-calls.md §4): the bare-name endpoint's demux after TLS and
// the one TURN connection a call may have. Same rules as iOS CallTurnGate.swift.
//
// The caller's only ICE server is `turns:<account>.<apex>:443`, so its TURN-over-TLS stream arrives on the same relayed
// streams as HTTP visits. The first byte after TLS decides (`flagship-turn-lite` `is_turn_first_byte`): a STUN first
// byte goes to TURN, anything else to the HTTP endpoint. TURN is accepted only while a call this device answered is
// armed with its one-time credential, only once, and only when a responder is linked; otherwise the stream is closed.
// The responder is `rust/crates/flagship-turn-lite` (sans-IO), linked through `flagship-turn-ffi` ([calls.TurnResponder]);
// a build without the CI's libraries (tools/libwebrtc) has no factory, so TURN streams are closed.

package com.flagshipserver.app.phoneroute

/** One call's TURN connection behind the endpoint: bytes in from the caller's TLS stream, bytes back out. */
interface CallTurnConnection {
    /** Bytes for the client's TLS stream; null ends the connection. */
    fun onClientBytes(data: ByteArray): List<ByteArray>?
    /** Called once, before the first bytes: where bytes the peer sends later go, and how to end the stream. */
    fun attach(toClient: (ByteArray) -> Unit, end: () -> Unit) {}
    fun close()
}

object CallTurnGate {
    enum class Route { Http, Turn, Close }

    data class Credential(val user: String, val secret: String)

    /** Makes the responder for an armed call; null while no TURN responder is linked into the app. */
    @Volatile var factory: ((Credential) -> CallTurnConnection?)? = null

    private var armed: Credential? = null
    private var taken = false

    /** A STUN message's first byte (top two bits zero); ChannelData overlaps HTTP methods, so only this decides. */
    fun isTurnFirstByte(b: Byte): Boolean = b.toInt() and 0xC0 == 0

    /** The demux rule: where a relayed stream goes, from its first byte after TLS. */
    fun route(firstByte: Byte, turnReady: Boolean): Route = when {
        !isTurnFirstByte(firstByte) -> Route.Http
        turnReady -> Route.Turn
        else -> Route.Close
    }

    /** The answer carrying this credential was sent: one TURN connection may now open. */
    @Synchronized fun arm(c: Credential) {
        armed = c
        taken = false
    }

    /** The call ended (or this device didn't win): no TURN until the next answer. */
    @Synchronized fun disarm() {
        armed = null
        taken = false
    }

    @get:Synchronized val isArmed: Boolean get() = armed != null

    /** Where a new stream goes; a TURN stream takes the call's one connection (null connection: close the stream). */
    fun open(firstByte: Byte): Pair<Route, CallTurnConnection?> {
        val (r, cred, make) = synchronized(this) {
            val make = factory
            val ready = armed != null && !taken && make != null
            val r = route(firstByte, ready)
            if (r == Route.Turn) taken = true
            Triple(r, armed, make)
        }
        if (r != Route.Turn || cred == null || make == null) return r to null
        val conn = make(cred) ?: return Route.Close to null
        return Route.Turn to conn
    }
}
