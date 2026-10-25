// G01–G05 on a real machine without a GPU: a throwaway UpCloud Debian 13 VM builds flagship-gpu
// from this tree (`--locked`, the pinned toolchain), runs its whole test suite on Linux, runs the
// simulated-device matrix through flagship-gpud's own operations (`self-test`), injects a
// simulated CDI device into a real Podman container, and checks that the VM itself honestly
// reports no accelerators (H12). Never a hardware qualification: see gpuReal.ts.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebianVm, destroyVm, packRust, scp, ssh, type Vm } from "../../lib/upcloudVm.js";
import type { Group } from "../types.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface SelfTest {
  schema: string;
  passed: number;
  failed: number;
  checks: { group: string; name: string; ok: boolean; detail: string }[];
}

export const gpuSim: Group = {
  name: "gpu-sim",
  title: "GPU allocator: simulated devices on a real Debian 13 VM",
  needs: [],
  phase: 1,
  async run(ctx) {
    const { rec } = ctx;
    const dir = join(ctx.dir, "gpu-sim");
    let vm: Vm | null = null;
    try {
      await rec.check("a throwaway Debian 13 VM is up", async () => {
        vm = await createDebianVm({ dir, title: `gym-gpu-sim-${Date.now().toString(36)}`, log: (s) => rec.log(s) });
        return vm.ip;
      });
      const box = vm as Vm | null;
      if (!box) return;
      const built = await rec.check("flagship-gpu builds --locked and its tests pass on Linux", async () => {
        const tar = join(dir, "rust.tar.gz");
        await packRust(REPO, tar);
        if ((await scp(box, tar, "/root/rust.tar.gz")).code !== 0) throw new Error("upload failed");
        if ((await scp(box, join(REPO, "tools/arch-drills/m7/setup-box.sh"), "/root/setup-box.sh")).code !== 0) throw new Error("upload failed");
        const r = await ssh(box, "bash /root/setup-box.sh /root/rust.tar.gz 2>&1 | tail -n 30");
        if (r.code !== 0 || !r.stdout.includes("cargo-test: ok")) throw new Error(r.stdout.slice(-1500));
        return r.stdout.split("\n").filter((l) => l.startsWith("test result")).length + " test binaries";
      });
      if (!built) return;
      let report: SelfTest | null = null;
      await rec.check("flagship-gpud self-test runs, with Podman", async () => {
        const r = await ssh(box, "/usr/local/bin/flagship-gpud self-test --podman /usr/bin/podman");
        report = JSON.parse(r.stdout) as SelfTest;
        return `${report.passed} passed, ${report.failed} failed`;
      });
      for (const c of (report as SelfTest | null)?.checks ?? []) {
        await rec.check(`sim ${c.group}: ${c.name}`, () => {
          if (!c.ok) throw new Error(c.detail || "failed");
        });
      }
      await rec.check("an ordinary hosted VM reports no accelerators", async () => {
        const r = await ssh(box, "/usr/local/bin/flagship-gpud probe");
        const inv = JSON.parse(r.stdout) as { available: boolean; reason: string | null; catalog: { status: string } };
        if (inv.available !== false || inv.reason !== "no-accelerators") throw new Error(r.stdout.slice(0, 400));
        return `catalog ${inv.catalog.status}`;
      });
    } finally {
      const box = vm as Vm | null;
      if (box) await destroyVm(box, (s) => rec.log(s));
    }
  },
};
