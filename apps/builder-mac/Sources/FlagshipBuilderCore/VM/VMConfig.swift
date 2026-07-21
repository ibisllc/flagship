import Foundation

public enum VMNetworkMode: String, Codable, Sendable, Equatable {
    /// Shared NAT (VZNATNetworkDeviceAttachment) — the guest gets outbound
    /// internet with zero host configuration, which is all the appliance needs
    /// (it dials OUT to .com/.services; inbound arrives over the tunnel).
    /// Bridged mode (com.apple.vm.networking) is future work.
    case nat
}

/// The deterministic spec for one hosted VM — a pure function of the recipe +
/// host resources. All decisions live HERE; the VZ adapter merely translates
/// this into a VZVirtualMachineConfiguration.
public struct VMConfig: Codable, Sendable, Equatable {
    /// Stable identifier + bundle-directory name. The server FQDN — already a
    /// hostname, so filesystem-safe, and unique per server.
    public let name: String
    public let serverDomain: String
    public let username: String
    public let serverName: String
    public let cpuCount: Int
    public let memoryBytes: UInt64
    public let mainDiskSizeBytes: UInt64
    public let networkMode: VMNetworkMode
    /// True iff the recipe carries the unsigned `debugGrant` sibling. Gates the
    /// serial console: a production VM gets NO console device at all. This
    /// mirrors the builder's debug-access hard guardrail — the host app must
    /// NEVER mount a production VM's disk or inject users to get around it;
    /// console access is gated on the phone-signed grant, period.
    public let serialConsoleEnabled: Bool
    /// From the SIGNED blob: "auto" | "approve" (absent ⇒ "auto").
    public let bootUnlockMode: String
    /// From the SIGNED blob: whether the guest root is LUKS-encrypted.
    public let diskEncrypted: Bool
    /// Random order capability used only while the unattended guest install is
    /// running, so Studio can read the same privacy-safe checkpoints the phone
    /// sees. It never grants access to the server or its content.
    public let provisionStatusSerial: String?

    /// Whether a boot passes through the sealed "waiting for you to unlock"
    /// state: an encrypted guest halts in the initramfs until the phone-home
    /// unlock supplies the key (auto = a held lease answers, approve = the
    /// owner taps). An unencrypted guest boots straight through.
    public var awaitsPhoneUnlockAtBoot: Bool { diskEncrypted }

    public func clearingProvisionStatusSerial() -> VMConfig {
        VMConfig(
            name: name,
            serverDomain: serverDomain,
            username: username,
            serverName: serverName,
            cpuCount: cpuCount,
            memoryBytes: memoryBytes,
            mainDiskSizeBytes: mainDiskSizeBytes,
            networkMode: networkMode,
            serialConsoleEnabled: serialConsoleEnabled,
            bootUnlockMode: bootUnlockMode,
            diskEncrypted: diskEncrypted,
            provisionStatusSerial: nil)
    }

    public init(name: String,
                serverDomain: String,
                username: String,
                serverName: String,
                cpuCount: Int,
                memoryBytes: UInt64,
                mainDiskSizeBytes: UInt64,
                networkMode: VMNetworkMode,
                serialConsoleEnabled: Bool,
                bootUnlockMode: String,
                diskEncrypted: Bool,
                provisionStatusSerial: String? = nil) {
        self.name = name
        self.serverDomain = serverDomain
        self.username = username
        self.serverName = serverName
        self.cpuCount = cpuCount
        self.memoryBytes = memoryBytes
        self.mainDiskSizeBytes = mainDiskSizeBytes
        self.networkMode = networkMode
        self.serialConsoleEnabled = serialConsoleEnabled
        self.bootUnlockMode = bootUnlockMode
        self.diskEncrypted = diskEncrypted
        self.provisionStatusSerial = provisionStatusSerial
    }

    /// Build the spec for a verified recipe on this host. Deterministic: the
    /// same recipe bytes + host always produce the same config.
    ///
    /// `recipeJSON` is the RAW recipe document (needed for the unsigned
    /// `debugGrant` sibling, which the parsed `Recipe` deliberately omits).
    public static func plan(recipe: Recipe,
                            recipeJSON: Data,
                            host: HostResources,
                            mainDiskSizeBytes: UInt64 = VMResourcePlan.defaultMainDiskSizeBytes) -> VMConfig {
        VMConfig(
            name: recipe.serverDomain,
            serverDomain: recipe.serverDomain,
            username: recipe.username,
            serverName: recipe.serverName,
            cpuCount: VMResourcePlan.vmCPUCount(host: host),
            memoryBytes: VMResourcePlan.vmMemoryBytes(host: host),
            mainDiskSizeBytes: mainDiskSizeBytes,
            networkMode: .nat,
            serialConsoleEnabled: RecipeSiblings.debugGrant(inRecipeJSON: recipeJSON) != nil,
            bootUnlockMode: recipe.effectiveBootUnlockMode,
            diskEncrypted: recipe.encryptsDisk,
            provisionStatusSerial: recipe.authCode.serial)
    }
}
