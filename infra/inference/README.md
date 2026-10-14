# Flagship Inference (backend)

Flagship Inference lets an owner build apps on their box without their own AI
key (`docs/build-modes.md` "Flagship Inference"). The phone or webapp signs a
request, `.com` mints a 12-hour pass, the box calls the **meter shim** with
it through the hub relay, and the shim calls the model.

```
infra/inference/
  README.md          ← this runbook
  shim/              ← the meter shim (Cloudflare Worker): the only front door
  vllm/              ← self-hosted upstream (later): vLLM launch + Serverless notes
```

## Architecture

```
box ──relay──▶ METER SHIM (Cloudflare Worker, e.g. inference.flagshipserver.com)
                 1. verify the .com pass (HMAC, shared secret)
                 2. POST .com /api/free-ai/allowance → stop at 0 left
                 3. rebuild the request from an allowlist, pin the model,
                    cap max_tokens; send it with ONLY our upstream key
                 4. POST .com /api/llm-promo/usage with the true usage
                 ▼
               UPSTREAM: any OpenAI-compatible /chat/completions
               (a hosted model API at launch; our own vLLM later)
```

What the upstream sees: Cloudflare's address, our API key, and a prompt the
box has already passed through its model redactor. Never the box's address,
the owner's account name, a `user` field or any box header. Swapping the
upstream is a shim config change; boxes and apps never notice.

## Launch backend: a hosted model API

No GPUs to run, pay per token. Choose a provider whose API:

- is OpenAI-compatible and streams **tool calls** (the agentic build needs
  them) and reports usage with `stream_options.include_usage`;
- says in its terms that API prompts are **not stored or trained on**;
- takes **prepaid credit or a hard spend limit**: that balance is the
  budget's real ceiling, on top of each account's allowance.

Serve an open coding model with tool calling (a Qwen-Coder-class model is
what the build prompts were tuned against). Budget: an app build is roughly
a few hundred thousand tokens, mostly input. The allowance (weekly top-up,
starter reserve, the output weight, an end date) is `.com` config (`AI_PROMO_*`,
`docs/build-modes.md`), and `AI_PROMO_DAILY_CAP_TOKENS` (default 50M weighted
tokens a day, every account together) bounds what the promotion can cost per
day however it's abused.

## Owner steps

1. **Upstream:** create the provider account, add prepaid credit, create an
   API key, note its chat-completions URL and model id.
2. **Shim** (see `shim/README.md`): set `UPSTREAM_CHAT_URL` and
   `UPSTREAM_MODEL` in `shim/wrangler.toml`, then
   ```sh
   cd infra/inference/shim
   openssl rand -hex 32                                   # the shared secret
   npx wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET
   npx wrangler secret put UPSTREAM_API_KEY
   npx wrangler deploy
   ```
   and bind its public host (e.g. `inference.flagshipserver.com`).
3. **`.com`:**
   ```sh
   cd apps/com
   npx wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET   # SAME value as the shim
   npx wrangler secret put FLAGSHIP_INFERENCE_ENDPOINT
   #   {"baseUrl":"https://inference.flagshipserver.com","model":"flagship-free"}
   cd ../.. && npx tsc -b && (cd apps/com && npm run deploy)
   ```
   `model` here is only a label (the shim pins the real one).
4. Check, with a running server on the account: Settings in any app shows
   "This week: 500k of 500k left · Starter reserve: 2M"; a build with no
   saved key runs; Settings then shows less left this week.

Pause everyone at once with `PAUSED = "1"` in the shim's vars (redeploy).
Rotating the secret invalidates outstanding passes (≤ 12 h); set it on both.

## Later: our own model

Run vLLM (`vllm/launch.sh`, or `vllm/serverless.md`), keep it private to the
shim, and point `UPSTREAM_CHAT_URL` at `http://<pod>:8000/v1/chat/completions`
(`UPSTREAM_MODEL` = its `--served-model-name`). Nothing else changes.
