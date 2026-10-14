# Free AI on our own GPU (UpCloud)

One UpCloud GPU server runs an open coding model in vLLM. The meter shim
(`../shim`) is the only thing that can reach it. Why this model and GPU, and
what it costs: `docs/ai-inference-costs.md`.

```
box ──hub relay──▶ METER SHIM (Worker) ──HTTPS + Access service token + vLLM key──▶ Cloudflare edge
                                                                                     │ Cloudflare Tunnel
                                                                                     ▼ (the server dials out; no inbound port)
                                     UpCloud fi-hel2: cloudflared ──▶ vLLM on 127.0.0.1:8000 ──▶ 1 GPU
```

| file | what |
|---|---|
| `config.json` | the server: zone, plan, template, disk, pinned vLLM image digest, pinned model revision, vLLM flags |
| `presets/*.json` | the alternatives (bigger GPU, safer model, cheaper GPU); pass one with `--config` |
| `cloud-init.yaml` | first boot: firewall, RAM-only logs, NVIDIA stack if missing, pull images, download weights, systemd units |
| `provision.mjs` | `plan` (dry run), `create`, `status`, `health`, `stop`, `start` |
| `teardown.mjs` | delete the server, its disk and backups |
| `cost-model.mjs` | the cost calculator behind the pricing doc |

## What runs on the box

- **vLLM** `vllm/vllm-openai@sha256:…` (v0.30.0) serving
  `Qwen/Qwen3.6-35B-A3B-FP8` at a pinned commit, as `flagship-coder`.
  Flags: `--enable-prefix-caching`, `--enable-auto-tool-choice --tool-call-parser qwen3_coder`,
  `--reasoning-parser qwen3`, thinking off by default
  (`--default-chat-template-kwargs '{"enable_thinking":false}'`), `--language-model-only`,
  `--max-model-len 65536`, `--max-num-seqs 8`. It binds **127.0.0.1** and requires
  `VLLM_API_KEY` (read from a 0600 env file, so it never shows in `ps`). `/health` is open, `/v1/*` needs the key.
- **cloudflared** `cloudflare/cloudflared@sha256:…` (2026.9.3), a remotely
  managed tunnel that only dials out to Cloudflare.
- A **watchdog** timer: three failed `/health` checks in a row (after a
  20-minute grace for loading the weights) restart vLLM. Both services are
  `Restart=always`.

### Reachability: why a Cloudflare Tunnel

The server has **no open inbound port**. vLLM listens on loopback; cloudflared
connects out to Cloudflare; the shim reaches it at a tunnel hostname that
Cloudflare Access guards with a service token, and vLLM checks its own key
behind that. Three layers keep everyone else out:

1. **UpCloud firewall** (`firewall: on`, rules in `lib.mjs`). It is
   *stateless* ([UpCloud docs](https://upcloud.com/docs/products/networking/firewall/)),
   so inbound allows only replies, matched by source port (443/80 for downloads,
   7844 tcp+udp for the tunnel, 53 DNS, 123 NTP, ICMP), then drops everything. SSH included.
2. **nftables on the host**: stateful, accepts only established/related
   traffic and loopback.
3. **Access + API key**: a request reaching the hostname without the service
   token stops at Cloudflare's edge; one with it still needs the vLLM key.

The alternative, a public TLS port allowlisted to Cloudflare's IP ranges, is
weaker: Worker subrequests share those ranges with every other Cloudflare
customer, so the allowlist doesn't authenticate anything. It would also need
our own certificate on the box and a port open to the internet.

**Even tighter, once it's GA:**
[Workers VPC](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)
(beta; doc page updated 2026-10-12) binds the shim straight to the tunnel
with no public hostname at all. The shim already supports it: bind the VPC
Service as `UPSTREAM_VPC` and set `UPSTREAM_CHAT_URL` to
`http://127.0.0.1:8000/v1/chat/completions`. The host in that URL only sets
the Host header.

### Logs: no prompts are kept

- vLLM logs a request only when started with `--enable-log-requests`; we never
  pass it. The uvicorn access log is off (`--disable-uvicorn-access-log`).
  vLLM usage stats and Hugging Face telemetry are off (`VLLM_NO_USAGE_STATS`, `DO_NOT_TRACK`,
  `HF_HUB_DISABLE_TELEMETRY`).
- Containers log to journald, and journald keeps **RAM only** (`Storage=volatile`, 64 MB,
  2 days). What's left is startup, throughput stats and errors. One caveat:
  if a tool-call parser fails, vLLM can log the model output it couldn't parse.
  That stays in RAM and is gone at reboot.
- cloudflared runs at `--loglevel warn` and never logs bodies.
- The shim, as before, logs nothing and sends no identity upstream. Set
  `UPSTREAM_CACHE_SALT = "per-pass"` so vLLM's shared prefix cache can't be
  probed across accounts by timing.

## Owner runbook

Nothing here has been run against UpCloud yet. Expect to fix small things the
first time.

**0. Prerequisites**

- An UpCloud account past the trial with **GPU quota**. GPUs are limited per
  account; ask support for 1× L40S (or the GPU you choose) in `fi-hel2`, the
  only GPU zone. GPUs can't be paid with promotional credit.
- An UpCloud API token for this (a separate token from the `.com` Worker's
  `UPCLOUD_TOKEN`; it needs server create/delete).
- Node 20+ on the machine you run this from.

**1. Cloudflare** (Zero Trust dashboard)

1. Networks → Tunnels → Create a tunnel (Cloudflared) named
   `flagship-inference`. Copy its **token** (`CF_TUNNEL_TOKEN`).
2. Give the tunnel a public hostname, e.g. `vllm-upstream.flagshipserver.com`,
   with service `http://127.0.0.1:8000`.
3. Access → Service Auth → create a service token `flagship-inference-shim`
   (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`).
4. Access → Applications → self-hosted app for `vllm-upstream.flagshipserver.com`,
   one policy with action **Service Auth** that includes only that service token.

**2. Dry run** (no token, no network):

```sh
node infra/inference/upcloud/provision.mjs plan          # or: plan --config infra/inference/upcloud/presets/<x>.json
```

Check the plan and price (the H100 price changes on 2026-10-20), and that the
template title matches exactly one public template. If not, put its UUID in
`config.template` (`upctl storage list --public --template`).

**3. Create** (it bills per started hour from here; L40S €1.11/h):

```sh
export UPCLOUD_TOKEN=…                         # never echoed
export VLLM_API_KEY=$(openssl rand -hex 32)    # keep it: the shim needs it
export CF_TUNNEL_TOKEN=…
node infra/inference/upcloud/provision.mjs create --yes
```

First boot takes about 15–25 min: images (~10 GB), weights (~38 GB), and a
reboot only if the template lacked the NVIDIA driver. The secrets live in the
server's `user_data`, which the UpCloud account and the box itself (metadata
service) can read. To rotate them, create a new server.

**4. Check it** the way the shim will call it:

```sh
export INFERENCE_UPSTREAM=https://vllm-upstream.flagshipserver.com
export CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=…
node infra/inference/upcloud/provision.mjs health
# ok /health · ok /v1/models (flagship-coder) · ok tool call read_file(…) · ok no key → 401
```

If it fails, open the UpCloud web console and read
`/var/log/cloud-init-output.log` and `journalctl -u flagship-vllm`.

**5. Point the shim at it** (`infra/inference/shim/wrangler.toml` `[vars]`):

```toml
UPSTREAM_CHAT_URL = "https://vllm-upstream.flagshipserver.com/v1/chat/completions"
UPSTREAM_MODEL = "flagship-coder"
UPSTREAM_CACHE_SALT = "per-pass"
```

```sh
cd infra/inference/shim
npx wrangler secret put UPSTREAM_API_KEY                 # = VLLM_API_KEY
npx wrangler secret put UPSTREAM_ACCESS_CLIENT_ID
npx wrangler secret put UPSTREAM_ACCESS_CLIENT_SECRET
npx wrangler deploy
```

Boxes notice nothing. Then run a real build with free AI and read
`/metrics` throughput from the console (`curl -s 127.0.0.1:8000/metrics | grep -E 'prefix_cache|tokens_total'`)
to replace the cost model's estimates.

**6. Daily cap.** On our own GPU the cost is fixed, so
`AI_PROMO_DAILY_CAP_TOKENS` now protects latency, not money. Set it to what
the GPU serves at peak (`cost-model.mjs` "The cap that just fills one GPU",
about 145M weighted/day for the L40S estimate, vs 50M today) once measured.

## Changing things

- **Model or image:** edit `config.json` (new digest and revision), create the
  new server under a new `name` (e.g. `flagship-inference-2`), check `health`,
  point the shim at it, then `teardown.mjs --config <old>`. That way builds
  never see a gap.
- **Bigger GPU:** `presets/rtxpro6000-qwen3.6-35b.json` (96 GB, 128k context,
  32 sequences) or `presets/h100-qwen3.6-35b.json`, the same way.
- **Safer model** if Qwen3.6's open vLLM issues bite (tool calls lost inside
  thinking, hybrid prefix caching): `presets/l40s-qwen3-coder-30b.json`, the
  2025 coder with plain attention and a mature parser.
- **Cheapest:** `presets/l4-gpt-oss-20b.json`, an L4 at €0.58/h. Weaker at
  agentic builds, and its Chat Completions tool calling has open bugs. Not
  recommended for builds.
- **CUDA:** the default image is built on CUDA 13 (driver ≥ 580). If the template's `nvidia-smi`
  shows an older driver, use the `v0.30.0-cu129` digest
  (`sha256:a67f8f186d4567612ac37a55bd82295006002b18858eb12a8af2f05f86c2ae3f`).

## Scheduled stop

A **stopped** UpCloud GPU server bills no plan, only its disk (120 GB
Standard, €10.20/mo) and IPv4 (€3.47/mo). Each hour off saves €1.11 on the
L40S. Off 8 h a night is €270/month (33%). A restart takes about 5 min: boot,
then load the weights from disk. vLLM's compile cache persists in
`/var/lib/flagship-inference/vllm-cache`. While the GPU is off, builds get the
shim's "Free AI is busy right now", so stop only at hours you've measured as
empty, e.g. from a cron on an always-on machine:

```cron
0 1 * * *  cd ~/flagship && UPCLOUD_TOKEN=… node infra/inference/upcloud/provision.mjs stop  --yes
0 6 * * *  cd ~/flagship && UPCLOUD_TOKEN=… node infra/inference/upcloud/provision.mjs start --yes
```

## Teardown

```sh
# first: shim PAUSED = "1", or point UPSTREAM_CHAT_URL elsewhere
UPCLOUD_TOKEN=… node infra/inference/upcloud/teardown.mjs --yes
```

This deletes the server, its disk (weights included) and backups. Then delete
the tunnel and Access app if you're done with them.
