import Foundation

/// Local Alpine personalize — the burner-owns-the-ISO path.
///
/// Instead of the website streaming a 240 MB personalized ISO per server, the
/// burner caches the base Alpine ISO once (BaseIsoCache) and appends the recipe
/// trailer LOCALLY, exactly as the server's `iso-personalizer/streamPersonalize`
/// would. Owning both ends here lets us fix the three seams the download path
/// had:
///   1. no per-server 240 MB download (just the ~1 KB recipe),
///   2. the output is padded to the device sector so the raw write is aligned,
///   3. the trailer lands EXACTLY where the box's volume-size find reads it.
///
/// Trailer wire format (byte-identical to packages/iso-personalizer/trailer.ts):
///   MAGIC_HEADER(16) || version(1) || u32le(jsonLen) || json ||
///   signature(64) || MAGIC_FOOTER(16) || u32le(totalSize)
///
/// `json` is `JSON.stringify(installBlobToJson(blob))` — we build it in the
/// SAME field order so the bytes match the server (see AlpinePersonalizeTests'
/// golden vector). The box parses it back via installBlobFromJson and verifies
/// the Ed25519 signature over the canonical InstallBlob bytes.
public enum AlpinePersonalize {
    public enum Error: LocalizedError {
        case baseTooSmall(Int)
        case notIso9660
        case badVolumeSize(file: Int, lbs: Int)
        case trailerTooLarge(Int)

        public var errorDescription: String? {
            switch self {
            case .baseTooSmall(let n): return "Base ISO is too small (\(n) bytes)."
            case .notIso9660: return "Cached base ISO isn't a valid ISO9660 image."
            case .badVolumeSize(let f, let l): return "Base ISO size \(f) isn't a multiple of its \(l)-byte logical block."
            case .trailerTooLarge(let n): return "Recipe trailer too large (\(n) bytes)."
            }
        }
    }

    // Trailer constants — must match trailer.ts exactly.
    static let magicHeader = Array("FLAGSHIP-BOOT\0\0\0".utf8)   // 16
    static let magicFooter = Array("\0\0\0FLAGSHIP-END\0".utf8)  // 16
    static let formatVersion: UInt8 = 0x01
    static let sigLen = 64
    static let maxTrailerBytes = 65_536
    // ISO9660 Primary Volume Descriptor: sector 16 (byte 32768). The
    // volume-space-size is a both-endian u32 at PVD offset 80; the logical
    // block size a both-endian u16 at PVD offset 128.
    static let pvdOffset = 16 * 2048
    static let vssOffset = 16 * 2048 + 80
    static let lbsOffset = 16 * 2048 + 128

    /// Build the trailer bytes for a verified recipe. Pure; unit-tested against
    /// the TS golden vector.
    public static func buildTrailer(_ recipe: Recipe) throws -> Data {
        let json = installBlobJSON(recipe)
        let jsonLen = json.count
        let totalSize = magicHeader.count + 1 + 4 + jsonLen + sigLen + magicFooter.count + 4
        if totalSize > maxTrailerBytes { throw Error.trailerTooLarge(totalSize) }
        guard let sig = Data(hexString: recipe.blobSignatureHex), sig.count == sigLen else {
            throw Error.trailerTooLarge(0)
        }
        var out = Data(capacity: totalSize)
        out.append(contentsOf: magicHeader)
        out.append(formatVersion)
        out.append(u32le(UInt32(jsonLen)))
        out.append(json)
        out.append(sig)
        out.append(contentsOf: magicFooter)
        out.append(u32le(UInt32(totalSize)))
        return out
    }

    /// Produce a flashable personalized image from the cached base ISO + recipe.
    /// Writes to `outURL`. The result = base bytes (with the PVD volume size
    /// patched so the trailer sits at the volume boundary) + trailer + zero pad
    /// to `sectorSize`, so a raw-device write is block-aligned.
    public static func personalize(baseISO: URL, recipe: Recipe, outURL: URL,
                                   sectorSize: Int = 512) throws {
        let fm = FileManager.default
        let fileSize = ((try? fm.attributesOfItem(atPath: baseISO.path))?[.size] as? Int) ?? 0
        guard fileSize >= 64 * 1024 else { throw Error.baseTooSmall(fileSize) }

        // Read enough of the head to inspect + patch the PVD.
        let base = try FileHandle(forReadingFrom: baseISO)
        defer { try? base.close() }
        // ISO9660 PVD descriptor type 1 + "CD001" identifier at sector 16.
        try base.seek(toOffset: UInt64(pvdOffset))
        let pvdHead = base.readData(ofLength: 8)
        guard pvdHead.count >= 6, pvdHead[0] == 0x01,
              pvdHead[1] == 0x43, pvdHead[2] == 0x44, pvdHead[3] == 0x30,
              pvdHead[4] == 0x30, pvdHead[5] == 0x31 else { throw Error.notIso9660 }

        try base.seek(toOffset: UInt64(lbsOffset))
        let lbs = Int(readU16le(base.readData(ofLength: 2)))
        let blockSize = lbs > 0 ? lbs : 2048
        guard fileSize % blockSize == 0 else { throw Error.badVolumeSize(file: fileSize, lbs: blockSize) }
        let newVss = UInt32(fileSize / blockSize)

        let trailer = try buildTrailer(recipe)

        // Build the output: copy base, patch the PVD vss to newVss (both-endian),
        // append the trailer, pad to the sector size.
        fm.createFile(atPath: outURL.path, contents: nil)
        let out = try FileHandle(forWritingTo: outURL)
        defer { try? out.close() }

        try base.seek(toOffset: 0)
        var copied = 0
        let chunk = 4 * 1024 * 1024
        while true {
            let data = base.readData(ofLength: chunk)
            if data.isEmpty { break }
            out.write(data)
            copied += data.count
        }
        // Patch the volume-space-size in place: u32le at vssOffset, u32be next.
        try out.seek(toOffset: UInt64(vssOffset))
        out.write(u32le(newVss))
        out.write(u32be(newVss))
        // Append the trailer at fileSize (== newVss × lbs == the box's read offset).
        try out.seek(toOffset: UInt64(fileSize))
        out.write(trailer)
        // Pad the whole image to a sector multiple so the raw write is aligned.
        let total = fileSize + trailer.count
        let pad = (sectorSize - (total % sectorSize)) % sectorSize
        if pad > 0 { out.write(Data(count: pad)) }
        try out.synchronize()
    }

    /// `JSON.stringify(installBlobToJson(blob))` — same field order + compact
    /// (no spaces) so the bytes match trailer.ts. bootUnlockMode is deliberately
    /// omitted (installBlobToJson doesn't emit it — server parity).
    static func installBlobJSON(_ r: Recipe) -> Data {
        var s = "{"
        s += "\"version\":\(r.version),"
        s += "\"serverDomain\":\(js(r.serverDomain)),"
        s += "\"username\":\(js(r.username)),"
        s += "\"serverName\":\(js(r.serverName)),"
        s += "\"phoneDelegatedPubKey\":\(js(r.phoneDelegatedPubKeyHex.lowercased())),"
        s += "\"registrationUrl\":\(js(r.registrationUrl)),"
        s += "\"authCode\":{"
        s += "\"version\":\(r.authCode.version),"
        s += "\"serial\":\(js(r.authCode.serial)),"
        s += "\"username\":\(js(r.authCode.username)),"
        s += "\"serverName\":\(js(r.authCode.serverName)),"
        s += "\"serverDomain\":\(js(r.authCode.serverDomain)),"
        s += "\"delegatedPubKey\":\(js(r.authCode.delegatedPubKeyHex.lowercased())),"
        s += "\"userPubKey\":\(js(r.authCode.userPubKeyHex.lowercased())),"
        s += "\"issuedAt\":\(r.authCode.issuedAt),"
        s += "\"expiresAt\":\(r.authCode.expiresAt)"
        s += "},"
        s += "\"authCodeUserSignature\":\(js(r.authCodeUserSignatureHex.lowercased())),"
        s += "\"installerGitRef\":\(js(r.installerGitRef)),"
        s += "\"rckPubKey\":\(js(r.rckPubKeyHex.lowercased()))"
        s += "}"
        return Data(s.utf8)
    }

    /// Minimal JSON string encoder matching JSON.stringify for the characters
    /// that appear in recipe fields (escapes ", \\, and control chars).
    private static func js(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    private static func u32le(_ n: UInt32) -> Data {
        Data([UInt8(n & 0xff), UInt8((n >> 8) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 24) & 0xff)])
    }
    private static func u32be(_ n: UInt32) -> Data {
        Data([UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)])
    }
    private static func readU16le(_ d: Data) -> UInt16 {
        guard d.count >= 2 else { return 0 }
        return UInt16(d[d.startIndex]) | (UInt16(d[d.startIndex + 1]) << 8)
    }
}
