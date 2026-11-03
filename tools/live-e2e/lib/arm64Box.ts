// Pure pieces of the arm64 gym box lane (lanes/arm64-box.ts): which gym release lists an arm64
// artifact, the QEMU command line for a Debian arm64 guest under HVF, and the NoCloud seed files.

export interface ReleaseIndex {
  releases?: Array<{ commit?: unknown; sequence?: unknown; arch?: unknown }>;
}

/** Whether the gym's releases.json lists `commit` with an artifact for `arch`. */
export function releaseListsArch(index: ReleaseIndex | null | undefined, commit: string, arch: "amd64" | "arm64"): boolean {
  const e = (index?.releases ?? []).find((r) => r.commit === commit);
  return !!e && Array.isArray(e.arch) && e.arch.includes(arch);
}

export interface QemuPaths {
  firmwareCode: string;
  firmwareVars: string;
  disk: string;
  seed: string;
  console: string;
  monitor: string;
  pidFile: string;
}

/**
 * qemu-system-aarch64 for a Debian 13 arm64 box on an Apple Silicon Mac: HVF, the virt machine,
 * UEFI, virtio disk + NoCloud seed, user-mode NAT (the box only dials out: relay, .com, artifacts),
 * SSH forwarded to loopback for diagnosis only.
 */
export function qemuArgs(p: QemuPaths, o: { cpus: number; memoryMiB: number; sshPort: number; accel?: "hvf" | "tcg" }): string[] {
  const accel = o.accel ?? "hvf";
  return [
    "-M", "virt",
    "-accel", accel,
    "-cpu", accel === "hvf" ? "host" : "max",
    "-smp", String(o.cpus),
    "-m", String(o.memoryMiB),
    "-drive", `if=pflash,format=raw,readonly=on,file=${p.firmwareCode}`,
    "-drive", `if=pflash,format=raw,file=${p.firmwareVars}`,
    "-drive", `file=${p.disk},if=virtio,format=qcow2`,
    "-drive", `file=${p.seed},if=virtio,format=raw,readonly=on`,
    "-nic", `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${o.sshPort}-:22`,
    "-display", "none",
    "-serial", `file:${p.console}`,
    "-monitor", `unix:${p.monitor},server,nowait`,
    "-daemonize",
    "-pidfile", p.pidFile,
  ];
}

/** NoCloud meta-data for the guest (instance id changes per run, so cloud-init runs the user-data). */
export function noCloudMetaData(instanceId: string, hostname = "flagship-pod"): string {
  if (!/^[A-Za-z0-9-]{1,63}$/.test(instanceId)) throw new Error("bad instance id");
  return `instance-id: ${instanceId}\nlocal-hostname: ${hostname}\n`;
}
