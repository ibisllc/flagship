"""flagship/gpu-mlp-forward/v1: a fixed 16-32-4 MLP (weights from closed formulas, so no file is
loaded) on the GPU; numerics.rs::mlp_expected is the fixture."""
import json, sys
import torch

dev = sys.argv[1] if len(sys.argv) > 1 else "cuda"
if not torch.cuda.is_available() and dev in ("cuda", "rocm"):
    print(json.dumps({"error": "no GPU"}))
    sys.exit(1)
d = torch.device("cuda" if dev in ("cuda", "rocm") else dev)
x = torch.tensor([(j % 7) / 7.0 for j in range(16)], dtype=torch.float32, device=d)
w1 = torch.tensor([[((i * 16 + j) % 11 - 5) / 10.0 for j in range(16)] for i in range(32)], dtype=torch.float32, device=d)
b1 = torch.tensor([(i % 3 - 1) / 10.0 for i in range(32)], dtype=torch.float32, device=d)
w2 = torch.tensor([[((k * 32 + i) % 13 - 6) / 12.0 for i in range(32)] for k in range(4)], dtype=torch.float32, device=d)
b2 = torch.tensor([k / 10.0 for k in range(4)], dtype=torch.float32, device=d)
with torch.no_grad():
    h = torch.relu(w1 @ x + b1)
    out = w2 @ h + b2
print(json.dumps({"schema": "flagship/gpu-mlp-forward/v1", "device": dev, "logits": [float(v) for v in out.cpu()]}))
