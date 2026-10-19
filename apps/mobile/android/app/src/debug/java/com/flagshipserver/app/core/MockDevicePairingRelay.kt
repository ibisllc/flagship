package com.flagshipserver.app.core



/**
 * Scripted in-memory relay that wires an admin + an incoming side
 * together for tests (and previews). One instance plays BOTH roles so a
 * unit test can run the full handshake without a network. The incoming
 * side's hello is buffered for the admin's [awaitPeerHello]; the admin's
 * deliver is buffered for the incoming's [awaitDelivery].
 */
class MockDevicePairingRelay {
    @Volatile private var helloPub: ByteArray? = null
    @Volatile private var delivered: Pair<String, String>? = null

    /** Optional scripted failure for the admin's awaitPeerHello. */
    var peerHelloError: PairingRelayError? = null

    /** Optional scripted failure for the incoming's awaitDelivery. */
    var deliveryError: PairingRelayError? = null

    val admin: AdminPairingRelay = object : AdminPairingRelay {
        override suspend fun awaitPeerHello(sid: String): ByteArray {
            peerHelloError?.let { throw it }
            return helloPub ?: error("MockDevicePairingRelay: incoming hasn't sent hello yet")
        }
        override suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String) {
            delivered = ciphertextBase64Url to nonceBase64Url
        }
        override fun close() {}
    }

    val incoming: IncomingPairingRelay = object : IncomingPairingRelay {
        override suspend fun connectAndHello(sid: String, hello: ByteArray) {
            helloPub = hello
        }
        override suspend fun awaitDelivery(): Pair<String, String> {
            deliveryError?.let { throw it }
            return delivered ?: error("MockDevicePairingRelay: admin hasn't delivered yet")
        }
        override fun close() {}
    }
}
