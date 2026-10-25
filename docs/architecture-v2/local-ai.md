# Local AI and the AI tool broker (AI01, AI02)

Status: 2026-10-24, worktree `integrate/0.3-arch`. Plan: `IMPLEMENTATION-PLAN.md` §10 and §13.1 rows
AI01, AI02 (training path of G05). Builds on the accelerator stack (`gpu.md`) and the AI privacy
rule (`docs/ai-privacy-and-staging.md`).

**Owner decision (2026-10-24):** everything ships in 0.3. Real-GPU runs happen after the release;
until then every GPU path is exercised against the simulated gpud and the CPU path runs for real
(gym group `local-ai`).

## 1. The tool broker (AI01)

`packages/server-daemon/src/buildmodes/toolBroker.ts`. Every model-driven tool call (the box's own
build loop, the chat's staged fix loop, an IDE over MCP) goes through `AiToolBroker`, built inside
`BuildToolHost`, so no caller can bypass it.

- **Grant, not text.** A session's `ToolGrant` is fixed by the box when the session starts, from the
  owner's own action: a signed `flagship/ai-repair-consent/v1` (adapt), an owner session (chat), an
  owner-issued MCP key. It is frozen. `TOOL_POLICIES` says what each tool needs
  (`contract.read`, `workspace.read|write`, `journal.read`, `env.names|request`, `staging.deploy|http|logs|data`,
  `build.finish`); a tool the grant doesn't cover is never offered to the model and is refused if called.
- **Exact argument shapes.** Unknown fields (`target: "live"`, an env `value`), wrong types, oversize
  values, `..` or absolute paths, URLs or other hosts in `check_app`, header injection, foreign store
  names: refused before any hook runs.
- **Staging fence.** No tool takes a host, URL, service id or store outside the build's private
  staging copy; data tools see only its sample data.
- **Credentials.** Exact values the box holds for the session (the provider key) are cut from every
  result, the repo's own bytes included; secret-shaped tokens are cut from box-written text.
- **Redaction.** Every box-written result, refusal and hook error passes `buildModelRedactor`; only
  `read_file`/`list_files` (the repo's own bytes) pass unchanged.
- **Revocation.** `revoke()` (discard, key withdrawn) refuses queued calls and abandons active ones;
  a sealed build refuses everything; a session has a call cap.
- Prompt injection: a README or tool result that "authorizes" anything changes nothing: authority
  exists only as the grant and the owner-signed orders the box verifies.

## 2. Redaction coverage (AI01)

`llm/modelPrivacy.ts` now also removes the host name, the owner's name in any spelling (file names,
identifiers), mail addresses (sample domains like `example.com` stay), home folders, clock times
(ISO, HTTP, git), time zones, UTC offsets, locales, MAC addresses and public IPv4/IPv6.

`llm/modelBoundary.ts` lists every source file that hands text to a model and how it is covered
(`redacted`, `via-broker`, `repo-content`, `owner-authored`, `fixed-text`).
`tests/llm/redactionCoverage.test.ts` scans the daemon for model sinks and fails when a file with one
is unlisted or a `redacted` file never calls a redactor; it plants the owner's identity in every
channel (tool results, errors, logs, build output, file listings, data, git metadata, env names,
MCP resources and errors, compaction) and checks none of it reaches a model. Found and fixed on the
way: MCP's internal error text was unredacted; env names in the chat's system prompt were not
redacted.

## 3. Local inference (AI01)

`packages/server-daemon/src/localAi/`.

- **Catalog** (`catalog.ts`): llama.cpp build b11541 images by manifest-list digest (server: CPU,
  CUDA, ROCm, Intel; training `full`: same four), and five GGUF models pinned by Hugging Face
  revision + SHA-256 + size with license provenance (Qwen2.5 Coder 7B, Qwen2.5 1.5B/0.5B: Apache-2.0;
  TinyStories 15M/260K F32: MIT, trainable). Registry hosts: `huggingface.co`, `*.huggingface.co`,
  `*.hf.co`.
- **Model store** (`modelStore.ts`): download only on the owner's request; https only, every
  redirect hop must be an allowlisted host; size and SHA-256 must match or nothing is kept; budget
  (64 GiB of models) and free-space checks; the verified file goes to root (`privd host localai
  model-install`, which checks the digest again on its own copy) into the `flagship-models` volume,
  read-only, named by digest.
- **Model server** (`service.ts`): `flagship-localai-<16 hex>`, llama.cpp server, gVisor or the GPU
  allocation's runtime, not root, read-only root filesystem, no capabilities, staging network (no
  internet), loopback-published, one read-only mount (models), a per-start random key. Started on
  first use, stopped after 10 idle minutes so a GPU goes back to apps. A short probe records the
  measured tokens/s.
- **Placement** (`devices.ts`): a qualified GPU through `AcceleratorBroker` (claim, fair queue wait up
  to 2 min, attach) as app `flagship-local-ai`, always `exclusive` and `secrecy: true`; otherwise
  CPU when the model fits 80 % of RAM; otherwise refused with a sentence.
- **Provider** `flagship-local` ("On this server"): the apps send
  `credential: {provider: "flagship-local", apiKey: "local"}`; the harness ignores the key and URL and
  leases the box's own endpoint (`LOCAL_GUARD`: loopback only, never the relay). When the server
  can't run, the call fails with the reason: **no cloud fallback**. Model `auto` = the owner's chosen
  model, else the best downloaded one. No cost consent (nothing is paid, nothing leaves the box).

## 4. Owner API (AI02)

Paired session; companions read only. JSON.

`GET /api/screens/local-ai` →

```jsonc
{
  "available": true, "reason": null,
  "privacy": "this-server", "cost": "none",
  "settings": { "useGpu": true, "serveModel": null },
  "hardware": { "cpus": 4, "memoryMiB": 7900, "diskFreeBytes": 52000000000, "gpuService": false,
                "gpus": [{ "id": "0", "model": "RTX 4090", "vendor": "nvidia", "memoryMiB": 24564,
                           "state": "in-use|free|quarantined|unqualified",
                           "holders": [{ "appId": "flagship-local-ai", "appName": "Local AI", "allocationId": "…", "state": "running" }] }] },
  "budget": { "usedBytes": 0, "budgetBytes": 68719476736 },
  "models": [{ "id": "qwen2.5-0.5b-q4", "name": "Qwen2.5 0.5B", "descriptor": "…", "parameters": "0.5B",
               "quantization": "Q4_K_M", "sizeBytes": 491400032, "license": { "id": "apache-2.0", "url": "…" },
               "contextTokens": 32768, "tools": true, "purpose": "build|chat|test", "trainable": false,
               "state": "available|downloading|verifying|installing|installed|failed",
               "progress": { "state": "downloading", "receivedBytes": 1, "totalBytes": 2 } | null,
               "reason": null, "memoryNeededMiB": 900, "fits": true,
               "speed": { "tokensPerSecond": 24.4, "measured": false, "on": "cpu|gpu" } }],
  "service": { "state": "stopped|queued|starting|running|stopping|failed", "jobId": null, "modelId": null,
               "device": "cpu|gpu|null", "gpu": { "allocationId": "…", "deviceIds": ["0"] } | null,
               "queuePosition": null, "startedAt": null, "lastUsedAt": null, "inFlight": 0, "reason": null },
  "jobs": [{ "id": "0123456789abcdef", "kind": "inference|training", "appId": "alice--notes" | null,
             "appName": "Notes" | null, "modelId": "stories-15m", "state": "queued|preparing|running|completed|cancelled|failed",
             "device": "cpu|gpu|null", "gpu": { "deviceIds": ["0"] } | null, "queuePosition": 1 | null,
             "createdAt": 0, "startedAt": null, "endedAt": null, "reason": null,
             "epochs": 3, "epochsDone": 1, "checkpoints": 1, "cost": "none" }],
  "apps": [{ "serviceId": "alice--notes", "name": "Notes",
             "grant": { "requestsPerDay": 500, "tokensPerDay": 200000, "maxTokensPerRequest": 1024, … } | null,
             "usage": { "day": "2026-10-24", "requests": 3, "tokens": 900 } }],
  "datasets": [{ "serviceId": "alice--notes", "name": "Notes", "hasSampleData": true }],
  "trainableModels": [{ "id": "stories-15m", "name": "TinyStories 15M", "installed": true, "memoryNeededMiB": 934 }]
}
```

- `GET /api/screens/local-ai/jobs/<jobId>` → `{job, datasetDigest, datasetBytes, checkpoints: [{epoch, sha256, sizeBytes, at, loss}]}`
- `POST …/settings {useGpu?, serveModel?}` · `POST …/models/download|cancel|delete {modelId}` (202 / 409 `{error, code: unknown-model|already-installed|in-progress|over-budget|disk-full}`)
- `POST …/service/start {modelId?}` (503 `{error, code}`) · `POST …/service/stop`
- `POST …/train {order, signature}`: `order` is exactly `{serverDomain, serviceId, jobId, baseModel, epochs, issuedAt}`, signed
  `flagship/local-ai-train/v1|<serverDomain lowercase>|<serviceId>|<jobId>|<baseModel>|<epochs>|<issuedAt>` with the
  sensitive-order key (admin root, else IRK); 202 `{job}`, 400 extra fields, 403 not signed/stale/other server, 404 app, 409.
- `POST …/jobs/cancel|resume|delete {jobId}`
- `POST …/apps/grant {order, signature}`: `order` is exactly `{serverDomain, serviceId, requestsPerDay, tokensPerDay, maxTokensPerRequest, issuedAt}`,
  signed `flagship/local-ai-app-grant/v1|<serverDomain lowercase>|<serviceId>|<requestsPerDay>|<tokensPerDay>|<maxTokensPerRequest>|<issuedAt>`;
  all three 0 withdraws. 409 when not newer than the held one; 422 when the app doesn't declare `localAi`.

Vectors: `packages/protocol/test-vectors/local-ai/vectors.json` (seed `0x45`×32).

## 5. Fine-tuning (AI02, G05 training path)

`localAi/training.ts`. One signed job trains a trainable catalog model on ONE app's staged sample
data: the sample files the owner attached to that app's build chats (else its test copy's
`/data/sample/`, its dev files volume read-only). The order can't name a volume or path; both
brokers refuse any mount but the models volume (ro), the job's own `flagship-aitrain-<hex>` output
volume and an app's DEV files volume at `/dataset` (ro). `llama-finetune` runs one epoch per run;
each epoch's GGUF checkpoint is hashed in a sandbox and recorded under an HMAC binding job, app,
base model and dataset digest; resume starts from the newest record that verifies and whose file
still hashes to it. One job at a time; GPU when a qualified one is free, else CPU.

## 6. The app SDK (AI02)

Manifest v2 `"localAi": {"inference": true}` (part of the capability digest). Such an app gets
`FLAGSHIP_AI_URL=http://host.flagship.internal:<owned port>/v1` (OpenAI-compatible:
`GET /v1/models`, `POST /v1/chat/completions`, streaming included). The owned gateway port opens
only to that app's containers and forwards to a loopback listener bound to that app; requests are
answered only under the owner's signed grant, within its daily quotas (requests, tokens) and per
request cap; the body is rebuilt from an allowlist, `cache_prompt: false`. The endpoint reaches
nothing else: the app only sends its own data.

## 7. Privileged shapes (both brokers)

- `docker run` of `flagship-localai-<16 hex>` / `flagship-aitrain-<16 hex>` with a pinned local-AI image
  and the mounts above; everything else is the ordinary run's rules (gVisor or the GPU claim's
  runtime, not root, named network, no host paths).
- `host localai model-install <sha256> <models volume dir>` (copies the daemon's verified file from
  `/var/flagship/data/local-ai/incoming/sha256-<hex>.gguf` into its own folder, checks the digest, installs 0444 root),
  `host localai model-remove <sha256> <dir>`, `host localai out-prepare <hex> <job volume dir>` (owner 10001).

## 8. Open / unverified

- No real GPU run (H1 receipt covers CUDA); the CUDA/ROCm/Intel image paths are exercised against the simulated gpud only.
- llama.cpp tool calling quality with small models is model-dependent; Qwen2.5 Coder 7B is the
  default builder model and needs a GPU to be pleasant.
- Fine-tuning uses full F32 fine-tuning (llama.cpp's `llama-finetune`), sized for small models; no LoRA yet.
