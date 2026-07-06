# Inference meter shim — deploy

A standalone Cloudflare Worker (own `wrangler.toml`; NOT part of the repo's
`tsc -b` build graph). It validates the `.com`-issued scoped token, enforces
the per-token daily cap, proxies to vLLM, and reports true usage to `.com`.

## Deploy

```sh
cd infra/inference/shim

# 1. Point at your private vLLM + your .com:
#    edit wrangler.toml [vars]: VLLM_UPSTREAM, COM_BASE_URL

# 2. The signing secret — MUST equal apps/com's FLAGSHIP_INFERENCE_TOKEN_SECRET:
wrangler secret put FLAGSHIP_INFERENCE_TOKEN_SECRET

# 3. (RunPod Serverless only) the upstream API key the box never sees:
wrangler secret put VLLM_UPSTREAM_KEY

# 4. Ship + bind a public host (e.g. inference.flagshipserver.com):
wrangler deploy
```

Then set `.com`'s `FLAGSHIP_INFERENCE_ENDPOINT` to
`{"baseUrl":"https://<shim-host>","model":"<served-model-name>"}` and
redeploy `.com`.

## Contract

The token wire format + the OpenAI request/response shape are pinned by
`packages/llm-providers/tests/inferenceShimContract.test.ts`. If you change
`src/meter.ts`'s token verify, keep it in sync with
`packages/control-plane/src/inferenceToken.ts` — the test fails otherwise.

## Notes

- Prompts pass through; they are not logged or stored.
- The per-token cap here is a fast per-isolate gate; the authoritative
  budget lives in `.com` (`GET /api/llm-promo/status/:user`), fed by the
  usage webhook this shim calls.
- The metered path handles the non-streaming JSON response (usage is in the
  body). A streaming variant would parse the terminal SSE `usage` chunk.
