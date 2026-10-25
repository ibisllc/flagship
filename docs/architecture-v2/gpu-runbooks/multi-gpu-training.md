# Single-server multi-GPU training (H7)

**Hardware (not procured):** one host with 2 or more NVIDIA GPUs on NVLink (an UpCloud GPU plan
with several cards, or a rented H100 node), qualified as in `nvidia-cuda.md`. The `gpu-real` group
can create an UpCloud GPU server: `GYM_UPCLOUD_GPU_PLAN=<plan> GYM_UPCLOUD_GPU_ZONE=<zone>`.

## Steps

1. `gpu-real.sh qualify-multi /root/gpu-receipt` records the GPU count and `nvidia-smi topo -m`;
   flagship-gpud's inventory must show the NVLink links (`topologyLinks` > 0).
2. Gang admission through flagship-gpud: claim `count: N, topology: peer-fabric` for a training app
   while another app holds one GPU of the island: the gang waits and holds **nothing** (no partial
   reservation); release the other app: the gang reserves all N at once.
3. Train: `torchrun --nproc_per_node=N tools/gpu/train/train_synthetic.py --out /data/ckpt --steps 600 --every 50`
   inside the attached container (`--device nvidia.com/gpu=<each claimed name>`). Record the final
   `w0`, `b` and loss.
4. Resume: a fresh checkpoint directory, run with `--stop-at 275` (cancellation), then run again
   without it: it resumes from step 250 and must end at the same `w0`/`b` (within 1e-9) as step 3.
5. Cancel through flagship-gpud mid-run (`gpu.release`): every gang member drains and settles.
6. Exhaustion: run with `--samples` large enough to exceed VRAM: the job fails, the devices settle,
   the box is fine. Fill the app's disk quota during checkpointing: the checkpoint write fails, the
   previous checkpoint is intact and resumable.
7. Fair competition: while the training job holds N-1 GPUs, an inference app's claim on the last
   GPU is served in its turn; with all N held, it waits in the queue (visible in
   `/api/screens/accelerators`).
8. Checkpoints are safetensors only: replace one with a `torch.save` pickle: the broker's
   checkpoint store refuses it and resumes from the previous good step.

Receipt `H7-nvidia-multi-gpu`; fill `nvidia-h100-nvlink-debian13` in the matrix.
