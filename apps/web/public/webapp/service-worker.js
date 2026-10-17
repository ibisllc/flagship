// Flagship webapp service worker.
// Strategy: cache-first for the PWA shell so the home screen icon "feels native"
// (instant launch even on lossy networks); network-first for /api/* so dynamic
// state never staleness-bites the user.

// SHELL_VERSION bumped each time the SHELL list changes so existing
// installs invalidate their cache.
//   v6: web.flagshipserver.com migration (origin change made the bump
//       documentation-only since old SWs were on a different origin).
//   v7: added lib/leases.js for the auto-unlock lease flow.
//   v8: added lib/recovery.js for WebAuthn-PRF cloud-shard recovery.
//   v9: added lib/push.js + Web Push event handler for unlock-approval
//       notifications.
//  v10: push event handler reads RFC 8291 encrypted payload and
//       personalises the notification with the requesting server FQDN.
//  v11: added e2e simulate-push message shim (gated on flagship-e2e:
//       prefix; harmless in prod since real clients never send it).
//  v12: rollback-safety overhaul.
//       - Dropped skipWaiting() + clients.claim() so a bad deploy can
//         no longer evict a live session mid-flight; the new SW waits
//         until every controlled tab closes (or the page explicitly
//         posts SKIP_WAITING after a user opt-in).
//       - Replaced cache.addAll(SHELL) with a per-URL allSettled
//         walk: optional SHELL entries are allowed to 404 (logged,
//         not fatal) and only the ESSENTIAL_PATHS subset (index.html,
//         app.js, style.css, manifest + icon, router/state/api libs)
//         rejects install. A single missing view module no longer
//         bricks every webapp install on the planet.
//  v14: removed views/unlock-approvals.js — the legacy plaintext
//       unlock-approval boot flow is gone (relay + box-sealed lease
//       replace it). Push handler's unlock-request branch dropped.
//  v16: first-run wizard gained a skippable "Secure your account" step
//       (cloud passkey pre-selected when available, else `.flagshipkey`
//       file); added views/wizard.js to the precache.
//  v17: webapp ↔ mobile parity — added the live account audit log
//       (lib/auditLog.js + views/account-audit.js), real IRK-signed TOTP
//       enroll/disable (lib/totp.js), the boot-approval relay
//       (lib/edToMont.js + lib/bootApproval.js + views/boot-approval.js),
//       and device-capability chip/scope-gating (consumed in home.js).
//  v18: refresh views/home.js so passwordless demo sign-in materialises the
//       server supplied by account resolution without requiring a paired
//       session id.
//  v19: refresh Home + usersCheck so opening a demo server mints the browser's
//       paired session instead of falling through to the unpaired detail error.
//  v20: demo profiles auto-unlock on reload and repair the old discarded local
//       wrap passphrase instead of showing an impossible Unlock prompt.
//  v21: refresh the quieter Home identity, recovery warning, and empty state.
//  v22: desktop-initiated /dock ceremony and browser-only polling secret.
//  v23: keyless companion banner + honest disabled-state policy.
//  v24: quieter cross-platform Settings, recovery, and account-backup copy.
//  v25: direct recipe download replaces the retired homepage QR handoff.
//  v26: web. split into webapp. + remote.; docking renamed to "remote".
//  v29: recovery re-pair is credential-gated — the takeover + replace-device
//       ceremonies now carry a credential on initiate and SIGN the
//       completion, so a stale shell would post bodies .com refuses.
//  v30: security links point at the one-page /security sections.
//  v31: demo accounts hide key-backed rows + remove-from-browser; every
//       Worker audit kind is labelled; recovery copy matches the gate.
//  v32: apex.js drops the retired `web.` sub-origin prefix.
//  v33: the update card shows the box's last update verdict.
//  v34: "Install complete" without the USB-only instruction.
//  v35: the update dialog lists the box's releases ("Update to latest").
//  v36: the server page shows the box's health report.
//  v37: the update sheet no longer asks again before going back.
//  v38: open build sessions can be resumed; Back from a build goes to the chooser.
//  v39: unique build names checked as you type, "Invite only", Discard in Build
//       sessions, named past builds, and the AI Key page split into add and
//       choose; precaches lib/vibeSessions.js + lib/vibeNames.js.
//  v40: "Edit this service" (AI chat or IDE); precaches views/edit-service.js
//       + lib/editService.js.
//  v41: name a git import, follow the AI adapt in the background, Discard
//       open git and IDE builds; precaches lib/gitImport.js.
//  v42: "Get flagship.app.json" on an adapted or installed git import.
//  v43: "Share the adaptation" on a git import, a crashed shared adaptation
//       hands over to the AI, "Report a problem with this adaptation";
//       precaches lib/adapterReport.js.
//  v44: Delete server for every server (typed-name gate, erase order + name
//       release), reversible Revoke + Un-revoke, revoked servers stay listed,
//       and the server page keeps its Danger zone when the box is offline.
//  v47: AI adapt is one step ("Use AI to adapt and deploy") with its staging
//       phases, the chat's Deploy runs staged in the background, an app asks
//       for internet access on its page (signed Allow / Stop access), and
//       each AI key has a Flagship relay switch; precaches lib/appEgress.js,
//       lib/chatDeploy.js + lib/aiRelay.js.
//  v48: app access lists replace the all-or-nothing internet approval: the
//       "Internet access" section, the access-list editor, the "<App> wants
//       to reach <host>" sheet, and the generic app-access push; precaches
//       lib/appAccess.js, lib/accessAlerts.js + views/app-access.js.
//  v49: one "Push notifications" switch: off drops this browser's push
//       registration and tells every box to send no alerts, and no access
//       sheet shows; a generic push's click checks access requests too;
//       precaches lib/pushSetting.js.
//  v50: a sent server update stays on the update card (and the update
//       sheet) until the box reports its outcome, with Send again / Forget
//       it once it's 30 minutes old.
//  v52: an app's page lists its API keys and creates (signed, shown once)
//       and revokes them; precaches lib/appApiKeys.js.
//  v53: suggested access lists (a card with Review / Dismiss, a badge, and
//       the "<App> suggests an access list" alert), and the owner's
//       Database section (tables, rows, CSV export, Run SQL with signed
//       writes); precaches lib/appDb.js + views/app-db.js.
//  v54: knocking on a box you were invited to signs with your contact id
//       for its owner (remembered from the invite link), and Process URL
//       reads "Open <app> on <server>" for any private app; a box that is
//       neither yours nor invited is refused; precaches lib/knockIdentity.js.
//  v56: where an app runs (docs/app-placement.md): making a server leader
//       makes it current, every new app picks its server ("Runs on",
//       defaulting to the leader), a server's page lists its apps and
//       "Create app here", and the app page's Runs on ticks copy the app to a
//       server (signed) and unticks remove it; precaches lib/appPlacement.js.
//  v57: a server's page is titled with its name, not "Server".
//  v58: an app's status pill (docs/app-placement.md §6): the services list
//       shows each app once with one pill for every server it's on
//       (Deploying / Editing / On N servers / Stopped / Can't reach), and
//       the app page and its Runs on rows show each server's state.
//  v60: a server's page ignores a late answer from the server shown before
//       it, so it never shows another server's detail under its name.
//  v62: an app's page no longer offers a custom domain (a Pro feature that
//       lives on feat/custom-domains until it launches).
//  v63: free AI credits: Settings shows what's left (or the way to your own
//       key), the AI-key step offers them first and is skipped for an
//       owner with no saved key, and builds mint a fresh pass per send;
//       the phone-number claim form is gone; precaches lib/freeAi.js.
//  v64: a server's page groups Health, CPU, Memory, Disk, Network and
//       Certificate in one Monitoring pane of rows that expand in place, and
//       its Danger zone is just the buttons; precaches lib/serverMonitoring.js.
//  v65: Access control replaces Collaborators and "Who can open this": an
//       Open to all | Members only toggle and the members list with each
//       person's and group's role (signed role orders); drops the invite
//       issue/manage views + lib/labelBook.js, precaches lib/memberRoles.js.
//  v66: free AI credits show this week's top-up and the starter reserve,
//       and say why they can't be used (busy today, no running server);
//       they disappear once the promotion has ended.
//  v67: a visitor's id is per app: invites, knocks and acceptances sign with
//       deriveAppAccountId(UMK, serviceRef), invite links carry `s=`, and a
//       link without it asks for a new one.
//  v68: free AI is the built-in "Flagship Inference" provider: always first
//       in Settings and the AI-key step, never removable, selectable as the
//       default, shown disabled (with why) instead of hidden once it ended.
//  v69: Flagship Inference everywhere (no more "free AI credits"), and its
//       allowance in credits: "1,840 free credits left · 500 added each
//       week", the same line in Settings and the AI-key step.
//  v70: Share this server: a server's page shows who it's shared with,
//       their level and opt-ins, and an Activity card; /share links open
//       the accept view; home lists "Shared with me" with a page limited to
//       the share's level; precaches lib/serverShare.js, lib/serverShares.js
//       and the server-sharing / share-accept / shared-server views.
//  v72: the remote page shows its QR at once (no account name, no server
//       list): the phone picks the server and seals it a one-use ticket.
//  v73: account read tokens (docs/account-read-token.md): every /pods,
//       /stream, /audit and app-links read carries one; precaches lib/accountRead.js.
//  v74: the owner's server order (docs/server-order.md): Home lists servers
//       in order with a Leader badge and drag/up/down to reorder; server
//       pages say "Make leader"; precaches lib/serverOrder.js.
//  v75: app links are https (/remote, /access, /invite-accept on the control
//       apex); the webapp opens an /access link handed over by the site.
//  v76: Home's server rows lose their numbers: the drag handle leads each
//       row, only the leader wears a badge (gray until it confirms the
//       order), "Add/connect a server" sits above the list; a saved order is
//       also handed straight to each online box.
//  v77: "Patent Pending" in About and a footer under every view.
//  v78: sharing for a family (docs/share-a-server.md §10): a co-manager can
//       ask to be told when a shared server needs to start (a content-free
//       `share-start-up` push), update it at "Can manage", and sees which
//       apps are members-only; the owner's unlock opt-in says what it hands over.
//  v79: notifications that name an app screen (https://<apex>/app/<route>)
//       open the matching webapp view; the old desktop-pairing view
//       (views/pair.js, flagship://desktop QR) is gone; invite replies and
//       app sign-in links carry their params in the fragment.
//  v80: a boot/unlock approval push reads "A server is waiting for your
//       approval." and opens the approvals view.
//  v81: an app invite handed over by the owner's server
//       (/invite#server=<box>&k=…) is accepted against that box.
//  v82: Settings and the AI-key step read Flagship Inference's status
//      without asking for a username first.
//  v83: a retried account creation presents the same device and grant ids
//       (never a second device); an app's page ends in "Remove app" (the signed
//       uninstall to the server the page reads, the only copy included) and shows
//       the box's "Recent logs" when it sends some.
//  v84: Backup/clone server on a server's page and "Add/Import a server" on
//       Home (a backup file imports onto any server); Replace and the install
//       Timeline are gone; Activity shows the box's own events.
//  v86: a server's relay-trust alert and a newly registered server get their
//       own notice text instead of "Flagship has an update for you."
//  v87: the transfer dialog shows its offer as a QR (/qrEncoder.js reaches
//      version 40); Home lists an account's servers from /pods, or says the
//      list is locked with "Show my servers"; a server's page says why its
//      box didn't answer (offline, coming up, never online, not paired +
//      Pair this server); recovery goes straight to the takeover (no choice
//      screen), the raw Members list and the URL-controller view are gone;
//      auto-unlock deposits the box-sealed v2 lease; account alerts open
//      account security or the device list; every start-up module is
//      precached.
//  v88: A server order refused because another device saved a newer one
//      says so instead of blaming the connection; a server paired by
//      address keeps its port when a screen reaches it by name.
//  v89: An app's "Back up now" fetches the archive with the session and
//      saves it (lib/appBackup.js) instead of a link the box refused.
//  v91: The build chat answers an env var the AI asks for, ahead of the
//      live link when the app is already live (an edit session).
//  v92: Backup/clone server downloads through the box's own link (straight
//       to disk, resumable), approved with this device's key; a backup is
//       sized first and carries no images.
//  v93: a build chat that is ready to deploy or failed takes a new message,
//      and its model menu lists Flagship Inference and every saved key with
//      their models (switching provider sends that key); precaches
//      lib/modelGroups.js.
//  v94: an AI-needs-you notification opens the build chat on the server
//      holding the session (the bare vibecode-chat view is gone); its
//      env-var ack carries the key and the model choice.
//  v95: Any device may invite at Member (admins pick higher ranks); the
//      members list says which device invited each person; admins get an
//      invite-created push that opens the account activity.
//  v96: a call flagshipserver.com rate-limits says who is limited and when
//      to try again (lib/rateLimited.js, precached) instead of a generic
//      error.
//  v101: Access control lists Account members (this account's devices,
//       named on this device, and co-managing accounts) with their rank;
//       admin devices change ranks, refuse, switch the mode, remove people
//       and uninstall with admin-root orders that name the app
//       (flagship/app-rank/v1, service-access-mode/v2, allow-remove/v2);
//       other devices invite at Member and withdraw their own invites with
//       their account device key while manager-class, else see why not. App
//       sign-in signs with the device key on own servers and the share key
//       on shared ones. (v97-v100 belong to feature branches.)
//  v106: Home's Add/Import a server offers Create a new server, Co-manage a
//       running server (moved off the create-server page) and Import a
//       backup, without the clone explainer. (v102-v105 belong to feature
//       branches.)
//  v107: Backups are two files (a passcode-protected backup file and the
//       data file); Import a backup restores onto a new server made from
//       the backup's settings, which waits for the app to send it
//       (lib/serverBackupFormat.js, vendor/noble-hashes/sha2.js).
//  v108: Home's empty state carries the same Add/Import a server button as
//       the list (no separate co-manage button), and only an admin device
//       of the account sees it.
//  v109: the services list shows "On N servers" as N and the server icon;
//       Settings moves Lock the app (was Lock with PIN code) and Sign out
//       (was Lock with passkey) onto the tab in one box, and the Danger zone
//       is a box of two red buttons, as on iOS, without explainer text;
//       Browser sessions lists only browsers opened through Remote.
//  v110: A server's page merges Backup and Migrate into one "Backup /
//       Migrate" card of buttons ("Migrate to new machine / VM"), placed
//       before Update; Diagnostics loses its explainer.
//  v111: Import a backup and Backup/clone server word their steps like iOS:
//       the passcode note, the passcode prompt and the waiting text.
//  v112: style.css takes the website's tokens and look and follows the
//       device's light or dark setting; index.html adds per-scheme
//       theme-color metas; manifest colours move to the site's dark canvas.
//  v113: Create, co-manage, take over and import a backup refuse a device
//       that isn't an admin device of the account wherever they are opened
//       (lib/addServerGate.js), and minting a recipe no longer mints an
//       admin root.
//  v114: the webapp refuses to run in a frame (lib/frameGuard.js) and the
//       service-worker registration moves out of index.html into
//       lib/swRegister.js, so the shell runs under a CSP with no inline
//       script.
//  v115: migration wording says "a new machine / VM" (not "new
//       hardware"); Activity names a damaged settings file the server
//       locked down (server.state.corrupt), and failed or warning rows get
//       the warning card and a ⚠️ when their kind is unknown.
//  v116: `.com` enforces adding a server as admin-only: the create flow
//       sends the admin root's approval of the AuthCode, the RCK and a
//       restore order sign under the admin root, and `.com`'s refusal
//       (code add-server-admin-only) reads as the apps' sentence.
//  v117: admin-only app orders (Remove app, Runs on, access lists, API
//       keys, database writes) only where they can be signed; backup and
//       restore errors in the box's words; long build chats capped with
//       Jump to latest (lib/vibeTranscript.js); a shared app's Database;
//       Settings → Scan a pairing code; access alerts from every server;
//       Flagship Inference refusals in .com's words.
//  v118: a tapped generic push also drains the AI-chat alerts and opens the
//       waiting build chat (?wake=1 when no tab is open); the firewall-
//       down sandbox notice in the box's words; Build sessions reopens a
//       git or IDE build a restart cut off; the server order only on
//       devices that can sign it.
//  v119: co-managers invite people to a shared server's apps at Member and
//       withdraw their own invites; the owner sees who invited.
//  v120: debug access on the server page (an SSH key for 1 h / 24 h / 7
//       days, signed by the admin root; renew, turn off, a banner while it's
//       on; lib/debugAccess.js + views/debug-access.js), the create flow's
//       debug-friendly server asks for an SSH key and signs a v2 grant, and
//       Activity labels the four debug-access entries.
//  v121: turning debug access on or renewing it (and a debug-friendly
//       recipe) asks for this device's passphrase again (lib/freshUnlock.js),
//       one fresh unlock per grant.
//  v122: the cover offers "Create your account" and "Connect to an
//       existing account", one page with both ways back in: the account
//       name (sign in) and a pairing code or link (join); a pairing link
//       typed as the name joins (lib/connectAccount.js).
//  v123: a non-admin device sees the server page and its sharing read-only;
//       Settings screens go Back to Settings, the install tracker and
//       report to Activity; Activity reads the signed-in account; hidden
//       settings rows stay hidden; rate-limit sentences for account
//       deletion and 2FA; one link per invite; a finished backup reopens;
//       .com's migration and directory refusals in its words; a new
//       account reopens with its passphrase as the same admin device;
//       auto-pair reads serverDomain; open git builds reopen where they
//       stand.
//  v124: no developer surfaces in the shipped webapp: the sticky debug URL
//       flag, Settings' Developer section and its Send order panel are gone.
//  v125: Welcome and the lock screens share one footer (primary, secondary
//       right below, a gap, Patent Pending); the lock screens gain Sign out.
//  v126: Connect your IDE shows each IDE's own config (Claude Code, Cursor,
//       VS Code, Cline) and Claude Code's one-line command.
//  v127: joining and taking over an account ask for this browser's
//       passphrase and unlock with it after a reload; a backup file's
//       takeover finishes.
//  v128: a pending server opens its setup view; Create a server speaks to a
//       browser; the model menu keeps focus; admin invites, rank orders and
//       share grants take one fresh unlock.
//  v136: teal splits into three roles: lighter --accent-graphic for icons,
//       rings and focus, --accent for small text, --teal for fills.
//  v139: light --accent-graphic is #0E9488 (3:1 on every surface); status
//       text (--ok, --warn, --err) is deepened to 4.5:1 on paper.
const SHELL_VERSION = "v139";
const SHELL_CACHE = `flagship-webapp-shell-${SHELL_VERSION}`;

// ESSENTIAL_PATHS: the absolute minimum to render the unlock view and
// route to one of the home/bootstrap views. If any of these 404 we
// abort the install — the browser keeps the previous SW active, which
// is the desired safe-rollback behaviour.
const ESSENTIAL_PATHS = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icon.svg",
  "/keystore.js",
  "/lib/router.js",
  "/lib/state.js",
  "/lib/api.js",
  "/lib/toast.js",
  "/lib/frameGuard.js",
  "/lib/swRegister.js",
];

// OPTIONAL_SHELL: everything else worth precaching. A 404 here is
// logged but doesn't fail the install — the offending URL just isn't
// in the precache; the runtime fetch handler will fall back to the
// network (and then cache whatever it gets). Keeps the webapp's
// offline launch path resilient while a deploy rolls forward.
const OPTIONAL_SHELL = [
  "/providers.js",
  "/qrScanner.js",
  "/lib/util.js",
  "/lib/podPair.js",
  "/lib/leases.js",
  "/lib/recovery.js",
  "/lib/keyfile.js",
  "/lib/keyfileBackup.js",
  "/vendor/noble-hashes/argon2.js",
  "/vendor/noble-hashes/blake2.js",
  "/vendor/noble-hashes/_blake.js",
  "/vendor/noble-hashes/_md.js",
  "/vendor/noble-hashes/sha2.js",
  "/vendor/noble-hashes/_u64.js",
  "/vendor/noble-hashes/utils.js",
  "/vendor/noble-hashes/crypto.js",
  "/lib/push.js",
  "/lib/icons.js",
  "/lib/auditLog.js",
  "/lib/accountRead.js",
  "/lib/serverOrder.js",
  "/lib/debugAccess.js",
  "/lib/freshUnlock.js",
  "/lib/totp.js",
  "/lib/edToMont.js",
  "/lib/bootApproval.js",
  "/lib/x25519.js",
  "/lib/companionReceiver.js",
  "/lib/companionGuard.js",
  "/lib/companionDockStart.js",
  "/lib/vibeSessions.js",
  "/lib/vibeNames.js",
  "/lib/editService.js",
  "/lib/gitImport.js",
  "/lib/adapterReport.js",
  "/lib/appEgress.js",
  "/lib/chatDeploy.js",
  "/lib/aiRelay.js",
  "/lib/appAccess.js",
  "/lib/accessAlerts.js",
  "/lib/pushSetting.js",
  "/lib/appApiKeys.js",
  "/lib/freeAi.js",
  "/lib/modelMenu.js",
  "/lib/modelGroups.js",
  "/lib/vibeTranscript.js",
  "/lib/appDb.js",
  "/lib/knockIdentity.js",
  "/lib/appPlacement.js",
  "/lib/serverMonitoring.js",
  "/lib/memberRoles.js",
  "/lib/serverShare.js",
  "/lib/serverShares.js",
  "/lib/serviceEnvChange.js",
  "/lib/serverArchive.js",
  "/lib/savedBackups.js",
  "/lib/migrateArchive.js",
  "/lib/appStorage.js",
  "/lib/backupPolicy.js",
  "/lib/peerBackup.js",
  "/lib/serverBackupFormat.js",
  "/lib/appBackup.js",
  "/lib/activityFeed.js",
  "/lib/accountAccess.js",
  "/lib/connectAccount.js",
  "/lib/accountDeletion.js",
  "/lib/accountDirectory.js",
  "/lib/accountMetadata.js",
  "/lib/accountResolve.js",
  "/lib/activeOperations.js",
  "/lib/adminRoot.js",
  "/lib/addServerGate.js",
  "/lib/adminRootRotation.js",
  "/lib/adminRootTransfer.js",
  "/lib/aiChatAlerts.js",
  "/lib/apex.js",
  "/lib/autoPair.js",
  "/lib/boxInbox.js",
  "/lib/buildDraft.js",
  "/lib/cgkDeposit.js",
  "/lib/comFetch.js",
  "/lib/companionClient.js",
  "/lib/companionRequestsClient.js",
  "/lib/companionWriteRelay.js",
  "/lib/crossDevicePairing.js",
  "/lib/dateFormat.js",
  "/lib/deepLink.js",
  "/lib/deleteServer.js",
  "/lib/demoAccount.js",
  "/lib/directLeads.js",
  "/lib/frontPage.js",
  "/lib/humanError.js",
  "/lib/journal.js",
  "/lib/liveSync.js",
  "/lib/localPassphrase.js",
  "/lib/lockAndPower.js",
  "/lib/loginTakeover.js",
  "/lib/maintainerTrust.js",
  "/lib/modal.js",
  "/lib/openAccount.js",
  "/lib/operationsBar.js",
  "/lib/pairingDeposit.js",
  "/lib/pairingRelay.js",
  "/lib/pendingRePairBanner.js",
  "/lib/pinLock.js",
  "/lib/podSwitcher.js",
  "/lib/profiles.js",
  "/lib/profilesStore.js",
  "/lib/provisionProgress.js",
  "/lib/rateLimited.js",
  "/lib/relayTrust.js",
  "/lib/releaseServer.js",
  "/lib/replaceDeviceCeremony.js",
  "/lib/revokeServer.js",
  "/lib/securedSessions.js",
  "/lib/serverHealth.js",
  "/lib/serverMigration.js",
  "/lib/serverReplacement.js",
  "/lib/serverTransfer.js",
  "/lib/serverTrust.js",
  "/lib/serverUpdate.js",
  "/lib/serviceInvite.js",
  "/lib/sessionTiers.js",
  "/lib/swkDeposit.js",
  "/lib/trustException.js",
  "/lib/trustOverride.js",
  "/lib/trustSliver.js",
  "/lib/uikit.js",
  "/lib/usersCheck.js",
  "/lib/wipeRestartCeremony.js",
  "/views/bootstrap.js",
  "/views/wizard.js",
  "/views/unlock.js",
  "/views/home.js",
  "/views/import-backup.js",
  "/views/settings.js",
  "/views/pod-pair.js",
  "/views/server-detail.js",
  "/views/server-sharing.js",
  "/views/server-backups.js",
  "/views/debug-access.js",
  "/views/shared-server.js",
  "/views/share-accept.js",
  "/views/services-list.js",
  "/views/service-detail.js",
  "/views/app-access.js",
  "/views/app-db.js",
  "/views/paired-sessions.js",
  "/views/vibe-code.js",
  "/views/edit-service.js",
  "/views/service-env.js",
  "/views/recovery.js",
  "/views/install-progress.js",
  "/views/browser-viewer.js",
  "/views/account-audit.js",
  "/views/boot-approval.js",
  "/views/companion-dock-start.js",
  "/views/access-authorize.js",
  "/views/account-delete.js",
  "/views/account-security.js",
  "/views/activity.js",
  "/views/add-device.js",
  "/views/build-git.js",
  "/views/build-journal.js",
  "/views/build-key.js",
  "/views/build-mcp.js",
  "/views/build-source.js",
  "/views/companion-dock.js",
  "/views/companion-requests.js",
  "/views/create-server.js",
  "/views/invite-redeem.js",
  "/views/join.js",
  "/views/peer-backup.js",
  "/views/pending-server.js",
  "/views/pinLock.js",
  "/views/profiles.js",
  "/views/secured-sessions.js",
  "/views/service-access.js",
  "/views/trusted-devices.js",
];

// Combined list kept for the existing webappStatic test, which scans
// the SW source for individual view paths. Order doesn't matter at
// runtime — the install handler walks ESSENTIAL_PATHS + OPTIONAL_SHELL
// separately so it can apply different failure semantics to each.
const SHELL = [...ESSENTIAL_PATHS, ...OPTIONAL_SHELL];

async function precacheEssential(cache) {
  // Promise.all so any rejection trips install rejection.
  await Promise.all(
    ESSENTIAL_PATHS.map(async (path) => {
      const res = await fetch(path, { cache: "reload" });
      if (!res || !res.ok) {
        throw new Error(
          `essential precache failed: ${path} -> ${res ? res.status : "no response"}`,
        );
      }
      await cache.put(path, res);
    }),
  );
}

async function precacheOptional(cache) {
  // allSettled so a single missing view doesn't poison the install.
  const settled = await Promise.allSettled(
    OPTIONAL_SHELL.map(async (path) => {
      const res = await fetch(path, { cache: "reload" });
      if (!res || !res.ok) {
        throw new Error(
          `optional precache 404: ${path} -> ${res ? res.status : "no response"}`,
        );
      }
      await cache.put(path, res);
      return path;
    }),
  );
  for (const r of settled) {
    if (r.status === "rejected") {
      // Visible in DevTools → Application → Service Workers logs.
      console.warn("[flagship-sw] optional shell entry skipped:", String(r.reason));
    }
  }
}

self.addEventListener("install", (event) => {
  // NOTE: no skipWaiting(). The new SW sits in `waiting` until every
  // controlled tab closes or the page explicitly posts SKIP_WAITING.
  // That way a deploy with a corrupted asset can't yank the rug out
  // from under a live unlock / pairing / vibe-code session.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await precacheEssential(cache);
      await precacheOptional(cache);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  // NOTE: no clients.claim(). The new SW only takes over once existing
  // controlled clients have all gone away (close + reopen, or user
  // taps the "Update available" toast which posts SKIP_WAITING).
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("flagship-webapp-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // P2.13 — offline-replay queue.
  // Idempotent POSTs (paired-session orders, claim, backup-start) are
  // safe to retry: the daemon dedupes by signed canonical bytes +
  // issuedAt, and a stale issuedAt window-gate rejects replays. Wrap
  // those in a fetch-or-queue so a transient offline window doesn't
  // bubble a confusing error to the user.
  if (event.request.method === "POST" && shouldQueue(url.pathname)) {
    event.respondWith(fetchOrQueue(event.request));
    return;
  }
  if (event.request.method !== "GET") return;
  // Same-origin gate: scope is "/" on webapp./remote.<apex>, so any
  // in-scope GET is a webapp asset. Cross-origin calls (the user's pod
  // at <server>.<user>.flagship.services for /api/screens/*) bypass
  // the SW entirely.
  if (url.origin !== self.location.origin) return;

  // Never cache API calls — they're dynamic. The webapp's only
  // same-origin /api/* paths today are the ones the offline-replay
  // queue handles above; this is a defensive skip in case future
  // additions slip through.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        // Don't cache non-200 responses or opaque responses.
        if (!res.ok || res.type === "opaque") return res;
        const clone = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(event.request, clone));
        return res;
      });
    }),
  );
});

// ---------- Offline replay queue (P2.13) -----------------------------

const REPLAY_QUEUE = [];
const REPLAY_PATH_PATTERNS = [
  /^\/api\/screens\/orders\/send$/,
  /^\/api\/screens\/app-backup\/start$/,
];

function shouldQueue(pathname) {
  return REPLAY_PATH_PATTERNS.some((re) => re.test(pathname));
}

async function fetchOrQueue(request) {
  try {
    const res = await fetch(request.clone());
    return res;
  } catch (_e) {
    // Network failure — queue the request and respond 202 Accepted so
    // the calling view doesn't error out. The replay loop will fire on
    // the next `online` event.
    const body = await request.clone().arrayBuffer();
    REPLAY_QUEUE.push({
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body,
      enqueuedAt: Date.now(),
    });
    return new Response(
      JSON.stringify({ queued: true, queueLength: REPLAY_QUEUE.length }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  }
}

self.addEventListener("online", () => {
  void replayQueue();
});

// ---------- Web Push notifications -----------------------------------
//
// .com / the daemon send RFC 8291-encrypted payloads. The browser
// decrypts before the push event fires; we get the plaintext via
// event.data.json(). Empty-payload pushes (no event.data) still work
// — they fall back to a generic notification body.
//
// `notificationclick` focuses an existing webapp tab if one is open,
// otherwise opens the root (or a deep-link the payload provides).
const ACCOUNT_NOTICES = {
  "cert-alert": "One of your servers needs your attention.",
  "server-registered": "A new server was added to your account.",
};

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data?.json?.() ?? null;
  } catch (_e) {
    // Malformed payload — fall back to the generic body below.
  }

  // W10 — vibecode-needs-you push. The daemon fires this when the AI
  // hits a tool_use (requestEnvVar / talkToUser) and pauses the
  // session. Route to the vibe-code chat surface for the session id.
  if (data && data.kind === "vibecode-needs-you" && typeof data.sessionId === "string") {
    const which = typeof data.request === "string" ? data.request : "input";
    const body = which === "requestEnvVar"
      ? "The AI needs an environment variable to continue."
      : "The AI is asking you a question.";
    const server = typeof data.server === "string" && data.server ? `&server=${encodeURIComponent(data.server)}` : "";
    const deepLink = typeof data.deepLink === "string"
      ? data.deepLink
      : `/?view=vibecode-chat&sessionId=${encodeURIComponent(data.sessionId)}${server}`;
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body,
        tag: `flagship-vibecode-${data.sessionId}`,
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: {
          kind: "vibecode-needs-you",
          sessionId: data.sessionId,
          deepLink,
        },
      }),
    );
    return;
  }

  // Provisioning-status push — the SINGLE canonical provisioning payload
  // (design §2.3). Recognised by `category === "provision-status"` (or
  // `meta.kind`); `meta.phase` is a canonical ProvisionStatusPhase. iOS +
  // Android parse this identical shape. We render ONE notification and
  // deep-link to the install-progress view.
  const isProvisionStatus =
    data &&
    (data.category === "provision-status" ||
      (data.meta && data.meta.kind === "provision-status"));
  if (isProvisionStatus) {
    const title = typeof data.title === "string" ? data.title : "Flagship";
    const psBody =
      typeof data.body === "string" ? data.body : "Your server is setting itself up.";
    const phase =
      data.meta && typeof data.meta.phase === "string" ? data.meta.phase : "";
    const deepLink =
      typeof data.deepLink === "string" ? data.deepLink : "/?view=install-progress";
    event.waitUntil(
      self.registration.showNotification(title, {
        body: psBody,
        tag: "flagship-provision-status",
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: { kind: "provision-status", phase, deepLink },
      }),
    );
    return;
  }

  // App access request (docs/ai-privacy-and-staging.md §3a). The text is
  // generic on purpose: which app and which host come from the box over the
  // paired session once the webapp is open, never through the push.
  const isAppAccess =
    data &&
    (data.category === "app-access" ||
      data.kind === "app-access" ||
      (data.meta && data.meta.kind === "app-access"));
  if (isAppAccess) {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "One of your apps wants to reach the internet",
        tag: "flagship-app-access",
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: { kind: "app-access" },
      }),
    );
    return;
  }

  // A server shared with this account waits to start (docs/share-a-server.md
  // §5.4). The push names no server; Home shows which one and the Approve button.
  if (data && data.kind === "share-start-up") {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "A server shared with you is asking you to unlock it.",
        tag: "flagship-share-start-up",
        renotify: true,
        requireInteraction: true,
        icon: "/icon.svg",
        data: { kind: "share-start-up", deepLink: "/" },
      }),
    );
    return;
  }

  // One of the owner's boxes waits for an approval (unlock or entitlement).
  // The text names no server, like the phone apps'; the approvals view
  // fetches and re-verifies what's pending.
  if (data && (data.kind === "secret-request" || data.category === "secret-request")) {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "A server is waiting for your approval.",
        tag: "flagship-secret-request",
        renotify: true,
        requireInteraction: true,
        icon: "/icon.svg",
        data: { kind: "secret-request", deepLink: "/?view=boot-approval" },
      }),
    );
    return;
  }

  // A non-admin device of the account invited someone (owner rule: admins are
  // told). The push names no app, person or device; the activity view does.
  if (data && (data.category === "invite-created" || data.kind === "invite-created")) {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "A device on your account invited someone to one of your apps.",
        tag: "flagship-invite-created",
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: { kind: "invite-created", deepLink: "/?view=account-audit" },
      }),
    );
    return;
  }

  // Account notices that carry only their category (as APNs and FCM see it):
  // a box's relay-trust SOS and a newly registered server. Home shows which.
  const noticeText = data && typeof data.category === "string" ? ACCOUNT_NOTICES[data.category] : undefined;
  if (noticeText) {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: noticeText,
        tag: `flagship-${data.category}`,
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: { kind: data.category, deepLink: "/" },
      }),
    );
    return;
  }

  // Generic fallback for any other (or empty) payload.
  const body = (data && typeof data.body === "string")
    ? data.body
    : "Flagship has an update for you.";
  const deepLink = data && typeof data.deepLink === "string" ? data.deepLink : null;
  event.waitUntil(
    self.registration.showNotification("Flagship", {
      body,
      tag: "flagship-notification",
      renotify: true,
      requireInteraction: false,
      icon: "/icon.svg",
      data: { kind: (data && data.kind) || "generic", deepLink },
    }),
  );
});

// #29 — deep-link push notifications. The push handler attaches a
// `deepLink` field to notification.data when the payload knows where
// the click should land. On notificationclick we:
//   - Focus an existing webapp tab if one is open AND navigate it to
//     the deep-link via a postMessage the page listens for.
//   - Otherwise open `/?view=<view>&...` directly so the SPA router
//     picks up the slot.
//
// If no deepLink is set, the existing behavior holds: focus or open
// the root.
// Push payloads name app screens as https://<apex>/app/<route> (older
// servers sent flagship://<route>). The phone apps route those; here the
// install-progress and approvals views have their own webapp routes and the
// rest open home.
const WEBAPP_ROUTES = {
  "install-progress": "/?view=install-progress",
  "secret-requests": "/?view=boot-approval",
  "secret-request": "/?view=boot-approval",
  // As the phones route them: certificate watch and two-factor open account
  // security; a quarantined device and a re-pair open the device list.
  "account/security": "/?view=account-security",
  "settings/two-factor": "/?view=account-security",
  "account/devices": "/?view=trusted-devices",
  "account/re-pair": "/?view=trusted-devices",
  "account/activity": "/?view=account-audit",
};
function webappDeepLink(link) {
  if (typeof link !== "string") return null;
  const m = link.match(/^(?:https:\/\/[^/]+\/app\/|flagship:\/\/)([^?#]*)/i);
  if (!m) return link;
  return WEBAPP_ROUTES[m[1]] ?? "/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const deepLink = webappDeepLink(data && data.deepLink);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const same = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        // Boxes send access alerts as `generic` pushes (older ones as
        // app-access), so any of them checks the box's access requests. A
        // build that needs the owner sends the same content-free `generic`
        // push, so that one also drains the AI-chat alerts and opens the chat.
        if (data && (data.kind === "app-access" || (data.kind === "generic" && !deepLink))) {
          // The open webapp fetches the requests and shows the sheet.
          try {
            same.postMessage({ type: "ACCESS_REQUESTS" });
            if (data.kind === "generic") same.postMessage({ type: "AI_CHAT_ALERTS" });
          } catch (_e) {
            /* the page also checks on focus */
          }
          return;
        }
        if (deepLink) {
          try {
            same.postMessage({ type: "DEEP_LINK", target: deepLink });
          } catch (_e) {
            /* postMessage may fail across origins; swallow */
          }
        }
        return;
      }
      // No tab open: a content-free push opens the webapp asking it to check
      // for a waiting build chat once unlocked (`?wake=1`, app.js).
      const wake = data && data.kind === "generic" && !deepLink;
      const target = deepLink ? new URL(deepLink, self.location.origin).toString() : wake ? "/?wake=1" : "/";
      await self.clients.openWindow(target);
    })(),
  );
});

// ---------- E2E test shim ---------------------------------------------
//
// Playwright can't synthesise a real Web Push event from outside the
// SW, so the e2e harness sends a `simulate-push` postMessage and we
// dispatch it as a local push. Gated on the page being loaded with
// `?e2e=1` in the query string — the SW checks self.location.search,
// which carries the SW's *registration* URL, not the page's. Use a
// stricter guard: only run the shim when an e2e marker is set in the
// SW's own scope storage at install time.
self.addEventListener("message", (event) => {
  const data = event?.data;
  if (!data) return;
  // Update-acknowledgement: the page detected a waiting SW, asked the
  // user, and the user opted in. Activate now. The page is responsible
  // for re-loading itself after `controllerchange` fires.
  if (data.type === "SKIP_WAITING" || data === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type !== "flagship-e2e:simulate-push") return;
  // Mirror the real push handler. The harness passes a JSON payload
  // matching what .com would send via RFC 8291.
  let serverFqdn = null;
  try {
    if (data.payload && typeof data.payload.serverFqdn === "string") {
      serverFqdn = data.payload.serverFqdn;
    }
  } catch (_e) {
    /* fall back to generic */
  }
  const body = serverFqdn
    ? `${serverFqdn} is asking to boot — tap to review.`
    : "A server is asking to boot — tap to review.";
  event.waitUntil(
    self.registration.showNotification("Flagship", {
      body,
      tag: "flagship-unlock-request",
      renotify: true,
      icon: "/icon.svg",
      data: { kind: "unlock-request", serverFqdn, e2e: true },
    }),
  );
});

async function replayQueue() {
  // Drain in FIFO order. On any failure, re-queue and stop — we'll
  // pick up again on the next `online` event.
  while (REPLAY_QUEUE.length > 0) {
    const job = REPLAY_QUEUE[0];
    try {
      const r = await fetch(job.url, {
        method: job.method,
        headers: new Headers(job.headers),
        body: job.body,
      });
      if (!r.ok) {
        // Don't re-queue on 4xx (the request is bad) — only on 5xx /
        // network. 4xx jobs are silently dropped after the first
        // attempt; the user can retry from the UI if it matters.
        REPLAY_QUEUE.shift();
        if (r.status >= 500) {
          REPLAY_QUEUE.unshift(job);
          break;
        }
      } else {
        REPLAY_QUEUE.shift();
      }
    } catch (_e) {
      // Still offline. Stop the loop; the next `online` retries.
      break;
    }
  }
}
