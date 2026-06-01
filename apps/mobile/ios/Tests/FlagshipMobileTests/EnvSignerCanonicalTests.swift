import XCTest
import FlagshipAPI
import FlagshipUI

/// Pins the SetServiceEnv canonical bytes to the SAME cross-surface vector the
/// webapp (`canonicalSetServiceEnv` in service-env.js), Android
/// (`EnvSignerCanonicalTest`), and `@flagship/protocol` produce. The daemon
/// re-derives these bytes to verify the owner-IRK signature, so any drift in
/// field order, the `|` separator, key sorting, the `key=value` pair shape, or
/// the pair-count / issuedAt stringification would break live service-env
/// writes. The previous production signer returned 128 zeros.
final class EnvSignerCanonicalTests: XCTestCase {
    func testCanonicalBytesMatchCrossSurfaceVector() {
        let env = ServiceEnvSetEnvelope(
            serverId: "srv1",
            creator: "alice",
            slug: "blog",
            // Unsorted insertion order to prove keys are sorted.
            env: ["B": "2", "A": "1"],
            issuedAt: 1700000000
        )
        let expected = "flagship/set-service-env/v1|srv1|alice|blog|2|A=1|B=2|1700000000"
        XCTAssertEqual(String(data: canonicalSetServiceEnv(env), encoding: .utf8), expected)
    }

    func testEmptyEnvHasZeroPairCount() {
        let env = ServiceEnvSetEnvelope(
            serverId: "s", creator: "c", slug: "g", env: [:], issuedAt: 42
        )
        XCTAssertEqual(
            String(data: canonicalSetServiceEnv(env), encoding: .utf8),
            "flagship/set-service-env/v1|s|c|g|0|42"
        )
    }
}
