#if canImport(Virtualization)
import Foundation
import FlagshipBuilderCore

/// Hidden signed-build harness for producing a generalized raw appliance on a
/// Mac. The Node CLI first remasters a stock Debian ISO with the secret-free
/// factory preseed; this entitled process boots it under Virtualization.framework
/// and promotes the powered-off installed disk only after a plausible runtime.
@MainActor
enum VMFactory {
    static func run(_ args: [String]) -> Never {
        do { try main(args) }
        catch {
            FileHandle.standardError.write(Data("vm-appliance-factory: \(error)\n".utf8))
            exit(2)
        }
        RunLoop.main.run()
        exit(0)
    }

    private enum FactoryError: LocalizedError {
        case usage
        case outputExists(String)
        case stoppedTooFast(Int)

        var errorDescription: String? {
            switch self {
            case .usage:
                return "usage: --vm-appliance-factory (--factory-iso <iso> | --cloud-base-raw <raw> --factory-seed <iso>) --output <base.raw> [--disk-gib 8] [--timeout 3600]"
            case .outputExists(let path): return "refusing to replace existing output: \(path)"
            case .stoppedTooFast(let seconds): return "factory VM stopped after only \(seconds)s"
            }
        }
    }

    private static func main(_ args: [String]) throws {
        var values: [String: String] = [:]
        var index = 0
        while index < args.count {
            let key = args[index]
            guard key.hasPrefix("--"), index + 1 < args.count else { throw FactoryError.usage }
            values[String(key.dropFirst(2))] = args[index + 1]
            index += 2
        }
        guard let outputPath = values["output"] else {
            throw FactoryError.usage
        }
        let installerIsoPath: String
        let cloudBasePath: String?
        if let iso = values["factory-iso"], values["cloud-base-raw"] == nil,
           values["factory-seed"] == nil {
            installerIsoPath = iso
            cloudBasePath = nil
        } else if let base = values["cloud-base-raw"], let seed = values["factory-seed"],
                  values["factory-iso"] == nil {
            installerIsoPath = seed
            cloudBasePath = base
        } else {
            throw FactoryError.usage
        }
        let iso = URL(fileURLWithPath: installerIsoPath)
        let output = URL(fileURLWithPath: outputPath)
        guard !FileManager.default.fileExists(atPath: output.path) else {
            throw FactoryError.outputExists(output.path)
        }
        let diskGiB = UInt64(values["disk-gib"] ?? "8") ?? 8
        let timeout = TimeInterval(values["timeout"] ?? "3600") ?? 3600
        let root = values["work-dir"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("flagship-appliance-factory-\(UUID().uuidString)", isDirectory: true)
        let layout = VMBundleLayout(root: root)
        let name = "factory.flagship.invalid"
        try FileManager.default.createDirectory(
            at: layout.bundleDir(name), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: iso, to: layout.installerISOURL(name))
        let config = VMConfig(
            name: name, serverDomain: name, username: "factory", serverName: "base",
            cpuCount: max(2, min(ProcessInfo.processInfo.processorCount, 8)),
            memoryBytes: min(8, max(4, ProcessInfo.processInfo.physicalMemory / VMResourcePlan.gib / 3)) * VMResourcePlan.gib,
            mainDiskSizeBytes: diskGiB * VMResourcePlan.gib,
            networkMode: .nat, serialConsoleEnabled: true, bootUnlockMode: "auto",
            diskEncrypted: true, provisioningMode: .installerISO)
        let promotedDisk: URL
        let additionalDisk: URL?
        if let cloudBasePath {
            try FileManager.default.copyItem(
                at: URL(fileURLWithPath: cloudBasePath),
                to: layout.diskImageURL(name))
            let target = layout.bundleDir(name).appendingPathComponent("factory-target.raw")
            FileManager.default.createFile(atPath: target.path, contents: nil)
            let handle = try FileHandle(forWritingTo: target)
            try handle.truncate(atOffset: config.mainDiskSizeBytes)
            try handle.close()
            promotedDisk = target
            additionalDisk = target
        } else {
            try VZHost.ensureMainDisk(config: config, layout: layout)
            promotedDisk = layout.diskImageURL(name)
            additionalDisk = nil
        }

        let startedAt = Date()
        let host = VZHost()
        host.onGuestStopped = { error in
            if let error {
                FileHandle.standardError.write(Data("factory guest failed: \(error)\n".utf8))
                exit(3)
            }
            let elapsed = Date().timeIntervalSince(startedAt)
            guard elapsed >= VMLifecycle.minPlausibleInstallDuration else {
                FileHandle.standardError.write(Data("\(FactoryError.stoppedTooFast(Int(elapsed)).localizedDescription)\n".utf8))
                exit(4)
            }
            do {
                try FileManager.default.moveItem(at: promotedDisk, to: output)
                try? FileManager.default.removeItem(at: root)
                print("generalized appliance ready: \(output.path) (\(Int(elapsed))s)")
                fflush(stdout)
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("could not promote factory disk: \(error)\n".utf8))
                exit(5)
            }
        }
        Task { @MainActor in
            do {
                try await host.start(
                    config: config,
                    layout: layout,
                    attachInstallerISO: true,
                    additionalWritableDisk: additionalDisk)
                if let console = host.consoleOutput {
                    console.readabilityHandler = { handle in
                        let data = handle.availableData
                        if !data.isEmpty { FileHandle.standardOutput.write(data) }
                    }
                }
                if let console = host.consoleInput {
                    FileHandle.standardInput.readabilityHandler = { handle in
                        let data = handle.availableData
                        if !data.isEmpty { console.write(data) }
                    }
                }
            } catch {
                FileHandle.standardError.write(Data("factory VM failed to start: \(error)\n".utf8))
                exit(3)
            }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            FileHandle.standardError.write(Data("factory VM timed out after \(Int(timeout))s\n".utf8))
            try? await host.forceStop()
            exit(6)
        }
    }
}
#endif
