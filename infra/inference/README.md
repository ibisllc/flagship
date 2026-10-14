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
                 3. rebuild the request from an allowlist, pick the
                    catalog model's id, cap max_tokens; send it with ONLY
                    our key to the primary, once to the fallback if the
                    primary fails (5xx / timeout / connection)
                 4. POST .com /api/llm-promo/usage with the true usage
                    and the model (charged at its multiplier)
                 ▼
               UPSTREAMS: OpenAI-compatible /chat/completions, both US
               (DeepInfra primary, OpenRouter ZDR fallback; our own vLLM later)
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

1. **Upstreams:** create the DeepInfra account (primary) and the OpenRouter
   account (fallback; turn on zero data retention in its privacy settings),
   add prepaid credit to each, and create an API key with a spending limit.
   The models each serves are in `.com`'s catalog
   (`packages/control-plane/src/inferenceModels.ts`, multipliers in
   `docs/ai-inference-costs.md` §15).
2. **Shim** (see `shim/README.md`): `shim/wrangler.toml` already names both
   upstreams (`UPSTREAM_NAME`/`UPSTREAM_CHAT_URL`, `FALLBACK_NAME`/
   `FALLBACK_CHAT_URL`), then
   ```sh
   cd infra/inference/shim
   openssl rand -hex 32                                   # the shared secret
   npx wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET
   npx wrangler secret put UPSTREAM_API_KEY               # DeepInfra
   npx wrangler secret put FALLBACK_API_KEY               # OpenRouter
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
(`UPSTREAM_NAME` = its catalog key, or `UPSTREAM_MODEL` = its
`--served-model-name`). Nothing else changes.

Regions: both upstreams are US-only at launch. A user-selectable US/EU region
(an EU upstream such as Scaleway, chosen per account) is open work.
