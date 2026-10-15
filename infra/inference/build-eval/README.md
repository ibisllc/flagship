# build-eval: what an AI app build really costs

The free-AI allowance (`AI_PROMO_STARTER_TOKENS` 2M, `AI_PROMO_WEEKLY_TOKENS`
500k, weighted input × 1 + output × 4, 1 credit = 1,000 weighted tokens) was
set from a model estimate: one build ≈ 424k input + 13k output = 474k weighted
tokens (`docs/ai-inference-costs.md` §5). This harness replaces the estimate
with measurements: it runs scripted app builds, follow-up edits and the fix
rounds after a failed build through the box's own build loop, against
Flagship Inference's upstream (DeepInfra), and reports the tokens, credits and
dollars per build, per model and per app size.

## Run it

Put the DeepInfra key in `~/.config/flagship/deepinfra-eval.key` (one line;
`DEEPINFRA_API_KEY` in the environment wins over the file), then from the
repo root:

```sh
npm run build-eval                               # every model × every scenario, stops at $5
npm run build-eval -- --models low --max-usd 2   # a first, cheaper look
npm run build-eval -- --plan                     # list the runs and their prior cost, spend nothing
npm run build-eval -- --mock                     # the whole loop with a scripted model: no key, no network, no cost
```

`npm run build-eval` runs `tsc -b` for the harness first (it loads the
daemon's workspace packages from their built `dist/`), then
`tsx src/cli.ts`. Options:

| option | default | |
|---|---|---|
| `--models a,b` | all: `low,medium,medium-vision,high` | catalog ids (`packages/control-plane/src/inferenceModels.ts`) |
| `--scenarios a,b` | all, smallest first | ids from `scenarios/*.json` |
| `--repeat N` | 1 | runs per model and scenario |
| `--concurrency N` | 1 | runs at once |
| `--max-usd X` | 5 | spending limit |
| `--mock` | off | the scripted model |
| `--stage auto\|static\|docker` | auto | the build check: Docker when `docker` runs here, else static |
| `--out DIR` | `results/<timestamp>` | `results/` is git-ignored |
| `--no-save-apps` | apps saved | keep or drop the apps the model wrote |
| `--agent-max-turns N` | 24 (the box's) | the fix loop's turn cap |
| `--model-thinking` | off | strip the shim's thinking switch on the way to DeepInfra, so each model thinks as it does by default (as before 2026-10-15); a comparison only, production never thinks |

On GitHub: **Actions → Build cost measurement (on demand) → Run workflow**
(`.github/workflows/build-eval.yml`, `workflow_dispatch` only). It uses the
`DEEPINFRA_API_KEY` repo secret, runs the Docker build check with a Postgres
service, writes the summary to the job page and uploads the results folder.

## What it costs

DeepInfra prices (`src/prices.ts`, checked 2026-10-14, standard tier, per 1M
tokens in / cached in / out): Low (Qwen3.6-35B-A3B) $0.10 / $0.10 / $0.95,
Medium (DeepSeek-V4-Flash) $0.09 / $0.018 / $0.18, Medium multimodal
(GLM-5.3-Flash) $0.15 / $0.03 / $0.50, High (MiniMax-M3) $0.28 / $0.056 /
$1.10.

At the doc's estimate a build costs $0.055 (Low), $0.041 (Medium), $0.070
(Medium multimodal) and $0.133 (High). The 10 scenarios have 31 steps (first
builds plus edits), so the full matrix, one repeat, is about **$9** if builds
match the estimate (`--plan` shows the per-run priors, which are doubled for
safety). Low alone is about $1.70.

**The budget guard** (`src/budget.ts`) never lets the total pass
`--max-usd`:

- a run starts only if what's spent, what running runs have reserved, and the
  run's own estimate (the dearest run of that model and scenario so far, else
  twice the doc's estimate per step) fit;
- every model call is checked before it is sent, at its worst case (every
  prompt token uncached, the model's whole output cap); one that doesn't
  fit isn't sent, its run ends "stopped by the budget", and no more runs start.

The key is read from the environment or the file and is never printed,
logged or written: it is added to the request on the way to DeepInfra (the
in-process shim only ever holds a placeholder), and every error text and
results file goes through `redactSecrets` (`src/key.ts`).

## Reading the report

`results/<timestamp>/summary.md` (also `summary.json`, `runs/<run>.json` with
every model call, and `apps/<run>/<step>/` with the files the model wrote):

- **Per model**: runs passed, credits for a **first build** (the owner's first
  message to the app live, including owner answers and the fix loop) and for
  an **edit** (one follow-up change), the whole run, dollars, build turns, how
  often the fix loop ran, compactions. Each cell is "median / p90".
- **Against the estimate and the allowance**: median weighted tokens of a
  first build against 474k, and how many first builds, edits and whole runs
  the 2M starter and the 500k week buy at each model's multiplier.
- **Per scenario**: the same per app, with fix rounds and owner answers.
- **Tokens**: input, output, cached share (DeepInfra's prefix cache, which
  only lowers the dollars: credits charge every input token) and wall time.
- **Failures**, with the box's reason.

Credits are what `.com` charges for the shim's usage report
(`recordFreeAiUsage`): ceil((input + 4 × output) × multiplier) / 1,000, from
the token counts DeepInfra reported. `creditsShown` in the JSON is the sum of
the shim's per-reply "used N credits" (rounded up to a tenth per call).

A **fix round** is a failure fed back to the model: the failed test copy that
starts the fix loop, then each failed `deploy` inside it.

## How it works

Everything model-facing is the box's own code, imported from
`packages/server-daemon/src` and wired as `index.ts` wires it:

1. **Chat** (`runBuild.ts`): a `VibeCodeSessionRegistry` session, the
   owner's prompt, and `buildVibeCodeStartStreaming` (system prompt
   `systemPrompt.ts` + owner choices + `TOOL_USE_PROMPT_SUPPLEMENT`, tools
   `talkToUser`/`requestEnvVar`, streamed through `LlmHarness.chatStream` and
   the `flagship` provider adapter). When the model pauses on a tool, the
   scripted owner answers (`ownerScript.ts`: the scenario's answers in order,
   then its fallback; an env var is `set`, `declined` or `deferred` per
   scenario, never with a value) and `buildVibeCodeResumeStreaming` continues,
   compacting with `contextCompaction.ts` when the context fills, exactly as
   `/api/screens/llm/sessions/:id/reply` does.
2. **Deploy**: `buildStagedChatDeploy` stages a test copy; if it won't build
   or start, `runBuildAgent` drives the fix loop with `BuildToolHost`
   (`read_file`, `write_file`, `validate`, `deploy`, `check_app`, `get_logs`,
   the data tools, `finish`), the error fed back to the model as on the box,
   up to the box's 24 turns. Then the files "go live".
3. **Edits**: each follow-up is a new session on the live app's files, read
   back with `readServiceSource`, as `/api/screens/vibe-code/start` with
   `editServiceId` makes it (the edit supplement in the system prompt).
4. **Flagship Inference** (`shimHost.ts`): the provider adapter calls the
   real meter shim (`infra/inference/shim`) in-process; the shim checks a
   stand-in `.com` (the catalog model resolved by `resolveInferenceModel`, no
   limit), shapes the request (allowlist, DeepInfra's model id, thinking off
   with the model's switch, the model's output cap, usage in the stream) and
   calls the upstream, where the harness adds
   the key, applies the budget guard and files the usage DeepInfra reported.

### The build check

- **Static** (default without Docker, `staticCheck.ts` + `staticStaging.ts`):
  the staging copy's manifest checks, migrations need a Postgres store, the
  box's runtime build (`prepareRuntimeContext`: package.json for node, a
  start command for python, port 8080 for static), package.json parses, the
  start script and its file exist, `node --check` on JS, TypeScript's syntax
  check on TS, `py_compile` on Python, JS imports listed in `dependencies`,
  Python imports in the stdlib, the app or `requirements.txt`, and something
  reads `PORT`. Failures are worded as the box words them ("docker build
  failed: …", "the app didn't start: it stopped (exit code 1). Its last
  output: …").
- **Docker** (`dockerStage.ts`, when `docker` runs, or `--stage docker`): the
  box's `runDockerBuild` (its runtime Dockerfile and Dockerfile policy), the
  container started hardened (read-only root, /tmp tmpfs, no capabilities),
  the box's `buildStartCheck`; `check_app` and `get_logs` reach the real
  container. With `BUILD_EVAL_PG_URL` (an admin Postgres URL) each copy gets a
  fresh database, the migrations and the box's synthetic sample rows, and
  `query_db` / `list_tables` work; without it a Postgres app is built for real
  and then checked statically.

### Where it differs from the box

- **No Docker (static check)**: a copy that passes is never started. Its
  `check_app` answers 200 with a note saying it wasn't started, and
  `get_logs` says so; the data tools answer "not available on this server".
  A crash after start, a route answering 500 or a package that doesn't exist
  on the registry is only caught by the Docker check. The checks are close to
  but not the box's own messages for import and syntax errors, and the Python
  import check maps a few module names to packages by a small table.
- **Docker check**: no gVisor, no egress fence (the build reaches the
  internet over docker's default network, not the registry-only build
  network), the files folder is a tmpfs, the app connects as the database
  admin rather than its own role (the box's extensions are created
  best-effort), and `check_app` doesn't sign the identity headers.
- **The relay**: calls go straight to the in-process shim, not through the
  hub relay (which carries bytes unchanged). The credential is a real
  `.com`-format pass minted by the harness.
- **`.com`**: the allowance check never refuses (no weekly limit, no daily
  cap) and the usage reports are only recorded; the catalog the box reads for
  context sizes is `inferenceCatalogResponse` from the same code `.com`
  serves.
- **Going live** writes the files to a folder; nothing is installed or
  signed. Session saving to disk, the build journal, push notifications and
  the name check are not used.
- **The owner** answers from a script, immediately, and never changes the
  model mid-chat. A real owner may ask for more changes in between, which
  costs more.
- **`buildAgentRunner`** is wired as in `index.ts` (it isn't exported); the
  copy is the 15 lines that bind the session's key and model.

## Scenarios

`scenarios/*.json`, smallest first: a static bakery page, a to-do list, a
Python reading log, a family chore tracker with ranks, a booking form on
Postgres, a sensor API with API keys, a photo gallery on the files folder, a
recipe box with typo-tolerant search, a realtime kanban board, and a hiking
club with an outside weather API (it asks for a key). Each has 1-3 edits.
Fields: `id`, `size`, `title`, optional `name` and `visibility` (the Describe
form), `prompt`, `owner.answers` / `owner.fallback` / `owner.envVars`,
`edits`, and `mock` (what the scripted model builds, and whether it asks,
requests an env var or breaks the first build; a real model never sees it).

## Tests

```sh
npx vitest run infra/inference/build-eval
```

Accounting (credits, multipliers, cached prices, the price table against the
catalog), the budget guard and the run pool, key loading and redaction (the
key reaches only DeepInfra's Authorization header and is masked in a
provider's error), the scripted owner answers, the static check, and mock
runs end to end through the box's loop (owner questions, an env var, the fix
loop, edits, a budget stop mid-run).
