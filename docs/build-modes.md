# Build-a-service modes

> **Branch discipline.** Workspace artifact (design doc) → lives on `main`.
> The feature code lives on **`feat/build-modes`** until launch. The
> marketplace *tile* in the chooser degrades to "coming soon" until
> `feat/marketplace` merges (it's the only mode whose code isn't on
> `feat/build-modes`).

Status: **feature-complete on `feat/build-modes` (pending launch).** Daemon
backbone + git/mcp/scratch modes + the shared journal + the AI-adapt endpoint
+ value-free env-requests + the scratch multimodal-chat seam, all tested, on
all three clients (webapp + iOS + Android).

**BYOK AI is now wired LIVE into the daemon boot path** (`index.ts`): the
`LlmHarness` streams (`chatStream`) + the non-streaming git-`adaptRunner`
both run for real. The credential flows phone/webapp → box over the
paired-session-gated **pinned pipe** (the box terminates TLS; flagshipserver
.com is NEVER in the credential path — the box calls the provider directly)
and is held in a **transient, sealed-at-rest credential store** keyed by
session/build (the "key on the box so a build continues while the phone is
locked" posture). When no credential is available the paths degrade cleanly
(scratch start → `needsCredential`; adapt → 503 "AI adapt not configured").

The remaining future item is the **in-house / self-hosted inference server**
(a LAN `baseUrl` + a `baseUrlGuard` override for private hosts); today the
strict public-https guard applies, with an explicit `baseUrl` allowed for
OpenAI-compatible / proxy *public* endpoints. The mobile scratch *attachment
picker* is the one nice-to-have not yet ported (mobile scratch uses the
existing vibe screen).

### BYOK credential delivery — the contract

The credential rides three optional request fields (one shape everywhere):

```jsonc
"credential": { "provider": "anthropic", "apiKey": "<owner key>", "baseUrl": "https://..." }
```

- **scratch:** `POST /api/screens/vibe-code/start` (and `…/reply` to seed a
  session that started without one). On receipt the daemon seals it for the
  session and **reuses it on every later turn** — no re-send needed. The
  start response carries `needsCredential: true` (200, session still exists)
  when no model can drive the session yet.
- **git adapt:** `POST /api/build/git` (and `…/adapt`). Stored keyed by
  `buildId`; the `adaptRunner` opens it just-in-time.

The value is **never echoed, never logged, never journalled** — at most the
provider NAME. Sealed at rest under the same SWK-derived AEAD the
`serviceEnvStore` uses; the store reloads on boot so an in-flight build
survives a daemon restart.

## The idea

"Build a service" used to mean one thing: pick a model-inference source and
vibe-code from zero. It now asks **"how do you want to build it?"** and fans
into four sources that all converge on the *same* deploy primitive
(`deployArtifact` → harness-only Forgejo push → docker build → signed
`servicePlatform.install`) and the *same* observability surface (one
append-only **build journal** per build):

| Mode | Who authors | Model key on the box? | Where the key lives |
|---|---|---|---|
| **scratch** | the box's daemon | yes (transient, sealed for the session) | phone BYOK / Flagship promo |
| **git** (fit) | nobody (deterministic) | **no** | — |
| **git** (adapt) | the box's daemon | yes (transient) | phone BYOK / promo |
| **mcp** (connect IDE) | the user's IDE (Cursor/Cline) | **no** | the user's own IDE subscription |
| **marketplace** | already authored | **no** | — |

**The box never *needs* an AID key as a matter of architecture.** It is "a
secured system that exposes limited functions" — signed identity headers +
the browser/sibling/URL APIs + scoped data env + a hardened container. The
model is only needed by whoever *authors*; three of five paths need no
box-side model at all. Transient keys for scratch/adapt are a deliberate,
good choice: they let a build continue while the phone is locked.

Containment is **structural, not prompt-based** — cap-drop, read-only FS,
single port, domain-gated browser API (`serviceRunner`/`serviceProxy`). So an
artifact from *any* author (internal AI, external IDE, a git repo, a human)
is contained by the same walls; the contract/prompt is a courtesy that lets a
well-behaved author avoid building something the harness would reject.

## The journal (`buildmodes/buildJournal.ts`)

One append-only JSONL file per build on the box (mode-0600, seq survives
restart). Written by every mode. Entry: `{seq, ts, buildId, mode, kind,
actor, summary, detail?, serviceId?}`. **Value-free by contract** —
secret-shaped tokens are redacted on append (mirrors `serviceEnvStore`'s
names-not-values rule). Read via `GET /api/build/sessions/:id/journal`; the
build list via `GET /api/build/sessions`. Bound to a `serviceId` on deploy so
the owner can later open "how was this built?" from service detail.

## Git mode (`buildmodes/gitImport.ts`)

One user option. Shallow-clone → read the text tree (skip
.git/node_modules/binaries/oversize) → **fitness check**: is there a
top-level `flagship.app.json` that parses against the manifest schema?

- **Fit** → deterministic install as-is. No model.
- **Not fit** → `buildAdaptPrompt` renders the repo for the AI adapt path.
  `POST /api/build/sessions/:id/adapt` runs it: the rendered tree (+ any
  owner instructions) goes through an injected `adaptRunner` model call,
  the output is parsed by the SAME `VibeCodeStreamParser` as scratch, and
  the produced files are merged into the workspace (path-guarded by
  `workspace.write`, requires a `flagship.app.json`). The owner then
  deploys via `.../deploy`. **The live model IS wired now**: `index.ts`
  builds `adaptRunner` from `LlmHarness.chatWithCredential` + the build's
  transient sealed credential (keyed by `buildId`). The endpoint returns the
  clean **503 "AI adapt not configured"** ONLY when no credential is stored
  for the build (`adaptCredentialAvailable(buildId) === false`) — the genuine
  no-key case, identical to the provider-not-wired degradation; the webapp
  falls back to from-scratch on a 503.

URL/ref validated: https or `git@` only (no `file://`), no shell
metacharacters, no `..` traversal.

## MCP mode (`buildmodes/mcpServer.ts`, `mcpKeyStore.ts`, `contract.ts`)

The box runs an **MCP server scoped to one build session** so an external
IDE agent builds against the box using the IDE's own model. The user pastes
a **per-build bearer key** into Cursor/Cline; the key binds the connection to
exactly that build (sealed at rest, sha256-indexed for auth, re-displayable,
rotatable, survives restart).

Transport: MCP Streamable-HTTP (JSON-RPC 2.0 over `POST /mcp/build/:id`,
bearer-gated — **not** paired-session gated; that's the whole point). Tools
express the entire limited surface and the rules: `get_contract`,
`list_files`, `read_file`, `write_file`, `delete_file`, `validate`,
`request_env_var` (**value-free**), `get_journal`, `deploy`, `get_logs`.
Resources: `flagship://contract`, `flagship://journal`. Every call is
journalled (actor `ide`).

## Forgejo (harness-only)

External actors never `git push` to the box. They go through chat / git
import / mcp; the harness materializes the result and commits it to the
per-app Forgejo repo on deploy (`deployArtifact` step 2), giving one internal
version history the owner can browse/revert via the existing
`/apps/:serviceId/git/*` surface.

## HTTP wire contract (`buildmodes/buildModesHttp.ts`)

Paired-session gated (`x-flagship-session`):
- `POST /api/build/git {gitUrl, ref?}` → `{buildId, fit, reason, manifestName?, fileCount}`
- `POST /api/build/mcp {label?}` → `{buildId, connection:{url, key, ideConfig}}`
- `GET  /api/build/sessions` → `{builds:[BuildJournalSummary]}`
- `GET  /api/build/sessions/:id` → `{state, files:[path]}`
- `GET  /api/build/sessions/:id/journal` → `{entries:[BuildJournalEntry]}`
- `GET  /api/build/sessions/:id/env-requests` → `{requests:[{name, why?, secret?, requestedAt, requestedBy, currentlySet}]}` (value-free)
- `POST /api/build/sessions/:id/deploy` → `{ok, serviceId, url}`
- `GET  /api/build/sessions/:id/mcp` → connection info (re-display)
- `POST /api/build/sessions/:id/mcp/rotate {label?}` → new connection info

Bearer gated (per-build mcp key):
- `POST /mcp/build/:id` → JSON-RPC (single + batch; notifications → 202)

## Client UX (the chooser → modes)

The create-a-service entry opens **"Build a service — how do you want to
build it?"** with four tiles → scratch / git / mcp / marketplace, plus a
"past builds" link to the journal viewer. Webapp is the reference
implementation (`views/build-*.js`). iOS + Android mirror it:
- **scratch** → existing vibe flow (to gain: a real multi-turn chat with
  attachments).
- **git** → URL+ref field → fitness verdict card → Install (fit) or Build-
  with-AI (not fit).
- **mcp** → "Create connection" → show URL + key + copyable IDE config +
  rotate + deploy.
- **journal** → per-build timeline; also reachable from service detail.

## Remaining work

- **Live BYOK wiring** — DONE. `LlmHarness.chatStream` (streaming) +
  `chatWithCredential` (non-streaming, for adapt) land in the daemon boot
  path: `index.ts` builds the harness, a `FileBuildCredentialStore`
  (transient, SWK-sealed, reload-on-boot), the live `startStreaming` thunk
  (`buildVibeCodeStartStreaming` resolves the session's credential + streams
  through the harness), and the live `adaptRunner` (+ `adaptCredentialAvailable`
  for the clean 503). Credential delivery contract: the optional
  `credential` field on vibe-code start/reply + build git/adapt (sealed for
  the session/build, reused on later turns, never echoed/logged/journalled).
  flagshipserver.com is NEVER in the credential path. REMAINING: the
  in-house / self-hosted inference server (LAN `baseUrl` + `baseUrlGuard`
  override for private hosts) — the strict public-https guard applies today.
- **Multimodal chat for scratch** — DONE except the mobile attachment picker.
  Provider foundation (additive `Attachment` + `ChatMessage.attachments`
  in `@flagship/llm-providers`, Anthropic adapter → base64 image / text blocks)
  was already landed. NOW landed:
  - The vibe **session carries attachments** (`pushUserMessage(text,
    attachments)` / `pushUserReply({…, attachments})`); they ride on the next
    `ChatRequest`'s user message (`vibeCodeStartStreaming`) so the multimodal
    adapter translates them. `messages()`/`conversation()` surface them for a
    reload. The live provider is now constructed in `index.ts` (see "Live
    BYOK wiring" above), so this streams for real.
  - **HTTP** accepts inlined base64 attachments on `POST
    /api/screens/vibe-code/start`, the screens `talkToUser` `/reply` path, and
    the `/api/llm/sessions` start + `user-reply` paths. One shared validator
    (`llm/vibeCodeAttachments.ts`): **≤6/turn, image ≤4 MB decoded, text
    ≤256 KB, common image/* + text only**; unknown kinds/types rejected. No
    separate upload endpoint for v1.
  - **Journal (value-free):** scratch turns append `user-message` (a short
    truncated text preview) + `attachment-added` (summary = NAME + kind + size
    ONLY, never the content/base64) to the shared build journal (buildId = the
    vibe sessionId). The journal is hoisted above the vibe wiring in `index.ts`
    so scratch shares it with git/mcp.
  - **Webapp chat UI** (`views/vibe-code.js`): a scrollable message list
    (user-right / AI-left), a composer with a textarea + an `accept="image/*,
    .txt,.md,.sql,.json,.csv"` attach input, removable chips with image
    thumbnails, FileReader→base64 with the same caps enforced client-side
    (friendly toast on violation), follow-up turns over `/reply`, and the
    Deploy affordance.
  REMAINING: the mobile scratch attachment picker (iOS/Android scratch routes
  to the existing vibe screen for now); openai/google adapters mirror the
  Anthropic translation when needed.
- **AI-adapt endpoint** — DONE (server + webapp). `POST
  /api/build/sessions/:id/adapt` runs `buildAdaptPrompt(files)` through an
  injected `adaptRunner`, parses the emit-format output with
  `VibeCodeStreamParser`, and merges the path-guarded files into the
  workspace (manifest required). The live `adaptRunner` is wired (see "Live
  BYOK wiring"); the 503 now means the genuine no-credential case for the
  build; webapp + iOS + Android all fall back to from-scratch on a 503.
- **iOS + Android** — DONE. The chooser + git/mcp/journal screens are native
  on both (SwiftUI + Compose), built to this spec, with a build-modes API
  client whose Mock matches the live wire format (pinned by tests). iOS 945
  XCTests (+31), Android 761 unit tests (+16); both build. Scratch tile routes
  to the existing vibe screen; marketplace tile degrades to "coming soon".
- **request_env_var → phone** — DONE (server + webapp). The orchestrator
  keeps a value-free per-build pending list, fires a value-free
  `notifyOwner({buildId, name})` hook (log-only by default, swap in the push
  relay in production — mirrors the vibe-code W10 hook) and journals an
  `env-requested` entry; `GET /api/build/sessions/:id/env-requests` returns
  `{requests:[{name, why?, secret?, requestedAt, requestedBy, currentlySet}]}`
  (deduped by name, never a value); the webapp mcp view surfaces it with a
  "the IDE never sees the value — set it in Configure environment" note.
  REMAINING: the real push fan-out + the iOS/Android surfaces.
