# Build-a-service modes

> **Status: LAUNCHED — merged into `main`.** This was developed on
> `feat/build-modes` and folded into `main` once BYOK went live (core
> feature). The marketplace *tile* in the chooser still degrades to
> "coming soon" until `feat/marketplace` merges (it's the only mode whose
> code isn't here). `feat/marketplace` + `feat/retail` will need to
> integrate `main` to pick this up.

Status: **shipped on `main`.** Daemon backbone + git/mcp/scratch modes + the
shared journal + the AI-adapt endpoint + value-free env-requests + the scratch
multimodal chat, all tested, on all three clients (webapp + iOS + Android),
with **BYOK wired live** end-to-end and an **AI-key step** (provide/confirm/
recall a device-saved key) on every surface.

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
| **scratch** | the box's daemon | yes (transient, sealed for the session) | phone BYOK / Flagship Inference |
| **git** (fit) | nobody (deterministic) | **no** | — |
| **git** (adapt) | the box's daemon | yes (transient) | phone BYOK / Flagship Inference |
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

## Flagship Inference

"For a limited time, building your apps is free on Flagship." Flagship
Inference is free as a launch promotion, not forever. An owner can build with
AI before bringing a key of their own. The apps list it as a built-in
provider, **Flagship Inference** ("We use third-party providers and anonymize
your requests."), and never say "free AI credits": the word "free" appears
only in the balance line, so it can go when the promotion ends. It runs on a
third-party hosted model provider chosen by us, which may change (e.g.
Qwen3.6-35B-A3B on a hosted open-model provider; the privacy policy §2.8
describes it generically, not by name), always behind the shim below. The
provider receives the prompt text and returns the reply; it never receives
the owner's account, server or IP address.

**Credits.** The apps show the allowance in credits: **1 credit = 1,000
weighted tokens** (`TOKENS_PER_CREDIT`). `.com` adds `remainingCredits` (week
+ starter, rounded down), `weeklyCredits` and `tokensPerCredit` to every
`credits` object and keeps the token fields for older apps; apps facing an
older `.com` divide the token fields by 1,000 themselves.

What it costs per customer and per token, on a hosted API or our own GPU,
and the price for later token sales: `docs/ai-inference-costs.md`.

**The allowance** (all `.com` vars, each optional; numbers are *weighted*
tokens, input × `AI_PROMO_INPUT_WEIGHT` + output × `AI_PROMO_OUTPUT_WEIGHT`,
default 1 and 4, since output costs more to serve):

| var | default | meaning |
|---|---|---|
| `AI_PROMO_WEEKLY_TOKENS` | 500,000 | top-up each ISO week (Monday 00:00 UTC); the rest doesn't carry over; spent first |
| `AI_PROMO_STARTER_TOKENS` | 2,000,000 | one-time reserve per account, spent after the week's |
| `AI_PROMO_DAILY_CAP_TOKENS` | 50,000,000 | every account together per UTC day; past it nobody gets new passes or calls until tomorrow ("Flagship Inference is busy today…") |
| `AI_PROMO_INPUT_WEIGHT` / `AI_PROMO_OUTPUT_WEIGHT` | 1 / 4 | the weights |
| `AI_PROMO_ENDS_AT` | none | ISO 8601 or epoch ms; after it nothing is issued ("The free building period has ended — use your own AI key") and the apps show Flagship Inference disabled with that message |

Only an account with a registered, unrevoked server that reported to `.com`
in the last 24 hours gets Flagship Inference ("Flagship Inference starts once one
of your servers is running"), so creating accounts without boxes gets nothing.
Counted on the metering core (`packages/control-plane/src/meter.ts`):
`ai-promo-week` (week), `ai-promo-starter` (lifetime), `ai-promo-global`
(day, account `*`), and raw `ai-promo-input` / `ai-promo-output` (month).

- **Claim = sign.** The phone or webapp signs
  `flagship/llm-promo-issue/v1|username|serverFqdn|flagship|0|0|issuedAt` with
  the account IRK (vectors: `packages/protocol/test-vectors/llm-promo-issue/`)
  and posts it to `.com`: `POST /api/free-ai/status` →
  `{available, ended, reason: null|"no-server"|"busy-today", message?,
  credits:{week:{used, allowance, remaining, resetsAt}, starter:{used,
  allowance, remaining}, usedTokens, allowanceTokens, remainingTokens,
  remainingCredits, weeklyCredits, tokensPerCredit}}`;
  `POST /api/free-ai/token` → `{credential:{provider:"flagship", apiKey,
  baseUrl, source:"promo", relay:true}, model, expiresAt, credits}`, or
  `{error, code}`: 403 `free-ai-no-server`, 410 `free-ai-ended`, 429
  `free-ai-busy-today` / `free-ai-used-up`, 503 `free-ai-unavailable`.
  Minting records nothing (`packages/control-plane/src/freeAiCredits.ts`), so
  apps mint a fresh 12-hour pass (never past the end date) for every build
  start and every reply.
- **On by default.** The AI-key step and Settings list "Flagship Inference"
  first, as a built-in provider that can't be deleted or renamed (and is
  announced that way to screen readers); it is selectable like a saved key,
  and the step is skipped for an owner with no saved key. Its status line
  reads "1,840 free credits left · 500 added each week" (the same line in
  Settings and on the step, with the locale's thousands separators), or why it can't be used now (unavailable, busy today, no running
  server, used up, ended) with a way to add your own key; it stays listed,
  disabled, once the promotion has ended or the status can't be read. The
  owner's own keys follow and stay deletable. Nothing is sold, so there is no
  purchase wording.
- **The box** treats the pass as any credential: sealed per session, sent
  through the hub relay, its SSRF guard pinned to the pass's host. Its default
  model for `flagship` is a placeholder the shim replaces, and a refusal from
  the shim reaches the owner in the shim's own words (`freeAiMessage`).
- **The shim** (`infra/inference/shim`) is the only front door: it verifies
  the pass, asks `.com` (`POST /api/free-ai/allowance`) what's left and stops
  with `.com`'s reason at zero, rebuilds the request from an allowlist (no
  `user`, no message names, no extras; the upstream's model id; capped
  output) and calls any OpenAI-compatible upstream with only our key, then
  reports true input and output (or an estimate) to
  `POST /api/llm-promo/usage`, which charges the promotion too. The upstream
  sees Cloudflare's address and our account, never the box, the owner or
  their account name. Its refusals carry only our words: a 429/5xx is
  `free-ai-busy`, a 413 or a 400 that says the prompt overflowed the context
  window is `free-ai-too-long` ("This build is too big for Flagship
  Inference. Try a smaller change, or use your own AI key."), any other is
  `free-ai-upstream` ("isn't available right now"). Prompts and replies are
  neither logged nor stored. It has a primary and a fallback upstream (both
  US: DeepInfra, then OpenRouter's zero-retention hosts); a 5xx, timeout or
  dropped connection on the primary sends the same request once to the
  fallback before any byte reaches the box, never a 4xx
  (`infra/inference/shim/README.md`).
- Anthropic, OpenAI and Google can't mint per-user keys with a hard token
  cap, so `/api/llm-promo/issue` refuses them (410) instead of handing out a
  placeholder key; the phone-OTP claim (`apps/web/src/routes/llmPromo.ts`)
  only ever ran on the Fastify dev surface and no app calls it.

## Choosing a model (2026-10-14)

The build chat header has a compact model menu, changeable between
messages; Settings holds a default per provider. The choice rides on every
start and reply (`model`, `effort`) and is kept on the session
(`VibeCodeSessionMeta.model`/`effort`), so the staged fix loop uses it too.

- **Flagship Inference:** the catalog `.com` serves
  (`GET /api/inference/models`, `packages/control-plane/src/inferenceModels.ts`):
  Low 1× (Qwen3.6-35B-A3B), Medium 1× (DeepSeek-V4-Flash, text only),
  Medium multimodal 2× (GLM-5.3-Flash), High 3.5× (MiniMax-M3). A call
  costs (input × 1 + output × 4) × multiplier / 1,000 credits; how the
  multipliers come from real cost plus a 1.25 margin is
  `docs/ai-inference-costs.md` §15. The shim learns the chosen model from the
  allowance check, sends each upstream its own id, and reports the model with
  the usage; `.com` charges its own multiplier for it. After each reply the
  apps show a muted "used N credits" (the shim's last stream chunk,
  `{"object":"flagship.usage","credits":N}`, kept per reply on the session).
  "Think harder" (shown when the model reasons) sends `effort: "high"`; no
  extra multiplier, only more tokens.
- **Own keys (every provider we support):** `POST /api/screens/ai/models` on
  the box lists the key's models live (OpenAI-compatible and OpenRouter
  `/v1/models`, Anthropic `/v1/models`, Google `/v1beta/models`, Ollama
  `/api/tags`; through the relay like any call with that key; the key never
  reaches `.com`) and joins them with `.com`'s capability table
  (`GET /api/inference/capabilities`, rebuilt daily from OpenRouter's public
  catalog: context, image input, tool calling, the reasoning efforts each
  model takes). Known models without tool calling are left out; unknown ones
  are offered with no effort control and a "capabilities unknown" note; a
  provider with no list gets a free-text model field. The effort goes in each
  provider's own parameter (OpenAI `reasoning_effort`, OpenRouter
  `reasoning.effort`, Anthropic adaptive thinking + `output_config.effort`,
  Gemini `thinkingConfig.thinkingLevel`). New models are logged by the cron
  and listed at `GET /api/admin/model-capabilities` (admin secret).
- **Long conversations:** before a call would come close to the model's
  context (75% of what's left after the reply's room, from the catalog or the
  table; 128k when unknown), the box has the same model summarise the older
  middle of the conversation and sends the summary instead
  (`packages/server-daemon/src/llm/contextCompaction.ts`), keeping the system
  prompt, the first request and the recent turns. What the summariser reads,
  and its summary, pass through the model redactor. A chat session keeps the
  summary (`summarised: true` on its state); the staged loop compacts in
  memory.

## Attachments in the build chat

Up to 6 per message, with "The AI will see what you attach." beside the
attach control: images (PNG, JPEG, GIF, WebP, 4 MB), text and code (256 KB),
**sample data** (CSV/JSON, 2 MB: the model reads a preview; the whole file is
written only into the app's private test copy at `/data/sample/<name>` in its
dev files volume, never the live app) and **PDFs** (10 MB: the text is
extracted on the box with unpdf; the PDF goes nowhere). An image sent to a
model that can't see images first asks "I'll have to switch to <model>
(<multiplier>) for this." (Switch / Cancel); for own keys the suggested model
is the provider's cheapest vision model at least as dear as the current one.

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
- **scratch** → **AI-key step** → multi-turn chat (with attachments on webapp).
- **git** → URL+ref field → fitness verdict card → Install (fit) or, on
  not-fit, **AI-key step** → Build-with-AI (adapt).
- **mcp** → "Create connection" → show URL + key + copyable IDE config +
  rotate + deploy (no key step — the IDE brings its own AI).
- **marketplace** → "coming soon" until `feat/marketplace` (no key step).
- **journal** → per-build timeline; also reachable from service detail.

### AI-key step (the box-AI paths only)

Scratch (always) and git-adapt (only when a repo needs adapting) show a
"provide or confirm your AI key" screen before the box's model runs;
marketplace + MCP skip it. The screen recalls **device-saved keys** (shown as
a masked slug `provider · label · ····1234`, never the full key), pre-selects
the active one with a **Confirm** affordance, and lets the user enter a new
key with an optional **"Save on this device"** toggle. Storage is device-local
and encrypted per surface — webapp `providers.js` (UMK-wrapped IndexedDB),
iOS Keychain (`SavedKeyStore`), Android `EncryptedSharedPreferences`
(`AiKeyStore`) — and a **Settings → AI keys** manager lists (slug) / adds /
deletes. The chosen `{provider, apiKey, baseUrl?}` rides the build request as
`credential` (see the contract above); flagshipserver.com never sees it.

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
