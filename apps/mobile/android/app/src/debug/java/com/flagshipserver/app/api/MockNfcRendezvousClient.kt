// Debug builds and unit tests only: a rendezvous that records deposits instead of posting them.

package com.flagshipserver.app.api


/**
 * Test seam — records every deposit + lets callers script the next
 * outcome (e.g. simulate a 500 from the Worker). The captured deposit
 * round-trips through openWiFiConfig in the happy-path test.
 */
class MockNfcRendezvousClient(
    var nextOutcome: Result<Unit> = Result.success(Unit),
) : NfcRendezvousClient {
    data class Deposit(val rendezvousId: String, val sealedHex: String, val nonceHex: String)

    private val _deposits = mutableListOf<Deposit>()
    val deposits: List<Deposit> get() = _deposits

    override suspend fun depositSealedWifi(
        rendezvousId: String,
        sealedHex: String,
        nonceHex: String,
    ): Result<Unit> {
        _deposits += Deposit(rendezvousId, sealedHex, nonceHex)
        return nextOutcome
    }
}
