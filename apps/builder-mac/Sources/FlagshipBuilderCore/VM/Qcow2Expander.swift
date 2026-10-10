import Compression
import CryptoKit
import Foundation

/// Read access to bytes that may be spread across several files (the
/// appliance is distributed as fixed-size parts and is never concatenated on
/// disk, which would double its footprint).
public protocol RandomAccessSource {
    var size: UInt64 { get }
    func read(at offset: UInt64, count: Int) throws -> Data
}

public final class MultiPartSource: RandomAccessSource {
    private let handles: [FileHandle]
    private let starts: [UInt64]
    public let size: UInt64

    public init(parts: [URL]) throws {
        var handles: [FileHandle] = []
        var starts: [UInt64] = []
        var offset: UInt64 = 0
        for url in parts {
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            let length = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
            handles.append(try FileHandle(forReadingFrom: url))
            starts.append(offset)
            offset += length
        }
        self.handles = handles
        self.starts = starts
        self.size = offset
    }

    deinit { handles.forEach { try? $0.close() } }

    public func read(at offset: UInt64, count: Int) throws -> Data {
        guard count > 0, offset < size else { return Data() }
        var out = Data(capacity: count)
        var position = offset
        var remaining = UInt64(min(UInt64(count), size - offset))
        var index = (starts.lastIndex { $0 <= position }) ?? 0
        while remaining > 0, index < handles.count {
            let end = index + 1 < starts.count ? starts[index + 1] : size
            let take = min(remaining, end - position)
            try handles[index].seek(toOffset: position - starts[index])
            let chunk = try handles[index].read(upToCount: Int(take)) ?? Data()
            guard chunk.count == Int(take) else { throw Qcow2Error.truncated }
            out.append(chunk)
            position += take
            remaining -= take
            index += 1
        }
        return out
    }
}

public enum Qcow2Error: LocalizedError, Equatable {
    case notQcow2
    case unsupported(String)
    case truncated
    case corruptCluster(UInt64)

    public var errorDescription: String? {
        switch self {
        case .notQcow2: return "The VM image is not a qcow2 file."
        case .unsupported(let what): return "The VM image uses an unsupported qcow2 feature: \(what)."
        case .truncated: return "The VM image is truncated."
        case .corruptCluster(let offset): return "The VM image has an unreadable block at offset \(offset)."
        }
    }
}

/// Expands a qcow2 image (as written by `qemu-img convert -c -O qcow2`) into a
/// sparse raw disk and returns the SHA-256 of the full raw image, so Studio
/// needs no qemu-img. Supports v2/v3, zlib-compressed and plain clusters, and
/// zero clusters; refuses backing files, encryption, external data files,
/// extended L2 entries and non-zlib compression.
public enum Qcow2Expander {
    public static func expand(source: RandomAccessSource,
                              to output: URL,
                              progress: (Double) -> Void = { _ in }) throws -> (sha256: String, sizeBytes: UInt64) {
        let header = try Header(source.read(at: 0, count: 112))
        let clusterSize = 1 << header.clusterBits
        let l2Entries = clusterSize / 8

        FileManager.default.createFile(atPath: output.path, contents: nil)
        let out = try FileHandle(forWritingTo: output)
        defer { try? out.close() }
        try out.truncate(atOffset: header.virtualSize)

        let l1 = try source.read(at: header.l1Offset, count: Int(header.l1Size) * 8)
        guard l1.count == Int(header.l1Size) * 8 else { throw Qcow2Error.truncated }

        var hasher = SHA256()
        let zeroCluster = Data(count: clusterSize)
        let totalClusters = (header.virtualSize + UInt64(clusterSize) - 1) / UInt64(clusterSize)
        var guestCluster: UInt64 = 0

        for l1Index in 0..<Int(header.l1Size) {
            guard guestCluster < totalClusters else { break }
            let l2Offset = l1.beUInt64(at: l1Index * 8) & 0x00ff_ffff_ffff_fe00
            let l2 = l2Offset == 0
                ? nil
                : try source.read(at: l2Offset, count: clusterSize)
            if let l2, l2.count != clusterSize { throw Qcow2Error.truncated }
            for l2Index in 0..<l2Entries {
                guard guestCluster < totalClusters else { break }
                let guestOffset = guestCluster * UInt64(clusterSize)
                let length = Int(min(UInt64(clusterSize), header.virtualSize - guestOffset))
                let entry = l2?.beUInt64(at: l2Index * 8) ?? 0
                let data = try cluster(entry: entry, header: header, clusterSize: clusterSize, source: source)
                if let data, data.contains(where: { $0 != 0 }) {
                    let slice = data.prefix(length)
                    try out.seek(toOffset: guestOffset)
                    try out.write(contentsOf: slice)
                    hasher.update(data: slice)
                } else {
                    hasher.update(data: zeroCluster.prefix(length))
                }
                guestCluster += 1
            }
            progress(Double(guestCluster) / Double(totalClusters))
        }
        let sha = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return (sha, header.virtualSize)
    }

    private static func cluster(entry: UInt64,
                                header: Header,
                                clusterSize: Int,
                                source: RandomAccessSource) throws -> Data? {
        if entry & (1 << 62) != 0 {
            let shift = 62 - (header.clusterBits - 8)
            let offsetMask = (UInt64(1) << shift) - 1
            let hostOffset = entry & offsetMask
            let sectors = ((entry & ((UInt64(1) << 62) - 1)) >> shift) + 1
            let compressedSize = Int(sectors * 512 - (hostOffset & 511))
            let compressed = try source.read(at: hostOffset,
                                             count: min(compressedSize, Int(source.size - min(source.size, hostOffset))))
            var decoded = Data(count: clusterSize)
            let written = decoded.withUnsafeMutableBytes { dst in
                compressed.withUnsafeBytes { src in
                    compression_decode_buffer(
                        dst.bindMemory(to: UInt8.self).baseAddress!, clusterSize,
                        src.bindMemory(to: UInt8.self).baseAddress!, compressed.count,
                        nil, COMPRESSION_ZLIB)
                }
            }
            guard written == clusterSize else { throw Qcow2Error.corruptCluster(hostOffset) }
            return decoded
        }
        if entry & 1 != 0 { return nil }
        let hostOffset = entry & 0x00ff_ffff_ffff_fe00
        if hostOffset == 0 { return nil }
        let data = try source.read(at: hostOffset, count: clusterSize)
        guard data.count == clusterSize else { throw Qcow2Error.truncated }
        return data
    }

    struct Header {
        let clusterBits: Int
        let virtualSize: UInt64
        let l1Size: UInt32
        let l1Offset: UInt64

        init(_ d: Data) throws {
            guard d.count >= 72, d.beUInt32(at: 0) == 0x5146_49fb else { throw Qcow2Error.notQcow2 }
            let version = d.beUInt32(at: 4)
            guard version == 2 || version == 3 else { throw Qcow2Error.unsupported("version \(version)") }
            guard d.beUInt64(at: 8) == 0 else { throw Qcow2Error.unsupported("backing file") }
            guard d.beUInt32(at: 32) == 0 else { throw Qcow2Error.unsupported("encryption") }
            let bits = Int(d.beUInt32(at: 20))
            guard (9...21).contains(bits) else { throw Qcow2Error.unsupported("cluster size 2^\(bits)") }
            if version == 3 {
                guard d.count >= 104 else { throw Qcow2Error.truncated }
                let incompatible = d.beUInt64(at: 72)
                // bit 0 (dirty refcounts) doesn't affect reading data.
                let refused: [(UInt64, String)] = [(1 << 1, "corrupt"), (1 << 2, "external data file"),
                                                   (1 << 4, "extended L2 entries")]
                for (bit, name) in refused where incompatible & bit != 0 {
                    throw Qcow2Error.unsupported(name)
                }
                let headerLength = d.beUInt32(at: 100)
                if incompatible & (1 << 3) != 0 || headerLength > 104 {
                    guard d.count > 104, d[d.startIndex + 104] == 0 else {
                        throw Qcow2Error.unsupported("non-zlib compression")
                    }
                }
            }
            clusterBits = bits
            virtualSize = d.beUInt64(at: 24)
            l1Size = d.beUInt32(at: 36)
            l1Offset = d.beUInt64(at: 40)
        }
    }
}

private extension Data {
    func beUInt32(at i: Int) -> UInt32 {
        self[startIndex + i ..< startIndex + i + 4].reduce(0) { ($0 << 8) | UInt32($1) }
    }
    func beUInt64(at i: Int) -> UInt64 {
        self[startIndex + i ..< startIndex + i + 8].reduce(0) { ($0 << 8) | UInt64($1) }
    }
}
