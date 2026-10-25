# GPU check workloads

The workloads the hardware runbooks (`docs/architecture-v2/gpu-runbooks/`) run on a real device
under the qualified isolation profile. Each prints one JSON report on stdout that
`flagship-gpu` checks (`numerics.rs`, `scrub.rs`, `media.rs`): a device passes when the report
matches, never because a tool answered. Build each image from its `Containerfile` with the base
image pinned by digest (`--build-arg BASE=<name>@sha256:<digest>`), and record the resulting image
digest in the catalog entry (`images`, purposes `vector-add`, `torch-check`, `scrub`,
`render-check`, `video-check`).

| Directory | Report | Checked by |
|---|---|---|
| `vector-add/` | `flagship/gpu-vector-add/v1` (CUDA; `vector_add.hip.cpp` for ROCm, `vector_add.sycl.cpp` for Level Zero) | `numerics::verify_vector_add` |
| `torch-check/` | `flagship/gpu-mlp-forward/v1` | `numerics::verify_mlp` |
| `scrub/` | `flagship/gpu-scrub-report/v1`; `canary` mode writes residue canaries for qualification | `scrub::judge` |
| `render-check/` | a P6 PPM of `flagship-test-scene/v1` (EGL, headless) | `flagship-gpud verify-render` |
| `video-check/` | raw YUV 4:2:0 of `flagship-test-clip/v1` after encode+decode | `flagship-gpud verify-transcode` |
| `train/` | safetensors checkpoints of a synthetic regression, multi-GPU (DDP) | resume equality, runbook |
