import XCTest
@testable import FlagshipCore

final class AccountMetadataTests: XCTestCase {
    private let umk = Data((0..<32).map(UInt8.init))
    private let nonce = Data((0..<12).map { UInt8(0xa0 + $0) })

    func testProtocolGoldenVectors() throws {
        let accountKey = try AccountMetadata.deriveAccountProfileKey(umk: umk)
        XCTAssertEqual(HexUtil.encode(accountKey), "6704c17878d90b3c9767fecbcbc969c55c4683674c76a6e5f7143fc2f2b5b674")
        XCTAssertEqual(
            HexUtil.encode(try AccountMetadata.deriveDeviceDirectoryKey(umk: umk)),
            "0f64692831c58829479951cca532646137a61c168b9ec9f079bb121694ba0d7f"
        )
        XCTAssertEqual(
            HexUtil.encode(try AccountMetadata.deriveAccountDeviceKey(
                umk: umk,
                accountId: "jolly-ranger",
                deviceId: "00112233445566778899aabbccddeeff"
            ).rawRepresentation),
            "19ee5d26fa101529c8596a83fd8341a4b74847fc0b996bf061f7a43bc6734e9d"
        )
        let coordinates = AccountMetadataCoordinates(
            accountId: "jolly-ranger",
            recordType: .accountProfile,
            revision: 1,
            keyVersion: 1
        )
        let encrypted = try AccountMetadata.encrypt(
            displayName: " Johnson Family ",
            keyBytes: accountKey,
            coordinates: coordinates,
            nonceData: nonce
        )
        XCTAssertEqual(encrypted.nonceHex, "a0a1a2a3a4a5a6a7a8a9aaab")
        XCTAssertEqual(
            encrypted.ciphertextHex,
            "a33dbbf36474c8cc0eacb0333f89e5d3c9067a7e37cc4f6c105e74901e86d71ac10dbb14587035116edd016459679ca1dfdffeb23e71bf15f9b95238"
        )
        XCTAssertEqual(
            try AccountMetadata.decrypt(ciphertext: encrypted, keyBytes: accountKey, coordinates: coordinates),
            "Johnson Family"
        )
    }

    func testAadRejectsAccountDeviceAndRecordSwaps() throws {
        let key = try AccountMetadata.deriveDeviceDirectoryKey(umk: umk)
        let coordinates = AccountMetadataCoordinates(
            accountId: "jolly-ranger",
            deviceId: "00112233445566778899aabbccddeeff",
            recordType: .deviceSelfProfile,
            revision: 1,
            keyVersion: 1
        )
        let encrypted = try AccountMetadata.encrypt(
            displayName: "Erica",
            keyBytes: key,
            coordinates: coordinates,
            nonceData: nonce
        )
        XCTAssertThrowsError(try AccountMetadata.decrypt(
            ciphertext: encrypted,
            keyBytes: key,
            coordinates: AccountMetadataCoordinates(
                accountId: "other-account",
                deviceId: coordinates.deviceId,
                recordType: .deviceSelfProfile,
                revision: 1,
                keyVersion: 1
            )
        ))
        XCTAssertThrowsError(try AccountMetadata.decrypt(
            ciphertext: encrypted,
            keyBytes: key,
            coordinates: AccountMetadataCoordinates(
                accountId: coordinates.accountId,
                deviceId: coordinates.deviceId,
                recordType: .deviceManagedProfile,
                revision: 1,
                keyVersion: 1
            )
        ))
    }

    func testNameValidation() throws {
        XCTAssertEqual(try AccountMetadata.validateDisplayName("  Jose\u{301} 👨‍👩‍👧  "), "José 👨‍👩‍👧")
        XCTAssertThrowsError(try AccountMetadata.validateDisplayName("unsafe\nname"))
        XCTAssertThrowsError(try AccountMetadata.validateDisplayName("unsafe\u{202e}name"))
    }
}
