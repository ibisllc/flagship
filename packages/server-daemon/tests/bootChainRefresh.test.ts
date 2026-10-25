import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVED_BOOT_HOSTS,
  UNLOCK_HOOK_PATH,
  UNLOCK_PREMOUNT_PATH,
  UNSEAL_HELPER_PATH,
  WIFI_HOOK_PATH,
  WIFI_PREMOUNT_PATH,
  bootChainScripts,
  buildUnlockPremountFile,
  buildWifiPremountScript,
} from "@flagship/boot-chain";
import {
  BOOT_CHAIN_STATE_DIR,
  TRIAL_ENTRY_ID,
  TRIAL_INITRD_NAME,
  compareKernels,
  missingFromInitrd,
  parseInitrdListing,
  realBootChainSystem,
  runBootChainRefresh,
  trialKernelLine,
  type BootChainState,
  type BootChainSystem,
  type FileInfo,
  type InitrdListingEntry,
  type ToolResult,
} from "../src/bootChainRefresh.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const RELEASE = "/opt/flagship-releases/c1/app";
const KERNEL = "6.12.48+deb13-amd64";
const CMDLINE = `BOOT_IMAGE=/vmlinuz-${KERNEL} root=/dev/mapper/flagship-root ro quiet`;
const NEW_HELPER = enc.encode("\x7fELF new unseal helper");
const OLD_HELPER = enc.encode("\x7fELF old helper");
const FIXED_INITRD = ["bin/openssl", "bin/curl", "bin/xxd", "sbin/cryptsetup", "etc/ssl/certs/ca-certificates.crt", "boot/flagship-boot-key.pem", "boot/server-domain", "boot/flagship-boot-host"];

interface FakeFile {
  data: Uint8Array;
  mode: number;
  uid: number;
  mtimeMs: number;
}

/** A box in memory: files, the initramfs tools and GRUB, with knobs for each failure. */
class FakeBox implements BootChainSystem {
  files = new Map<string, FakeFile>();
  owners = new Map<string, { uid: number; mode: number }>();
  links = new Map<string, string>();
  grubenv = new Map<string, string>();
  calls: string[] = [];
  clock = 1_000_000;
  bootIdValue = "boot-1";
  cmdlineValue = CMDLINE;
  bootTime = 1_500_000;
  token = "a1b2c3d4e5f6a1b2c3d4e5f6";
  /** Paths a build leaves out of the image, per tool. */
  dropFromStage: string[] = [];
  dropFromUpdate: string[] = [];
  hookFails = false;
  updateExtra = "";
  grubWorks = true;

  constructor() {
    for (const d of ["/", "/opt", "/opt/flagship-releases", "/opt/flagship-releases/c1", RELEASE, `${RELEASE}/installer`, "/boot", "/etc", "/etc/initramfs-tools"]) {
      this.owners.set(d, { uid: 0, mode: 0o755 });
    }
    this.put(`${RELEASE}/installer/flagship-unseal`, NEW_HELPER, 0o755);
    this.put("/boot/grub/grub.cfg", enc.encode("if [ \"${next_entry}\" ] ; then\n  set default=\"${next_entry}\"\nfi\n### BEGIN /etc/grub.d/41_custom ###\nsource ${config_directory}/custom.cfg\n"), 0o444);
    this.put(`/boot/vmlinuz-${KERNEL}`, enc.encode("kernel"), 0o644);
    this.put("/etc/initramfs-tools/initramfs.conf", enc.encode("MODULES=most\n"), 0o644);
  }

  put(path: string, data: Uint8Array, mode: number, uid = 0): void {
    this.files.set(path, { data, mode, uid, mtimeMs: this.clock });
  }
  text(path: string): string | null {
    const f = this.files.get(path);
    return f ? dec.decode(f.data) : null;
  }
  mode(path: string): number | undefined {
    return this.files.get(path)?.mode;
  }

  async read(path: string) {
    return this.files.get(path)?.data ?? null;
  }
  async write(path: string, data: Uint8Array, mode: number) {
    this.clock += 1;
    this.files.set(path, { data: new Uint8Array(data), mode, uid: 0, mtimeMs: this.clock });
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async info(path: string): Promise<FileInfo | null> {
    if (this.links.has(path)) return { uid: 0, mode: 0o777, size: 0, mtimeMs: 0, kind: "symlink" };
    const f = this.files.get(path);
    if (f) return { uid: f.uid, mode: f.mode, size: f.data.length, mtimeMs: f.mtimeMs, kind: "file" };
    const o = this.owners.get(path);
    const isDir = o !== undefined || [...this.files.keys()].some((k) => k.startsWith(path === "/" ? "/" : `${path}/`));
    return isDir ? { uid: o?.uid ?? 0, mode: o?.mode ?? 0o755, size: 0, mtimeMs: 0, kind: "dir" } : null;
  }
  async realpath(path: string) {
    for (const [from, to] of this.links) if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
    if (!(await this.info(path))) throw new Error("ENOENT");
    return path;
  }
  async list(dir: string) {
    const out = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(`${dir}/`)) out.add(k.slice(dir.length + 1).split("/")[0]!);
    return [...out];
  }
  async freeBytes() {
    return 1e12;
  }
  async copyTree(from: string, to: string) {
    for (const [k, f] of [...this.files]) if (k.startsWith(`${from}/`)) this.files.set(to + k.slice(from.length), { ...f });
  }
  async removeTree(path: string) {
    for (const k of [...this.files.keys()]) if (k === path || k.startsWith(`${path}/`)) this.files.delete(k);
  }
  /** mkinitramfs: the hooks in the conf dir stage the helper from /boot; the scripts are copied. */
  image(confDir: string, drop: string[]): Uint8Array {
    const entries: Array<{ path: string; size: number; sha: string }> = [];
    const add = (path: string, data: Uint8Array) => {
      if (!drop.includes(path)) entries.push({ path, size: data.length, sha: createHash("sha256").update(data).digest("hex") });
    };
    const script = (rel: string) => this.files.get(`${confDir}/${rel}`);
    for (const rel of ["scripts/local-top/flagship-unlock", "scripts/init-premount/flagship-wifi"]) {
      const f = script(rel);
      if (f && f.mode & 0o100) add(rel, f.data);
    }
    const hook = script("hooks/flagship-unlock");
    if (hook && hook.mode & 0o100) {
      const helper = this.files.get(UNSEAL_HELPER_PATH);
      if (helper) add("usr/bin/flagship-unseal", helper.data);
      for (const p of FIXED_INITRD) add(p.startsWith("bin/") ? `usr/${p}` : p, enc.encode(p));
    }
    return enc.encode(JSON.stringify(entries));
  }
  async buildInitrd(confDir: string, out: string, kernel: string): Promise<ToolResult> {
    this.calls.push(`mkinitramfs -d ${confDir} -o ${out} ${kernel}`);
    if (this.hookFails) return { ok: true, output: "flagship-unlock hook: no CA bundle at /etc/ssl/certs/ca-certificates.crt\n" };
    await this.write(out, this.image(confDir, this.dropFromStage), 0o600);
    return { ok: true, output: "" };
  }
  async updateInitrd(kernel: string): Promise<ToolResult> {
    this.calls.push(`update-initramfs -u -k ${kernel}`);
    await this.write(`/boot/initrd.img-${kernel}`, this.image("/etc/initramfs-tools", this.dropFromUpdate), 0o644);
    if (this.updateExtra) {
      const f = this.files.get(`/boot/initrd.img-${kernel}`)!;
      f.data = enc.encode(dec.decode(f.data) + this.updateExtra);
    }
    return { ok: true, output: "update-initramfs: Generating /boot/initrd.img\n" };
  }
  async listInitrd(image: string): Promise<InitrdListingEntry[] | null> {
    const f = this.files.get(image);
    if (!f) return null;
    return (JSON.parse(dec.decode(f.data).replace(/\].*$/s, "]")) as Array<{ path: string; size: number }>).map((e) => ({ path: e.path, size: e.size, kind: "file" }));
  }
  async initrdContentDigest(image: string) {
    const f = this.files.get(image);
    return f ? createHash("sha256").update(f.data).digest("hex") : null;
  }
  async fsUuid() {
    return "0a1b2c3d-1111-2222-3333-444455556666";
  }
  async grubBootOnce(_bootDir: string, entry: string) {
    this.calls.push(`grub-reboot ${entry}`);
    if (!this.grubWorks) return false;
    this.grubenv.set("next_entry", entry);
    return true;
  }
  async grubClearOnce() {
    this.grubenv.delete("next_entry");
  }
  async toolsPresent() {
    return true;
  }
  async sync() {}
  kernelRelease() {
    return KERNEL;
  }
  async cmdline() {
    return this.cmdlineValue;
  }
  async bootId() {
    return this.bootIdValue;
  }
  async bootTimeMs() {
    return this.bootTime;
  }
  randomToken() {
    return this.token;
  }
  now() {
    return this.clock;
  }
  log() {}

  /** What the installer of an older release left: its scripts, its helper and the initrd built from them. */
  installOld(o: { premount?: string; wifi?: { ssid: string; psk: string } } = {}): void {
    const scripts = bootChainScripts({ approvedHosts: APPROVED_BOOT_HOSTS, ...(o.wifi ? { wifi: o.wifi } : {}) });
    for (const s of scripts) this.put(s.path, enc.encode(s.path === UNLOCK_PREMOUNT_PATH && o.premount !== undefined ? o.premount : s.content), s.mode);
    this.put(UNSEAL_HELPER_PATH, OLD_HELPER, 0o755);
    this.put(`/boot/initrd.img-${KERNEL}`, this.image("/etc/initramfs-tools", []), 0o644);
  }
  /** What this release's own installer leaves. */
  installCurrent(wifi?: { ssid: string; psk: string }): void {
    for (const s of bootChainScripts({ approvedHosts: APPROVED_BOOT_HOSTS, ...(wifi ? { wifi } : {}) })) this.put(s.path, enc.encode(s.content), s.mode);
    this.put(UNSEAL_HELPER_PATH, NEW_HELPER, 0o755);
    this.put(`/boot/initrd.img-${KERNEL}`, this.image("/etc/initramfs-tools", []), 0o644);
  }
  reboot(onTrial: boolean): void {
    this.bootIdValue = `boot-${this.clock}`;
    this.bootTime = this.clock + 10;
    this.clock += 100;
    this.cmdlineValue = onTrial ? `BOOT_IMAGE=/vmlinuz-${KERNEL} root=/dev/mapper/flagship-root ro quiet panic=30 flagship.bootchain=${this.token}` : CMDLINE;
  }
  state(): BootChainState {
    return JSON.parse(this.text(`${BOOT_CHAIN_STATE_DIR}/state.json`) ?? "{}") as BootChainState;
  }
}

const OLD_PREMOUNT = buildUnlockPremountFile(APPROVED_BOOT_HOSTS).replace("# Flagship pre-mount unlock", "# Flagship pre-mount unlock (an older release)");
const run = (box: FakeBox) => runBootChainRefresh(box, { releaseRoot: RELEASE });

describe("boot chain refresh", () => {
  it("does nothing when the box already has this release's pieces, and keeps a known-good copy once", async () => {
    const box = new FakeBox();
    box.installCurrent();
    const etcBefore = box.text(UNLOCK_PREMOUNT_PATH);
    expect(await run(box)).toEqual({ action: "none", reason: "current", established: true });
    expect(box.files.get(`${BOOT_CHAIN_STATE_DIR}/known-good/initrd.img-${KERNEL}`)?.data).toEqual(box.files.get(`/boot/initrd.img-${KERNEL}`)?.data);
    expect(await run(box)).toEqual({ action: "none", reason: "current" });
    expect(box.calls).toEqual([]);
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(etcBefore);
    expect(box.files.has(`/boot/${TRIAL_INITRD_NAME}`)).toBe(false);
  });

  it("leaves a box without an encrypted root alone", async () => {
    const box = new FakeBox();
    expect(await run(box)).toEqual({ action: "none", reason: "no-boot-chain" });
    expect(box.calls).toEqual([]);
  });

  it("stages a changed chain as a one-time trial, then makes it the default after the trial boots", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    const oldInitrd = box.files.get(`/boot/initrd.img-${KERNEL}`)!.data;

    const staged = await run(box);
    expect(staged).toMatchObject({ action: "staged", kernel: KERNEL });
    // Nothing the default boot uses changed.
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
    expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(OLD_HELPER);
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
    // The trial: built from a copy of the conf dir with the release's pieces and the release's helper.
    expect(box.calls[0]).toMatch(/^mkinitramfs -d \/var\/lib\/flagship-bootchain\/stage\/initramfs-tools -o \S+ 6\.12\.48\+deb13-amd64$/);
    const trial = await box.listInitrd(`/boot/${TRIAL_INITRD_NAME}`);
    expect(trial?.find((e) => e.path === "usr/bin/flagship-unseal")?.size).toBe(NEW_HELPER.length);
    expect(trial?.find((e) => e.path === "scripts/local-top/flagship-unlock")?.size).toBe(enc.encode(buildUnlockPremountFile()).length);
    const cfg = box.text("/boot/grub/custom.cfg")!;
    expect(cfg).toContain(`--id ${TRIAL_ENTRY_ID}`);
    expect(cfg).toContain(`linux /vmlinuz-${KERNEL} root=/dev/mapper/flagship-root ro quiet panic=30 flagship.bootchain=${box.token}`);
    expect(cfg).toContain(`initrd /${TRIAL_INITRD_NAME}`);
    expect(cfg).toContain("search --no-floppy --fs-uuid --set=root 0a1b2c3d-1111-2222-3333-444455556666");
    expect(box.grubenv.get("next_entry")).toBe(TRIAL_ENTRY_ID);
    expect(box.state().journal).toBeUndefined();
    expect([...box.files.keys()].some((k) => k.includes("/stage/"))).toBe(false);

    // Same boot: waiting for the restart.
    expect(await run(box)).toEqual({ action: "none", reason: "trial-pending" });

    box.reboot(true);
    box.grubenv.delete("next_entry");
    const promoted = await run(box);
    expect(promoted).toMatchObject({ action: "refreshed", kernel: KERNEL });
    for (const s of bootChainScripts({ approvedHosts: APPROVED_BOOT_HOSTS })) {
      expect(box.text(s.path)).toBe(s.content);
      expect(box.mode(s.path)).toBe(0o755);
    }
    expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(NEW_HELPER);
    expect(box.mode(UNSEAL_HELPER_PATH)).toBe(0o755);
    expect(box.calls).toContain(`update-initramfs -u -k ${KERNEL}`);
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(box.image("/etc/initramfs-tools", []));
    expect(box.files.get(`${BOOT_CHAIN_STATE_DIR}/known-good/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
    expect(box.files.has(`/boot/${TRIAL_INITRD_NAME}`)).toBe(false);
    expect(box.files.has("/boot/grub/custom.cfg")).toBe(false);
    expect(box.state().trial).toBeUndefined();

    // The next ordinary boot: current, and the new default becomes the known-good copy.
    box.reboot(false);
    expect(await run(box)).toEqual({ action: "none", reason: "current", established: true });
    expect(box.files.get(`${BOOT_CHAIN_STATE_DIR}/known-good/initrd.img-${KERNEL}`)!.data).toEqual(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data);
  });

  it("drops a trial the box did not come up on, and does not try that release again", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    const oldInitrd = box.files.get(`/boot/initrd.img-${KERNEL}`)!.data;
    expect((await run(box)).action).toBe("staged");
    box.reboot(false);
    const r = await run(box);
    expect(r).toMatchObject({ action: "rolled-back", reason: "trial-boot-failed" });
    expect(box.files.has(`/boot/${TRIAL_INITRD_NAME}`)).toBe(false);
    expect(box.files.has("/boot/grub/custom.cfg")).toBe(false);
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
    expect(await run(box)).toEqual({ action: "none", reason: "failed-before" });
    expect(box.calls.filter((c) => c.startsWith("mkinitramfs"))).toHaveLength(1);
  });

  it("keeps the old pieces when the built initrd fails its check", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    box.dropFromStage = ["usr/bin/flagship-unseal"];
    const r = await run(box);
    expect(r).toMatchObject({ action: "rolled-back", reason: "verify-failed" });
    expect(r.action === "rolled-back" && r.detail).toContain("no bin/flagship-unseal");
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
    expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(OLD_HELPER);
    expect(box.files.has(`/boot/${TRIAL_INITRD_NAME}`)).toBe(false);
    expect(box.grubenv.has("next_entry")).toBe(false);
    expect(await run(box)).toEqual({ action: "none", reason: "failed-before" });
  });

  it("keeps the old pieces when the unlock hook refuses the build", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    box.hookFails = true;
    const r = await run(box);
    expect(r).toMatchObject({ action: "rolled-back", reason: "build-failed" });
    expect(r.action === "rolled-back" && r.detail).toContain("no CA bundle");
    expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(OLD_HELPER);
  });

  it("puts the old files and the known-good initrd back when the rebuilt default fails its check", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    const oldInitrd = box.files.get(`/boot/initrd.img-${KERNEL}`)!.data;
    box.put(UNLOCK_HOOK_PATH, box.files.get(UNLOCK_HOOK_PATH)!.data, 0o700);
    box.put("/var/lib/initramfs-tools/" + KERNEL, enc.encode("sha1  /boot/initrd.img\n"), 0o644);
    expect((await run(box)).action).toBe("staged");
    box.reboot(true);
    box.dropFromUpdate = ["scripts/local-top/flagship-unlock"];
    const r = await run(box);
    expect(r).toMatchObject({ action: "rolled-back", reason: "promote-verify-failed" });
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
    expect(box.mode(UNLOCK_HOOK_PATH)).toBe(0o700);
    expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(OLD_HELPER);
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
    expect(box.text("/var/lib/initramfs-tools/" + KERNEL)).toBe("sha1  /boot/initrd.img\n");
    expect(box.files.has(`/boot/${TRIAL_INITRD_NAME}`)).toBe(false);
    expect(box.state().journal).toBeUndefined();
  });

  it("refuses a default rebuild that differs from the trial that booted", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    const oldInitrd = box.files.get(`/boot/initrd.img-${KERNEL}`)!.data;
    expect((await run(box)).action).toBe("staged");
    box.reboot(true);
    box.updateExtra = "drift";
    expect(await run(box)).toMatchObject({ action: "rolled-back", reason: "promote-differs" });
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
  });

  it("reports a promotion that throws, with everything put back", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    const oldInitrd = box.files.get(`/boot/initrd.img-${KERNEL}`)!.data;
    expect((await run(box)).action).toBe("staged");
    box.reboot(true);
    box.updateInitrd = async () => {
      throw new Error("update-initramfs was killed");
    };
    expect(await run(box)).toMatchObject({ action: "rolled-back", reason: "promote-failed" });
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
    expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(OLD_HELPER);
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
  });

  it("undoes a promotion the power cut short, on the next run", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    const oldInitrd = box.files.get(`/boot/initrd.img-${KERNEL}`)!.data;
    box.put(UNLOCK_PREMOUNT_PATH, enc.encode("half written"), 0o755);
    box.put(`/boot/initrd.img-${KERNEL}`, enc.encode("torn"), 0o644);
    box.put("/var/lib/initramfs-tools/x", enc.encode("new"), 0o644);
    box.put(`${BOOT_CHAIN_STATE_DIR}/backup/0`, enc.encode(OLD_PREMOUNT), 0o600);
    box.put(`${BOOT_CHAIN_STATE_DIR}/backup/1`, oldInitrd, 0o600);
    const journal: BootChainState["journal"] = {
      phase: "promoting",
      backups: [
        { path: UNLOCK_PREMOUNT_PATH, saved: `${BOOT_CHAIN_STATE_DIR}/backup/0`, mode: 0o755 },
        { path: `/boot/initrd.img-${KERNEL}`, saved: `${BOOT_CHAIN_STATE_DIR}/backup/1`, mode: 0o644 },
        { path: "/var/lib/initramfs-tools/x", saved: null, mode: 0 },
      ],
    };
    box.put(`${BOOT_CHAIN_STATE_DIR}/state.json`, enc.encode(JSON.stringify({ v: 1, journal } satisfies BootChainState)), 0o600);
    await run(box);
    expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
    expect(box.files.get(`/boot/initrd.img-${KERNEL}`)!.data).toEqual(oldInitrd);
    expect(box.files.has("/var/lib/initramfs-tools/x")).toBe(false);
    expect(box.files.has(`${BOOT_CHAIN_STATE_DIR}/backup/0`)).toBe(false);
    expect(box.state().journal).toBeUndefined();
  });

  it("refuses a helper the daemon could have written, and changes nothing", async () => {
    for (const tamper of [
      (b: FakeBox) => b.put(`${RELEASE}/installer/flagship-unseal`, NEW_HELPER, 0o755, 1001),
      (b: FakeBox) => b.put(`${RELEASE}/installer/flagship-unseal`, NEW_HELPER, 0o757),
      (b: FakeBox) => b.owners.set(`${RELEASE}/installer`, { uid: 1001, mode: 0o755 }),
      (b: FakeBox) => b.owners.set("/opt/flagship-releases", { uid: 0, mode: 0o777 }),
      (b: FakeBox) => {
        b.owners.set("/var/flagship", { uid: 1001, mode: 0o700 });
        b.put("/var/flagship/flagship-unseal", NEW_HELPER, 0o755, 1001);
        b.files.delete(`${RELEASE}/installer/flagship-unseal`);
        b.links.set(`${RELEASE}/installer/flagship-unseal`, "/var/flagship/flagship-unseal");
      },
    ]) {
      const box = new FakeBox();
      box.installOld({ premount: OLD_PREMOUNT });
      tamper(box);
      const r = await run(box);
      expect(r).toMatchObject({ action: "rolled-back", reason: "untrusted-source" });
      expect(box.calls).toEqual([]);
      expect(box.text(UNLOCK_PREMOUNT_PATH)).toBe(OLD_PREMOUNT);
      expect(box.files.get(UNSEAL_HELPER_PATH)!.data).toEqual(OLD_HELPER);
      expect(await run(box)).toEqual({ action: "none", reason: "failed-before" });
    }
  });

  it("refuses installed scripts that are not root's own", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    box.put(UNLOCK_PREMOUNT_PATH, enc.encode(OLD_PREMOUNT), 0o755, 1001);
    expect(await run(box)).toMatchObject({ action: "rolled-back", reason: "untrusted-source" });
    expect(box.calls).toEqual([]);
  });

  it("keeps the hosts and Wi-Fi the box was installed with", async () => {
    const wifi = { ssid: "Café O'Brien", psk: "pa ss'w\"ord $(reboot)" };
    const box = new FakeBox();
    const extra = [...APPROVED_BOOT_HOSTS, "boot.acme-enterprise.example"];
    for (const s of bootChainScripts({ approvedHosts: extra, wifi })) box.put(s.path, enc.encode(s.content), s.mode);
    box.put(UNSEAL_HELPER_PATH, NEW_HELPER, 0o755);
    box.put(`/boot/initrd.img-${KERNEL}`, enc.encode("[]"), 0o644);
    expect(await run(box)).toMatchObject({ action: "none", reason: "current" });
    expect(box.text(WIFI_PREMOUNT_PATH)).toBe(buildWifiPremountScript(wifi.ssid, wifi.psk));
    expect(box.files.has(WIFI_HOOK_PATH)).toBe(true);
  });

  it("does not stage while a newer kernel waits for a restart", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    box.put("/boot/vmlinuz-6.12.50+deb13-amd64", enc.encode("k"), 0o644);
    expect(await run(box)).toEqual({ action: "none", reason: "deferred", detail: "newer-kernel" });
    expect(box.calls).toEqual([]);
  });

  it("does not touch a GRUB custom.cfg someone else wrote", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    box.put("/boot/grub/custom.cfg", enc.encode("menuentry 'mine' {}\n"), 0o644);
    expect(await run(box)).toMatchObject({ action: "rolled-back", reason: "grub-custom-in-use" });
    expect(box.text("/boot/grub/custom.cfg")).toBe("menuentry 'mine' {}\n");
    expect(box.calls).toEqual([]);
  });

  it("drops the trial when GRUB won't take the one-time entry", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    box.grubWorks = false;
    expect(await run(box)).toMatchObject({ action: "rolled-back", reason: "grub-failed" });
    expect(box.files.has(`/boot/${TRIAL_INITRD_NAME}`)).toBe(false);
    expect(box.files.has("/boot/grub/custom.cfg")).toBe(false);
  });

  it("replaces a waiting trial when a newer release arrives before the restart", async () => {
    const box = new FakeBox();
    box.installOld({ premount: OLD_PREMOUNT });
    expect((await run(box)).action).toBe("staged");
    const first = box.state().trial!.digest;
    box.put(`${RELEASE}/installer/flagship-unseal`, enc.encode("\x7fELF newer still"), 0o755);
    box.token = "ffffffffffffffffffffffff";
    expect(await run(box)).toMatchObject({ action: "staged" });
    expect(box.state().trial!.digest).not.toBe(first);
    expect(box.text("/boot/grub/custom.cfg")).toContain("flagship.bootchain=ffffffffffffffffffffffff");
  });
});

describe("boot chain helpers", () => {
  it("reads lsinitramfs -l listings, merged-/usr paths included", () => {
    const listing = parseInitrdListing(
      [
        "Image: /boot/initrd.img-6.12.48+deb13-amd64",
        "-rwxr-xr-x   1 root     root        12052 Oct 25 12:00 scripts/local-top/flagship-unlock",
        "lrwxrwxrwx   1 root     root            7 Oct 25 12:00 bin -> usr/bin",
        "-rwxr-xr-x   1 root     root      2515968 Oct 25  2026 usr/bin/flagship-unseal",
        "drwxr-xr-x   2 root     root            0 Oct 25 12:00 etc/ssl/certs",
        "-rw-r--r--   1 root     root       219342 Oct 25 12:00 ./etc/ssl/certs/ca-certificates.crt",
      ].join("\n"),
    );
    expect(listing).toEqual([
      { path: "scripts/local-top/flagship-unlock", size: 12052, kind: "file" },
      { path: "bin", size: 7, kind: "symlink" },
      { path: "usr/bin/flagship-unseal", size: 2515968, kind: "file" },
      { path: "etc/ssl/certs", size: 0, kind: "dir" },
      { path: "etc/ssl/certs/ca-certificates.crt", size: 219342, kind: "file" },
    ]);
    expect(missingFromInitrd(listing, [{ path: "bin/flagship-unseal", size: 2515968 }, { path: "etc/ssl/certs/ca-certificates.crt" }])).toEqual([]);
    expect(missingFromInitrd(listing, [{ path: "scripts/local-top/flagship-unlock", size: 12053 }, { path: "bin/curl" }])).toEqual([
      "scripts/local-top/flagship-unlock is 12052 bytes, not 12053",
      "no bin/curl",
    ]);
  });

  it("repeats the running command line for the trial, quoted for GRUB, and refuses what it can't carry", () => {
    expect(trialKernelLine("BOOT_IMAGE=(hd0,gpt2)/vmlinuz-6.12 root=UUID=ab-cd ro quiet panic=5 flagship.bootchain=old", "tok")).toEqual({
      kernelPath: "/vmlinuz-6.12",
      args: ["root=UUID=ab-cd", "ro", "quiet", "panic=30", "flagship.bootchain=tok"],
    });
    expect(trialKernelLine("BOOT_IMAGE=/boot/vmlinuz-6.12 root=/dev/sda1 console=tty0;reboot", "t")?.args).toEqual(["root=/dev/sda1", "'console=tty0;reboot'", "panic=30", "flagship.bootchain=t"]);
    expect(trialKernelLine("root=/dev/sda1 ro", "t")).toBeNull();
    expect(trialKernelLine("BOOT_IMAGE=/vmlinuz-6.12 x='y'", "t")).toBeNull();
  });

  it("orders kernel releases by their numbers", () => {
    expect(["6.12.9+deb13-amd64", "6.12.10+deb13-amd64", "6.1.0-28-amd64"].sort(compareKernels)).toEqual(["6.1.0-28-amd64", "6.12.9+deb13-amd64", "6.12.10+deb13-amd64"]);
  });
});

describe("the real writer", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("sets exact modes under the daemon's 0077 umask", async () => {
    dir = await mkdtemp(join(tmpdir(), "bootchain-"));
    const old = process.umask(0o077);
    try {
      const sys = realBootChainSystem(() => {});
      await sys.write(join(dir, "hooks", "flagship-unlock"), enc.encode("#!/bin/sh\n"), 0o755);
      await sys.write(join(dir, "state.json"), enc.encode("{}"), 0o600);
      await sys.write(join(dir, "initrd"), enc.encode("x"), 0o644);
      expect((await stat(join(dir, "hooks", "flagship-unlock"))).mode & 0o7777).toBe(0o755);
      expect((await stat(join(dir, "state.json"))).mode & 0o7777).toBe(0o600);
      expect((await stat(join(dir, "initrd"))).mode & 0o7777).toBe(0o644);
      expect((await sys.info(join(dir, "hooks", "flagship-unlock")))?.mode).toBe(0o755);
    } finally {
      process.umask(old);
    }
  });
});
