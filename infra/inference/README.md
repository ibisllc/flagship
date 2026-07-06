# Flagship in-house inference (free-credits backend)

The `flagship` provider posture is a Flagship-hosted, OpenAI-compatible
coding model. Users claim free credits; `.com` mints a scoped 1-hour token;
the user's box calls this endpoint directly (never through `.com`). This
directory is the deployable backend:

```
infra/inference/
  README.md          ← this runbook
  vllm/
    launch.sh        ← the vLLM OpenAI-server launch command (RunPod pod)
    serverless.md    ← RunPod Serverless (vLLM worker) variant
  shim/
    src/meter.ts     ← pure auth/meter core (token verify + usage extract)
    src/index.ts     ← the Cloudflare Worker entry (proxy + meter)
    wrangler.toml    ← shim deploy config
    README.md        ← shim deploy steps
```

## Architecture

```
box (daemon)  ──Bearer <scoped .com token>──▶  METER SHIM (Cloudflare Worker)
                                                  │  1. verify token (HMAC, .com secret)
                                                  │  2. enforce per-token caps
                                                  │  3. proxy → vLLM /v1/chat/completions
                                                  │  4. POST true usage → .com /api/llm-promo/usage
                                                  ▼
                                               vLLM (RunPod GPU) — the model
```

`FLAGSHIP_INFERENCE_ENDPOINT` on `.com` points at the **shim** (its public
`https` host), NOT vLLM directly — the box's promo credential is host-pinned
to whatever host `.com` hands back, and only the shim validates tokens /
meters usage. vLLM is not exposed publicly; the shim reaches it over a
private URL (`VLLM_UPSTREAM`).

## The model

Use a **Qwen2.5-Coder-Instruct**-class model — it emits OpenAI-style
`tool_calls`, which the agentic build path needs (read_file → write_file →
validate → deploy). Verified served shape: with `--enable-auto-tool-choice
--tool-call-parser hermes`, vLLM returns
`choices[].message.tool_calls[].function.{name,arguments}` and streams
`delta.tool_calls[]` shards — exactly what `packages/llm-providers`'
OpenAI adapter (which the `flagship` provider delegates to) parses. See
`packages/llm-providers/tests/inferenceShimContract.test.ts` for the pinned
wire contract.

- **32B** (`Qwen/Qwen2.5-Coder-32B-Instruct`): best quality; needs ~2×A100
  80GB or 1×H100 80GB (bf16) / 1×A100 with AWQ.
- **7B** (`Qwen/Qwen2.5-Coder-7B-Instruct`): 1×A10G/L4 24GB; good default
  for a free tier's cost profile.

Pick per budget; the `model` field in `FLAGSHIP_INFERENCE_ENDPOINT` must
match the id vLLM serves (`--served-model-name`).

## Owner deploy steps (you must run these — the agent can't)

1. **Stand up vLLM on RunPod.** A GPU pod:
   ```sh
   bash infra/inference/vllm/launch.sh          # runs on the pod
   ```
   or a Serverless endpoint — see `vllm/serverless.md`. Note the private URL
   vLLM listens on (pod: `http://<pod-ip>:8000`).

2. **Deploy the meter shim** (Cloudflare Worker) — see `shim/README.md`:
   ```sh
   cd infra/inference/shim
   wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET   # SAME value as .com
   wrangler deploy
   # set VLLM_UPSTREAM + COM_BASE_URL + SERVED_MODEL in wrangler.toml [vars]
   ```
   Note the shim's public host, e.g. `https://inference.flagshipserver.com`.

3. **Point `.com` at the shim + set the signing secret.** Both are Worker
   secrets on `apps/com`:
   ```sh
   cd apps/com
   wrangler secret put FLAGSHIP_INFERENCE_ENDPOINT
   #   {"baseUrl":"https://inference.flagshipserver.com","model":"flagship-coder-v1"}
   wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET   # a strong random; SAME as the shim
   ```
   Optionally set `FLAGSHIP_PROMO_IDENTITY_PEPPER` (64-hex) if serving the
   Fastify `.com` promo surface.

4. **Redeploy `.com`** (`npx tsc -b && cd apps/com && npm run deploy`). A
   `flagship` promo issue now mints a scoped token + returns
   `{apiKey, baseUrl, model}`; the webapp saves it as a `source:"promo"`
   provider; the box calls the shim; the shim meters back to
   `POST /api/llm-promo/usage` so `GET /api/llm-promo/status/:user` shows
   real consumption.

## Rotating the endpoint

Change `FLAGSHIP_INFERENCE_ENDPOINT` on `.com` and redeploy — no client
rebuild, no recipe change. Rotating the token secret invalidates
outstanding scoped tokens (≤1h blast radius); set the new value on BOTH
`.com` and the shim.

## Metering model — (b), true usage

We chose model **(b)**: the shim reports TRUE per-request token usage
(`prompt_tokens`/`completion_tokens` from vLLM) to `.com`, which records it
without bumping the call counter. Because we OWN the endpoint, this closes
the integrity gap of the pessimistic issue-time cap estimate used for
providers we don't proxy (model (a)). Caps are enforced at the shim (fast,
local to the request) and reflected in `.com` status for the user.
