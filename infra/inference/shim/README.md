# Free-AI meter shim — deploy

A standalone Cloudflare Worker (own `wrangler.toml`; not in the repo's
`tsc -b` graph; tested by `packages/llm-providers/tests/inferenceShim*.test.ts`).
It verifies the `.com`-issued pass, checks the account's allowance with
`.com`, sends an allowlisted request to the upstream with only our key, and
reports the true usage back to `.com`.

## Config

`wrangler.toml` `[vars]`:

| var | meaning |
|---|---|
| `UPSTREAM_CHAT_URL` | the primary's full OpenAI-compatible chat-completions URL |
| `UPSTREAM_NAME` | the primary's provider key in `.com`'s catalog (`deepinfra`): picks its model ids |
| `FALLBACK_CHAT_URL` | the fallback's chat-completions URL (optional) |
| `FALLBACK_NAME` | the fallback's provider key in the catalog (`openrouter`) |
| `UPSTREAM_MODEL` / `FALLBACK_MODEL` | a pinned model id, only for an upstream the catalog names no ids for (our own vLLM) |
| `UPSTREAM_TIMEOUT_MS` | how long to wait for an upstream's response headers before trying the fallback (default 60000) |
| `MAX_OUTPUT_TOKENS` | ceiling on output tokens per call (default 8192) |
| `PAUSED` | `"1"` refuses every call with "isn't available right now" |
| `COM_BASE_URL` | `.com` for the allowance check and usage reports |

Secrets: `FLAGSHIP_INFERENCE_TOKEN_SECRET` (the same value as `apps/com`'s),
`UPSTREAM_API_KEY` and `FALLBACK_API_KEY`. `VLLM_UPSTREAM` /
`VLLM_UPSTREAM_KEY` still work for an older config.

Both upstreams are in the US at launch: DeepInfra primary, OpenRouter
fallback. On OpenRouter turn on zero data retention in the account's privacy
settings and give the key a credit limit; the shim also asks for ZDR hosts
that don't collect data and caps each model's price at what the catalog
budgets (`provider.max_price`), so a fallback call never costs more than the
multiplier assumes.

## Which model, and the fallback

The box sends a catalog id (`low`, `medium`, …). `.com`'s allowance check
answers with that model's multiplier, modalities, whether it reasons, and its
id on each upstream (`packages/control-plane/src/inferenceModels.ts`); an
unknown id gets the default model. The shim sends the primary its id. When
the primary answers 5xx, times out or drops the connection, the same request
(with the fallback's id and key) goes to the fallback, once, before any byte
reaches the box. A 4xx about the request (bad parameters, too long, rate
limited) is never retried. Metering and the request allowlist are identical
on both.

## Deploy

```sh
cd infra/inference/shim
npx wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler secret put FALLBACK_API_KEY
npx wrangler deploy
```

Then set `.com`'s `FLAGSHIP_INFERENCE_ENDPOINT` to
`{"baseUrl":"https://<shim-host>","model":"flagship-free"}` and redeploy `.com`.

## Contract

- The pass format must match `packages/control-plane/src/inferenceToken.ts`
  (`inferenceShimContract.test.ts` fails otherwise).
- Refusals are OpenAI-shaped `{"error":{"message","code":"free-ai-…"}}`; the
  box shows `message` to the owner. An upstream refusal is never passed on:
  429/5xx ⇒ `free-ai-busy`; 413, or a 400 saying the prompt overflowed the
  context window ⇒ 400 `free-ai-too-long` ("This build is too big for
  Flagship Inference…"); any other ⇒ `free-ai-upstream`.
- Usage: the upstream's `usage` (non-streaming body or the `include_usage`
  stream chunk), else an estimate of 4 characters per token, reported with
  the catalog model so `.com` charges its multiplier. A report the shim
  couldn't send under-counts; a `.com` that can't answer the allowance check
  fails the call closed.
- What a call cost reaches the box as a last stream chunk after `[DONE]`,
  `{"object":"flagship.usage","credits":N,"model":"low"}` (a non-streaming
  reply carries `flagship.credits`), so the apps show "used N credits".
- "Think harder" arrives as `reasoning_effort`; the shim sends it as
  `reasoning_effort` (DeepInfra) or `reasoning.effort` (OpenRouter), and drops
  it for a model that doesn't reason. An image sent to a text-only model is
  refused with `free-ai-no-images`, naming the model to switch to.
- Prompts pass through; they are not logged or stored.
