# Build-a-service modes

> **Branch discipline.** Workspace artifact (design doc) → lives on `main`.
> The feature code lives on **`feat/build-modes`** until launch. The
> marketplace *tile* in the chooser degrades to "coming soon" until
> `feat/marketplace` merges (it's the only mode whose code isn't on
> `feat/build-modes`).

Status: **in progress on `feat/build-modes`.** Daemon backbone + git & mcp
modes + webapp client landed & tested. Remaining: multimodal chat for
scratch, iOS + Android clients, AI-adapt endpoint for non-fit git repos.

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
- **Not fit** → `buildAdaptPrompt` renders the repo for the AI adapt path
  (vibe loop with an adapt system prompt). Needs a model. *(adapt endpoint
  is the one remaining server piece — the renderer + UI affordance exist.)*

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

- **Multimodal chat for scratch** — provider foundation LANDED: additive
  `Attachment` + `ChatMessage.attachments` in `@flagship/llm-providers`, the
  Anthropic adapter translates to base64 image / text blocks (tested,
  backward-compatible). REMAINING: thread attachments through the vibe
  session + an upload endpoint, journal the turns, and add the chat UI with an
  attachment picker on each client (openai/google adapters can mirror the
  Anthropic translation when needed).
- **AI-adapt endpoint** — feed `buildAdaptPrompt(files)` into the vibe loop
  for non-fit git repos and deploy the result.
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
