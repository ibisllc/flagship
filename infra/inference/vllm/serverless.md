# RunPod (pod or Serverless)

The same model, pins and flags as the UpCloud server (`../upcloud/config.json`).
How it compares on cost, privacy and effort: `docs/ai-inference-costs.md` §12.
Prices and terms were researched 2026-10-13.

## Pod (always on): `Dockerfile` + `launch.sh`

A RunPod pod runs exactly one image (no Docker inside), so the image carries
both pieces: the pinned vLLM image, plus cloudflared checked against its
release checksum.

```sh
docker build --platform linux/amd64 -t ghcr.io/<org>/flagship-vllm:qwen3.6-v0.30.0 infra/inference/vllm
docker push ghcr.io/<org>/flagship-vllm:qwen3.6-v0.30.0
```

1. **Template.** Use that image pinned by its pushed digest, with a 60–80 GB
   volume disk mounted at `/workspace` so the weights and compile cache survive
   restarts. Expose **no** ports. Env: `VLLM_API_KEY` and `TUNNEL_TOKEN`, as
   RunPod secrets.
2. **Pod.** Secure Cloud L40S ($1.09/h) or RTX PRO 6000 ($2.49/h), in an EU
   data centre: EU-NL-1 or EUR-IS-2 had L40S stock on 2026-10-13.
3. **Network.** The same Cloudflare Tunnel and Access app as on UpCloud
   (`../upcloud/README.md` steps 1, 4 and 5). Pods carry TCP only, so
   cloudflared runs `--protocol http2`. The shim config is identical.

Who can see prompts:

- **With the tunnel:** TLS ends inside our container, so RunPod's proxy never
  carries the traffic. The data centre operator still has root on the machine,
  and RunPod's terms say it "may … access, store, process" Your Content.
  Secure Cloud partners are SOC 2 / ISO 27001 vetted, and hosts are barred by
  policy (not technically) from inspecting pods.
- **Community Cloud:** an unvetted third party owns the machine. Don't use it
  for user prompts.
- **Without `TUNNEL_TOKEN`:** vLLM listens on `0.0.0.0:8000` behind RunPod's
  HTTP proxy (`https://<pod>-8000.proxy.runpod.net`). That proxy terminates TLS
  at Cloudflare and RunPod, which then see prompts in plaintext, and anyone who
  has the URL reaches vLLM's API-key check. Use it only to smoke-test.

Billing is per second with no egress fees. A stopped pod bills its volume at
$0.20/GB-month and may come back without a GPU.

## Serverless (scale to zero): RunPod's `worker-vllm`

Use the `runpod/worker-v1-vllm:v2.29.0` template (bundles vLLM 0.31.0), with
these env vars (names from the worker-vllm README):

```
MODEL_NAME=Qwen/Qwen3.6-35B-A3B-FP8
MODEL_REVISION=95a723d08a9490559dae23d0cff1d9466213d989
OPENAI_SERVED_MODEL_NAME_OVERRIDE=flagship-coder
MAX_MODEL_LEN=65536
MAX_NUM_SEQS=8
GPU_MEMORY_UTILIZATION=0.92
ENABLE_PREFIX_CACHING=true
ENABLE_AUTO_TOOL_CHOICE=true
TOOL_CALL_PARSER=qwen3_coder
REASONING_PARSER=qwen3
ENABLE_LOG_REQUESTS=false
VLLM_EXTRA_ARGS=--default-chat-template-kwargs '{"enable_thinking":false}' --language-model-only --disable-uvicorn-access-log
```

Endpoint settings:

- **GPU and region:** the 48 GB PRO class (L40S / 6000 Ada), pinned to EU data
  centres (`dataCenterIds`).
- **Idle timeout: 300 s, not the 5 s default.** A build pauses between turns
  while its tool runs; a worker that scales down in that gap cold-starts
  mid-build.
- **Max workers:** your budget ceiling. 0 active workers scales to zero; each
  active worker is billed every second, at a discount you have to negotiate.
- **Cold starts:** use RunPod's cached-model feature, or a network volume with
  `HF_HUB_OFFLINE=1` and `VLLM_CACHE_ROOT` on the volume.

Shim:

- `UPSTREAM_CHAT_URL=https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1/chat/completions`
- `UPSTREAM_MODEL=flagship-coder`
- `UPSTREAM_API_KEY` = a RunPod API key. Requests authenticate at RunPod's
  gateway, so vLLM's own key does nothing here.
- Leave `UPSTREAM_CACHE_SALT` unset unless the worker passes it through.

What you give up:

- **Privacy:** TLS ends at RunPod's Cloudflare-fronted gateway, so RunPod sees
  prompts in plaintext, the same exposure as a hosted API. Inputs and outputs
  are deleted after the job TTL and result retention (minutes to 24 h). Worker
  logs are kept 90 days, so request logging must stay off.
- **Cold starts:** RunPod measured a 32 GB FP8 model cold-starting in a
  ~91 s median after tuning, and ~5 min untuned (2×H200, 2026-08). For our
  ~38 GB on one 48 GB GPU, expect 1.5–5 min. Any build that finds no warm
  worker waits that long for its first reply. At launch volumes that is most
  builds (§12).
- **Price:** flex is $1.75/h for the 48 GB class (pricing page; the docs table
  says $1.91/h). Serverless pays for every second a worker is up, including
  the idle timeout. Because a build holds a worker for about 15 minutes, it
  costs more than an always-on pod above a few hundred signups a month.
