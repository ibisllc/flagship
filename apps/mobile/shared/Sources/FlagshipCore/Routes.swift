import Foundation
import FlagshipAPI

/// Typed navigation destinations per tab. Each NavigationStack inside the
/// RootShell uses one of these as its path element type so we get
/// type-safe deep-linking and zero stringly-typed navigation.
public enum HomeRoute: Hashable, Sendable {
    case serverDetail(podId: String)
    /// The Home "Own a .com?" notice → the name-dibs claim screen.
    case nameDibs
    /// "Add a server" — provisions a new box. Goes straight into the CreateServer
    /// flow: there's no chooser. Pairing is automatic (every control device sees
    /// every server), and taking over a transferred box is a link/QR ingestion
    /// (handled via the universal process-link path), not a menu option.
    case provisionServer
    /// The create flow opened by Studio's pairing link: once the server is
    /// designed it pairs with that Studio instead of scanning its QR.
    case provisionServerForBuilder(link: String)
    case installProgress(serial: String, name: String, description: String)
    /// Slice C — take over a transferred box, reached from a scanned/deep-linked
    /// (IRK-signed) transfer offer. Carries the offer JSON (`offerText`) so the
    /// `TransferAcquirerViewModel` mounts with it pre-ingested + verified. The
    /// screen shows a SEVERE confirmation (type-to-confirm + biometric) before
    /// the claim. Distinct from a top-level menu entry — take-over is always a
    /// link/QR ingestion, never a browsed action.
    case transferAcquirer(offerText: String)
    /// Share this server (docs/share-a-server.md §8): open a share link. Nil
    /// parts open the paste/scan entry.
    case acceptShare(shareId: String?, secretHex: String?)
    /// A server another account shared with this one.
    case sharedServer(shareId: String)
    /// One app on a shared server.
    case sharedApp(shareId: String, serviceId: String)
    /// Import a backup onto a new server, or send it to a server waiting for
    /// it (docs/server-backup-and-clone.md).
    case importBackup(targetFqdn: String?)

    public var builderLink: String? {
        if case .provisionServerForBuilder(let link) = self { return link }
        return nil
    }

    /// The flows that bring a server into the account (create, take over,
    /// co-manage, import a backup): only an admin device of the account may
    /// open them.
    public var addsServerToAccount: Bool {
        switch self {
        case .provisionServer, .provisionServerForBuilder, .transferAcquirer, .acceptShare, .importBackup: return true
        case .serverDetail, .nameDibs, .installProgress, .sharedServer, .sharedApp: return false
        }
    }
}

public enum AppsRoute: Hashable, Sendable {
    case appDetail(serviceId: String)
    /// Marketplace browse + per-listing detail (feat/marketplace).
    case marketplace
    case marketplaceDetail(creator: String, slug: String)
    /// Build-a-service chooser ("how do you want to build it?"). The new
    /// create-a-service entry; fans into the build modes below. Scratch
    /// routes on to `.vibeCodeProviderPick` (the existing vibe flow).
    case buildSource
    /// git build mode — paste a repo URL → fitness verdict → install /
    /// AI-adapt.
    case buildGit
    /// mcp build mode — connect Cursor/Cline with the user's own AI.
    case buildMcp
    /// Build-journal viewer. `buildId == nil` opens the list of past
    /// builds; non-nil opens that build's timeline directly.
    case buildJournal(buildId: String?)
    /// AI-key step — confirm or provide the BYOK key the box's model will
    /// use, BEFORE a box-AI build path runs. `purpose` decides what happens
    /// once a credential is chosen (the chosen credential itself rides an
    /// in-memory holder, not the route, since it's a secret). Only the
    /// box-model paths (scratch, git-adapt) route through here; marketplace
    /// + MCP skip it.
    case buildKey(purpose: BuildKeyPurpose)
    /// "Edit this service": change it with the AI chat or from an IDE.
    case editService(serviceId: String)
    /// Describe the change for the AI chat.
    case editDescribe(serviceId: String)
    /// Connect an IDE to a build that starts from the service's code.
    case editMcp(serviceId: String)
    case vibeCodeProviderPick
    case vibeCodeDescribe
    case vibeCodeGenerating(sessionId: String)
    /// W10 — vibe-code chat surface. Reached via push deep link
    /// `https://flagshipserver.com/app/vibecode/<sessionId>` when the AI needs the owner.
    case vibeCodeChat(sessionId: String)
    /// W10 — per-app env-var KV editor. Reached from the per-service
    /// detail screen's "Configure environment" menu item, OR from a
    /// marketplace install of an app that needs an LLM key — in which case
    /// `prefillName` carries the expected env-var name so the add-form opens
    /// with it filled in (the user only pastes the value, which is set on the
    /// box; flagshipserver.com never sees it).
    case serviceEnv(appId: String, creator: String, slug: String, prefillName: String? = nil)
    /// P8 — list of headless-Chromium tabs running for an app.
    case browserTabs(serviceId: String)
    /// P8 — the framebuffer viewer that streams a single tab.
    case browserViewer(serviceId: String, tabId: String)
    /// #92 — per-service access gating (docs/service-access-gating.md): the
    /// open ⇄ members-only toggle + the members list.
    /// Reached from the service-detail "Access control" row.
    case serviceAccess(serviceId: String)
    /// The owner's Database section (docs/app-apis.md §6): each store's tables.
    case appDatabase(serviceId: String)
    /// One table's rows, paged, with Export CSV.
    case appDatabaseTable(serviceId: String, store: String, table: String)
    /// Run SQL on one store (writes confirmed with Face ID).
    case appDatabaseQuery(serviceId: String, store: String)
}

/// What the AI-key step does once a credential is chosen. The credential
/// itself is NOT carried here (it's a secret held in an in-memory holder) —
/// only the downstream intent.
public enum BuildKeyPurpose: Hashable, Sendable {
    /// Start-from-scratch: seed the vibe-code describe → start flow with the
    /// chosen credential.
    case scratch
    /// Changing an installed service with the AI chat.
    case edit(serviceId: String)
    /// Git non-fit "Build with AI": run the adapt pass on this build with the
    /// chosen credential (keeps the 503 → fall-back-to-scratch path).
    case gitAdapt(buildId: String)
}

public enum ActivityRoute: Hashable, Sendable {
    /// The sealed-key RELAY approval surface (SecretRequestsContainer).
    case secretRequests
    case installProgress(serial: String)
    /// Activity-feed shortcut into Settings → Recovery → Re-attach
    /// progress. Separate path-stack entry so back-nav lands the user
    /// on Activity, not Settings.
    case postRecovery
    /// P5 — the dedicated full-page audit-log viewer, reached from the
    /// Activity feed's "View full audit log" row.
    case auditLog
}

public enum SettingsRoute: Hashable, Sendable {
    /// Settings → AI keys. View saved BYOK keys (masked slugs), add, delete.
    /// Device-local; never shows a full key.
    case aiKeys
    /// P7 — the dedicated tier-status / subscription screen, reached from
    /// the Settings "Subscription" nav row.
    case tierStatus
    /// Settings → "Claim your .com name" (name dibs; only while the window is open).
    case nameDibs
    case recovery
    /// Settings → Account security. TOTP enroll/disable, recovery codes, and
    /// the Watch delegate. Reached via the account-security row — previously
    /// unwired (the row fired a no-op handler and there was no route case, so
    /// `AccountSecurityScreen` was unreachable from iOS Settings: a parity gap
    /// with web + Android, surfaced by the UI gym).
    case accountSecurity
    case postRecoveryProgress
    /// "Back up your account key" — passphrase-encrypted `.flagshipkey`
    /// export of the whole UMK. Reached from Settings → Recovery.
    case keyfileBackup
    case about
    /// Phase 3b — ADMIN side of cross-device QR pairing. Settings →
    /// Devices → Add device. Shows a pairing QR (a `/join` universal
    /// link) and runs the admin relay role: derive SAS → confirm match
    /// → sign a DeviceAdmit → seal + send the UMK bundle.
    case addDevice
    /// Phase 3b — INCOMING side of cross-device QR pairing, when the app
    /// is ALREADY paired and a `/join` deeplink (or in-app scan) arrives.
    /// Carries the scanned pairing-link string; routes into the
    /// JoinAccountViewModel add-profile flow.
    case joinAccount(joinUrl: String)
    /// Phase 3b — the in-app scanner entry for the incoming side
    /// ("Scan a pairing code"), reached from Settings → Devices.
    case scanPairingCode
    case developer
    case privacy
    /// B7 — Replace-device FINALIZE surface. Reached after `initiate`
    /// returns `.pending`, or re-entered later while a rotation is in
    /// flight. Carries the server-reported `completesAt` (Unix ms) so the
    /// screen renders the 24-hour grace countdown and gates the Complete
    /// button until the window elapses. `nil` means "deadline unknown on
    /// this launch" (e.g. re-entered from a cold start where only the
    /// pending version survived) — the screen then lets the user attempt
    /// Complete and relies on the server's 425 to keep them waiting.
    case replaceDeviceFinalize(completesAt: Int64?)
    /// W3 — multi-profile picker; lists the clouds this phone is a
    /// member of and lets the user switch active profile.
    case profiles
    /// P9 — peer-backup management. Participation toggle + peer lists
    /// (backing you up / you back up) + shard health + repair status.
    case peerBackup
    /// P14 — "Remote" browser-pairing surface. Mints a
    /// 60-second pairing QR a desktop browser scans to become a 4-hour
    /// read-only companion of the user's account; lists + revokes
    /// active companions.
    case companionDock
    case companionDockApproval(link: String)
    /// P14 Phase 2 — "Companion requests" inbox. Lists unsigned write
    /// requests companions have forwarded to the owner; the owner
    /// approves (which IRK-signs + dispatches the destination call) or
    /// denies. Reached from Settings.
    case companionRequests
    /// Web-experience gating (docs/service-access-gating.md) — "Open secured
    /// sessions": the browser QR-login sessions THIS phone has authorized. Per
    /// row: serviceUrl / browserAgent / started-at + a debounced Refresh
    /// (online/offline) and a Stop (close + remove). Reached from Settings.
    case securedSessions
    /// Web-experience gating — "Process URL": a paste field that takes a
    /// `https://flagshipserver.com/access#…` link (or the raw "Get link" string) from a
    /// box's knock page and routes it into the same KnockAuthorize flow.
    case processUrl
    /// Last-device account-DEATH ceremony (docs/account-deletion-and-name-reclaim.md
    /// §2). Reached only when `SignOutPolicy.evaluate(...) == .deletionCeremony`
    /// (no cloud recovery AND this is the last device) after the confirm popup.
    /// Hosts the full-page irreversible warning → typed-username + biometric →
    /// owner-IRK self-delete bundle → local wipe → Welcome.
    case deleteAccount
}

/// The four top-level destinations. Both the iPhone TabView and the iPad
/// NavigationSplitView sidebar use this as the selection type.
public enum RootDestination: String, CaseIterable, Hashable, Identifiable, Sendable {
    case home, apps, activity, settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .home:     return "Home"
        case .apps:     return "Services"
        case .activity: return "Activity"
        case .settings: return "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .home:     return "house.fill"
        case .apps:     return "square.grid.2x2.fill"
        case .activity: return "waveform.path.ecg"
        case .settings: return "gearshape.fill"
        }
    }
}

/// Onboarding sub-routes. Welcome is the root; the leaf flows are
/// "create a new account" (Welcome → ChooseUsername → OpenAccount) and
/// "I already have an account" (Welcome → Recovery via WebAuthn-PRF →
/// the post-recovery choice). Both leave the user on the paired RootShell.
/// Provisioning a server is no longer part of onboarding — it's the
/// in-shell "Add a server" flow (HomeRoute.provisionServer).
public enum OnboardingRoute: Hashable, Sendable {
    case chooseUsername
    /// Open account — the Phase-2 step that decouples account identity
    /// from server provisioning. Generates the UMK, derives the IRK,
    /// POSTs a standalone `claimUsername`, and names this first device.
    /// On success the user lands on Home with ZERO servers; the
    /// create-server flow becomes a reusable "Add a server" from there
    /// (HomeRoute.provisionServer), so onboarding no longer carries a
    /// server-mint route.
    case openAccount(username: String)
    /// Skippable "Secure your account" step. Shown right after a
    /// brand-new account is opened (OpenAccount) and BEFORE the user
    /// lands in the main app — the new-account path only (never the "I
    /// already have an account" path). Nudges a backup with the cloud
    /// option pre-selected; lets the user skip behind a clear warning.
    /// Reuses the existing cloud-recovery + `.flagshipkey` mechanisms.
    case secureAccount(username: String)
    /// Username-first Join ("I already have an account"). The FIRST
    /// screen is a bare-username input; on submit a single preflight
    /// (`/api/account/resolve`, 200 always) branches: demo attaches a
    /// new device + opens the sandbox; unknown renders an inline state;
    /// single/multi push `.realAccountLogin`. This replaces the old
    /// `assertAny()`-first recovery entry — Join no longer 404s.
    case recoverFromWelcome
    /// Phase 3 — the real single/multi login state machine for a
    /// resolved account. Carries the full `AccountResolution` from the
    /// preflight so the downstream screen branches on `kind` / `recovery`
    /// / `graceModel` WITHOUT re-resolving. Drives:
    ///   - `recovery.present == false` → a clean STATE (single vs multi
    ///     copy), never a 404.
    ///   - `single` (recovery) → passkey-PRF unwrap → 7-day-grace
    ///     TAKEOVER → install UMK → initiate re-pair → admin label.
    ///   - `multi` (recovery + TOTP) → passkey-PRF + recovery-TOTP /
    ///     recovery-code → 24h-grace TAKEOVER → install UMK → admin.
    /// Replaces the Phase-1 stopgap that pushed the old passkey
    /// recovery container. (`AccountResolution` is Hashable so it rides
    /// the typed nav path directly.)
    case realAccountLogin(resolution: AccountResolution)
    /// Phase 3b — cross-device QR pairing as a brand-new collaborator
    /// (the app is UNPAIRED and a `/join` deeplink/scan arrives, or the
    /// user picks "Scan a pairing code" from Welcome). Carries the
    /// scanned/deeplinked `/join` link; runs the incoming JoinAccount
    /// flow which attaches a FRESH device key + installs the shared UMK
    /// into a new per-profile slot, then completes onboarding paired.
    case joinByPairing(joinUrl: String?)
}

public extension Array where Element == AppsRoute {
    /// Open a vibe-code session so that Back lands on the build chooser:
    /// the AI-key and describe steps (or the session list) that led here are
    /// dropped, and a session reached from elsewhere gets the chooser under it.
    mutating func openVibeSession(_ sessionId: String) {
        if let i = firstIndex(of: .buildSource) {
            removeSubrange((i + 1)...)
        } else {
            append(.buildSource)
        }
        append(.vibeCodeChat(sessionId: sessionId))
    }

    /// The AI-chat session changing a service, directly above that service's
    /// page, so Back from it returns there.
    mutating func openEditSession(_ sessionId: String, serviceId: String) {
        if let i = lastIndex(of: .appDetail(serviceId: serviceId)) {
            removeSubrange((i + 1)...)
        }
        append(.vibeCodeChat(sessionId: sessionId))
    }

    /// The build-sessions list, one level above "Build a service", so Back
    /// from it returns to the chooser rather than to a half-filled form.
    mutating func openBuildSessions() {
        if let i = firstIndex(of: .buildSource) {
            removeSubrange((i + 1)...)
        } else {
            append(.buildSource)
        }
        append(.buildJournal(buildId: nil))
    }
}
