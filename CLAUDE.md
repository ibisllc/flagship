# Flagship — orientation for Claude Code

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + web.flagshipserver.com (webapp host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   ready/                  /ready/ — after an order: copy/download the recipe + get the burner (replaced the old /build/ paste-a-code page; /build/iso/ stays as the R2 ISO-stream backend)
   dev/create-server       /dev/create-server — phone simulator
   status/                 /status/ — live health dashboard
   security/               disclosure.html, report.html
   webapp/                 PWA source (served at root on web.flagshipserver.com)
apps/mobile/               iOS Swift + Android Kotlin clients — substantial code; not yet on TestFlight/Play

packages/protocol/         Canonical-bytes + Ed25519 sign/verify for every signed message
packages/storage/          Storage interfaces + InMemory + D1 adapters + SQL migrations
packages/control-plane/    Pure runtime-agnostic handlers (used by Worker AND Fastify)
packages/server-daemon/    PRODUCTION daemon entry (acme, tunnel client, service runner, lease store, browser bundle)
packages/hello-daemon/     Minimal demo daemon — kept around for chain smoke-testing only
packages/iso-personalizer/ Trailer format (build/parse/personalize-stream)
packages/installer-apkovl/ Builds the apkovl tarball baked into the Alpine ISO
packages/tunnel-protocol/  Frame format for the tunnel + SNI parser
packages/services-zone/    `<server>.<user>.flagship.services` validation + DNS publisher
packages/bootkey-builder/  Caddyfile + per-server FQDN/SAN helpers
packages/llm-providers/    BYOK provider adapters

installer/                 Public install scripts the apkovl curls at boot
   install.sh              First-boot installer: LUKS + git clone + register
   boot-stage.sh           Steady-state boot: contact .services for unlock-key

Dockerfile                 Builds the Fly app image
fly.toml                   :443 raw-TCP (SNI passthrough) + :8443 TLS-term (API + tunnel hub)
```

## Architecture in one sentence

**`.com` (Worker + D1 + R2)** owns identity & persistent state. **`.services` (single Fly app)** is a stateless pipe: SNI passthrough on :443 + tunnel-hub WebSocket on :8443. **The user's daemon** runs ACME locally (TLS-ALPN-01 over the same passthrough chain), holds the Let's Encrypt cert, and serves services. **Routing-Control-Key (RCK)** is a phone-held primitive that decouples "who can claim a subdomain's traffic" from "which server is currently handling it" — enables failover/migration/delegation.

## Live URLs

- `https://flagshipserver.com/` — landing
- `https://flagshipserver.com/ready/` — after an order: copy/download the recipe + get the burner
- `https://flagshipserver.com/dev/create-server` — phone simulator (mints build codes)
- `https://flagshipserver.com/status/` — live health
- `https://flagshipserver.com/api/health` — JSON health
- `https://flagship.services/api/health` — direct Fly health
- `https://<server>.<user>.flagship.services/` — user content (after a real install)

## Common operations

```sh
# Tests
npx vitest run                                  # everything (~30s)
npx tsc -b                                      # typecheck the whole tree

# Deploy
npx tsc -b && (cd apps/com && npx wrangler deploy)   # Worker — tsc -b FIRST: it bundles the BUILT control-plane dist/, so a deploy without a rebuild silently ships stale handler logic
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services

# D1 schema migrations
cd apps/com && npx wrangler d1 execute flagship-state \
    --file=../../packages/storage/migrations/0003_install_events.sql --remote

# Smoke a fresh build chain
# 1. Open https://flagshipserver.com/dev/create-server in a browser
# 2. Mint an order; collect the recipe from https://flagshipserver.com/ready/
# 3. Run packages/hello-daemon with the printed creds
# 4. curl https://<assigned-subdomain>/   (real green padlock)
```

## Conventions

- **No `Co-Authored-By: Claude` trailer on commits** — user preference.
- BUSL-1.1 license. Change Date 2030-05-03 → Apache 2.0.
- Imperative commit subjects. Body explains *why*, not *what*.
- TypeScript ESM, strict mode, `noUncheckedIndexedAccess`.
- Tests live next to packages: `packages/<pkg>/tests/`.
- Canonical-bytes use `|` separator and `flagship/<purpose>/v1` tag prefix.
- No comments unless the *why* is non-obvious; never explain *what*.
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace) and **`feat/retail`** (getting the app working with
  retail / NFC boxes). **No marketplace/retail code may sit on `main` until
  that feature launches** — branching IS the gate, there is NO gating/flag code
  in `main`.
  - **`alpine` is a *parked* branch, not a feature-to-launch.** It holds the
    full Alpine bare-metal installer path (ISO builder + apkovl + installer-tiny
    + the burner Quick/trailer flow + `/api/personalize-iso`) that `main` shed
    when we went Debian-only. Same mechanics (it's `main` + the Alpine delta,
    built by reverting the removal commits — `git diff <pre-extraction> alpine`
    was empty = lossless), but its purpose is *revival* if/when the Alpine
    initramfs USB-enumeration blocker is solved, not merging into a launch.
  - **Each branch = `main` + exactly one feature.** A branch is built so its
    diff against `main` is *only* that feature (so merging it ships the
    feature). Branches are **independent of each other** — you can check out one
    at a time to work on it; neither carries the other's code.
  - **Dependencies go through git, not entanglement.** If a feature ever
    depends on another, branch it OFF that feature's branch — never co-mingle
    two features on one branch.
  - **Extraction/reorg is forward-only** (no history rewrite on `main`) and
    **lossless** — nothing in features/UX/code/tests is lost, only relocated;
    anything removed from `main` exists on the feature branch.
  - **Workspace artifacts stay on `main`, never extracted:** DB migrations +
    repo-root `docs/*` design specs. Neither ships to users or the website —
    they're dev scaffolding. A feature-only table in prod (`marketplace_listings`,
    `box_serials`) is fine: develop the feature by checking out its branch and
    running against the live table. Only *application* code is extracted.
  - **At commit time, weigh impact on the feature branches** — they don't
    auto-receive `main`'s commits, so a `main`-only fix to shared code needs
    cherry-picking forward when a branch is integrated.

## Current status & open work

> **This section is the single source of truth.** Update it as work lands —
> don't spawn new `docs/*handoff*.md` files. Dated handoffs + completed launch
> trackers are frozen in `docs/archive/`. Last updated **2026-06-14**.

### 2026-06-14 (latest) — build-a-service multi-mode SHIPPED + folded into `main`

**Merged to `main`** (core feature, owner-directed). The whole multi-mode
"build a service" flow — chooser (scratch / git / mcp / marketplace / journal)
+ the shared build journal + AI-adapt + value-free env-requests + scratch
multimodal chat + **BYOK wired live** + an **AI-key step** on every surface —
is now on `main`. `feat/marketplace` + `feat/retail` must integrate `main` to
pick it up. Design + contract: `docs/build-modes.md`.

**AI-key flow (all surfaces).** The box-AI paths (scratch always; git only
when a non-fit repo needs adapting) show a "provide or confirm your AI key"
step before the model runs; marketplace + MCP skip it (no box model). It
recalls **device-saved keys** as a masked slug (`provider · label · ····1234`,
never the full key), pre-selects the active one (Confirm), and offers "Save on
this device". Storage is device-local + encrypted per surface — webapp
`providers.js` (UMK-wrapped IndexedDB), iOS Keychain (`SavedKeyStore`), Android
`EncryptedSharedPreferences` (`AiKeyStore`) — plus a **Settings → AI keys**
manager (view-slug / add / delete). The chosen `{provider, apiKey, baseUrl?}`
rides the build request as `credential` (sealed transiently per session/build
by the daemon; flagshipserver.com never in the path). One future item: the
**in-house / self-hosted inference server** (LAN `baseUrl` + `baseUrlGuard`
override) — BYOK needs no inference infra.

Final gates at merge: `npx tsc -b` clean · `npx vitest run` **5147 pass / 8
skip / 392 files** · iOS **979** XCTests · Android **789** unit tests + both
build. (Mobile chat *attachment picker* is the one deferred nice-to-have;
webapp has it.)

### 2026-06-14 — BYOK AI wired LIVE on the box

**`LlmHarness` is now complete + the live build paths actually run the
model.** Closed the three gaps that left scratch-chat + git-adapt as tested
seams:
- **Streaming in `LlmHarness`** (`chatStream(credential, request, onEvent)`):
  resolves a `StreamingLLMProvider` from a new `StreamingProviderRegistry`
  (anthropic/openai/google), applies the SSRF `baseUrlGuard`, streams
  `ChatStreamEvent`s; defaults `streamingFetchImpl` to a shared
  `defaultStreamingFetch` (Node fetch) so openai/google work in prod too. Plus
  `chatWithCredential` (non-streaming) for the adapt path. The harness holds
  NO key — it opens a credential per call.
- **Transient sealed BYOK credential store** (`llm/buildCredentialStore.ts`,
  mirrors `serviceEnvStore`): InMemory + File, keyed by session/build, SWK-
  sealed at rest (one `.cred` file, mode-0600), reload-on-boot so an in-flight
  build survives a daemon restart (the owner-endorsed "transient key on the
  box while the phone is locked"). `providerName()` is the only non-secret
  accessor; the value is never logged.
- **Contract:** optional `credential: {provider, apiKey, baseUrl?}` on
  vibe-code start/reply + build git/adapt. Delivered ONCE over the
  paired-session-gated pinned pipe (box terminates TLS), sealed for the
  session/build, **reused on later turns** — never echoed, never logged,
  never journalled (provider NAME at most). **flagshipserver.com is NEVER in
  the credential path.**
- **`index.ts` wiring:** constructs the harness + `FileBuildCredentialStore`,
  the live `startStreaming` thunk (`buildVibeCodeStartStreaming` now resolves
  provider+config per-session from the stored credential), and the live
  `adaptRunner` (+ `adaptCredentialAvailable` → clean 503 ONLY on genuine
  no-credential).
- **Graceful absence:** scratch start returns `200 {needsCredential:true}`
  (session exists, not streaming) → client shows "add an AI key"; adapt → 503
  "AI adapt not configured".

Future item: in-house / self-hosted inference server (LAN `baseUrl` +
`baseUrlGuard` override) — strict public-https guard applies today.

Gates: `npx tsc -b` clean · full `npx vitest run` **5138** pass / 8 skip (391
files; server-daemon+providers slice green incl. new `buildCredentialStore`,
`LlmHarness.chatStream`/`chatWithCredential`, live startStreaming + adapt
tests). iOS/Android untouched (clients are a later worker).

### 2026-06-14 — build-a-service multi-mode (`feat/build-modes`, FEATURE-COMPLETE pending launch)

**New feature branch `feat/build-modes`** — the "build a service" workflow
fans from one model-source pick into a **"how do you want to build it?"**
chooser over four sources, all converging on ONE deploy primitive
(harness-only Forgejo push → docker build → signed install) and ONE shared
**build journal**. Design + wire contract: `docs/build-modes.md`. Key answer
to the design question: **the box never needs an AI key as architecture** —
it's a contract-bounded function surface; the model is only needed by whoever
*authors*. 3 of 5 modes need no box-side model (git-fit, mcp, marketplace);
transient sealed keys for scratch/adapt are deliberate (build continues while
the phone is locked).

**Landed + gated (daemon + webapp):**
- **`buildmodes/` daemon backbone (all tested):** `buildJournal` (append-only
  JSONL, value-free/redacted, restart-safe), `gitImport` (clone + Flagship-
  fitness verdict + `buildAdaptPrompt`), `buildWorkspace` (path-safe file
  tree), `contract` (rules restated for an external agent), `mcpServer` (pure
  JSON-RPC 2.0 MCP — tools express the whole limited surface incl. value-free
  `request_env_var`), `mcpKeyStore` (sealed per-build bearer key, binds an IDE
  to one build), `deployArtifact` (mode-agnostic deploy core), `buildOrchestrator`,
  `buildModesHttp` (`/api/build/*` paired-gated + `/mcp/build/:id` bearer-gated
  Streamable-HTTP). Wired into `index.ts` (guarded on servicePlatform; scratch
  bridged into the same journal).
- **Webapp client:** chooser + git + mcp (URL/key/IDE-config/rotate) + journal
  viewer (`views/build-*.js`); create-service entry repointed to the chooser;
  marketplace tile degrades to "coming soon" until `feat/marketplace` merges.
- **`request_env_var` → owner (value-free):** the orchestrator keeps a per-build
  pending env-request list, fires a value-free `notifyOwner({buildId, name})`
  hook (log-only by default — production swaps in the push relay, mirroring the
  vibe-code W10 hook) + journals an `env-requested` entry; new
  `GET /api/build/sessions/:id/env-requests` returns the deduped list
  (`name/why?/secret?/requestedAt/requestedBy/currentlySet`, NEVER a value);
  the webapp mcp view shows it with a "the IDE never sees the value — set it in
  Configure environment" note.

Gates: `npx tsc -b` clean · daemon+providers+web vitest **2539** (229 files) ·
**iOS 945 XCTests** (+31, xcodebuild green) · **Android 761 unit tests** (+16,
gradle green). Forgejo-push stays harness-only (external actors go through
chat/git/mcp, the harness materializes).

**Multimodal chat for scratch — DONE (server seam + webapp UI).** Provider
layer was already done (`Attachment`/`ChatMessage.attachments` + Anthropic
base64 translation). Now: the vibe session carries attachments
(`pushUserMessage(text, attachments)` / `pushUserReply`), `vibeCodeStartStreaming`
puts them on the `ChatRequest` user message, and `messages()` surfaces them for
a reload; the screens BFF (`/vibe-code/start` + `talkToUser` `/reply`) and the
`/api/llm/sessions` start + `user-reply` paths accept inlined base64
attachments via one shared validator (`llm/vibeCodeAttachments.ts`: **≤6/turn,
image ≤4 MB decoded, text ≤256 KB, common image/* + text**); scratch turns
journal `user-message` (truncated text preview) + `attachment-added` (NAME +
kind + size ONLY, never content/base64) to the shared build journal (buildId =
vibe sessionId, hoisted above the vibe wiring in `index.ts`); the webapp
`views/vibe-code.js` is now a real chat (message list, composer with an
image/text attach picker, removable chips + image thumbnails, FileReader→base64
with the caps mirrored client-side, `/reply` follow-ups, Deploy). NOTE: the
live LLM provider is still NOT constructed in `index.ts` — this is the proven
*seam*; it lights up when that separate wiring lands. Gates: `tsc -b` clean ·
daemon vibe/buildmodes/screens green (+ new `vibeCodeAttachments` +
`screensVibeAttachments`) · web `webappBuildModesView` + new
`webappScratchChatView` · `llm-providers/multimodal` still green.

**Remaining (next):** AI-adapt endpoint for non-fit git repos — DONE (server
+ webapp): `POST /api/build/sessions/:id/adapt` renders the cloned tree via
`buildAdaptPrompt`, runs it through an injected `adaptRunner`, parses the
emit-format output with `VibeCodeStreamParser`, and merges the path-guarded
files into the workspace (manifest required); 503 "AI adapt not configured"
until the daemon's live LLM provider is wired (the pre-existing gap), and the
webapp falls back to from-scratch on a 503.

**iOS + Android — DONE.** Native chooser + git/mcp/journal screens (SwiftUI +
Compose) built to the `docs/build-modes.md` UX spec, with a build-modes API
client whose Mock matches the live wire format (pinned by tests). MCP screen
shows the copyable key + IDE config + the value-free env-requests list; git
screen has the fitness verdict + Install / Build-with-AI (503 → scratch);
journal list + timeline. Scratch tile routes to the existing vibe screen;
marketplace tile degrades to "coming soon".

**Remaining (all gated on one pre-existing dependency):** wire a **live LLM
provider** into the daemon boot path (`index.ts` never constructs one today —
not specific to this feature) — that single change lights up scratch-chat
streaming + git-adapt on all surfaces. Plus two nice-to-haves: the mobile
scratch **attachment picker** (mobile scratch uses the existing vibe screen),
and swapping the value-free `notifyOwner` env-request hook for the real push
relay (it's log-only by default, like the vibe-code W10 hook).

### 2026-06-14 — session-action buttons simplified across surfaces + webapp PIN lock

**Settings "leave the app" cluster relabelled + grey-out gating (all
surfaces).** The three tiers are now framed as a lock spectrum: tier-1
**"Lock with Face ID"** (iOS) / **"Lock with biometrics"** (Android), tier-2
**"Lock with passkey"** (was "Sign out" — erases the local key + data, restore
via recovery passkey), tier-3 **"Remove this device from account"**. Subtitles
simplified. Tiers 2+3 are now **greyed-but-tappable until cloud recovery is
enrolled** (demo exempt); a tap-while-greyed shows a toast ("Set up account
recovery to use this.") instead of running the destructive path — this also
closed an inconsistency where the *more* destructive remove-device had *no*
gate while sign-out did. iOS adds a `muted` style to `FSDangerButton` +
`onRecoveryRequired` wired to `ToastCenter`; Android mirrors it (Toast); the
confirm dialogs realigned to "Lock with passkey?". A fail-closed action-layer
backstop now guards remove-from-account too.

**Tier-1 "Lock with PIN code" — webapp only (new primitive).** The browser has
no biometric, so the webapp's tier-1 lock is a numeric PIN (replaces the
dropped biometric button). `lib/pinLock.js`: the UMK is PIN-wrapped in
IndexedDB (argon2id stretch) but the wrap key is bound to a **non-extractable
WebCrypto HMAC "device pepper"** — so a stolen IndexedDB copy can't be
brute-forced offline (guesses must run in-origin, where the **5-try lockout →
wipe-PIN → fall back to passphrase** bites). Threat model is explicitly the
casual "grabbed my unlocked tab", NOT device theft (that's tier-2 + disk
encryption). Flows: "Lock with PIN code" runs first-time setup (new+confirm)
then locks; **"Change PIN"** (visible only when set) requires the current PIN
then new+confirm; **any** full-passphrase unlock CLEARS the PIN (the reset
rule), and `resetDevice()` now clears it too so a tier-2/3 wipe can't leave a
PIN-wrapped copy of the key behind. New views `view-pin-unlock` /
`view-pin-set`; boot routes to the PIN screen when a PIN is set.

Gates: `npx tsc -b` clean · web vitest 1142 pass + new `webappPinLock` (crypto
roundtrip, lockout-wipe, device-pepper binding, reset-rule) + updated
`uxCopyFindings`/`webappSessionTiers`. **iOS (xcodebuild) + Android (gradle)
still need a build on the Mac** — this session was Linux, so only the TS/web
gates ran. The relabel/grey-out touch no copy-pinned mobile tests.

### 2026-06-12 — owner-assignable apex ("Front page") shipped on all surfaces + console banner fixed

**Front page (owner-assignable apex) — full slice, all surfaces.** The box
apex now 302s (no-store, never 301) to an installed service's tier-1
canonical, or serves the default Flagship card when unassigned. Design
rationale (from the apex discussion): REDIRECT, not serve-in-place — one
origin per app (no split cookie jars / zombie service workers on reassign),
and the URL bar lands on the pinned trust tier.
- **Protocol:** new `set-front-page` PhoneOrder
  (`flagship/order/set-front-page/v1|<serverId>|<label>|<issuedAt>`, "" =
  clear) + cross-platform pinned vector (`bc57770c…`, asserted by TS, webapp,
  Swift, Kotlin).
- **Daemon:** `frontPage.ts` — persisted `FrontPageStore`
  (/var/flagship/front-page.json), `GET/POST /api/front-page` (POST is the
  owner-IRK envelope path, same as `/api/power`; 422 on uninstalled label),
  the 302 itself (GET/HEAD on "/", APEX HOST ONLY — LAN IPs + /api/* are
  untouchable by construction), fallback to the default card when the
  assigned service disappears.
- **Clients:** "Front page" picker on server-detail — webapp
  (lib/frontPage.js + section), iOS (FrontPageCard + FrontPageViewModel +
  SetFrontPageOrder/FrontPageClient in shared, env-injected, pinned session),
  Android (FrontPageCard + FrontPageViewModel + core/api mirrors). Options
  come from the pod's unauthenticated `GET /api/services`; a stale assigned
  label shows "(no longer installed)" so the owner can clear it.

**Console banner fixed + subtitle (`a8666b51`).** The /etc/issue art was
block-Unicode + em-dashes; Debian's console font (Lat15) has no such glyphs →
rows of "?" boxes on metal (owner photo). Now pure ASCII + a bright-cyan
"Get yours at flagshipserver.com" line via a printf'd literal ESC (the VT
palette has no true teal). Test pins the banner to ASCII. Burner needs the
usual rebuild+sign+install to carry it (done this session).

Gates: vitest (protocol 507 · daemon 1221 · burner 185 · web 1135) · iOS 917
· Android 734 · `tsc -b` clean. NOTE: Android tests need
`JAVA_HOME=/opt/homebrew/opt/openjdk@17` on this machine (no system Java);
iOS tests run via `xcodebuild test -scheme FlagshipMobile-Package
-destination 'platform=iOS Simulator,id=<sim>,arch=arm64'` (plain `swift
test` fails on UIKit).

### 2026-06-12 (later) — ⭐ PHONE-APPROVAL UNLOCK E2E PROVEN ON METAL + mapper-name root cause

**MILESTONE: the full phone-approval LUKS chain is validated end-to-end on real
hardware.** az2.harry: burn → phone lease granted → box-sealed lease
self-unlock → (after the in-place mapper-name patch below) clean cryptroot
handoff → daemon up → Let's Encrypt per-box cert minted (issuer YR2, 20:01 UTC)
→ `https://az2.harry.flagship.services/` HTTP 200 with a verifying chain.
The 3×Enter + console-patch recovery worked exactly as designed.

**Box apex page shipped (brand v2).** The daemon's unassigned-apex landing
(`defaultApexPage`, runtime.ts) replaced the dev hello page: tokens.css
palette + the square/ring/core mark (breathing core = liveness), FQDN
rendered server-side, "This is a Flagship server… choose what appears here
from the Flagship app." Fully SELF-CONTAINED by design — no remote fonts/
assets, so a box never leaks its visitors to .com (pinned by test); noindex
(hostnames are CT-public). **Design decisions from the apex discussion:** no
in-page attestation ceremonies (self-attestation can't bootstrap trust —
TLS + phone pinning are the real mechanism), no box stats on a public page
(CT logs make every box apex discoverable). **Follow-up (product): make the
apex owner-assignable to one of the box's apps** (the page copy already
promises it); maybe a "verify this server" QR deep-linking into the app
(phone = verifier), explicitly attesting box health only — not the
browser's channel.

**🐛 NEW (track): the 5-minutely STK-signed daemon-status heartbeat is NOT
landing** — 60+ min after cert mint, `/pods` shows
`lastReported/signedStatus/currentCert` all null for az2 (and az). The box
serves fine; impact is phone-side cert PINNING (no pin installs without
`signedStatus`) + liveness detail. Next probe (console, `debug` user):
`journalctl -u flagship-daemon --no-pager | grep -i -E 'daemon-status|heartbeat|report'`
— then check the `.com` ingest path (handler auth? D1 write?).

The az2 live run got further than ever (burn ok, phone lease granted, box
self-unlocked from the box-sealed lease, VG activated) then hung forever at
Debian's "Please unlock disk sda4_crypt:" prompt → app showed "Never came
online". **ROOT CAUSE: the initramfs premount opened the LUKS container as
`flagship_root`, but Debian's `local-top/cryptroot` skips an already-active
target ONLY under its crypttab name (`sda4_crypt`)** — so cryptroot prompted
against an in-use device (unanswerable: cryptsetup refuses a busy source).
Every earlier encrypted e2e used the `manual` keyword, where cryptroot itself
opens the device — the premount-succeeds handoff had never run on metal.
**Fix (burner-only, committed): the Debian premount reads the target name from
`/cryptroot/crypttab` and opens under THAT (fallback `flagship_root`)**;
cryptroot then skips (verified against trixie cryptsetup 2:2.7.5-2 source:
`setup_mapping()` returns 0 if `dm_blkdevname "$CRYPTTAB_NAME"` exists; its
`prereqs()` lists every other local-top script, so the premount-first ordering
is guaranteed, not luck). New cross-language sha pin for the encrypted DEBIAN
bootstrap (`21cfa21b`, TS + Swift; the old `ba0f4fcc` pin covers the Ubuntu
literal and is unchanged). Burner rebuilt + re-signed + installed.
**az2 recovery without a reburn:** at the prompt press Enter 3× (cryptroot
gives up + exits; root LV is already active so boot continues; ignore/Enter
through the full-OS sda4_crypt passphrase prompt — it times out harmless),
log in as `debug` on the console, then
`sudo sed -i 's/"$ROOT_LUKS_PART" flagship_root/"$ROOT_LUKS_PART" sda4_crypt/' /etc/initramfs-tools/scripts/local-top/flagship-unlock && sudo update-initramfs -u`
and reboot — the box should then self-unlock AND come online (validates the
whole phone-approval chain). UI polish for the phone approval flow noted as a
follow-up (owner request).

### 2026-06-12 — phone-approval unlock debugged to root cause + boot merge live

Long live-hardware session driving the FIRST end-to-end **phone-approval LUKS
unlock** (every prior unlock used the `manual` keyword, so this path was never
exercised). Box `az.harry` (10.10.3.142) reached green padlock but the
phone-approval flow surfaced a chain of real bugs, now all fixed + pushed +
deployed (Worker `b23e0e3d`; com/boot/services all 200):

- **⭐ ROOT-CAUSE: the box sealed its disk key to the discarded delegated key
  (`eadd7195`, burner — needs re-burn to take).** The bootstrap sealed the LUKS
  key to the blob's `phoneDelegatedPubKey`, but the phone generates that
  per-server keypair at create-time and DISCARDS the private half — so the disk
  key was sealed to a key NO phone could reproduce (error: "couldn't unseal the
  disk key with this phone's keys"). Fix: seal to the account **IRK**
  (`authCode.userPubKey`, already in the blob) — phone re-derives it via
  `deriveIRK` and it survives cloud recovery. Burner-only (userdata.ts + Swift
  mirror, sha re-pinned ba0f4fcc); **burner rebuilt+signed+installed**. This is
  the "owner-IRK path" the pre-existing-bug note called for. EXISTING boxes
  sealed to the dead key can't be unlocked → re-burn (or SSH re-seal a live box).
- **Boot-worker consolidation CUT OVER (live).** `boot.flagshipserver.com` is now
  a Custom Domain on `flagship-com` (served from `@flagship/boot-core` in-process);
  the fragile cross-worker notify bridge is gone. `apps/boot` kept as a routeless
  clone target. (Full rationale + DNS mechanics: the 2026-06-11 entry below +
  `docs/boot-worker-consolidation.md`.)
- **Cheap `awaitingUnlock` directory signal (`0a0c93ad` + trickle `19306f3c`).**
  A locked box can't heartbeat and the phone's mailbox read is biometric (can't
  poll), so a waiting box was misclassified "never came online" + offered for
  (dangerous) deletion. `/api/users/:u/pods` now returns `awaitingUnlock` per pod
  (from `secret_mailbox.listPendingForUser`, no auth); iOS + Android + webapp
  consume it → "waiting for approval", delete suppressed.
- **iOS approval-card chain fixed:** surfaced the boot-unlock card at the TOP of
  the server page, OUTSIDE the state switch (`3ed05f12`); made the mailbox read
  user-initiated since the IRK is biometric and can't poll (`db996e8e`); show it
  whenever `awaitingUnlock` is true regardless of BFF load (`aa38e5d9`); and the
  REAL blocker — **the card built its VM in `onAppear` inside a `Group { if let
  vm }`, so the first render was a zero-size empty view and onAppear never fired
  in the ScrollView → card permanently blank** — fixed by building the VM
  synchronously in the body (`e8ac4ed9`). The full UI now works: card shows →
  Check (Face ID) → finds request → Approve (Face ID).

**OWNER — to validate the unlock fix (NOT yet proven):** the UI + relay are
proven; only the unseal needs a box sealed with the new code. Either (A) **SSH
re-seal** `az.harry`: console `manual`+burn-passphrase to boot it, then re-key +
`seal-for-bak --bak-ed25519-pub <authCode.userPubKey>` + re-upload (faster, no
burn), or (B) **fresh burn** with the rebuilt burner. Then Check→Approve should
unseal. Also rebuild the iOS + Android apps (all the card/awaitingUnlock changes
are source-only).

**New follow-ups:** `phoneDelegatedPubKey` is now unused for unlock (still used by
the separately-DEAD PhoneOrder path) — clean up or persist; phone-approval unlock
e2e still unproven; (carried) `recovery.flagshipserver.com` doesn't resolve
(route, no DNS record — make it a custom domain like boot.); push-token/APNs gap
(no auto-notification until TestFlight/Play).

### 2026-06-11 — full deploy + prod wipe for a fresh hardware e2e

Prepped a clean-slate e2e (no agent-doable blockers remained — machine backlog
closed; this session's docker fix + status-pill UI all landed).
- **Burner** rebuilt + re-signed (IBIS LLC Developer ID) + installed to
  `/Applications` (carries the docker-install bootstrap `edd3580e`).
- **`.com` Worker deployed** (`npx tsc -b && wrangler deploy`). Prod D1 already
  had migrations 0047/0048/0049; applied **0050 (boot_nonces, idempotent)**.
- **Boot-worker consolidation CUT OVER (live, version `82bb011f`).** After
  weighing merge-vs-true-decouple: the coupling is intrinsic (boot AUTHORIZES an
  unlock by binding the principal to the identity-plane directory — `gate.ts`),
  and the security boundary is the phone IRK, not the worker split, so a separate
  deployment only ever bought the fragile shared-secret notify bridge (the
  silent-401 unlock-hang). Kept the logical separation at the `@flagship/boot-core`
  package boundary; merged the deployment. **Mechanism: `boot.flagshipserver.com`
  is now a CUSTOM DOMAIN on flagship-com, not a zone route** — the zone has no
  wildcard, and a bare route has no DNS record to catch (recovery., a route with
  no record, doesn't even resolve). `wrangler deploy` reassigned the existing
  custom domain from flagship-boot → flagship-com in place (DNS+cert reused →
  zero downtime). Verified: `/api/health` flipped to `service:"flagship-com",
  surface:"boot"` (ssl_verify=0), gate rejects unauthed `/api/boot/lease/…` with
  `400 malformed authorization`. Contract byte-identical → box/burner/phone need
  no change (compat audited: boot-core routes = `boot-stage.sh` + initramfs +
  `SecretMailboxClient` call sites; in-process directory/notify/push wired in
  `tryBootHost`). `apps/boot` kept as a routeless clone target.
- **`.services` Fly app deployed** (`flyctl deploy`, immediate). Health: com /
  boot / services all 200.
- **Prod DB wiped** (`scripts/wipe-all-users.sh` — 44 tables, marketplace_listings
  + schema_version preserved). servers/usernames/secret_mailbox all 0.
- **Owner-side for the e2e:** rebuild the iOS app in Xcode + the Android app
  (the status-pill fix + cert simplification + push token are source-only); then
  fresh encrypted burn → register → green padlock → **phone-approval unlock**
  (the one path still unproven; prior e2e unlocked via the `manual` keyword).
  The previous live box (`xyz.harry.flagship.services`, 10.10.3.142) was just
  de-registered by the wipe — reuse that hardware for the fresh burn. Burner
  re-rebuilt + DB re-wiped right before this e2e (clean: servers/usernames/
  mailbox = 0; boot merge live).

- **🐛 FOUND (track to GA) — `recovery.flagshipserver.com` does NOT resolve.**
  It's declared as a Worker **Route** in `apps/com/wrangler.toml`, but the
  flagshipserver.com zone has **no wildcard** and recovery. has **no explicit
  DNS record**, so `dig`/`curl` fail with "could not resolve host" — the webapp
  cloud-recovery sub-origin flow (WebAuthn rpId `recovery.flagshipserver.com`)
  is currently broken in prod. Same DNS gotcha the boot cutover surfaced: a
  route only fires for a hostname that already resolves into Cloudflare (`web.`
  works because it has an explicit proxied CNAME). **Fix:** either add a proxied
  DNS record for recovery. (CNAME → flagshipserver.com, like web.) OR make it a
  **custom domain** on flagship-com (like boot. now is — wrangler self-provisions
  DNS+cert). Needs CF dashboard/API (no CF API token in the agent env; wrangler
  can't create arbitrary DNS records, but the custom-domain route in wrangler.toml
  would do it on the next deploy). Doesn't block the cert/boot/unlock e2e.

### 2026-06-11 — vestigial UI removed + WhatsApp-inspired redesign

- **Removed the vestigial "grant a box cert autonomy" ceremony** (iOS + Android;
  webapp never had it). Cert simplification made every box self-renew, so sealing
  the shared ACME account key to a box for "autonomous minting" is meaningless.
  Kept the AcmeAccountKeyGrant machinery (tier-2 + recovery still use it).
- **UI redesign (WhatsApp-inspired), trickled to all platforms.** Found + fixed a
  brand split: mobile was still on the legacy blue `#3B5BFF` while web was on the
  brand teal — **unified mobile on teal `#14B8A6`/`#2DD4BF`**. New shared component
  language (filter chip row, search field, account monogram, profile hero card,
  single dismissible announcement card, grouped icon-square settings rows, clean
  list rows), applied to the three hero screens (Home/Servers, Apps, Settings) on
  iOS (reference), Android (Compose mirror), and webapp (vanilla JS mirror): large
  collapsing title + search + filter chips (All/Online/Pending/Offline on Home;
  All/Yours/Shared on Apps) + list rows + announcement card; Settings gets a
  profile hero + grouped rows. A shared status classifier (PodStatusStyle /
  HomeStatusFilter) keeps the bucket rules identical across platforms. Large-screen
  pass: a 640pt centered reading column + inline titles on iPad/expanded. Pure
  presentation restyle — every callback/flow + the sign-out gating preserved.
  Note: the webapp already had a bottom tab bar (an earlier note was stale).
- Analysis confirmed iOS/Android were already at near-parity on flows; the
  redesign + teal unification closed the main visual/brand gaps.

Gates: `npx vitest run` 4914 (371 files) · iOS 906 · Android 724 · webapp 1125 ·
`npx tsc -b` clean. All pushed.

### 2026-06-11 (later) — cert model simplified + lock/dead-man feature

**Cert model simplified to one system-wide policy.** Removed the creation-time
managed-vs-autonomous / offline-window choice and the account-wide
certificate-validity setting (all clients). Every box now self-renews its own
per-box A′ cert with its own ACME account key on a single policy: standard
~90-day cert, renew at ≤30 days remaining (one issuance per ~60 days) with a
per-box random hold-off + backoff-jitter so the fleet never bursts Let's
Encrypt. The shared account-key + mint-reservation machinery is untouched
(tier-2 service certs + recovery still use it). `certAutonomy` removed from the
InstallBlob + canonical bytes (byte-identical when absent → no signature break)
across protocol, daemon, iso-personalizer, both burners, and all 3 clients.
Follow-up: the post-creation "grant a box cert autonomy" ceremony
(CertAutonomyGrant* on iOS/Android) is now vestigial — retire separately.

**Lock & power-off + dead-man heartbeat-lock shipped** (`docs/lock-and-poweroff.md`;
ungated/all-users for now — paid gating is a later pass). One shared daemon
primitive (`executeLockAndPower` = suppress auto-unlock → `systemctl
poweroff|reboot`), exposed two ways:
- **Manual buttons** on server-detail (iOS/Android/webapp): "Lock and turn off" /
  "Lock and restart" (drop "Lock and" on a non-LUKS box) → confirm + biometric →
  IRK-signed power-off envelope to **`POST /api/power`**.
- **Dead-man**: opt-in per box (default off). A MANUAL biometric affirmation
  (never the silent renewer — a stolen phone can't keep it alive) renews a lease;
  on lapse past grace the daemon suppresses auto-unlock then powers off/restarts
  per policy. Window default 24h, user-shortenable with a one-tap "tighten now"
  (border-control case). Lockout default = turn off (rubber-hose posture),
  selectable to restart (fast resume).
- A **one-shot** `/boot/flagship-lock-once` marker forces approve-mode on the
  next boot only (consumed after a successful luksOpen), honored at the actual
  LUKS-unlock layer — the initramfs premount for encrypted boxes (TS+Swift
  byte-identical, sha re-pinned), boot-stage.sh for the unencrypted path,
  mutually exclusive. A single Lock&restart does NOT permanently flip the box to
  approve-mode. Needs a live reburn to validate the kernel/luksOpen path.

**⚠️ PRE-EXISTING BUG surfaced (track to GA): the phone→box PhoneOrder path is
DEAD on real Debian boxes.** The daemon verifies orders against `pskPub` read
from `/var/flagship/psk.pub.hex`, but that file is NEVER written — the installer
writes `/var/flagship/phone-delegated.pub` instead, and the phone generates the
per-server "delegated" keypair at create-time then DISCARDS the private half. So
`/api/orders-from-user` is disabled on metal, and **`shut-down` +
`add-paired-session`/`remove-paired-session` cannot be invoked on a real box.**
The lock feature sidestepped this (power-off now verifies against the owner IRK
at `/api/power`, like the dead-man, which works because the box persists
`cfg.irkPublicKey`). Fix the rest of the orders surface before GA: either
persist the delegated private key on the phone + reconcile the
psk.pub.hex/phone-delegated.pub filename + sign orders with it, OR cut the
remaining orders over to the owner-IRK path like power-off did.

Gates (2026-06-11 later): `npx vitest run` 4868 (369 files) · iOS 896 · Android
718 · burner-mac swift 107 · `npx tsc -b` clean. All pushed.

### 2026-06-11 (late) — full-repo security/UX/ops audit + remediation

Ran a six-dimension read-only audit (protocol/crypto, cloud API, daemon/boot,
client, UX, architecture/ops), **personally verified every critical/high claim**
(four agent-flagged "CRITICALs" were false — see below), then fixed the verified
set. 13 focused commits, all gated (vitest **4817**/365 files · iOS 877 · Android
702 · `npx tsc -b` clean). On `main`, pushed.

**Verified-and-fixed:**
- **cert-pin keep-last-known-good (iOS+Android, the top security fix):** `update(pods)`
  used to DROP a verified pin when a still-listed pod's daemon-status didn't
  re-verify → a MITM on the `.com` path could strip `signedStatus` and downgrade to
  default TLS (rogue-cert passes). Now: present+verifies replaces, present+unverified
  RETAINS, absent/revoked prunes. `d6c61ab`/`b145481`.
- **push/relay auth** `19097ce` — was unauthenticated (push spam + registration
  oracle); now an STK-signed `flagship/push-relay/v1` envelope from a registered box,
  category constrained to an enum, no-token target returns `200 {fanout:0}` (oracle
  closed).
- **rate limits** `c96f521` — added buckets for push-relay, voici/shorten,
  llm-promo/issue (were unthrottled at the edge).
- **app-container isolation** `33d2760` — `--cap-drop=ALL`, dedicated bridge (apps can
  no longer reach the daemon API/siblings over host loopback; data path preserved via
  host-gateway alias), `--memory/--cpus/--pids-limit`, read-only rootfs.
- **BYOK SSRF guard** `809bae9` — `assertSafeProviderBaseUrl` blocks loopback/
  link-local/metadata-IP/RFC1918 (override for LAN Ollama); DNS-rebinding documented
  as residual.
- **canonical field-guard uniformity** `424af57` — `legacyFieldGuard` now on every
  free-text canonical field (defense-in-depth; JSON blobs exempt).
- **D1↔InMemory parity harness** `b65d2a3` — real D1-over-`node:sqlite`, all 48
  migrations; **caught a real bug** (D1 `voiciLinks.insert` masked every storage error
  as a collision — now rethrows).
- **ops guardrails:** predeploy staleness gate `5620219`; migration ledger +
  `/api/admin/schema-status` + CA-lease lapse warning (`/api/admin/ca-lease-status`,
  7-day audit alert) `2371e88`.
- **UX pass (all surfaces)** `f2d428a`/`4b1d971`/`2f4d2ca` — cert-pin hard-fail now a
  visible "someone may be intercepting" alert (was a silent network error); raw `HTTP
  <code>` strings → plain language; sign-out→recovery CTA; wedged-install escape;
  de-jargoned recovery copy; short-vs-canonical link labels.

**Audit claims that did NOT survive verification (don't re-chase):** cert-pin
"label-boundary bypass" (the leading `.` defeats it), "SQL injection" (it's an
authenticated owner-only SQL console over the owner's own DB), "preseed shell
injection" (debconf scalar, not shell; newline already stripped), "root-helper
arbitrary write" (write target is `/dev/disk*`, caller is code-sign-pinned), "TOTP
brute-force" (handler self-throttles 5/15min). Residual real-but-deferred: tier-2
mint/install client UX; cert-pin can't run in-browser (webapp relies on CAA+CT);
DNS-rebinding on BYOK baseUrl.

**Deploy note for this batch:** apply migration `0049_schema_version.sql` with the
rest; the new admin endpoints + CA-lease cron ride the normal Worker deploy; the
predeploy gate now runs automatically before `wrangler deploy`.

### 2026-06-11 — machine-doable backlog closed (cert A′ + #52 + parity + NFC C3)

Everything agent-doable from the open-work list landed this session; `main` and
`feat/retail` are both green and pushed. Beyond the cert migration (block below):
- **#52 re-pair hardening (`b95f9ad`):** the same-day-rotation mystery is
  ROOT-CAUSED in code — `/re-pair/complete` is signature-less and accepted any
  row with `completesAt <= now` with NO upper bound, so a stale pending row from
  earlier testing was completable forever, by anyone (this is almost certainly
  how the live rotation "beat" the 3d grace). Fixed: completion only inside
  `[completesAt, +7d)`, else 410 + sweep + audit; initiate's lock keeps a row
  alive through that window (a rival initiate could previously evict a legit
  recovery at grace-elapse). And single-device initiate now requires TOTP or a
  recovery code when enrolled (neither enrolled → grace-only + audited);
  iOS/Android/webapp reuse the multi-device second-factor UX on the 401.
- **Android install-progress parity (`c57a350`):** live ladder on
  the pending-pod detail (order mode w/ serial, else /pods `pending[].phase`
  directory fallback), instant Home upsert at delivery, and the fake-ONLINE
  random-podId pod on leaving the progress screen is gone. Follow-up noted:
  Android has no PendingServerStore — pending pods don't survive process death
  with their serial (iOS persists them).
- **NFC C3 shipped on `feat/retail`** (`837c179`+`3a628fd`+`a5b4c77`, pushed):
  iOS+Android read-only tap flow per the locked Q2 decision — incl. a REAL
  protocol bug fix (the Wi-Fi rendezvous deposit never carried the phone's
  ephemeral pub, so the box could never have decrypted it; new blob format
  `ePhonePub||ciphertext`), 30s session-lock shared constant, SAS glance,
  LED-SAS fallback seam. `main` stays retail-free; § N updated. Open: N-PHONE-3
  write tap, N-PHONE-6 LED capture UI, N-BOX-8 daemon rendezvous consumer.

**OWNER CHECKLIST (in order — everything machine-side is done and pushed):**
1. **Deploy `.com`**: apply D1 migrations `0047_ct_alerts.sql` AND
   `0048_daemon_status_signed.sql` to prod FIRST (0048 before the Worker — the
   new write path needs the columns), wire `CloudflareDnsClient` as the CAA
   client, then `npx tsc -b && cd apps/com && npx wrangler deploy`.
2. `flyctl deploy` the `.services` app (hub wildcard-claim hardening + per-box
   DNS route changes).
3. **One prod read I was permission-blocked from** (then optionally wipe):
   `cd apps/com && npx wrangler d1 execute flagship-state --remote --command
   "SELECT username, initiated_at, completes_at, objected_at FROM
   pending_re_pairs"` — if a stale row predating the live rotation is (still)
   there, that confirms the #52 root cause empirically; the code fix closes the
   hole either way. Then `bash scripts/wipe-all-users.sh` for the clean slate.
4. **Rebuild + re-sign the Mac burner** (A′ daemon changes ship in the recipe).
5. **Rebuild the iOS app in Xcode** (pinning + tier-1 URLs + re-pair second
   factor + push token).
6. **Hardware e2e** — the full post-cert-rebuild test list at the bottom of
   `docs/cert-model-A-prime-migration.md`: fresh encrypted burn → per-box cert
   green on `<server>.<user>` AND `x.<server>.<user>`, phone-approval unlock
   (notify pipe is fixed), pin enforcement on a real box, CAA/CT checks,
   decommission, voi.ci.
7. Recovery Phase B on-device validation + iOS owner-device confirmations
   (carry-overs, unchanged).

**New follow-ups surfaced this session (agent-doable next time):** tier-2
mint/install client orchestration UX (daemon endpoints + envelopes are live);
phone reminder before a shared service cert expires; custom-domain CNAME target
`<user>.flagship.services` no longer has an A record under per-box DNS (weigh
with tier-2 work); mobile in-app Replace-device lacks the TOTP prompt (webapp
ceremony has it); Android PendingServerStore persistence; webapp pending
re-pair banner could surface the completion deadline on GET.

### 2026-06-10 (late) — CERT-MODEL MIGRATION C → A′ EXECUTED IN CODE

**⭐ The entire cert-model migration is implemented on `main` and gated** (15
commits; vitest 4608 · iOS full suite green · Android 669 · burner-mac 109 ·
`npx tsc -b` clean). `docs/cert-model-A-prime-migration.md` header lists what
remains. What landed:
- **Phase 1 (per-box wildcard):** the daemon mints `[<server>.<user>, *.<server>.<user>]`
  (`boxCertSans`, SANs re-derived at startup ⇒ model-C certs auto-discard +
  re-mint on first boot); `.com` registration publishes the per-box A/AAAA pair;
  DNS-01 (`dns01.ts` AND the dns-broker policy) accept a box's challenges ONLY at
  its own subdomain; CAA stays at the user zone (RFC 8659 tree-climb covers
  everything below); CT monitoring (both monitors) flags any cert whose SAN set
  doesn't fit exactly ONE registered box's pair — incl. the retired per-user shape.
- **Phase 2 (`--` revert):** pin operator deleted (hierarchy replaces it);
  tier-1 canonical `https://<label>.<server>.<user>` is the share/copy/open URL on
  iOS + Android + webapp (clients use the daemon-provided AppSummary.url, not
  local derivation); mocks mirror the live shape. Tier-2 `<label>.<user>` kept
  ONLY where genuinely leader-routed. Bonus bug fix: app-backup `resolveSource`
  composed `<creator>--<slug>` and never matched (8a00e3b).
- **Phase 3 (voi.ci):** no change needed — targets already mint from the tier-1
  canonical.
- **Phase 4 (pinning):** `/pods` relays the VERBATIM STK-signed daemon-status
  (`signedStatus`, migration **0048**); `verifyDaemonStatusReport` in
  @flagship/protocol + byte-identical Swift/Kotlin mirrors (pinned cross-platform
  vector). iOS (URLSession delegate) + Android (hostname-verifier + interceptor —
  the verifier stage covers WebSockets, which OkHttp interceptors skip) HARD-FAIL
  when a verified pin mismatches; fail-open only when no pin exists. STK pubs
  derive LOCALLY (.com's echo is not a trust input); demo/mock can't install pins.
- **Phase 5 (tier-2 shared service certs):** ServiceCertAuthority (IRK, ≤1h) +
  mint/export/install envelopes; the authorized box mints `[<service>.<user>]`
  via its own ACME with the authority forwarded on DNS-01; key distribution is
  phone-driven over each box's pinned canonical pipe (`POST /api/service-certs/
  {mint,export,install}` on the daemon); certManager serves it on exact SNI;
  rehydrates on restart. Renewal = phone re-mints (deliberate v1).
- **Hub hardening (came out of the routing audit):** routing never used wildcard
  claims (the one-label SNI strip IS the per-box wildcard, and the old `*.<user>`
  claim was inert) — but nothing REFUSED foreign wildcards; now the hub nacks any
  wildcard claim except a box's own `*.<podCanonical>`, the allocator drops `*`
  canonicals, findBySni refuses `*` SNIs.

**Deploy set for this migration (owner, do together):** `npx tsc -b && cd apps/com
&& npx wrangler deploy` · apply migrations **0047_ct_alerts.sql + 0048_daemon_
status_signed.sql** to prod D1 (0048 BEFORE the Worker deploy — the new D1 write
path needs the columns) · wire `CloudflareDnsClient` as the CAA client · rebuild
+ re-sign the Mac burner · rebuild the iOS app · wipe + fresh burn → the full
post-cert-rebuild hardware test list in the migration doc.

**Open follow-ups from the migration:** tier-2 mint/install client UX (phone
orchestration of the new daemon endpoints — protocol + endpoints are done);
phone-side reminder before a shared service cert expires; custom-domain CNAME
target says `<user>.flagship.services` whose A record per-box DNS no longer
publishes (weigh with tier-2/custom-domain work); webapp cannot pin (browser
constraint — CAA + CT are its backstop).

### 2026-06-10 session — ENCRYPTED BOX e2e PROVEN ON METAL + cert-model plan

**⭐ MILESTONE: the encrypted-box end-to-end works on real hardware.** After a long
debug chain, a real encrypted box (`abc5.harry1.flagship.services`) reached a genuine
**Let's Encrypt green padlock** (issuer CN=YR1, per-user cert `[harry1, *.harry1]`),
serving content, `.services` content-blind. The #27 saga's entire downstream is
validated. (The unlock was MANUAL via the `manual` keyword + recovery passphrase — the
PHONE-approval unlock still needs a fresh end-to-end run, see TODO.)

**DOCKER FIX (2026-06-11, agent, on real metal + on `main`):** the daemon was
crash-looping on the live A′ box because docker was never installed — the bootstrap
apt-installed node/git but not docker, so `ensureNetwork`'s `docker network create`
hit ENOENT. Two commits: `1b1b75e7` made the daemon survive a missing docker
(serviceRunner's realCommandRunner had no `'error'` listener → unhandled crash;
`ensureNetwork` now swallows it); `edd3580e` installs docker in the bootstrap
(`docker.io docker-cli docker-compose` — docker-cli listed explicitly because
`--no-install-recommends` drops it) + a gated `flagship-data-services.service`
oneshot that runs `installer/data-services/init.sh` after docker is up (NOT before
the daemon — image pulls must not delay the padlock). Verified live: docker installs,
`network create` succeeds, the full data stack (postgres/minio/redis/forgejo/chromium)
comes up healthy, daemon logs **"data layer wired"**, green padlock holds. Swift burner
mirror byte-identical (bootstrap sha pin re-asserts both sides). Burner 200 TS + 57
swift EngineTests green; `tsc -b` clean.

**~~NEXT SESSION = EXECUTE THE CERT-MODEL MIGRATION~~ — DONE, see the block
above.** Full detailed plan in
`docs/cert-model-A-prime-migration.md` (all decisions LOCKED). Headline: move off the
current model **C** (per-box key + per-user wildcard `*.<user>`, each box re-mints →
hits LE's duplicate-cert limit at >5 boxes + forced the `--` name hack) to **A′**:
- **A′ = per-box wildcard** `[<server>.<user>, *.<server>.<user>]` — box-local key,
  never shared, distinct per box (no duplicate-limit), covers `<service>.<server>.<user>`.
- **Revert `--`** flattening → hierarchical `<service>.<server>.<user>`.
- **Three trust tiers** (the share-URL encodes the assurance): canonical
  `<service>.<server>.<user>` (security+hardware, pinned) · `<service>.<user>` (security,
  hardware-agnostic, leader-routed — the EXISTING multi-server mechanism, KEPT) ·
  `voi.ci/<blurb>` (convenience redirector, visible 302, trust-us).
- **Canonical long-form HTTPS = the root primitive** — incl. delivering a tier-2
  `<service>.<user>` key to a box over its own pinned pipe (phone→box direct, NOT `.com`).
- **voi.ci stays a path redirector** (no per-service certs, no voi.ci LE exposure).
- **Cert-fingerprint pinning** (hard-fail) off the STK-signed daemon-status fingerprint
  — the real defense against a `.com` rogue cert.
- **PSL** for flagship.services: file once there are real users (per LE).
- The post-cert-rebuild **test TODO** lives at the bottom of that doc (the rebuild
  touches names/certs/DNS/routing/all clients → full validation pass follows).

**What landed this session (all committed + pushed; `main` green, tree clean):**
- **Boot-unlock brought up on metal** — initramfs Wi-Fi (op-mode module staging, DNS
  resolv.conf+NSS, CA bundle, wired DHCP) `7db385a`/`de10869`/`c2617a9`/`8101e6b`;
  Beacon E `installing`; **wait-forever for phone + `manual` keyword override + mailbox
  heartbeat** `964cd88`; boot worker fixes — **service binding to the identity plane**
  `d17ae01` (same-zone Worker→Worker fetch was returning HTML), **fetch `this`-binding
  1101 fix** `242ab68`, no-store directory reads `76aa05e`.
- **#52 sign-out gate** `8f9c9c0` · **/pods serial→orderRef** `aa78e2b` · **iOS
  install-progress** `48a4b9e` · **decommission failed servers (free the name)**
  `240ac3e` + dead-server status `e4b38e5` · **3-state liveness (waiting/coming-online/
  dead)** `56910d1` · **monotonic install checklist (phase order)** `97f63c5` ·
  **liveness bridge (live box reads online) + daemon-status heartbeat** `41a039a` ·
  Dock progress contrast `73cf35f`.
- **Cert-security (committed, NOT deployed — deploy WITH the cert rebuild):** CAA
  CA-restriction publishing `ca29a0b`; CT-log rogue-cert monitor (6h cron, owner
  push) `1f8086e`.
- **Notify pipe FIXED (root cause of "no phone permission ever"):** the boot→`.com`
  notify shared secret was mismatched (silent 401) → re-synced `NOTIFY_SHARED_SECRET`
  (boot) and `BOOT_NOTIFY_SECRET` (.com) to one value. (No commit — secret rotation.)
- Security tracking added to the pre-GA list `b52762f` (/pods enumeration; CAA+CT;
  daemon reporting).

**OWNER-SIDE (carry into next session):** rebuild the iOS app (push token + all the
UX); deploy `.com` + apply migration `0047_ct_alerts.sql` + wire `CloudflareDnsClient`
as the CAA client (do this WITH the cert rebuild); rebuild+re-sign the Mac burner after
the A′ daemon change; then the phone-approval unlock e2e.

Gates (2026-06-10): `npx vitest run` 4517 (351 files) · iOS 824 · Android 620 · burner
175 TS + 105 swift · webapp green · `npx tsc -b` clean.

### 2026-06-09 session — what landed + the live encrypted-unlock failure

**NEXT SESSION — FIRST MOVES (in order):**
1. **Deploy the Worker** — `npx tsc -b && cd apps/com && npx wrangler deploy`. One deploy ships three things: the `/pods` orderRef hardening (`aa78e2b`), and (already-seeded) `FLAGSHIP_ISO_MANIFEST` Simple-mode downloads.
2. `bash scripts/wipe-all-users.sh` (clean slate).
3. Rebuild the iOS app in Xcode — `main` has the consolidated server list (#56), orderRef reconciliation, the #52 sign-out gate, the three-tier session model (#46), and the keychain self-heal.
4. **Rebuild + re-sign the Mac burner** — it is NO LONGER current: `main` now carries the 2026-06-09 initramfs Wi-Fi hardening + the `installing` beacon (`7db385a`); a reburn from the old binary would re-test the broken hook.
5. **Encrypted Wi-Fi e2e (#27) — the ONE piece the project still has to prove.** Create a fresh account → **enroll Cloud Recovery FIRST** (sign-out is now BLOCKED without it, #52) → create a server with **Encrypt disk ON** (default) → burn with the rebuilt burner → boot → unplug USB → power on → watch LUKS-unlock-over-Wi-Fi. If it still fails: console-login as `debug` / `flagship`, read **`/boot/flagship-wifi-build.log`** (NEW — stage-by-stage build-time staging log: interface/driver/firmware/binaries, each OK or MISSING) + `/boot/flagship-wifi.log` (an empty one now means "premount never ran", nothing else).

**2026-06-09 evening sweep (agent) — four task closures on `main`:**
- `7db385a` **#27 hardening + Beacon E** — see the updated LIVE FAILURE note below.
- `8f9c9c0` **#52 DONE** — Tier-2 sign-out is blocked without cloud recovery on iOS + Android + webapp (shared `SignOutPolicy`, enforced at the action layer that calls `Keystore.wipe()`, not just dialog copy; blocked dialog routes into recovery enrollment; demo/mock sessions exempt). The re-pair audit answered the open question: single-device re-pair-by-grace with a brand-new self-signed IRK is the **designed** takeover path (no credential to initiate, old key has no veto, only T+0/+1d/+3d alerts) — so blocking the no-recovery wipe is the correct fix. One loose end: the observed live rotation completed same-day, which the 3d grace shouldn't permit — check whether a stale pending re-pair row predated it.
- `aa78e2b` **/pods serial → orderRef** (details in the SECURITY list below).
- **Android #56 parity was already DONE** (`f0acd5d`, complete port + 6 pending-state tests) — the "in flight" note below was stale.
- **Recovery Phase B iOS re-pair branch (open-work item 5) is already fully wired + tested** — `registeredIrkPubHex` captured (RecoveryViewModel:184), `recoveredKeyMatchesRegistered` (:239), Phase A/B branch in `RealAccountLoginViewModel.startSingleDeviceTakeover()` (:250) calling `initiateRotatedRePair` with `oldIrkPub = registeredIrkPubHex`, KeyfileImportViewModel instant skip-grace. Only on-device validation remains.
- `48a4b9e` **iOS install-progress fixes from the live burn** (deploy+wipe+burner-rebuild had been run; a real encrypted Wi-Fi install was in flight and the backend phases were advancing — Beacon E `installing` CONFIRMED firing on metal): (1) the delivered page's hardcoded "Status: pending" → live ladder polling the per-order status; (2) the pod now upserts onto Home the moment the delivered page appears (was: only on "Done" — a watcher of that page never saw the server until pull-down); (3) a serial-less pod (surfaced from `/pods`, which ships only opaque orderRefs) sat forever on the empty "Booting up" ladder → the timeline VM gained a directory fallback (poll `/pods`, project `pending[].phase`, flip live on registration) and `upsertPendingPod` re-attaches the local serial to a serial-less twin. iOS 801 XCTests. **Parity follow-up (agent-doable): check Android for the same three behaviors** (instant surface at delivery; serial-less pending detail riding `pending[].phase`); webapp is unaffected (home renders pending straight from `/pods` and shows phase on the card). **Owner: rebuild the iOS app in Xcode to pick this up.**

**#27 LIVE FAILURE (2026-06-09):** an encrypted Wi-Fi-only box installed/sealed/registered fine but **failed to auto-unlock** — stuck at `Please unlock disk`, `curl (6) could not resolve host boot.flagshipserver.com` (NO network in the initramfs), Wi-Fi beacon empty (DHCP never succeeded). After a hand-unlock with the burn-time recovery passphrase the **full-OS daemon also didn't check in** (daemons=0) — so Wi-Fi isn't engaging on this box in EITHER context, despite #45. Everything downstream of unlock is PROVEN — the no-LUKS box reached a real Let's Encrypt green padlock (`*.harry.flagship.services`) on hardware.
**→ HARDENED (`7db385a`, agent audit, awaits a real reburn):** the build-time hook was confirmed able to silently no-op exactly as suspected — driver detection unvalidated (empty `wl*` lookup fed `manual_add_modules ""` behind `|| true`), Debian-13 `.xz`/`.zst` firmware variants never matched, and `wpa_cli` + `ip` (both used by the premount) never staged. Hook now validates every step + logs to `/boot/flagship-wifi-build.log`, stages firmware variants + dependency-module firmware + `cfg80211`/`mac80211`, copies `wpa_cli`/`ip`, falls back to `copy_modules_dir kernel/drivers/net/wireless`; premount logs before mounting, waits (bounded) for FLAGSHIP_BOOT, records the mount result; iface wait 15s→30s; the full-OS Wi-Fi safety-net unit dropped its `After=network.target` chicken-and-egg. TS↔Swift byte-identical, sha pins updated. The static tests prove the script text — the kernel/net path needs the live reburn (FIRST MOVES above).

**DEPLOY GOTCHA (cost real time this session):** `wrangler deploy` bundles apps/com's import of the BUILT `@flagship/control-plane` `dist/` — a control-plane change that isn't compiled silently ships stale. ALWAYS `npx tsc -b && cd apps/com && npx wrangler deploy`. (This is why the outstanding-orders endpoint "deployed" yet never worked.)

**App server-list — CONSOLIDATED (#56, LIVE):** one unauthenticated `GET /api/users/:u/pods` now returns registered `pods` (`state:"online"`) + active `pending` orders (`state:"pending"`, with `serial`/fqdn/phase) — **no more biometric Face ID on a list refresh**, and a just-created server appears instantly. Server `bae3537` (deployed via tsc -b + wrangler, verified `pending` key live), webapp `792a620`. Replaces the split-brain (registered `/pods` + biometric-signed `outstanding-orders` whose silent per-order `provision_status` failure swallowed the whole list) that caused the entire "server doesn't appear / Face ID on refresh" saga. iOS done; webapp done; Android done (`f0acd5d`). Wire note: `pending[].serial` was replaced by `orderRef` in `aa78e2b` (see SECURITY below) — deploy before judging client pending behavior against prod.

**SECURITY — pre-production cleanup (track to GA):**
- **Remove the `debug` user.** The burner now installs a sudo `debug` / `flagship` console user (a deliberate backdoor for bring-up — `flagship` is SSH-key-only, so on-box log reading was impossible; `/etc/issue` warns loudly). REMOVE before production.
- **#52 — DONE (`8f9c9c0`).** Tier-2 sign-out is blocked on all three surfaces when `hasCloudRecovery` is false (action-layer `SignOutPolicy` gate; blocked dialog routes to recovery enrollment; demo exempt). Audit verdict: the rotation rode the DESIGNED single-device re-pair-by-grace path (no credential to initiate, no old-key veto) — see the evening-sweep note above. Possible follow-up: require a credential on the single-device re-pair initiate, and check why the live rotation beat the 3d grace.
- **/pods serial exposure — HARDENED (`aa78e2b`, not yet deployed).** The unauthenticated `/pods` `pending[]` no longer carries the auth-code `serial` (a provision-status write capability); it ships an opaque `orderRef = hex(sha256("flagship/order-ref/v1|" + serial))` (`orderRefForSerial`, control-plane `podInventory.ts`; byte-identical mirrors in iOS `FlagshipCore.OrderRef` + Android `core.OrderRef`, pinned cross-platform vector). The creating device reconciles by hashing its locally-stored serial; a non-creating device reconciles by fqdn and shows list-level phase only (it never learns the serial, so no deep-progress poll / cancel-revoke there). All surfaces + tests updated in lockstep. Deploy needs the usual `npx tsc -b && cd apps/com && npx wrangler deploy`.
- Remove the **burn-time LUKS recovery passphrase** (`flagship-burn-time-luks-rekey-me-immediately`, a kept known constant) + disarm the mass-wipe (#35) — before GA.
- **/pods unauthenticated server-list enumeration (track to GA).** `GET /api/users/:u/pods` is unauthenticated (a deliberate #56 tradeoff to avoid a biometric Face ID on every list refresh, and because the boot worker's directory client reads it). It leaks METADATA to any knower-of-a-username: the user's server domains, identity pubkeys, registered timestamps, apps-served (NO secrets/keys/content; the serial is already opaque-`orderRef`'d). Pre-GA decision needed: require auth (re-introduces the refresh-biometric problem #56 solved), OR rate-limit + make usernames non-guessable, OR accept-with-rationale. Currently UNTRACKED-until-now.
- **CAA pinning + CT monitoring — SPEC'd, NOT deployed (track to GA).** Because `.com` controls the `flagship.services` DNS zone, it could in principle satisfy a DNS-01 challenge and mint a ROGUE per-user cert (it never sees the box's cert private key — that's generated + held box-local and never transmitted — but it controls the name). Defenses are designed in `docs/per-user-cert-and-addressing.md` (CAA pinned to the user's ACME account so LE refuses out-of-account issuance; CT monitoring on the phone to alert on any cert the owner didn't mint) but NOT implemented. Mitigating factor today: a cert is NOT the access-control primitive — routing authority (RCK/STK, phone-held) is, so a rogue cert can't redirect traffic. Deploy CAA+CT before GA.
- **Daemon liveness/cert reporting — DONE (2026-06-10 late).** The daemon sends the 5-minutely STK-signed daemon-status heartbeat (wired in server-daemon index); `/pods` now relays the VERBATIM signed report (`signedStatus`, migration 0048) so phones verify the cert fingerprint against the locally-derived STK and hard-fail-pin on it. The provision-status liveness bridge remains as the fallback for boxes that haven't reported yet.

Gates (2026-06-09 evening): `npx vitest run` 4465 (348 files) · iOS 793 XCTests · Android 611 · burner 175 (TS) + 105 (swift) · webapp 1012 · `npx tsc -b` clean.

### Live in production
- **Per-user TLS** — one Let's Encrypt cert per user, SANs `[<user>, *.<user>]`, real green padlock (per-box → per-user cutover verified live 2026-06-02). ACME runs on the user's daemon over SNI passthrough; `.services` stays content-blind. Wildcard SANs via DNS-01.
- Auto-unlock-lease (one-shot + long-lived) with silent renewer; WebAuthn-PRF cloud recovery; Web Push (RFC 8291 encrypted payloads); `/consume` → push.
- **Cert model** (iOS + web + Android): creation is a binary — *managed* (your devices renew it, default) vs *autonomous* (the box self-renews); renewal window is an account-wide "Certificate validity" setting (presets 7/30/90, default 30).
- **Recovery Phase B backend** deployed — single-device re-pair grace 7d→3d; the wrapped-UMK fetch returns `registeredIrkPubHex` for rotation detection.
- Brand/teal migration complete (rounded-square-containing-a-circle mark; the flag-on-mast pennant is **retired — do not reintroduce**). `/og` social card, `/ready` page, webapp no-server empty states, iOS Apps→Services rename + persistent pending servers.
- **All prod users wiped 2026-06-02** for a clean pre-release slate (`marketplace_listings` preserved).

Gates (2026-06-03): web 978 · com+control-plane 1108 · iOS 755 XCTests · `npx tsc -b` clean. `npx vitest run` ~30s. Workspace deps: `npm install` + `npx tsc -b`.

### Open work

**Hardware / boot — Debian-only now; getting a box to boot is the gate:**
> **Decision (2026-06-08): Debian is the sole shipping path; Alpine is parked on the `alpine` branch.** Alpine's initramfs wouldn't enumerate USB on real metal ("mounting boot media failed"), and the fix was hardware-iteration-gated + speculative; Debian-installer already solves the hard UEFI-NVRAM-rejection problem and its whole downstream (bootstrap, boot-stage, LUKS, systemd, register) is shared + Debian-ready. `main` is Alpine-free + green.
>
> **DONE (agent, 2026-06-08) — the Debian-quick + manifest + phone-home plan all landed on `main`:**
> - ✅ **`POST /api/iso-manifest`** — server-driven base-ISO manifest (dumb-executor burner; `{download:{url,sha256,version,sizeBytes,attestation}}` or `{download:null}`; blessed manifest in Worker env `FLAGSHIP_ISO_MANIFEST` = the hold/fast-track lever). Spec: `docs/iso-manifest.md`.
> - ✅ **Burner Simple mode** (mac/linux/windows) — manifest-driven Debian base cache: downloads + sha-verifies when ordered, shows the URL under the progress bar, logs path+sha on every launch + after each download; remasters via the shared preseed path. Advanced (user ISO) stays. (mac swift 90 · linux pytest 88 · windows via its own CI.)
> - ✅ **Website simplified** — one story: mint recipe → copy/download on `/ready` → get the burner → it fetches the OS itself. All user-facing Alpine/ISO-pick/Advanced-mode framing gone.
> - ✅ **Earliest phone-home** — best-effort beacons in the burner preseed (TS + Swift, byte-identical, injection-sanitized): Beacon A in `preseed/early_command` (`d-i-started`, busybox-wget, pre-network `|| true`) + Beacon B at top of `late_command` (`installer-running`) → existing `POST /api/install-events/<serial>` (the channel the phone watches).
> - ✅ **Wipe script re-audited** through migration 0046 (`scripts/wipe-all-users-prerelease-2026-06-02.sql`): dropped stale `build_tickets`, added `acme_account_key_delivery` + `nfc_rendezvous`.
>
> Gates on `main`: `tsc -b` clean · vitest **4379** · iOS **728** + App build · Android · burner-mac swift **90** · burner-linux pytest **88**.

**Wi-Fi unlock + no-LUKS escape hatch — DONE (agent, 2026-06-08):**
> A Wi-Fi-only box installed + sealed fine but **hung at the early-boot LUKS
> unlock on every reboot**: the initramfs unlock premount curls the boot relay
> assuming the network is up (true on Ethernet's auto-DHCP, false on Wi-Fi where
> the early-boot env brings up no radio). Two landed fixes, both with byte-identical
> TS↔Swift generators (sha-pinned) + green gates (vitest 4406 · iOS 728→738 ·
> Android 583 · burner swift 104 · tsc clean):
> - ✅ **Wi-Fi in the initramfs** (`b1dd738`): a build-time hook stages the box's
>   actual `wl*` driver + firmware + `wpa_supplicant`; a boot-time `init-premount`
>   (runs strictly before `local-top/flagship-unlock`) associates + DHCPs, fully
>   best-effort + wall-clock bounded so it can never hang boot. Only on the
>   encrypted Wi-Fi path; wired burns byte-identical. **Also keeps the burn-time
>   LUKS passphrase as a bring-up recovery slot** (`luksRemoveKey` guarded off, not
>   deleted) — a KNOWN CONSTANT; flip the guard back on before GA.
> - ✅ **No-LUKS server option** (`dad6bf0`+`f4231a2`): phone-signed
>   `InstallBlob.diskEncryption` ("luks"|"none"), appended last in canonical bytes
>   as `de=<mode>` (absent ⇒ encrypted; a relay can't downgrade luks→none without
>   breaking the sig). Toggle in every create-server flow (iOS/Android/webapp +
>   demo/dev mint), default ON; OFF provisions an unencrypted box that boots
>   without needing network at unlock. Help entry added for "stuck at installed".
> - ✅ **Install checklist** (`d92e1ea`): dropped the redundant `installed` rung
>   (it spun while the box was powered off); Installing now goes green + carries
>   "unplug the USB" detail. `installed` stays a wire phase + push milestone.
>
> Owner-side next: rebuild+re-sign the Mac burner (below), then a live Wi-Fi
> reburn to confirm the initramfs radio actually associates + DHCPs before the
> unlock relay (the static tests prove the script text, not the kernel/net path).

**Remaining to a live box (owner + hardware):**
1. **Deploy to activate the manifest.** `FLAGSHIP_ISO_MANIFEST` is already seeded in `apps/com/wrangler.toml` [vars] (Debian 13.5.0 netinst, version-pinned cdimage url, official signed sha, size 791 674 880; verified live 2026-06-08) — so just `cd apps/com && npx wrangler deploy` turns Simple-mode downloads on. (To serve from our own R2 instead of Debian's CDN, upload the same bytes and change only the `url` field — sha is unchanged. Re-pin all three on a new Debian point release.)
2. **Rebuild + re-sign the Mac burner** (it now ships Simple-as-default + the manifest client).
3. **Run the wipe** — `bash scripts/wipe-all-users.sh` (NOT the raw `--file` .sql: prod D1 drifts from the repo's migrations, and a one-transaction `--file` run aborts on the first table prod lacks; the runner deletes each table independently and skips absent ones).
4. **Verify Debian-preseed reliability + live e2e** — cmdline injection (`Remaster.swift`/`remasterIso.ts` grub+isolinux patch) was per-ISO flaky earlier; add real-Debian-ISO tests, then create-account → recipe → burn → boot → watch the phone-home timeline → registers → green padlock.

**Install / provisioning polish:**
- ✅ **Beacon the partitioning→installing transition — DONE (`7db385a`).**
  `partman/early_command` now drops a backgrounded best-effort
  `/usr/lib/base-installer.d/05flagship-beacon` that POSTs `phase:"installing"`
  via the shared `debianBeaconCommand` idiom; byte-identical in both generators,
  pinned by tests. NOT locally testable (no d-i dry-run) → observe on the next
  real burn's checklist (cosmetic if it doesn't fire: lag, not hang).

**App / recovery:**
5. **Recovery Phase B re-pair branch — CODE DONE, on-device validation only.** The full Phase A/B branch is already wired + tested (see the 2026-06-09 evening-sweep note): validate on a real device that a rotated-key recovery lands in re-pair-with-grace and an unrotated one pairs instantly. Backend already deployed.
6. **iOS owner-device confirmations** (from 2026-06-02, never confirmed on device): cross-device-QR recovery fix (`f4593a3`); Passwords-app icon flips to the teal ring; a real burn → box registers → green padlock.
7. **iOS diagnostics:** jetsam memory crash after ~14 min (use the Memory Graph Debugger; note which screen grows); input-field delay on "I already have an account" (confirm with a Release/Profile build).

**Ship / launch (owner-side, mostly):**
8. **Stores.** iOS TestFlight (Associated Domains capability, Xcode Archive + ASC upload, metadata, 5 external testers); Android Play (signed AAB via `./gradlew :app:bundleRelease`, internal track, 5 testers). Neither app is on a store yet, so push / Live-Activity timelines can't be received on a real device.
9. **Marketplace security scanner** — `marketplace_listings.scan_grade` ships NULL; needs the Trivy + custom-checks service that posts grade + R2 report. MVP gate before public marketplace.
10. **v1-alpha live exercises** (multi-day, observational): recovery / rotation / update-pack over 7 days × 2 pods; peer-backup at scale; marketplace MVP; public disclosure + bounty path.
11. **Disarm the mass-wipe before real users.** `scripts/wipe-all-users-prerelease-2026-06-02.sql` is a single idempotent file that deletes every user + server. Fine for the pre-release slate, a footgun once we serve real accounts. Before GA: gate it (per-env confirmation token, prod row-count safety/dry-run, audit-logged admin-only path) or remove the blanket script from the deployable surface so no one can nuke prod in one command. Keep the wipe script's table list in sync with new migrations until then.
12. **In-house AI inference server (build-modes follow-on).** Today the AI-authoring paths (scratch chat, git-adapt) run on **BYOK** — the box calls the user's chosen provider directly; no inference infra needed. When we stand up our own model server, wire it as a third posture (in addition to BYOK + a possible Flagship-promo tier): run an OpenAI-compatible endpoint (Ollama / vLLM / TGI) on the box or a LAN/datacenter host, point a provider at its `baseUrl`, and flip the `LlmHarness` `baseUrlGuard` (`allowPrivate`/`allowHttp` or `hostAllowlist`) — the guard is built for exactly this (see `llmHarness.ts` + `docs/build-modes.md` "in-house inference server"). No bespoke inference code; the adapter (`ollama`/`openai`) already exists. Also decide the default-provider UX once it's hosted (auto-select the in-house server vs. keep BYOK primary).

**NFC retail tier (post-v1; design in `docs/v1-operational-tasks.md § N`):** protocol + daemon state machine + cloud activation API are built & partly live; **C3 — iOS + Android NFC read flow** is the remaining agent-doable chunk. Hardware bring-up waits on the hardware-shipping business decision.

### When in doubt
This file is the in-repo source of truth. For deeper detail, read the relevant living spec in `docs/` (index below), the operational runbooks in `docs/runbooks/`, or — for architecture — `project_overview.md` in agent memory. `docs/archive/` is frozen history.

### Living design specs (index)
- **Cert & addressing** — `per-user-cert-and-addressing.md`, `per-user-cert-worklist.md`, `multiplexing.md`
- **Recovery / multi-device / security** — `multi-device.md`, `lifecycle-spec.md`, `security-phone-as-unlock-endpoint.md`, `v1.2-security-cascade.md`, `revocation-ui.md`, `wipe-restart.md`, `watch-delegate-key-design.md`, `v2-device-addressing-and-real-ticket.md`
- **Login / accounts / demo** — `login-and-account-redesign.md`, `sample-users.md`
- **Install / ISO / burner** — `recipe-schema-v2.md`, `installer-tiny.md`, `installer-netboot.md`, `cloud-init-direct-provisioning.md`, `installation-real-usb.md`, `reproducible-iso-build.md`
- **NFC retail box** — `nfc-box-pairing.md`, `v1-operational-tasks.md § N`, `n-cloud-2-design-discussion.md`
- **CA / maintainers** — `ca-operations.md`, `maintainer-ca-endorsement.md`, `maintainers-checkpoints-spec-v0.1.md`, `maintainers-deployment.md`
- **Marketplace / apps / monetization** — `app-developer-guide.md`, `manifest.md`, `monetization-free-tier-first.md`, `multi-device-monetization.md`, `vibe-code-experience.md`
- **Testing** — `e2e-test-plan.md`
- **Design / ops** — `design-system.md`, `psl-submission-flagship-services.md`, `runbooks/`, `policy/`
