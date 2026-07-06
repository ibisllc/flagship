#!/usr/bin/env bash
# vLLM OpenAI-compatible server for the Flagship in-house coding model.
#
# Runs ON the RunPod GPU pod. Serves /v1/chat/completions with OpenAI-style
# tool_calls (the agentic build path needs them). The meter shim — NOT the
# public internet — is what reaches this; keep port 8000 private to the pod
# network / Cloudflare Tunnel.
#
# Verify tool-calling after boot:
#   curl -s http://localhost:8000/v1/chat/completions \
#     -H 'content-type: application/json' \
#     -d '{"model":"flagship-coder-v1","messages":[{"role":"user","content":"list the repo"}],
#          "tools":[{"type":"function","function":{"name":"read_file",
#            "description":"read","parameters":{"type":"object",
#            "properties":{"path":{"type":"string"}}}}}]}' | jq '.choices[0].message.tool_calls'
# Expect a non-null tool_calls array.
set -euo pipefail

# --- model + served name ------------------------------------------------
# The served-model-name MUST equal the `model` in .com's
# FLAGSHIP_INFERENCE_ENDPOINT. Swap the 32B for the 7B on smaller GPUs.
MODEL="${MODEL:-Qwen/Qwen2.5-Coder-32B-Instruct}"
SERVED_NAME="${SERVED_NAME:-flagship-coder-v1}"
PORT="${PORT:-8000}"
# Tensor-parallel across the pod's GPUs (1 for a single-GPU 7B pod).
TP="${TENSOR_PARALLEL:-1}"
# Context: coding agents want a large window; clamp to what the GPU holds.
MAX_LEN="${MAX_MODEL_LEN:-32768}"

exec python -m vllm.entrypoints.openai.api_server \
  --model "${MODEL}" \
  --served-model-name "${SERVED_NAME}" \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --tensor-parallel-size "${TP}" \
  --max-model-len "${MAX_LEN}" \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --disable-log-requests
  # ^ hermes parser makes Qwen2.5-Coder emit OpenAI tool_calls (+ streamed
  #   delta.tool_calls shards) that the flagship/openai adapter parses.
  # --disable-log-requests: prompts are user content; do not log them.
