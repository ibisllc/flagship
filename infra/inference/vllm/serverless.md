# RunPod Serverless (vLLM worker) variant

For bursty free-tier traffic, RunPod **Serverless** scales to zero between
requests (cheaper than an always-on pod) at the cost of cold starts.

Use the official **`runpod/worker-vllm`** endpoint template:

1. Create a Serverless endpoint from the vLLM worker template.
2. Set the environment on the endpoint:
   - `MODEL_NAME=Qwen/Qwen2.5-Coder-32B-Instruct` (or the 7B)
   - `SERVED_MODEL_NAME=flagship-coder-v1`
   - `MAX_MODEL_LEN=32768`
   - `ENABLE_AUTO_TOOL_CHOICE=1`
   - `TOOL_CALL_PARSER=hermes`
   - `DISABLE_LOG_REQUESTS=1`
3. Pick a GPU tier that fits the model (H100/A100 80GB for 32B; A10G/L4 for
   7B) and set max workers to your budget ceiling.

The worker exposes an **OpenAI-compatible route**:
`https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1/chat/completions`, auth'd
with a RunPod API key. Point the shim's `VLLM_UPSTREAM` at
`https://api.runpod.ai/v2/<ENDPOINT_ID>/openai` and put the RunPod API key
in the shim secret `VLLM_UPSTREAM_KEY` (the shim adds it as the upstream
`Authorization` — the box never sees it).

Cold-start note: the first request after scale-to-zero can take tens of
seconds while the model loads. The daemon's provider call has no hard
timeout on the agentic path, but consider a min-worker of 1 during launch
to avoid a poor first-token experience.
