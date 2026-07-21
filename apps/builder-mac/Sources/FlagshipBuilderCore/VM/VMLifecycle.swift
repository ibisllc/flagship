import Foundation

/// One hosted VM's lifecycle — pure and event-driven. The host (VZ adapter /
/// UI) feeds it events and executes the effects it returns; nothing in here
/// touches Virtualization.framework, the filesystem, or a real clock.
///
///     created ──startInstall──▶ installing (installer ISO attached)
///     installing ──installSucceeded──▶ installed (ISO DETACHED — from here
///                                       the guest boots from its own disk)
///     installed/stopped ──powerOn──▶ awaitingPhoneUnlock   (encrypted guest:
///                                       sealed in the initramfs until the
///                                       phone-home unlock answers)
///                              └────▶ running              (unencrypted guest)
///     awaitingPhoneUnlock ──guestUnlocked──▶ running
///     running/awaitingPhoneUnlock ──powerOff──▶ stopped
///     + failure states (install / run), each retryable.

public struct VMFailure: Codable, Sendable, Equatable {
    public enum Phase: String, Codable, Sendable {
        case install
        case run
    }
    public let phase: Phase
    public let reason: String

    public init(phase: Phase, reason: String) {
        self.phase = phase
        self.reason = reason
    }
}

public enum VMState: Codable, Sendable, Equatable {
    case created
    case installing
    case installed
    case awaitingPhoneUnlock
    case running
    case stopped
    case failed(VMFailure)

    /// User-facing status label (sidebar / detail).
    public var label: String {
        switch self {
        case .created: return "Created"
        case .installing: return "Installing…"
        case .installed: return "Installed"
        case .awaitingPhoneUnlock: return "Waiting for you to unlock"
        case .running: return "Running"
        case .stopped: return "Stopped"
        case .failed(let f):
            switch f.phase {
            case .install: return "Install failed"
            case .run: return "Stopped unexpectedly"
            }
        }
    }
}

public enum VMEvent: Sendable, Equatable {
    /// Begin (or retry) the unattended install from the remastered ISO.
    case startInstall
    /// The installer ran to completion (the guest powered itself off).
    case installSucceeded
    case installFailed(String)
    /// Boot the installed guest from its main disk.
    case powerOn
    /// The sealed guest's phone-home unlock completed (owner approved / a
    /// lease answered) and the guest is up.
    case guestUnlocked
    /// The guest stopped (user action or a clean guest shutdown).
    case powerOff
    case runtimeFailed(String)
}

/// Side effects the caller must perform, in order. The state machine decides;
/// the VZ layer obeys.
public enum VMEffect: Sendable, Equatable {
    case attachInstallerISO
    case detachInstallerISO
    case startVirtualMachine
    case stopVirtualMachine
}

public enum VMLifecycleError: Error, Equatable {
    case invalidTransition(from: VMState, on: VMEvent)
}

public struct VMLifecycle: Sendable {
    public private(set) var state: VMState
    /// When the current state was entered (via the injected clock).
    public private(set) var stateChangedAt: Date

    /// From VMConfig.awaitsPhoneUnlockAtBoot: whether powering on an installed
    /// guest lands in the sealed awaiting-phone-unlock state first.
    public let sealedAtBoot: Bool
    private let clock: @Sendable () -> Date

    public init(state: VMState = .created,
                sealedAtBoot: Bool,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.state = state
        self.sealedAtBoot = sealedAtBoot
        self.clock = clock
        self.stateChangedAt = clock()
    }

    /// Apply one event. Returns the effects to execute; throws on an event
    /// that is meaningless in the current state (a programming error or a
    /// stale caller — never silently swallowed).
    @discardableResult
    public mutating func handle(_ event: VMEvent) throws -> [VMEffect] {
        let (next, effects) = try transition(for: event)
        state = next
        stateChangedAt = clock()
        return effects
    }

    private func transition(for event: VMEvent) throws -> (VMState, [VMEffect]) {
        switch (state, event) {
        case (.created, .startInstall):
            return (.installing, [.attachInstallerISO, .startVirtualMachine])
        case (.failed(let f), .startInstall) where f.phase == .install:
            return (.installing, [.attachInstallerISO, .startVirtualMachine])

        case (.installing, .installSucceeded):
            // The install→first-boot seam: the ISO comes OFF here so every
            // subsequent boot is from the guest's own disk.
            return (.installed, [.detachInstallerISO])
        case (.installing, .installFailed(let reason)):
            return (.failed(VMFailure(phase: .install, reason: reason)),
                    [.stopVirtualMachine, .detachInstallerISO])

        case (.installed, .powerOn), (.stopped, .powerOn):
            return (sealedAtBoot ? .awaitingPhoneUnlock : .running, [.startVirtualMachine])
        case (.failed(let f), .powerOn) where f.phase == .run:
            return (sealedAtBoot ? .awaitingPhoneUnlock : .running, [.startVirtualMachine])

        case (.awaitingPhoneUnlock, .guestUnlocked):
            return (.running, [])
        case (.awaitingPhoneUnlock, .powerOff), (.running, .powerOff):
            return (.stopped, [.stopVirtualMachine])
        case (.awaitingPhoneUnlock, .runtimeFailed(let reason)),
             (.running, .runtimeFailed(let reason)):
            return (.failed(VMFailure(phase: .run, reason: reason)), [])

        default:
            throw VMLifecycleError.invalidTransition(from: state, on: event)
        }
    }
}

// MARK: - Install-stop interpretation (the reboot/poweroff/never-booted seam)

extension VMLifecycle {
    /// The minimum wall-clock time from entering `.installing` for a CLEAN
    /// (no-error) guest self-stop to plausibly mean "the unattended install
    /// finished". A real Debian-preseed install takes many minutes; a clean
    /// stop faster than this means the guest did NOT install:
    ///
    ///   - it failed to boot at all — e.g. an amd64 base image on an
    ///     Apple-silicon host, which VZ cannot run: the VM stops ~0.3s after
    ///     start with `error=nil` (observed during Phase-0 hardware bring-up);
    ///   - or the installer rebooted very early (a mid-install failure).
    ///
    /// The seam must NOT read such a fast clean stop as success, or a VM that
    /// never ran an install is reported "Installed" and then boots an empty
    /// disk. Only a clean stop after a plausible duration is a real install
    /// completion — and that is true whether the finished installer POWERED OFF
    /// or REBOOTED (VZ surfaces both as a delegate `guestDidStop`, so the
    /// distinction is duration, not the stop kind).
    public static let minPlausibleInstallDuration: TimeInterval = 90

    public enum InstallStopVerdict: Equatable, Sendable {
        case installed
        case failedTooFast(elapsed: TimeInterval)
    }

    /// Interpret a clean guest self-stop observed while `.installing`.
    /// `installStartedAt` is when `.installing` was entered (this lifecycle's
    /// `stateChangedAt`); `now` from the caller's clock.
    public static func verdictForCleanInstallStop(installStartedAt: Date,
                                                  now: Date) -> InstallStopVerdict {
        let elapsed = now.timeIntervalSince(installStartedAt)
        return elapsed >= minPlausibleInstallDuration
            ? .installed
            : .failedTooFast(elapsed: elapsed)
    }

    /// A sealed guest awaiting phone-unlock should come online within a few
    /// minutes; past this it has very likely failed to reach the network (e.g. a
    /// first-boot NIC/DHCP failure) and would otherwise spin on "Waiting for you
    /// to unlock" forever with no hint. The UI keeps polling, but past this
    /// threshold it surfaces an advisory instead of an indefinite spinner.
    public static let comingUpStallThreshold: TimeInterval = 8 * 60

    /// True iff a hosted server has been sealed + awaiting unlock past the stall
    /// threshold. Pure so the view can evaluate it against a live `now`.
    public static func comingUpIsStalled(state: VMState, elapsed: TimeInterval) -> Bool {
        state == .awaitingPhoneUnlock && elapsed >= comingUpStallThreshold
    }
}
