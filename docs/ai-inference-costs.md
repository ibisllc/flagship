# AI inference costs: free AI on our own GPU, and what to charge later

"For a limited time, building your apps is free on Flagship." This doc covers
what that costs when we serve the model ourselves on UpCloud, what one new
customer costs, and what to charge per token once tokens go on sale.

Researched 2026-10-13. Every number comes from
`infra/inference/upcloud/cost-model.mjs`. Change an assumption there (or with
`--set`) and rerun rather than editing the tables by hand. The infrastructure
is in `infra/inference/upcloud/` (runbook: its `README.md`). The allowance
mechanics are in `docs/build-modes.md` "Free AI credits".

## TL;DR

> **Update 2026-10-14 (§12):** UpCloud's promotional credit can't pay for
> GPUs, so RunPod was compared too. For the launch promotion, **rent the
> model per token** (DeepInfra-class Qwen3.6-35B-A3B, about €19–160 a month)
> rather than run a GPU (€500–830). Run our own GPU when no third party may
> see prompts (UpCloud L40S) or once volume passes ~8B weighted tokens a
> month. RunPod Serverless is not recommended.
>
> **Provider shortlist (§13, 2026-10-14):** for Qwen3.6-35B-A3B, DeepInfra
> (exact model, nothing stored by default, spending limit; ≈ €142/month at
> 1,000 signups) is first. OpenRouter with zero-data-retention routing (≈ €120,
> fails over between hosts) is second. Scaleway (EU, zero retention; ≈ €367)
> is the pick if EU hosting is required.

- **Run `Qwen/Qwen3.6-35B-A3B-FP8` on one UpCloud L40S** (plan `GPU-8xCPU-64GB-1xL40S`,
  `fi-hel2`, €1.11/h). With the disk and IPv4 that is **≈ €824/month**.
  - The model is Apache-2.0: 35B parameters, a mixture-of-experts with 3B active, scoring 73.4 on SWE-bench Verified (vendor-reported).
  - Serve it with FP8 weights, thinking off and a 64k context.
  - Estimated capacity is **≈ 55 app builds/hour**. That is an estimate: measure it after launch.
- **One new customer costs about €0.09 in GPU time** over a 12-week promotion. That rests on the assumptions in §6: 60% build, 2.9 builds each, about 1.4M weighted tokens.
  - Someone who uses their entire allowance (8M) costs about €0.50.
  - The GPU is a fixed €824 a month, so fully loaded that is **€8.29 per signup at 100 signups a month, €0.83 at 1,000, and €0.08 at 10,000**. At 10,000, today's 50M daily cap turns most demand away.
- **Self-hosting is not the cheap option at launch volumes.** Renting the same model per token from DeepInfra would cost **€19/month at 100 signups/month and €142 at 1,000**.
  - Our GPU only beats renting above **~44% utilisation (≈ 8.3B weighted tokens a month)**.
  - Run our own for privacy and control: no third party sees a prompt, even a redacted one. Run it for cost only once volume is there.
- **The daily cap changes job.** On a fixed-cost GPU it protects latency, not money. One L40S serves ≈ 145M weighted tokens/day at peak-safe load, against today's cap of 50M (≈ 106 builds/day).
- **Price for later token sales: $0.50 per 1M weighted tokens.**
  - That is $0.50/M input and $2.00/M output equivalent, **2M weighted tokens per $1 voucher, ≈ 4 app builds per $1**.
  - It breaks even at ~11% GPU utilisation and earns a 57% margin at 25%.
  - It sits beside the model's first-party price (Alibaba, ≈ $0.40/M on our mix) and about a quarter of a frontier model (Claude Sonnet 5.5, ≈ $2.05/M on our mix).
  - Sell vouchers in packs of 5–10: card fees make single $1 vouchers lose about a third.

## 1. UpCloud's GPU offering (2026-10)

UpCloud has suitable GPUs, but with caveats. They run **only in `fi-hel2` (Helsinki)**.

| Plan | GPU (VRAM) | vCPU / RAM | € / hour | ≈ € / month (720 h) |
|---|---|---|---|---|
| GPU-8xCPU-64GB-1xL4 | L4 (24 GB) | 8 / 64 GB | 0.58 | 418 |
| **GPU-8xCPU-64GB-1xL40S** | **L40S (48 GB)** | 8 / 64 GB | **1.11** | **800** |
| GPU-16xCPU-80GB-1xRTXPRO6000 | RTX PRO 6000 (96 GB) | 16 / 80 GB | 1.65 | 1,188 |
| GPU-12xCPU-240GB-1xH100 | H100 SXM (80 GB) | 12 / 240 GB | 1.79 | 1,289 |
| GPU-24xCPU-240GB-1xB200 | B200 (192 GB) | 24 / 240 GB | 4.50 | 3,240 |

Prices exclude VAT. Larger and multi-GPU plans exist (up to 8× H100/B200).

What the table doesn't show:

- **Where the prices come from:** the live pricing page is behind a bot
  challenge, so these are from the 2026-10-07 Wayback snapshot. **UpCloud
  announces new H100/B200 pricing from 2026-10-20**, and I couldn't tell
  whether the snapshot shows the old or the new prices.
- **Spot pricing:** L40S spot is €0.83/h. It's interruptible (30 s notice),
  only offered for L40S and B200, and there is no spot field in the API,
  `upctl` or Terraform today. That suggests spot is control-panel only.
  Not used here.
- **Billing:** per started hour. A **stopped GPU server bills no plan**, only
  its storage and IPs. Storage: Standard €0.085/GB-month, MaxIOPS €0.22.
  IPv4: €3.47/month (IPv6 is free). No storage is included with GPU plans.
  Egress is free within a fair-transfer limit (the 1×L40S plan adds 12 TB).
- **API:** a normal `POST /1.3/server` with a `GPU-…` plan, with no
  GPU-specific fields. `GET /1.3/device/availability` shows live per-zone GPU
  capacity. `upctl` supports it (`upctl zone devices`).
- **OS template:** a public template "Ubuntu with NVIDIA Drivers and CUDA"
  (NVIDIA driver, container toolkit, Docker CE) exists for GPU plans. Our
  cloud-init uses it and installs the stack itself on any other Ubuntu.
- **Quota:** GPU quota is limited per account and set by its history. Ask
  support. GPUs aren't in the free trial and can't be paid with promo credit.
- **Firewall:** stateless, free, up to 1000 rules per server.
- **No managed inference product:** UpCloud offers GPU servers, Kubernetes GPU
  nodes and dedicated B200/B300 clusters, nothing hosted.

If UpCloud says no to quota, the closest equivalents (not verified today) are
Scaleway (L4/L40S/H100, Paris/Amsterdam, hourly, API) or Verda (ex-DataCrunch,
Helsinki).

## 2. The model

The build agent drives tools through OpenAI-style `tools`
(`packages/server-daemon/src/buildmodes/buildAgent.ts`), so the model must
call tools reliably. It must also be licensed for commercial serving and fit
one GPU at FP8.

| Model | Licence | Params (active) | SWE-bench Verified* | FP8 weights | KV / token | vLLM tool parser | Fit |
|---|---|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** (2026-04) | Apache-2.0 | 36B MoE (3B), hybrid DeltaNet | **73.4** | 37.5 GB | 20 KiB + per-seq state | `qwen3_coder` | L40S (tight), RTX PRO 6000, H100 |
| Qwen3.8-27B (2026-08) | Apache-2.0 | 27.8B dense, hybrid | n/a (Terminal-Bench 2.1: 73.0) | 30.9 GB | 64 KiB + state | `qwen3_coder` | L40S (tight), larger |
| Qwen3.6-27B | Apache-2.0 | 27.8B dense, hybrid | 77.2 | 30.9 GB | 64 KiB + state | `qwen3_coder` | as above |
| Devstral Small 2 (2512) | Apache-2.0 | 24B dense | 68.0 | ≈ 26 GB | 160 KiB | `mistral` | open vLLM regression; Mistral retired it from their API |
| GLM-4.7-Flash | MIT | 31B MoE (≈ 3B) | 59.2 | 32.5 GB (community) | ≈ 53 KiB | `glm47` | L40S |
| gpt-oss-20b | Apache-2.0 | 21B MoE (3.6B) | 60.7 (OpenAI) / 34.0 (Z.ai harness) | 13.8 GB MXFP4 | 24 KiB | `openai` | L4 and up; open tool-call bugs |
| gpt-oss-120b | Apache-2.0 | 117B MoE (5.1B) | 62.4 | 65 GB MXFP4 | small | `openai` | H100 / RTX PRO 6000 |
| Qwen3-Coder-30B-A3B (2025-07) | Apache-2.0 | 30.5B MoE (3.3B), plain attention | none official | 31.2 GB | 96 KiB | `qwen3_coder` | L40S (tight) |

\* Vendor-reported and from different harnesses, so they aren't strictly
comparable. Sources are in §12.

**Recommended: Qwen3.6-35B-A3B-FP8 on one L40S.**

- **Quality and speed:** it has the best published agentic score that runs at
  3B-active speed. It is the same family and tool-call format (`qwen3_coder`)
  the build prompts were written for.
- **Thinking off by default**
  (`--default-chat-template-kwargs '{"enable_thinking":false}'`), for three
  reasons:
  - thinking tokens are output tokens, weighted ×4 in the allowance;
  - the shim caps a reply at 8,192 output tokens;
  - an open vLLM issue (#39056) drops a tool call emitted inside `<think>`.

  Turning thinking on is a one-flag A/B worth running on real builds.
- **Why the L40S:** it's the cheapest card that holds the model. It's tight
  (≈ 5 GiB of KV room after the 37.5 GB weights), so the context is 64k, not
  the 128k Qwen suggests for thinking, and at most 8 sequences.
- **Prefix caching:** the default for hybrid models in vLLM ≥ 0.30 is
  `--mamba-cache-mode align`, which caches at block boundaries. That's fine
  for our long, growing prompts.

**Stronger:** the same model on an **RTX PRO 6000 96 GB** (€1.65/h) or
**H100 80 GB** (€1.79/h, price changes 2026-10-20), at 128k context and 32
sequences (`presets/`). Each serves about 2.7–3.3× the builds of an L40S, for
1.5–1.6× the price, so per token they are cheaper once they're busy. For more
quality rather than more throughput, try Qwen3.8-27B-FP8 on the same cards
(dense, so about 3× slower decode).

**Cheaper:** **gpt-oss-20b on an L4** (€0.58/h, `presets/l4-gpt-oss-20b.json`).
It halves the fixed cost, but its agentic scores are contested (60.7 vs 34.0
depending on harness), and its Chat Completions tool calling has open vLLM
bugs (#44216, #58825). Not recommended for builds.

**Fallback:** if Qwen3.6's hybrid-model issues bite, use
`presets/l40s-qwen3-coder-30b.json`. That is the 2025 coder with plain
attention, a mature parser and FP8 KV cache, on the same L40S.

## 3. Throughput

There is **no published saturation benchmark** for any of these models on an
L40S. The real data points:

| Source | Setup | Result |
|---|---|---|
| GPUStack Perf Lab | gpt-oss-20b, 1×H100, vLLM 0.11 | 7.8–9.1k output tok/s (ShareGPT); 29.7k total tok/s at 32k-in/100-out |
| GPUStack Perf Lab | gpt-oss-20b, 1×A100 80GB | 7.3k total tok/s at 32k-in/100-out |
| DevForth (2026-02) | gpt-oss-20b single stream | L40S 160 tok/s, H100 228 tok/s; 16 concurrent 131k sequences fit on L40S |
| Millstone AI | Qwen3-Coder-30B-A3B FP8, latency-capped | H100 584 tok/s at 1–6 concurrent (understates saturation) |
| Red Hat (2025-10) | Qwen3-Coder-30B-A3B AWQ, 1×L40S | ≈ 8k tok/s peak (probably total tokens) |

From those, plus bandwidth and compute ratios (the L40S has ≈ 0.26× the H100's
memory bandwidth), the model's defaults for **Qwen3.6-35B-A3B-FP8 on an L40S**
are **8,000 tok/s prefill** (uncached) and **450 tok/s aggregate decode**. The
research range for decode was 350–800.

**What actually limits an L40S is its KV room, not compute.** An app build:

- re-sends its whole history every turn: up to 24 turns, no compaction,
  tool results up to 24k characters;
- waits on its own tool runs (Docker builds, test deploys), so it holds its
  context for about 15 minutes.

A build only gets its prefix-cache hits while its context stays cached. About
125k tokens fit on an L40S, roughly 4 builds at once. Past that, builds still
run, but they re-read their context at full prefill cost. The model handles
this with two hit rates: 70% for builds that stay cached, 10% for evicted
ones.

| GPU (Qwen3.6-35B-A3B-FP8) | € / month | builds/hour at 100% | limited by | € per 1M weighted at 10% / 25% / 70% busy | beats renting above |
|---|---|---|---|---|---|
| **L40S 48 GB** | 824 | 55 | KV room (≈ 4 cached) | 0.44 / 0.18 / 0.06 | 44% busy (8.3B/month) |
| RTX PRO 6000 96 GB | 1,218 | 146 | compute (≈ 38 cached) | 0.24 / 0.10 / 0.03 | 24% (12.2B/month) |
| H100 80 GB | 1,320 | 184 | KV room (≈ 26 cached) | 0.21 / 0.08 / 0.03 | 21% (13.3B/month) |

The RTX PRO 6000 and H100 rows use `--set` throughput guesses: decode 900 and
1,600, prefill 12k and 20k, KV room 1.15M and 800k tokens. Replace every
throughput figure with measured ones (`vllm bench serve`, or the box's
`/metrics`) in the first week.

## 4. The calculator

```sh
node infra/inference/upcloud/cost-model.mjs                         # the report
node infra/inference/upcloud/cost-model.mjs --set users.pctBuild=0.4 --set gpu.hourly=1.79
node infra/inference/upcloud/cost-model.mjs --config my.json --json # deep-merged overrides, machine output
node infra/inference/upcloud/cost-model.mjs --compare               # one row per cost-presets/*.json (§12)
```

Every input is in `DEFAULTS` at the top of the file, with where it came from:

| group | inputs |
|---|---|
| `gpu` | `hourly`, `monthlyCap`, `stoppedHourly`, `storageGb`, `storagePerGbMonth`, `ipv4Monthly` |
| `onHoursPerDay` | 24, or less for a scheduled stop |
| `throughput` | `prefillTokPerSec`, `decodeTokPerSec`, `prefixCacheHit`, `prefixCacheHitEvicted`, `kvCacheTokens` |
| `build` | `turns`, `firstPromptTokens`, `growthPerTurn`, `outputPerTurn`, `wallMinutes` |
| `weights` / `allowance` | 1 / 4; starter 2M, weekly 500k, daily cap 50M (`.com` `AI_PROMO_*`) |
| `users` | `pctBuild`, `buildsFirstWeek`, `pctReturnWeekly`, `weeklyRetention`, `buildsPerActiveWeek`, `promoWeeks` |
| `fleet` | `peakToAverage` (3), `maxUtilisation` (70%), `minGpus` |
| `sales` | `pricingUtilisation`, `marginPct`, card fees, `vouchersPerPurchase` |
| `benchmarks` | hosted USD prices; `sameModelBenchmark` picks the like-for-like one |
| `mode` / `serverless` / `meta` | `always-on`, `serverless` (per-second workers: flex/active rate, idle timeout, cold start) or `hosted`; labels for `--compare` |
| `usdPerCurrencyUnit` | 1.15 (UpCloud's own EUR/USD price pairs imply 1.14–1.19) |

How it works:

- **Capacity.** A cached build costs `input × (1 − hit) / prefill + output / decode`
  GPU-seconds. The KV room retains `kvCacheTokens / average context` builds,
  each for `wallMinutes`. Builds beyond that use the evicted hit rate.
- **Customer.** It follows one builder through the promotion:
  - week 1 spends the weekly top-up first, then the starter reserve;
  - nobody uses more than the allowance;
  - each week is weighted by the chance they're still building.
- **Steady-state bill.** Signups a month × lifetime tokens per signup
  (Little's law), served up to the daily cap, then rounded up to whole GPUs
  at `maxUtilisation` of the peak hour.

## 5. Cost per token

One build is **424k input + 13k output tokens = 474k weighted**: 14 turns,
a 14k first prompt growing 2.5k per turn, 900 output tokens per turn. That
matches the earlier "a few hundred thousand tokens, mostly input" estimate.
It is a model, not a measurement, and §16 measured builds at 3–9% of it: `infra/inference/build-eval` runs scripted
builds, edits and fix rounds through the box's own loop against DeepInfra
and reports the real figures per model and app size (`npm run build-eval`).

On the recommended L40S (€824/month):

| scenario | utilisation | weighted tokens/month | builds/month | € per 1M weighted |
|---|---|---|---|---|
| idle-heavy | 3% | 566M | 1.2k | 1.46 |
| light | 10% | 1.89B | 4k | 0.44 |
| moderate | 25% | 4.72B | 10k | 0.18 |
| busy | 50% | 9.43B | 20k | 0.09 |
| saturated | 70% | 13.2B | 28k | 0.06 |

The same tokens rented, on the same mix:

| model, provider | input / output per 1M | per 1M weighted |
|---|---|---|
| Qwen3.6-35B-A3B, DeepInfra | $0.10 / $0.95 | **$0.115** (≈ €0.10) |
| Qwen3.6-35B-A3B, Alibaba Model Studio (intl) | $0.375 / $2.25 | $0.395 |
| Qwen3-Coder-30B-A3B, OpenRouter (SiliconFlow) | $0.07 / $0.28 | $0.070 |
| gpt-oss-120b, Together / Fireworks / Groq | $0.15 / $0.60 | $0.150 |
| Claude Sonnet 5.5 (frontier reference) | $2 / $10 | $2.05 |

Hosted providers also discount cached input (Fireworks: gpt-oss-120b cached
input $0.015). That widens their lead on our cache-heavy builds.

## 6. Cost per new customer

The assumptions are guesses until we have data. Change them in `users`:

- **60%** of signups build with free AI at all;
- a builder makes **2.5 builds in week 1**;
- **35%** come back in week 2, and each later week keeps 85% of the
  previous week's returners;
- a returner makes 1.2 builds a week;
- the promotion lasts **12 weeks** per owner.

| behaviour | builds per signup | weighted tokens per signup | GPU cost (L40S at 70%) | same tokens rented (DeepInfra) |
|---|---|---|---|---|
| light (30% build) | 1.4 | 0.69M | €0.04 | $0.08 |
| **default** | **2.9** | **1.37M** | **€0.09** | **$0.16** |
| heavy (90% build, 60% return) | 5.8 | 2.77M | €0.17 | $0.32 |
| builds twice as big | 2.1 | 2.03M | €0.11 | $0.22 |
| uses the whole allowance | 16.9 | 8.0M | €0.50 | $0.92 |

The first 30 days are about 75% of a customer's use (1.04M of 1.37M). The
starter reserve is mostly spent in week 1.

The GPU cost column is **marginal**: the cost of the tokens if the GPU is
already paid for and busy. The real cost at launch is the fixed GPU spread
over few customers (§7).

## 7. The monthly bill

Steady state, N signups every month, today's 50M daily cap:

| signups/month | demand (weighted) | refused by daily cap | L40S GPUs | bill/month | per signup | same tokens rented |
|---|---|---|---|---|---|---|
| 100 | 137M | 0% | 1 | €829 | €8.29 | €19 |
| 1,000 | 1.37B | 0% (on average; peak days hit the cap) | 1 | €829 | €0.83 | €142 |
| 10,000 | 13.7B | **89%** | 1 | €829 | €0.08 | €157 |

With the cap lifted, 10,000 signups/month needs **4 L40S (€3,301/month,
€0.33/signup)** or **2 RTX PRO 6000 (€2,441, €0.24/signup)**, against
€1,374 rented. Sizing keeps the busiest hour (3× average) under 70%, so
average utilisation tops out near 23%.

A one-off cohort (signups arriving once, e.g. a launch spike) uses ≈ 1.04M
weighted tokens each in its first month. A cohort of 10,000 is about 10B. That
is more than a month of the 50M/day cap (1.5B), so most of them would be told
"Free building is busy today".

## 8. What the daily cap protects

Hosted per token, the 50M weighted/day cap was a **money** cap: at most
≈ $175/month on the DeepInfra price. On our own GPU the money is fixed, so the
cap protects **latency**:

- 50M/day ≈ 106 builds/day ≈ 8% of one L40S's 24 hours. One GPU easily covers it.
- The cap that just fills one L40S at peak-safe load is **≈ 145M/day (≈ 305
  builds/day)**. For an RTX PRO 6000 it is ≈ 390M, for an H100 ≈ 490M.
- Past that, vLLM queues requests. Builds slow down; nothing is refused until
  the shim's upstream times out or answers 5xx ("Free AI is busy right now").

Recommendation: when the shim points at our GPU, set
`AI_PROMO_DAILY_CAP_TOKENS` to about 80% of the measured peak-safe capacity
(start at 100M for an L40S). Add a GPU when the cap is hit on more than a
few days a month.

## 9. Scheduled stop (scale to zero)

Worth it, because a stopped GPU server bills nothing but its disk and IP
(≈ €14/month here):

- every hour off saves €1.11;
- off 8 hours a night is **€824 → €554/month (−33%)**
  (`--set onHoursPerDay=16`);
- a restart takes about 5 minutes (boot plus loading 38 GB of weights from
  disk), and builds meanwhile get "Free AI is busy right now".

So stop only during hours `/metrics` shows to be empty, with `provision.mjs
stop/start` from a cron (runbook). Starting the GPU on the first request
would need the shim to call UpCloud's API. That isn't built, and a 5-minute
first reply is a poor experience anyway.

## 10. Selling tokens

Tokens are sold as weighted tokens, the unit the allowance already uses (input × 1 + output × 4).

- **Break-even** at the 25% utilisation we price for: €0.175 ($0.20) per 1M weighted.
- **Fees:** a $1 voucher nets $0.941 after card fees (2.9% + $0.30 spread over a 10-voucher purchase).
- **Tokens per $1:** break-even is **4.7M weighted tokens per $1**; with a 50% margin, **2.3M per $1** ($0.43 per 1M).

**Recommended consumer price: $0.50 per 1M weighted tokens.** That is $0.50/M
input and $2.00/M output equivalent, **2M weighted tokens per $1 voucher, ≈ 4
app builds per $1**. At L40S utilisation:

| utilisation | our cost per 1M weighted | margin at $0.50 |
|---|---|---|
| 5% | $1.01 | −114% |
| 10% | $0.50 | −7% |
| 25% | $0.20 | +57% |
| 50% | $0.10 | +79% |

Why $0.50:

- **It covers the GPU from ~11% utilisation**, about 2B weighted tokens or
  4k builds a month. Below that the promotion's fixed cost dominates anyway.
- **It's honest against the market.** A rented price on our mix is $0.115
  for the same model from a bargain host and $0.395 from Qwen's maker
  (Alibaba), versus $2.05 for a frontier model. We're above the bargain hosts,
  near first-party, and a quarter of frontier. What the margin buys: no AI
  account or key to manage, prompts that never reach a third party, and an
  allowance that can't surprise-bill.
- **The owner can always bring their own key** (BYOK stays free), so the
  price has to stay near first-party prices, never far above them.
- **Floor:** $0.25 per 1M (4M per $1) once the GPU runs ≥ 25% busy. That still
  leaves ≈ 15% margin at 25% and ≈ 57% at 50%.

Sell vouchers in packs of $5–10, never $1 alone: on a single $1 card payment
the fixed $0.30 fee takes a third. See `docs/anonymous-vouchers.md` for the
voucher design. Payments live on `feat/marketplace`.

## 11. Risks and unknowns

- **Throughput is estimated, not measured.** Every per-token and capacity
  figure moves with it. Measure in week one and update `DEFAULTS`.
- **Prices:** UpCloud's prices are from a 2026-10-07 snapshot, and H100/B200
  pricing changes 2026-10-20. Re-check before creating anything.
- **Qwen3.6 on vLLM:** open issues for tool calls inside `<think>` (#39056),
  prefix caching with MTP (#47194, MTP is off here) and KV offloading with
  prefix caching (#49127, offloading is off here). The plain-attention
  fallback preset exists for this.
- **Context:** builds have no history compaction. A build that outgrows the
  64k context fails with a context-length error. The shim currently shows
  such 400s as "Free AI isn't available right now"; give it its own message.
- **Prefix caching across passes:** with `UPSTREAM_CACHE_SALT = "per-pass"` each pass gets its own cache
  namespace. A build's turns share one pass, but a new pass (the next reply)
  re-reads its history once.
- **Behaviour assumptions** (§6) are guesses. `ai-promo-week` /
  `ai-promo-starter` usage on `.com` will give real ones within weeks.
- **GPU quota** depends on UpCloud support. Scaleway is the fallback (§1).

## 12. RunPod, and the comparison (2026-10-14)

UpCloud's promotional credit can't pay for GPUs, so this section compares
RunPod for the same model and flags. Pod: `infra/inference/vllm/Dockerfile` +
`launch.sh`. Serverless: `infra/inference/vllm/serverless.md`.

### RunPod prices and terms

Read 2026-10-13 from RunPod's public GraphQL API, the pricing page, the docs
and the legal pages.

- **On-demand pods** ($/GPU-hour, Secure / Community):

  | GPU | Secure Cloud | Community Cloud |
  |---|---|---|
  | L40S | 1.09 | 0.79 |
  | RTX PRO 6000 96 GB | 2.49 | 1.69 |
  | RTX 6000 Ada | 0.99 | 0.74 |
  | A100 80 GB | 1.79 | 1.19–1.39 |
  | H100 PCIe | 2.89 | 1.99 |
  | H100 SXM | 3.99 | 2.69 |
  | L4 | 0.59 | secure only |

  - Billed per second; no ingress or egress fees.
  - Stopped pods bill only their volume disk ($0.20/GB-month) and can come
    back without a GPU.
  - The pricing page's embedded data shows lower Secure prices (H100 SXM
    $3.49, RTX PRO 6000 $2.09). I used the live API's numbers.
  - **Spot:** every spot price in the API is null, so it appears not to be
    sold any more.
  - **Savings plans:** 3 or 6 months prepaid, with the discount quoted by
    sales only.
- **Serverless:**
  - Flex workers cost $1.75/h for the 48 GB class (L40S / 6000 Ada), $2.72
    (A100 80 GB), $3.49 (RTX PRO 6000), $4.79 (H100). The docs' per-second
    table disagrees ($1.91/h for 48 GB).
  - Active (always-warm) worker prices aren't published.
  - Billed per second, including start-up and the idle timeout (default 5 s,
    up to 3600 s).
  - **Cold start:** RunPod measured a 32 GB FP8 model at a ~91 s median after
    tuning (network-volume cache, prefetch, trimmed CUDA graphs) versus
    ~324 s untuned (2×H200, blog 2026-08-20). For our 38 GB on one 48 GB GPU,
    expect **1.5–5 min**. The model uses 180 s.
  - FlashBoot can revive a recently stopped worker in seconds, but is reported
    unreliable at low traffic.
- **Storage:** network volume $0.07/GB-month; volume disk $0.10.
- **EU:** Secure Cloud data centres in the Netherlands (EU-NL-1: L40S, H100,
  RTX PRO 6000), Romania, Czechia, France, Sweden, Norway and Iceland.
  Serverless endpoints can be pinned to EU data centres. RunPod states GDPR
  compliance for EU regions, and its DPA (with SCCs) must be signed separately.
- **Who can see what:**
  - RunPod's proxy and Serverless gateway terminate TLS at Cloudflare/RunPod.
  - Serverless job inputs and outputs are kept until the TTL or result
    retention expires (minutes to 24 h); worker logs are kept 90 days.
  - The terms say RunPod "may, but [has] no obligation to, access, store,
    process, and use any of Your Content".
  - Secure Cloud data centres are SOC 2 / ISO 27001 vetted, and hosts are
    barred from inspecting pods by policy, not technically.
  - Community Cloud runs on third-party machines whose owners have root.
  - Pods run one image (no Docker inside) and carry TCP only, so our
    cloudflared runs inside the image over http2. With the tunnel, RunPod's
    proxy never carries our traffic.

### The table

`node infra/inference/upcloud/cost-model.mjs --compare` (rows in
`infra/inference/upcloud/cost-presets/`). The same model and assumptions as
§5–§7, today's 50M/day cap, € at 1.15 $/€. Each bill cell is "bill (per
signup)".

| option | 100 signups/mo | 1,000 signups/mo | 10,000 signups/mo | break-even utilisation vs renting | who can see prompts | EU hosting | operational effort |
|---|---|---|---|---|---|---|---|
| UpCloud L40S, always on | €829 (€8.29) | €829 (€0.83) | €829 (€0.08) | 44% | us only: TLS ends on our box; UpCloud runs the hardware | yes, Helsinki | medium: our cloud-init, tunnel, upgrades |
| UpCloud L40S, off 8 h a night | €559 (€5.59) | €559 (€0.56) | €559 (€0.06) | 44% | as above | yes | medium + stop/start cron; night builds get "busy" |
| RunPod pod, Secure Cloud L40S | €704 (€7.04) | €704 (€0.70) | €704 (€0.07) | 37% | us + the vetted data centre's operator (by policy, not technically); RunPod's proxy is bypassed by our tunnel | yes, EU-NL-1 / EUR-IS-2 | medium: our image + tunnel; a restarted pod can lose its GPU |
| RunPod pod, Community Cloud L40S | €513 (€5.13) | €513 (€0.51) | €513 (€0.05) | 27% | us + an unvetted third-party host with root | maybe | medium + host churn |
| RunPod pod, Secure Cloud RTX PRO 6000 | €1,593 (€15.93) | €1,593 (€1.59) | €1,593 (€0.16) | 31% | as Secure L40S | yes | medium |
| RunPod Serverless 48 GB, scale to zero | €165 (€1.65); worker up 14%, **86% of builds cold-start** | €876 (€0.88); up 78%, 22% cold | €913 (€0.09); up 81%, 19% cold | 59% of up-time busy | RunPod + Cloudflare (plaintext at their gateway; job data kept up to the TTL) | yes, pinned | low: worker-vllm + env vars |
| Rented API: DeepInfra Qwen3.6-35B-A3B | €19 (€0.19) | €142 (€0.14) | €157 (€0.02) | n/a (per token) | DeepInfra, a third party (prompts redacted, no identity from the shim) | not verified (US provider) | lowest: an API key in the shim |

At 10,000 signups/month the 50M/day cap refuses 89% of demand in every row,
so the bills there are capped.

With the cap lifted, 10,000 signups/month costs:

| option | per month | per signup |
|---|---|---|
| UpCloud L40S | €3,301 (4 GPUs) | €0.33 |
| RunPod Secure L40S | €2,800 | €0.28 |
| RunPod Secure RTX PRO 6000 | €3,180 | €0.32 |
| RunPod Serverless | €1,163 | €0.12 |
| DeepInfra | €1,374 | €0.14 |

Serverless follows load instead of being sized for the peak hour, which is
why it is cheapest there.

The cold-start column is the UX cost. A builder who finds no warm worker
waits **~3 minutes** for the first reply. At 100 signups a month that is
almost every build. The idle timeout must be ~300 s, or builds cold-start
between their own turns.

### Recommendation

**Launch promotion: rent per token (DeepInfra-class Qwen3.6-35B-A3B) behind
the shim.**

- It costs €19–160 a month across every volume here, against €500–830 for the
  cheapest GPU we'd run ourselves.
- No cold starts, and nothing to operate. The daily cap stays a hard money cap
  (≈ $175/month at most).
- The shim already strips identity, and the box redacts prompts before they
  leave.
- Before switching, check the provider's terms say API prompts aren't stored
  or trained on (`infra/inference/README.md`), and pick an EU-hosted provider
  if that matters. I did not verify DeepInfra's terms or regions.

**If no third party may see prompts at launch:**

- Use **UpCloud L40S** (€829, or €559 with a nightly stop). It is the only
  option where TLS ends on hardware we rent outright, in the EU, with a
  provider whose terms don't claim access to content.
- **RunPod Secure L40S** is €125 a month cheaper and works with the same
  tunnel, but its terms and the data-centre operator's root access are weaker
  guarantees.
- RunPod's promo-credit position wasn't researched. If UpCloud's GPU quota is
  refused, RunPod Secure in EU-NL-1 is the fallback.

**Not recommended:**

- **RunPod Serverless.** It exposes prompts like a hosted API, costs more
  than one at every volume, and cold-starts most builds by minutes.
- **Community Cloud.** Unvetted hosts with root.

**Later (selling tokens, or past ~8–13B weighted tokens a month, roughly
6,000+ signups a month):** move to our own GPUs.

- Run the RTX PRO 6000 or H100 class on UpCloud (€1,218 / €1,320 a month):
  cheaper than RunPod Secure for the big cards ($2.49 / $3.99 an hour), and EU.
- Keep the rented API as overflow behind the same shim when the GPUs are
  full.
- Revisit RunPod Serverless only for burst overflow, with ≥1 active worker,
  once active-worker pricing is known.

## 13. Provider shortlist (2026-10-14)

Owner decision 2026-10-14: launch free AI on the cheapest good-quality hosted
tokens. A third party may serve them, because the shim strips identity and the
box redacts prompts. The owner makes the final call.

Everything below was checked 2026-10-14 against each provider's docs and
public model APIs. Every link returned HTTP 200 that day.

**Effective price** is the cost model's price on our build mix (424k input,
13k output per build), with half of each build's input billed at the cached
price where one exists (`hostedCacheHit`, a guess), in € at 1.15 $/€.
`node infra/inference/upcloud/cost-model.mjs --compare` prints the whole
comparison, provider presets `07`–`13` in `cost-presets/`.

### Ranked shortlist (Qwen3.6-35B-A3B)

| # | provider: model id | $ / 1M in · cached · out | effective € / 1M weighted · 1,000 signups/mo | streaming tool calls · usage in stream | context | data terms | region | spend control | links |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **DeepInfra**: `Qwen/Qwen3.6-35B-A3B` (fp8) | 0.10 · 0.10 · 0.95 | **€0.100 · €142** | yes · yes (on by default) | 262k | **not stored by default**, held in memory only, no training | US only | prepaid; account and per-key spending limits; auto top-up off unless enabled | [home](https://deepinfra.com) · [pricing](https://deepinfra.com/pricing) · [model](https://deepinfra.com/Qwen/Qwen3.6-35B-A3B) · [data privacy](https://docs.deepinfra.com/account/data-privacy) |
| 2 | **OpenRouter**, zero-data-retention hosts only: `qwen/qwen3.6-35b-a3b` | 0.10 · 0.05 · 0.90 on the cheapest ZDR host (AkashML), **+5.5% credit fee** | **€0.083 · €120** | yes · always on | 262k | OpenRouter stores metadata only; with the account ZDR setting it routes only to 8 ZDR hosts | host's region (EU routing needs the Business plan) | prepaid credits; per-key credit limits | [home](https://openrouter.ai) · [model](https://openrouter.ai/qwen/qwen3.6-35b-a3b) · [pricing](https://openrouter.ai/pricing) · [ZDR](https://openrouter.ai/docs/guides/features/zdr) · [data collection](https://openrouter.ai/docs/guides/privacy/data-collection) · [your privacy settings](https://openrouter.ai/settings/privacy) |
| 3 | **Scaleway** (EU): `qwen3.6-35b-a3b` | €0.25 · none · €1.50 | €0.263 · €367 | yes · `stream_options` supported | 256k (32k out) | **zero retention by default**; requests that error or look malicious may be kept up to 2 weeks; no training | **EU, Paris** | postpaid; **no hard cap** (billing alerts only) | [home](https://www.scaleway.com/en/generative-apis/) · [pricing](https://www.scaleway.com/en/pricing/model-as-a-service/) · [data privacy](https://www.scaleway.com/en/docs/generative-apis/reference-content/data-privacy/) |
| 4 | **Parasail**: `parasail-qwen3p6-35b-a3b` | 0.15 · 0.05 · 1.00 | €0.101 · €144 | listed with tools on OpenRouter; streaming not verified in its docs | 262k | not stored, no training | US | postpaid, invoiced monthly; no cap | [home](https://www.parasail.io/) · [pricing](https://www.parasail.io/pricing) · [security & data](https://docs.parasail.io/parasail-docs/security-and-account-management/overview) |
| 5 | **Novita**: `qwen/qwen3.6-35b-a3b` | 0.248 · none · 1.485 | €0.227 · €317 | streaming not verified · yes | 262k | zero retention per its terms; no training by default | not published | prepaid | [home](https://novita.ai/) · [model](https://novita.ai/models/llm/qwen-qwen3.6-35b-a3b) · [terms (data)](https://novita.ai/legal/terms-of-service) |
| 6 | **Alibaba Cloud Model Studio** (the model's maker): `qwen3.6-35b-a3b` | 0.248 · none · 1.485 (Global scope; Singapore 0.375 / 2.25) | €0.227 · €317 | yes · yes | 262k | **kept up to 30 days**; zero retention is enterprise-only and doesn't cover this model | Frankfurt endpoint, but processing anywhere | pay-as-you-go; no budget cap | [home](https://www.alibabacloud.com/en/product/modelstudio) · [model and price](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-35b-a3b) · [data retention](https://www.alibabacloud.com/help/en/model-studio/data-retention-policy) |

Close substitute on another model (not Qwen3.6):

| provider: model id | $ / 1M in · cached · out | effective € / 1M weighted · 1,000 signups/mo | terms and caveats | links |
|---|---|---|---|---|
| **Fireworks**: `accounts/fireworks/models/gpt-oss-120b` | 0.15 · 0.015 · 0.60 | €0.078 · €112 | Cheapest per token, zero retention by default, monthly spend limit. But a different model: our prompts target Qwen's tool format, and gpt-oss's agentic scores are lower. Fireworks hosts Qwen3.6 only on dedicated GPUs. | [home](https://fireworks.ai) · [pricing](https://docs.fireworks.ai/serverless/pricing) · [data handling](https://docs.fireworks.ai/guides/security_compliance/data_handling) · [ZDR](https://docs.fireworks.ai/accounts/zero-data-retention) |

Checked and left off:

- **Together AI:** Qwen3.6 only on dedicated GPUs; stores prompts unless ZDR is switched on.
- **Groq:** no Qwen3.6; Qwen3.8-27B in preview at $0.80 / $4.00.
- **Cerebras:** no Qwen3.6; Qwen3.8-27B at $0.99 / $1.49.
- **Nebius:** no Qwen3.6; keeps data by default; region not guaranteed.
- **Mistral:** no Devstral any more. Mistral Small 4 at $0.15 / $0.60 has the only real hard spend cap, but it's a different family.
- **OVHcloud** (EU): Qwen3.6-27B at €0.40 / €2.70; no usage cap.

### How to read the ranking

1. **DeepInfra** is the simplest good choice: the exact model, the lowest
   price with first-party terms, nothing stored by default, and a real
   spending limit to back the daily cap. Two caveats:
   - it is US-only;
   - OpenRouter's monitor showed its endpoint at only 40% uptime over one day.

   The shim maps upstream 5xx/429 to "Free AI is busy right now", so outages
   are visible but safe.
2. **OpenRouter with ZDR** is ~17% cheaper on this mix, and it fails over
   across hosts, which fixes the reliability risk. Set it up like this:
   - turn on ZDR at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy). The shim drops unknown request fields, so `provider.zdr` must be the account setting, not a request field;
   - give the key a credit limit.

   Two caveats:
   - prompts pass through two companies (OpenRouter and the host);
   - which host serves a request, and so the exact price and quantisation, can
     vary. One cheap host serves 4-bit and isn't ZDR, so the ZDR setting
     excludes it.
3. **Scaleway** is the only one hosted **in the EU** with zero retention by default:
   - about 2.6× DeepInfra's price (€367 vs €142 a month at 1,000 signups);
   - no hard spend cap, so the shim's daily cap is the only ceiling.

   Choose it if EU residency matters more than price.
4. **Parasail** matches DeepInfra's price, but is postpaid with no cap, and
   its streaming support isn't documented.
5. **Novita and Alibaba** cost about 2.3× more. Alibaba keeps prompts up to 30
   days.

**Recommendation for the owner's call:**

- **Primary: DeepInfra**, with a prepaid balance and a spending limit set
  around the daily cap (≈ $175/month at 50M weighted/day).
- **Failover:** OpenRouter (ZDR) as a second shim upstream once the shim gets
  a fallback URL.
- **If EU hosting is required:** Scaleway instead.

Before going live with any provider:

- run `provision.mjs health`-style checks (one streamed tool call, a final
  usage chunk) through the shim;
- keep `UPSTREAM_CACHE_SALT` unset: hosted APIs may reject `cache_salt`.

## 14. Sources (all retrieved 2026-10-13 unless dated)

UpCloud:

- Pricing: <https://web.archive.org/web/20261007112259/https://upcloud.com/pricing/>
  (EUR, snapshot 2026-10-07) and
  <https://web.archive.org/web/20260922044355/https://upcloud.com/global/pricing/>
  (USD, 2026-09-22).
- GPU servers: <https://upcloud.com/docs/products/gpu-servers/configurations/>,
  <https://upcloud.com/docs/products/gpu-servers/availability/>,
  <https://upcloud.com/docs/products/gpu-servers/faq/> (stopped billing),
  <https://upcloud.com/docs/products/gpu-servers/spot/>,
  <https://upcloud.com/docs/changelog/2026-07-06-gpu-spot-pricing/>.
- Storage, network and templates:
  <https://upcloud.com/docs/products/block-storage/billing/>,
  <https://upcloud.com/docs/products/networking/billing/>,
  <https://upcloud.com/docs/products/networking/network-transfer/>,
  <https://upcloud.com/docs/products/block-storage/templates/>.
- Firewall and API: <https://upcloud.com/docs/products/networking/firewall/>
  (stateless), <https://developers.upcloud.com/1.3/11-firewall/>,
  <https://developers.upcloud.com/1.3/7-plans/>,
  <https://developers.upcloud.com/1.3/8-servers/>.

Models (licence, scores, configs from Hugging Face model cards and the
`/api/models` endpoint):

- <https://huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8> (commit `95a723d0…`, 2026-04),
  <https://huggingface.co/Qwen/Qwen3.8-27B-FP8>,
  <https://huggingface.co/Qwen/Qwen3.6-27B-FP8>.
- <https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8>,
  <https://huggingface.co/openai/gpt-oss-20b>,
  <https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512>,
  <https://huggingface.co/zai-org/GLM-4.7-Flash>.
- gpt-oss model card: <https://arxiv.org/abs/2508.10925>.

vLLM:

- Flags checked in the v0.30.0 and v0.31.0 source (`vllm/engine/arg_utils.py`,
  `vllm/config/cache.py`, `vllm/entrypoints/launchers/cli_args.py`,
  `vllm/entrypoints/serve/middleware/authenticate.py`).
- Images: <https://hub.docker.com/r/vllm/vllm-openai/tags> (v0.30.0 pushed
  2026-09-22).
- Issues: #39056, #47194, #49127, #44216, #58825, #44911 on
  <https://github.com/vllm-project/vllm/issues>.

Throughput:

- <https://docs.gpustack.ai/2.0/performance-lab/gpt-oss-20b/h100>
  (and `/a100`, `/gpt-oss-120b/h100`).
- DevForth gpt-oss GPU comparison (2026-02-20); Millstone AI throughput
  tables; Red Hat Developer (2025-10-06).
- <https://dgallitelli.github.io/blog/posts/qwen36-sagemaker-benchmark> (2026-04-27).

Hosted prices:

- <https://deepinfra.com/pricing>, <https://openrouter.ai/>
  (`/api/v1/models/<id>/endpoints`), <https://www.together.ai/pricing>,
  <https://docs.fireworks.ai/serverless/pricing>,
  <https://console.groq.com/docs/models>.
- <https://www.alibabacloud.com/help/en/model-studio/model-pricing>,
  <https://platform.claude.com/docs/en/about-claude/pricing>.

RunPod (2026-10-13): <https://api.runpod.io/graphql> (gpuTypes, lowestPrice,
dataCenters), <https://www.runpod.io/pricing>, <https://docs.runpod.io/pods/pricing>,
<https://docs.runpod.io/pods/storage/types>, <https://docs.runpod.io/serverless/pricing>,
<https://docs.runpod.io/serverless/endpoints/endpoint-configurations>,
<https://docs.runpod.io/serverless/endpoints/model-caching>,
<https://docs.runpod.io/pods/configuration/expose-ports>,
<https://docs.runpod.io/references/security-and-compliance>,
<https://www.runpod.io/blog/cut-vllm-cold-starts-runpod-serverless> (2026-08-20),
<https://github.com/runpod-workers/worker-vllm> (v2.29.0, 2026-10-07),
<https://www.runpod.io/legal/terms-of-service> (2026-03-24),
<https://www.runpod.io/legal/data-processing-agreement>, <https://www.runpod.io/legal/compliance>.

Cloudflare:

- <https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/>
  (beta; page updated 2026-10-12).
- Cloudflare Tunnel and Access service tokens (developers.cloudflare.com).

## 15. The model menu and its multipliers (2026-10-14)

Owner decision 2026-10-14: owners pick a Flagship Inference model per message,
and a dearer model costs more credits. The catalog is
`packages/control-plane/src/inferenceModels.ts` (typed data deployed with
`.com`, served at `GET /api/inference/models`); the multiplier is computed
there by `multiplierFor`, tested in
`packages/control-plane/tests/inferenceModels.test.ts`.

**How a multiplier is set.** A model's cost is its price on a typical build's
token mix (424k input, 13k output, §13) at its dearest upstream (DeepInfra's
list price, or the `provider.max_price` ceiling the shim gives OpenRouter, so
a fallback call can't cost more). Its multiplier is that cost over the base
model's, times a **1.25 margin**, **rounded up** to the next 0.5 (so we never
charge less than cost × margin). The base model is 1× by definition: the
allowance is budgeted on it. A model cheaper than the base is still 1×.

Credits charged for a call = (input × 1 + output × 4) × multiplier / 1,000,
rounded up to a tenth for the "used N credits" line. `.com` charges the
multiplier from its own catalog for the model the shim names; an id it
doesn't know is charged at the dearest rate.

**The lineup**, checked 2026-10-14 against DeepInfra's model API
(`/v1/openai/models`) and OpenRouter's catalog and endpoints (tool calling on
both, US hosts):

| Menu label | DeepInfra id · $/1M in · out | OpenRouter id (price ceiling) | Cost per build | × base | × 1.25 | Multiplier | Context | Images |
|---|---|---|---|---|---|---|---|---|
| Low 1× (Qwen3.6-35B-A3B) | `Qwen/Qwen3.6-35B-A3B` · 0.10 · 0.95 | `qwen/qwen3.6-35b-a3b` (0.10 / 0.95) | $0.0548 | 1.00 | — | **1×** (base) | 262k | yes |
| Medium 1× (DeepSeek-V4-Flash) | `deepseek-ai/DeepSeek-V4-Flash` · 0.09 · 0.18 | `deepseek/deepseek-v4-flash` (0.09 / 0.18) | $0.0405 | 0.74 | 0.93 | **1×** (floor) | 1M | no |
| Medium multimodal 2× (GLM-5.3-Flash) | `zai-org/GLM-5.3-Flash` · 0.15 · 0.50 | `z-ai/glm-5.3-flash` (0.15 / 0.50) | $0.0701 | 1.28 | 1.60 | **2×** | 1M | yes |
| High 3.5× (MiniMax-M3) | `MiniMaxAI/MiniMax-M3` · 0.28 · 1.10 | `minimax/minimax-m3` (0.28 / 1.10) | $0.1330 | 2.43 | 3.04 | **3.5×** | 262k (smallest host) | yes |

Notes:

- Most strong open models now take images, so only Medium is text-only; a
  screenshot sent with it prompts "I'll have to switch to Medium multimodal
  2× (GLM-5.3-Flash) for this." in the apps.
- DeepSeek-V4-Flash is cheaper than the base per build, mostly because of its
  low output price, so it is 1× too; its 1M-token context makes it the
  choice for large apps.
- Kimi-K2.6 (8.5×) and GLM-5.3 (10×) were left out: at those multipliers one
  build would use most of a month's free credits.
- "Think harder" (reasoning on) adds no multiplier; it only uses more tokens.
- Context sizes are the smallest across the hosts we may be routed to, so
  compaction (`packages/server-daemon/src/llm/contextCompaction.ts`) triggers
  early enough on either upstream.

To change the lineup: edit `INFERENCE_MODELS` (ids must exist with tool
calling on every upstream listed), update this table, run the tests, deploy
`.com`. The shim needs no change.

## 16. Measured builds (2026-10-15)

`infra/inference/build-eval` ran the box's own build loop against DeepInfra:
10 scripted apps (static page to club manager), each a first build plus 1–3
edits, once per model. 40 runs cost **$0.79**. Credits are what `.com`
charges (multiplier included); "median / worst 10%".

| Model | Apps passed | First build | One edit | App with its edits | $ per app |
|---|---|---|---|---|---|
| Low 1× (Qwen3.6-35B-A3B) | 8/10 | 34 / 199 | 41 / 444 | 117 / 751 | $0.023 |
| Medium 1× (DeepSeek-V4-Flash) | 7/10 | 38 / 99 | 27 / 53 | 103 / 179 | $0.005 |
| Medium multimodal 2× (GLM-5.3-Flash) | 5/10 | 28 / 100 | 27 / 85 | 80 / 129 | $0.005 |
| High 3.5× (MiniMax-M3) | 6/10 | 143 / 192 | 124 / 148 | 236 / 466 | $0.017 |

What it changes:

- **A first build is 14–41k weighted tokens, 3–9% of §5's 474k.** Builds
  are one or two turns, not 14: the model writes the whole app in one reply,
  and most of the input is the cached system prompt. §6–7's per-customer
  costs are roughly 10× too high.
- **Fix rounds are the expensive case.** A run that needed them used 5–25×
  the median (Low's chore tracker: 1,430 credits).
- **The allowance buys a lot.** The 2M starter covers about 17 apps with
  their edits on Low, 20 on Medium, 25 on Medium multimodal and 8 on High;
  the 500k week about a quarter of that. Spent in full, a starter costs us at
  most about $0.40 (Low is the dearest per credit) and a week $0.10.
- **Recommendation: keep 2M starter, 500k a week and the 50M daily cap.**
  Raise the week only if owners report running out mid-edit.

Failures it found, all fixed on the box (need an endorsed release):

- Qwen "called" `flagship.app.json` as a tool and waited: the chat hung
  (`55d5c50a`).
- GLM wrote descriptions over 30 characters and its fix rounds never
  shortened them: 3 builds lost (`c83316e8`).
- MiniMax writes its reasoning as visible text, hits the 8,192-token output
  cap mid-file, and the box deployed the truncated reply: 3 builds lost
  (`19e13d62` asks the model to carry on).

Still open: apps
that crash at start and that the fix loop can't repair (Low, Medium, High,
one or two each); one DeepInfra 429 on DeepSeek, which production's
OpenRouter fallback would absorb.

Limits of the measurement: one run per model and app, so each cell is a
single sample; the build check was static (no Docker on the Mac that ran
it), so crashes after start are under-counted and real fix rounds will
cost more; the scripted owner answers at once and never asks for extra
changes. Rerun with `npm run build-eval` (see its README), or with Docker
through the `build-eval` workflow.

### Thinking off (2026-10-15, evening)

Flagship Inference no longer pays for thinking: the shim strips any effort
the box asks for and sends each model's switch from the catalog
(`packages/control-plane/src/inferenceModels.ts`), and each model gets its
own output cap (16–32k) instead of the single 8,192. The same 40 runs again,
for **$0.55**, plus GLM rerun on its final setting ($0.16):

| Model | Apps passed | First build | One edit | App with its edits | $ per app |
|---|---|---|---|---|---|
| Low 1× (Qwen3.6-35B-A3B) | 6/10 | 29 / 65 | 31 / 61 | 71 / 193 | $0.013 |
| Medium 1× (DeepSeek-V4-Flash) | 5/10 (4 lost to DeepInfra 429s) | 16 / 55 | 38 / 59 | 54 / 143 | $0.003 |
| Medium multimodal 2× (GLM-5.3-Flash), no switch | 9/10 | 38 / 222 | 42 / 119 | 148 / 1,301 | $0.009 |
| High 3.5× (MiniMax-M3) | 9/10 | 75 / 228 | 101 / 195 | 312 / 407 | $0.015 |

- **High is the clear win:** 9/10 (was 6/10), its first build about half
  the credits, and no transcript shows the "Thinking Process" text any more,
  so the output cap no longer cuts a reply mid-file.
- **GLM must not be switched off.** With `enable_thinking: false` DeepInfra
  reports no reasoning tokens, but GLM writes its reasoning as visible
  reply text (about 7k tokens a reply, so nothing is saved) and then leaves
  out `flagship.app.json`: 0/9. Sent as DeepInfra serves it, GLM built 9/10
  with short replies, so the catalog sends it no switch. Its one 1,301-credit
  run (kanban, 3 fix rounds) is the fix-loop cost again.
- **Low and Medium** are about the same or cheaper; their failures are not
  thinking: four DeepInfra 429s (production falls back to OpenRouter), a
  manifest with an empty name, apps that crash at start, and Qwen asking its
  clarifying questions as plain reply text, which the box took as a finished
  turn with no manifest (open).
- The allowance decision stands: a first build is 16–38 credits at the
  median on every model.
