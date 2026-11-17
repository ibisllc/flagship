import Foundation

/// The unsigned big integers the voucher client needs (RFC 9474 blinding, unblinding and PSS verification with the
/// public exponent): multiply, divide (Knuth's algorithm D), modular power and inverse. Never used with a private
/// exponent, so constant time is not a goal. Limbs are UInt32, least significant first, with no high zero limbs.
struct VoucherBigUInt: Equatable, Comparable, Sendable {
    private(set) var limbs: [UInt32]

    init(limbs: [UInt32]) {
        var l = limbs
        while let last = l.last, last == 0 { l.removeLast() }
        self.limbs = l
    }

    init(_ v: UInt64) { self.init(limbs: [UInt32(truncatingIfNeeded: v), UInt32(truncatingIfNeeded: v >> 32)]) }

    /// Big-endian bytes.
    init(bytes: [UInt8]) {
        var out = [UInt32](repeating: 0, count: (bytes.count + 3) / 4)
        for (i, b) in bytes.reversed().enumerated() { out[i / 4] |= UInt32(b) << (8 * UInt32(i % 4)) }
        self.init(limbs: out)
    }

    /// Lowercase or uppercase hex, any length (empty is 0).
    init?(hex: String) {
        var s = Array(hex.utf8)
        if s.count % 2 == 1 { s.insert(0x30, at: 0) }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(s.count / 2)
        var i = 0
        while i < s.count {
            guard let hi = Self.nibble(s[i]), let lo = Self.nibble(s[i + 1]) else { return nil }
            bytes.append(hi << 4 | lo)
            i += 2
        }
        self.init(bytes: bytes)
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }

    static let zero = VoucherBigUInt(limbs: [])
    static let one = VoucherBigUInt(limbs: [1])

    var isZero: Bool { limbs.isEmpty }

    var bitLength: Int {
        guard let top = limbs.last else { return 0 }
        return (limbs.count - 1) * 32 + (32 - top.leadingZeroBitCount)
    }

    /// Big-endian, left-padded to `count` bytes; nil when it doesn't fit.
    func bytes(count: Int) -> [UInt8]? {
        var out = [UInt8](repeating: 0, count: count)
        for (i, l) in limbs.enumerated() {
            for k in 0..<4 {
                let byte = UInt8(truncatingIfNeeded: l >> (8 * UInt32(k)))
                let pos = i * 4 + k
                if pos >= count { if byte != 0 { return nil } else { continue } }
                out[count - 1 - pos] = byte
            }
        }
        return out
    }

    /// Lowercase hex of the minimal whole bytes (`toString(16)` padded to even length; "" is never produced: 0 is "00").
    var evenHex: String {
        let n = max(1, (bitLength + 7) / 8)
        return CanonicalJson.hex(bytes(count: n) ?? [])
    }

    static func < (a: VoucherBigUInt, b: VoucherBigUInt) -> Bool {
        if a.limbs.count != b.limbs.count { return a.limbs.count < b.limbs.count }
        for i in stride(from: a.limbs.count - 1, through: 0, by: -1) where a.limbs[i] != b.limbs[i] {
            return a.limbs[i] < b.limbs[i]
        }
        return false
    }

    static func + (a: VoucherBigUInt, b: VoucherBigUInt) -> VoucherBigUInt {
        let n = max(a.limbs.count, b.limbs.count)
        var out = [UInt32](repeating: 0, count: n + 1)
        var carry: UInt64 = 0
        for i in 0..<n {
            let s = UInt64(i < a.limbs.count ? a.limbs[i] : 0) + UInt64(i < b.limbs.count ? b.limbs[i] : 0) + carry
            out[i] = UInt32(truncatingIfNeeded: s)
            carry = s >> 32
        }
        out[n] = UInt32(carry)
        return VoucherBigUInt(limbs: out)
    }

    /// a - b for a >= b.
    static func - (a: VoucherBigUInt, b: VoucherBigUInt) -> VoucherBigUInt {
        precondition(!(a < b), "negative result")
        var out = a.limbs
        var borrow: Int64 = 0
        for i in 0..<out.count {
            let t = Int64(out[i]) - Int64(i < b.limbs.count ? b.limbs[i] : 0) - borrow
            out[i] = UInt32(truncatingIfNeeded: t)
            borrow = t < 0 ? 1 : 0
        }
        return VoucherBigUInt(limbs: out)
    }

    static func * (a: VoucherBigUInt, b: VoucherBigUInt) -> VoucherBigUInt {
        if a.isZero || b.isZero { return .zero }
        var out = [UInt32](repeating: 0, count: a.limbs.count + b.limbs.count)
        for i in 0..<a.limbs.count {
            var carry: UInt64 = 0
            let ai = UInt64(a.limbs[i])
            for j in 0..<b.limbs.count {
                let t = ai * UInt64(b.limbs[j]) + UInt64(out[i + j]) + carry
                out[i + j] = UInt32(truncatingIfNeeded: t)
                carry = t >> 32
            }
            out[i + b.limbs.count] = UInt32(carry)
        }
        return VoucherBigUInt(limbs: out)
    }

    /// Quotient and remainder (Knuth D, Hacker's Delight `divmnu`).
    static func divMod(_ u: VoucherBigUInt, _ v: VoucherBigUInt) -> (q: VoucherBigUInt, r: VoucherBigUInt) {
        precondition(!v.isZero, "division by zero")
        if u < v { return (.zero, u) }
        let n = v.limbs.count
        if n == 1 {
            let d = UInt64(v.limbs[0])
            var q = [UInt32](repeating: 0, count: u.limbs.count)
            var r: UInt64 = 0
            for i in stride(from: u.limbs.count - 1, through: 0, by: -1) {
                let cur = (r << 32) | UInt64(u.limbs[i])
                q[i] = UInt32(cur / d)
                r = cur % d
            }
            return (VoucherBigUInt(limbs: q), VoucherBigUInt(r))
        }
        let m = u.limbs.count - n
        let s = UInt32(v.limbs[n - 1].leadingZeroBitCount)
        var vn = [UInt32](repeating: 0, count: n)
        for i in stride(from: n - 1, to: 0, by: -1) {
            vn[i] = s == 0 ? v.limbs[i] : (v.limbs[i] << s) | (v.limbs[i - 1] >> (32 - s))
        }
        vn[0] = v.limbs[0] << s
        var un = [UInt32](repeating: 0, count: u.limbs.count + 1)
        un[u.limbs.count] = s == 0 ? 0 : u.limbs[u.limbs.count - 1] >> (32 - s)
        for i in stride(from: u.limbs.count - 1, to: 0, by: -1) {
            un[i] = s == 0 ? u.limbs[i] : (u.limbs[i] << s) | (u.limbs[i - 1] >> (32 - s))
        }
        un[0] = u.limbs[0] << s
        var q = [UInt32](repeating: 0, count: m + 1)
        let b: UInt64 = 1 << 32
        for j in stride(from: m, through: 0, by: -1) {
            let num = (UInt64(un[j + n]) << 32) | UInt64(un[j + n - 1])
            var qhat = num / UInt64(vn[n - 1])
            var rhat = num % UInt64(vn[n - 1])
            while qhat >= b || qhat * UInt64(vn[n - 2]) > ((rhat << 32) | UInt64(un[j + n - 2])) {
                qhat -= 1
                rhat += UInt64(vn[n - 1])
                if rhat >= b { break }
            }
            var k: Int64 = 0
            var t: Int64 = 0
            for i in 0..<n {
                let p = qhat * UInt64(vn[i])
                t = Int64(un[i + j]) - k - Int64(p & 0xffff_ffff)
                un[i + j] = UInt32(truncatingIfNeeded: t)
                k = Int64(p >> 32) - (t >> 32)
            }
            t = Int64(un[j + n]) - k
            un[j + n] = UInt32(truncatingIfNeeded: t)
            q[j] = UInt32(truncatingIfNeeded: qhat)
            if t < 0 {
                q[j] = q[j] &- 1
                k = 0
                for i in 0..<n {
                    t = Int64(un[i + j]) + Int64(vn[i]) + k
                    un[i + j] = UInt32(truncatingIfNeeded: t)
                    k = t >> 32
                }
                un[j + n] = UInt32(truncatingIfNeeded: Int64(un[j + n]) + k)
            }
        }
        var r = [UInt32](repeating: 0, count: n)
        for i in 0..<n {
            r[i] = s == 0 ? un[i] : (un[i] >> s) | (un[i + 1] << (32 - s))
        }
        return (VoucherBigUInt(limbs: q), VoucherBigUInt(limbs: r))
    }

    static func % (a: VoucherBigUInt, m: VoucherBigUInt) -> VoucherBigUInt { divMod(a, m).r }

    func modPow(_ exp: VoucherBigUInt, _ m: VoucherBigUInt) -> VoucherBigUInt {
        var result = VoucherBigUInt.one % m
        var base = self % m
        let bits = exp.bitLength
        for i in 0..<bits {
            if (exp.limbs[i / 32] >> UInt32(i % 32)) & 1 == 1 { result = (result * base) % m }
            if i + 1 < bits { base = (base * base) % m }
        }
        return result
    }

    static func gcd(_ a: VoucherBigUInt, _ b: VoucherBigUInt) -> VoucherBigUInt {
        var (x, y) = (a, b)
        while !y.isZero { (x, y) = (y, x % y) }
        return x
    }

    /// The inverse of `self` modulo `m` (extended Euclid with the coefficients kept modulo `m`), nil when none exists.
    func modInverse(_ m: VoucherBigUInt) -> VoucherBigUInt? {
        var (oldR, r) = (self % m, m)
        var (oldS, s) = (VoucherBigUInt.one, VoucherBigUInt.zero)
        while !r.isZero {
            let (q, rem) = Self.divMod(oldR, r)
            (oldR, r) = (r, rem)
            // newS = oldS - q*s (mod m)
            let qs = (q * s) % m
            let newS = oldS < qs ? (oldS + m) - qs : oldS - qs
            (oldS, s) = (s, newS)
        }
        guard oldR == .one else { return nil }
        return oldS % m
    }
}
