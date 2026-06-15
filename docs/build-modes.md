# Build-a-service modes

> **Branch discipline.** Workspace artifact (design doc) → lives on `main`.
> The feature code lives on **`feat/build-modes`** until launch. The
> marketplace *tile* in the chooser degrades to "coming soon" until
> `feat/marketplace` merges (it's the only mode whose code isn't on
> `feat/build-modes`).

Status: **in progress on `feat/build-modes`.** Daemon backbone + git & mcp
modes + webapp client landed & tested; the scratch multimodal chat (chat +
attachments) seam + webapp UI landed & tested. Remaining: iOS + Android
clients, AI-adapt endpoint for non-fit git repos, and live-provider wiring
into the daemon boot path (the model isn't constructed in `index.ts` yet —
a separate pre-existing task).

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
  deploys via `.../deploy`. **The live model isn't wired into the daemon
  yet** (the pre-existing gap — `buildVibeCodeStartStreaming` is never
  constructed in `index.ts`), so `adaptRunner` is left undefined and the
  endpoint returns a clean **503 "AI adapt not configured"**; the webapp
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

- **Multimodal chat for scratch** — DONE except mobile + live-provider
  wiring. Provider foundation (additive `Attachment` + `ChatMessage.attachments`
  in `@flagship/llm-providers`, Anthropic adapter → base64 image / text blocks)
  was already landed. NOW landed:
  - The vibe **session carries attachments** (`pushUserMessage(text,
    attachments)` / `pushUserReply({…, attachments})`); they ride on the next
    `ChatRequest`'s user message (`vibeCodeStartStreaming`) so the multimodal
    adapter translates them. `messages()`/`conversation()` surface them for a
    reload. (The live provider is still NOT constructed in `index.ts`, so this
    is the *seam* — it lights up when that separate wiring lands.)
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
  REMAINING: iOS + Android attachment pickers; openai/google adapters mirror
  the Anthropic translation when needed; live-provider wiring (separate task).
- **AI-adapt endpoint** — DONE (server + webapp). `POST
  /api/build/sessions/:id/adapt` runs `buildAdaptPrompt(files)` through an
  injected `adaptRunner`, parses the emit-format output with
  `VibeCodeStreamParser`, and merges the path-guarded files into the
  workspace (manifest required). Returns 503 until the daemon's live LLM
  provider is wired (the separate pre-existing gap); the webapp falls back
  to from-scratch on a 503. REMAINING: that live-provider wiring, and the
  iOS/Android affordance.
- **iOS + Android** — the chooser + git/mcp/journal screens to this spec.
- **request_env_var → phone** — DONE (server + webapp). The orchestrator
  keeps a value-free per-build pending list, fires a value-free
  `notifyOwner({buildId, name})` hook (log-only by default, swap in the push
  relay in production — mirrors the vibe-code W10 hook) and journals an
  `env-requested` entry; `GET /api/build/sessions/:id/env-requests` returns
  `{requests:[{name, why?, secret?, requestedAt, requestedBy, currentlySet}]}`
  (deduped by name, never a value); the webapp mcp view surfaces it with a
  "the IDE never sees the value — set it in Configure environment" note.
  REMAINING: the real push fan-out + the iOS/Android surfaces.
