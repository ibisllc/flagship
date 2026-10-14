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
| `UPSTREAM_CHAT_URL` | full OpenAI-compatible chat-completions URL |
| `UPSTREAM_MODEL` | the upstream's model id (replaces the box's) |
| `MAX_OUTPUT_TOKENS` | ceiling on output tokens per call (default 8192) |
| `PAUSED` | `"1"` refuses every call with "isn't available right now" |
| `COM_BASE_URL` | `.com` for the allowance check and usage reports |

Secrets: `FLAGSHIP_INFERENCE_TOKEN_SECRET` (the same value as `apps/com`'s)
and `UPSTREAM_API_KEY`. `VLLM_UPSTREAM` / `VLLM_UPSTREAM_KEY` still work for
an older config.

## Deploy

```sh
cd infra/inference/shim
npx wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET
npx wrangler secret put UPSTREAM_API_KEY
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
  stream chunk), else an estimate of 4 characters per token. A report the
  shim couldn't send under-counts; a `.com` that can't answer the allowance
  check fails the call closed.
- Prompts pass through; they are not logged or stored.
