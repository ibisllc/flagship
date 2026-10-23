import Foundation
import CryptoKit
@testable import FlagshipAPI

/// A well-formed first (`genesis`) recovery upload for the mock server. The mock checks the chain
/// and the signed digests as `.com` does; it does not check the signature, so a throwaway key signs.
func makeRecoveryUpload(
    username: String,
    credentialIdHex: String = "aabbccddeeff00112233445566778899",
    wrappedUmk: String = Data([1, 2, 3, 4]).base64EncodedString(),
    wrappedAdminRoot: String? = nil,
    wrappedAcmeAccountKey: String? = nil,
    fetchTokenHashHex: String = String(repeating: "ab", count: 32),
    prfSaltHashHex: String = String(repeating: "cd", count: 32),
    current: RecoveryRecordState? = nil
) throws -> RecoveryUploadRequest {
    let key = Curve25519.Signing.PrivateKey()
    let claim = try RecoveryRecordChain.next(
        username: username,
        irkPubHex: key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined(),
        adminRootPubHex: nil,
        current: current,
        credentialIdHex: credentialIdHex,
        wrappedUmk: wrappedUmk,
        wrappedAdminRoot: wrappedAdminRoot,
        wrappedAcmeAccountKey: wrappedAcmeAccountKey,
        fetchTokenHashHex: fetchTokenHashHex,
        prfSaltHashHex: prfSaltHashHex,
        issuedAt: 1_700_000_000_000
    )
    return RecoveryUploadRequest(
        claim: claim, signature: try claim.sign(with: key), wrappedUmk: wrappedUmk,
        wrappedAdminRoot: wrappedAdminRoot, wrappedAcmeAccountKey: wrappedAcmeAccountKey
    )
}
