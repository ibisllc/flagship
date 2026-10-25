// G02–G05 hardware receipts, run only where a real GPU is: GYM_GPU_SSH=root@<host> (a box booted
// for a receipt, e.g. the owner's PC from USB with debug access; key in GYM_GPU_SSH_KEY), or
// GYM_UPCLOUD_GPU_PLAN=<plan> (+ GYM_UPCLOUD_GPU_ZONE) for an UpCloud GPU server made and deleted
// here. The base images must be digest-pinned (CUDA_DEVEL_BASE, TORCH_BASE; RENDER_BASE and
// FFMPEG_NVIDIA_BASE add the H9 graphics/video receipts). Without a GPU host every check is skipped
// with the reason, never passed.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebianVm, destroyVm, packRust, run, scp, ssh, type Vm } from "../../lib/upcloudVm.js";
import type { Group } from "../types.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const IMAGE_ENV = ["CUDA_DEVEL_BASE", "CUDA_RUNTIME_BASE", "TORCH_BASE", "RENDER_BASE", "FFMPEG_NVIDIA_BASE"];

export const gpuReal: Group = {
  name: "gpu-real",
  title: "GPU allocator: hardware receipts on a real NVIDIA GPU",
  needs: [],
  phase: 1,
  async run(ctx) {
    const { rec } = ctx;
    const target = process.env.GYM_GPU_SSH;
    const plan = process.env.GYM_UPCLOUD_GPU_PLAN;
    if (!target && !plan) {
      rec.skip("real GPU receipts", "no GPU host: set GYM_GPU_SSH=root@<host> (+ GYM_GPU_SSH_KEY) or GYM_UPCLOUD_GPU_PLAN");
      return;
    }
    const missing = ["CUDA_DEVEL_BASE", "TORCH_BASE"].filter((k) => !/@sha256:[0-9a-f]{64}$/.test(process.env[k] ?? ""));
    if (missing.length) {
      rec.skip("real GPU receipts", `pin the check images' bases first: ${missing.join(", ")} (gpu-runbooks/nvidia-cuda.md)`);
      return;
    }
    const dir = join(ctx.dir, "gpu-real");
    let vm: Vm | null = null;
    let owned = false;
    try {
      if (target) {
        const [, host] = target.split("@");
        vm = { uuid: "", ip: host ?? target, key: process.env.GYM_GPU_SSH_KEY ?? join(process.env.HOME ?? "", ".ssh/id_ed25519") };
      } else {
        vm = await createDebianVm({ dir, title: `gym-gpu-real-${Date.now().toString(36)}`, plan, zone: process.env.GYM_UPCLOUD_GPU_ZONE, log: (s) => rec.log(s) });
        owned = true;
      }
      const box = vm;
      await rec.check("upload and build flagship-gpu on the GPU host", async () => {
        const tar = join(dir, "src.tar.gz");
        await run("mkdir", ["-p", dir]);
        await packRust(REPO, tar);
        if ((await scp(box, tar, "/root/src.tar.gz")).code !== 0) throw new Error("upload failed");
        await scp(box, join(REPO, "tools/arch-drills/m7/setup-box.sh"), "/root/setup-box.sh");
        const r = await ssh(box, "M7_RUN_TESTS=1 bash /root/setup-box.sh /root/src.tar.gz 2>&1 | tail -n 20");
        if (!r.stdout.includes("cargo-test: ok")) throw new Error(r.stdout.slice(-1200));
      });
      const ready = await ssh(box, "command -v nvidia-smi && nvidia-smi -L");
      if (ready.code !== 0) {
        await rec.check("prepare the NVIDIA stack (driver, toolkit, runsc-nvproxy)", async () => {
          const r = await ssh(box, "bash /opt/flagship-m7/tools/arch-drills/m7/gpu-real.sh prepare-nvidia 2>&1 | tail -n 5; (sleep 2; reboot) &");
          await new Promise((r2) => setTimeout(r2, 120_000));
          for (let i = 0; i < 30 && (await ssh(box, "nvidia-smi -L", 20_000)).code !== 0; i++) await new Promise((r2) => setTimeout(r2, 10_000));
          return r.stdout.trim().split("\n").at(-1);
        });
      }
      const env = IMAGE_ENV.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join(" ");
      await rec.check("run the NVIDIA receipts", async () => {
        const r = await ssh(box, `${env} bash /opt/flagship-m7/tools/arch-drills/m7/gpu-real.sh qualify-nvidia /root/gpu-receipt 2>&1 | tail -n 40`, 7_200_000);
        return r.stdout.split("\n").at(-1);
      });
      const s = await ssh(box, "cat /root/gpu-receipt/summary.json");
      let rows: { name: string; ok: boolean; detail: string }[] = [];
      try {
        rows = JSON.parse(s.stdout);
      } catch {
        rows = [];
      }
      for (const row of rows) {
        await rec.check(`hw ${row.name}`, () => {
          if (!row.ok) throw new Error(row.detail || "failed");
          return row.detail.slice(0, 160);
        });
      }
      await run("scp", ["-r", "-i", box.key, "-o", "StrictHostKeyChecking=accept-new", `root@${box.ip}:/root/gpu-receipt`, dir]);
      rec.log(`receipt material in ${join(dir, "gpu-receipt")}`);
    } finally {
      if (vm && owned) await destroyVm(vm, (m) => rec.log(m));
    }
  },
};
