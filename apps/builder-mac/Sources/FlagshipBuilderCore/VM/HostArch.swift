import Foundation

/// Which base-ISO architecture this Mac's SILICON needs when hosting a VM.
/// Burning always targets amd64 (real boxes are x86) — this exists only for
/// the host-on-this-Mac path, where Virtualization.framework boots
/// native-arch guests only.
public enum HostArch {
    /// Rosetta-safe: `#if arch(arm64)` and `utsname.machine` report the
    /// PROCESS architecture, so an x86_64-translated build on an
    /// Apple-silicon Mac would fetch an amd64 base the VM can't boot. Ask the
    /// kernel about the hardware instead: `hw.optional.arm64` is 1 on Apple
    /// silicon regardless of translation, and doesn't exist on Intel Macs.
    public static func current() -> IsoArch {
        isoArch(hwOptionalArm64: readHwOptionalArm64())
    }

    /// Pure mapping, seam for tests. nil = the sysctl doesn't exist (Intel).
    static func isoArch(hwOptionalArm64: Bool?) -> IsoArch {
        hwOptionalArm64 == true ? .arm64 : .amd64
    }

    static func readHwOptionalArm64() -> Bool? {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0 else { return nil }
        return value == 1
    }
}
