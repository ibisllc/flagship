import XCTest
@testable import FlagshipBurnerCore

/// Verifies the local Alpine personalize matches the server's trailer wire
/// format AND places the trailer where the box's volume-size find reads it —
/// the bug the download path had (trailer at file-end, box reads at the volume
/// offset). No boot needed: we check the bytes directly.
final class AlpinePersonalizeTests: XCTestCase {
    private func sampleRecipe() -> Recipe {
        let ac = RecipeAuthCode(
            version: 1, serial: "CPSERIAL0001", username: "dani", serverName: "home",
            serverDomain: "home.dani.flagship.services",
            delegatedPubKeyHex: String(repeating: "ab", count: 32),
            userPubKeyHex: String(repeating: "cd", count: 32),
            issuedAt: 1_780_276_747_131, expiresAt: 1_780_298_347_131)
        return Recipe(
            version: 2, serverDomain: "home.dani.flagship.services", username: "dani",
            serverName: "home", phoneDelegatedPubKeyHex: String(repeating: "ab", count: 32),
            registrationUrl: "https://flagship.services/api/server/register",
            authCode: ac, authCodeUserSignatureHex: String(repeating: "11", count: 64),
            installerGitRef: "main", rckPubKeyHex: String(repeating: "ef", count: 32),
            blobSignatureHex: String(repeating: "22", count: 64), bootUnlockMode: nil)
    }

    private func u32le(_ d: Data, _ off: Int) -> UInt32 {
        let b = [UInt8](d)
        return UInt32(b[off]) | (UInt32(b[off+1])<<8) | (UInt32(b[off+2])<<16) | (UInt32(b[off+3])<<24)
    }

    func testTrailerWireFormatMatchesServer() throws {
        let r = sampleRecipe()
        let t = try AlpinePersonalize.buildTrailer(r)
        let b = [UInt8](t)
        // MAGIC_HEADER(16) || version(1) || u32le(jsonLen) || json || sig(64) ||
        // MAGIC_FOOTER(16) || u32le(totalSize)
        XCTAssertEqual(Array(b.prefix(16)), Array("FLAGSHIP-BOOT\0\0\0".utf8))
        XCTAssertEqual(b[16], 0x01)
        let jsonLen = Int(u32le(t, 17))
        let json = Data(b[21..<(21 + jsonLen)])
        let obj = try JSONSerialization.jsonObject(with: json) as! [String: Any]
        XCTAssertEqual(obj["serverDomain"] as? String, "home.dani.flagship.services")
        XCTAssertEqual(obj["installerGitRef"] as? String, "main")
        XCTAssertNil(obj["bootUnlockMode"], "installBlobToJson omits bootUnlockMode (server parity)")
        let acj = obj["authCode"] as! [String: Any]
        XCTAssertEqual(acj["serial"] as? String, "CPSERIAL0001")
        // signature is the recipe's 64-byte blobSignature, verbatim
        let sig = Array(b[(21 + jsonLen)..<(21 + jsonLen + 64)])
        XCTAssertEqual(sig, [UInt8](Data(hexString: r.blobSignatureHex)!))
        // footer + self-describing totalSize at the very end
        let total = b.count
        XCTAssertEqual(Array(b[(total-20)..<(total-4)]), Array("\0\0\0FLAGSHIP-END\0".utf8))
        XCTAssertEqual(Int(u32le(t, total-4)), total)
    }

    func testPersonalizePlacesTrailerAtVolumeOffsetAndAligns() throws {
        // Synthetic ISO9660: 16 system sectors + a PVD + 10 trailing "xorriso
        // padding" blocks, so file > volume — exactly the shape that broke the
        // download path (box reads at the volume offset, not file-end).
        let lbs = 2048, volBlocks = 100, padBlocks = 10
        let fileBlocks = volBlocks + padBlocks
        var iso = Data(count: fileBlocks * lbs)
        let pvd = 16 * lbs
        iso[pvd] = 0x01
        iso.replaceSubrange((pvd+1)...(pvd+5), with: Array("CD001".utf8))
        // vss (both-endian u32) at PVD+80
        let vss = UInt32(volBlocks)
        let leP = pvd + 80
        iso[leP]=UInt8(vss & 0xff); iso[leP+1]=UInt8((vss>>8)&0xff); iso[leP+2]=UInt8((vss>>16)&0xff); iso[leP+3]=UInt8((vss>>24)&0xff)
        iso[leP+4]=UInt8((vss>>24)&0xff); iso[leP+5]=UInt8((vss>>16)&0xff); iso[leP+6]=UInt8((vss>>8)&0xff); iso[leP+7]=UInt8(vss&0xff)
        // lbs (both-endian u16) at PVD+128
        iso[pvd+128]=UInt8(lbs & 0xff); iso[pvd+129]=UInt8((lbs>>8)&0xff)
        iso[pvd+130]=UInt8((lbs>>8)&0xff); iso[pvd+131]=UInt8(lbs&0xff)

        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
        let baseURL = tmp.appendingPathComponent("base-\(UUID().uuidString).iso")
        let outURL = tmp.appendingPathComponent("out-\(UUID().uuidString).iso")
        try iso.write(to: baseURL)
        defer { try? FileManager.default.removeItem(at: baseURL); try? FileManager.default.removeItem(at: outURL) }

        try AlpinePersonalize.personalize(baseISO: baseURL, recipe: sampleRecipe(), outURL: outURL, sectorSize: 512)
        let out = try Data(contentsOf: outURL)
        let fileSize = fileBlocks * lbs

        // PVD volume-space-size patched to fileSize/lbs so the box's
        // `volumeSpaceSize × lbs` lands on the trailer (not in the padding).
        XCTAssertEqual(Int(u32le(out, pvd + 80)), fileBlocks)
        // The trailer header sits at that offset (== fileSize).
        XCTAssertEqual(Array([UInt8](out)[fileSize..<(fileSize+16)]), Array("FLAGSHIP-BOOT\0\0\0".utf8))
        // Output padded to the device sector so the raw write is aligned.
        XCTAssertEqual(out.count % 512, 0)
        XCTAssertGreaterThanOrEqual(out.count, fileSize + 16)
    }
}
