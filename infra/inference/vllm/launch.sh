#!/usr/bin/env bash
# vLLM for Flagship free AI on a RunPod pod: the same pinned model, flags
# and no-logging stance as the UpCloud server (../upcloud/config.json and
# cloud-init.yaml; tests/upcloud.test.ts keeps them in step).
#
# It is the ENTRYPOINT of ./Dockerfile (vLLM image + a checksummed
# cloudflared). Two ways to reach it:
#
#   TUNNEL_TOKEN set (recommended): vLLM binds 127.0.0.1 and cloudflared
#     dials out to Cloudflare. Expose NO ports on the pod. The shim reaches
#     it at the tunnel hostname behind Access, as on UpCloud.
#   TUNNEL_TOKEN unset: vLLM binds 0.0.0.0:8000 for RunPod's HTTP proxy
#     (https://<pod>-8000.proxy.runpod.net). That proxy terminates TLS on
#     RunPod's side, so RunPod's edge sees prompts in clear; VLLM_API_KEY is
#     then the only lock. Use it for a smoke test, not for users.
#
# Env: VLLM_API_KEY (required), TUNNEL_TOKEN, MAX_MODEL_LEN (65536),
# MAX_NUM_SEQS (8), GPU_MEMORY_UTILIZATION (0.92). Weights are cached on
# the pod's volume (/workspace) so a restart doesn't download 38 GB again.
set -euo pipefail

MODEL="Qwen/Qwen3.6-35B-A3B-FP8"
REVISION="95a723d08a9490559dae23d0cff1d9466213d989"
SERVED_NAME="flagship-coder"

: "${VLLM_API_KEY:?VLLM_API_KEY is required: vLLM must not answer without a key}"
export VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1 HF_HUB_DISABLE_TELEMETRY=1
export HF_HOME="${HF_HOME:-/workspace/hf}"
mkdir -p "$HF_HOME" /workspace/vllm-cache /root/.cache
ln -sfn /workspace/vllm-cache /root/.cache/vllm 2>/dev/null || true

HOST=0.0.0.0
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  HOST=127.0.0.1
  # cloudflared reads TUNNEL_TOKEN from its environment, never the process list.
  # RunPod pods carry TCP only (no UDP), so http2 rather than QUIC.
  cloudflared tunnel --no-autoupdate --protocol http2 --loglevel warn --metrics 127.0.0.1:20241 run &
fi
unset TUNNEL_TOKEN

# Request logging stays off: vLLM logs requests only with
# --enable-log-requests, which we never pass (the old --disable-log-requests
# flag is gone from current vLLM). The access log is off too.
exec vllm serve "$MODEL" \
  --revision "$REVISION" \
  --served-model-name "$SERVED_NAME" \
  --host "$HOST" \
  --port 8000 \
  --max-model-len "${MAX_MODEL_LEN:-65536}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.92}" \
  --max-num-seqs "${MAX_NUM_SEQS:-8}" \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking":false}' \
  --language-model-only \
  --disable-uvicorn-access-log
