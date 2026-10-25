"""Single-server multi-GPU training (G05): data-parallel SGD on the synthetic regression set
(the same generator as flagship-gpu training.rs), one process per GPU (torchrun), safetensors
checkpoints every K steps, resume from the newest, and a deterministic final weight file to compare
an interrupted-and-resumed run against an uninterrupted one. Pickle checkpoints are never written.

  torchrun --nproc_per_node=<gpus> train_synthetic.py --out /data/ckpt --steps 600 --every 50 [--stop-at 275]
"""
import argparse, json, os
import torch, torch.distributed as dist
from safetensors.torch import save_file, load_file

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--steps", type=int, default=600)
ap.add_argument("--every", type=int, default=50)
ap.add_argument("--stop-at", type=int, default=-1)
ap.add_argument("--features", type=int, default=64)
ap.add_argument("--samples", type=int, default=65536)
a = ap.parse_args()
dist.init_process_group("nccl")
rank, world = dist.get_rank(), dist.get_world_size()
torch.cuda.set_device(rank)
torch.use_deterministic_algorithms(True)
dev = torch.device("cuda", rank)

g = torch.Generator().manual_seed(42)
X = (torch.rand(a.samples, a.features, generator=g, dtype=torch.float64) - 0.5) * 4
truth = torch.arange(1, a.features + 1, dtype=torch.float64) * 0.5
Y = X @ truth + 0.75 + (torch.rand(a.samples, generator=g, dtype=torch.float64) - 0.5) * 0.01
w = torch.zeros(a.features, dtype=torch.float64, device=dev)
b = torch.zeros(1, dtype=torch.float64, device=dev)
start = 0
steps = sorted(d for d in os.listdir(a.out) if d.startswith("step-")) if os.path.isdir(a.out) else []
if steps:
    t = load_file(os.path.join(a.out, steps[-1], "weights.safetensors"))
    w, b, start = t["w"].to(dev), t["b"].to(dev), int(steps[-1][5:])
batch = 192 * world
for s in range(start, a.steps):
    if s == a.stop_at:
        break
    idx = (torch.arange(batch) + s * batch) % a.samples
    mine = idx[rank::world]
    x, y = X[mine].to(dev), Y[mine].to(dev)
    e = x @ w + b - y
    gw, gb = 2 * (x.T @ e), 2 * e.sum().reshape(1)
    dist.all_reduce(gw); dist.all_reduce(gb)
    w -= 0.01 * gw / batch; b -= 0.01 * gb / batch
    if (s + 1) % a.every == 0 and rank == 0:
        d = os.path.join(a.out, f"step-{s + 1:012d}")
        os.makedirs(d + ".tmp", exist_ok=True)
        save_file({"w": w.cpu().contiguous(), "b": b.cpu().contiguous()}, os.path.join(d + ".tmp", "weights.safetensors"))
        os.replace(d + ".tmp", d)
    dist.barrier()
if rank == 0:
    loss = float(((X.to(dev) @ w + b - Y.to(dev)) ** 2).mean())
    print(json.dumps({"schema": "flagship/gpu-train-report/v1", "world": world, "start": start, "loss": loss, "w0": float(w[0]), "b": float(b[0])}))
dist.destroy_process_group()
