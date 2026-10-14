# Flagship free-AI pod image for RunPod: the pinned vLLM image plus a
# checksummed cloudflared, started by launch.sh. Same pins as
# ../upcloud/config.json (tests keep them in step).
#
#   docker build --platform linux/amd64 -t ghcr.io/<org>/flagship-vllm:qwen3.6-v0.30.0 infra/inference/vllm
#   docker push ghcr.io/<org>/flagship-vllm:qwen3.6-v0.30.0     # then pin the pushed digest in the RunPod template
FROM vllm/vllm-openai@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90

# cloudflared 2026.9.3 (released 2026-09-24), checksum from its GitHub release.
ADD --checksum=sha256:77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2 \
    https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-amd64 \
    /usr/local/bin/cloudflared
RUN chmod 0755 /usr/local/bin/cloudflared

COPY launch.sh /usr/local/bin/flagship-launch
RUN chmod 0755 /usr/local/bin/flagship-launch
ENTRYPOINT ["/usr/local/bin/flagship-launch"]
