/**
 * The lease key's seed sealed to the box's TPM 2.0 (docs/architecture-v2/pq-suites.md §19.4).
 * DRAFT: the PCR set is not a reviewed policy (IMPLEMENTATION-PLAN.md §7, security N10).
 *
 * The seed (hex text) is a sealed data object under the owner hierarchy's ECC P-256 primary
 * (re-created from the TPM's seed each time, the template in `PRIMARY_ARGS`). The object has no
 * usable password: its only authorization is a PCR policy over the measured boot chain, so the
 * premount (unlockPremount.ts) and the Rust boot client (rust/crates/flagship-boot/src/tpm.rs)
 * can unseal it only on this TPM with the firmware, boot loader and (where GRUB measured them)
 * kernel and initrd it was sealed under. A copy of /boot is then useless on another machine or
 * a changed boot chain. Labels stay honest: TPM keys and the TPM's own crypto are classical; the
 * disk key's PQ protection is the hybrid seal to the lease key, which the TPM only gates.
 *
 * Software fallback: no TPM, no tools, or no measured PCR leaves the seed in a 0600 file on /boot
 * (custody `software`), as before.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const PRIMARY_ARGS = ["-C", "o", "-g", "sha256", "-G", "ecc256:aes128cfb"] as const;
/** Firmware (0), option ROMs (2), boot loader and EFI images (4), Secure Boot state (7), GRUB commands (8) and the kernel and initrd GRUB loaded (9). */
export const CANDIDATE_PCRS = [0, 2, 4, 7, 8, 9] as const;

export interface TpmRunner {
  run(cmd: string, args: readonly string[], input?: string): Promise<{ code: number; stdout: Buffer; stderr: string }>;
}

export const systemTpmRunner: TpmRunner = {
  run(cmd, args, input) {
    return new Promise((ok) => {
      const p = execFile(cmd, [...args], { encoding: "buffer", timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
        ok({ code, stdout: Buffer.from(stdout ?? []), stderr: Buffer.from(stderr ?? []).toString("utf8") });
      });
      if (input !== undefined) p.stdin?.end(input);
    });
  },
};

const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

async function must(r: TpmRunner, cmd: string, args: readonly string[], input?: string): Promise<Buffer> {
  const out = await r.run(cmd, args, input);
  if (out.code !== 0) throw new Error(`${cmd} failed: ${lastLine(out.stderr) || `exit ${out.code}`}`);
  return out.stdout;
}

/** True when a TPM 2.0 answers through tpm2-tools (the device, or `TPM2TOOLS_TCTI` for swtpm). */
export async function tpmAvailable(r: TpmRunner = systemTpmRunner, exists: (p: string) => boolean = existsSync): Promise<boolean> {
  if (!process.env.TPM2TOOLS_TCTI && !exists("/dev/tpmrm0")) return false;
  const out = await r.run("tpm2_getcap", ["properties-fixed"]);
  return out.code === 0 && out.stdout.toString("utf8").includes("TPM2_PT_FAMILY_INDICATOR");
}

/** Parses `tpm2_pcrread sha256:...` output into index → lowercase hex digest. */
export function parsePcrRead(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*:\s*0x([0-9A-Fa-f]{64})\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]!.toLowerCase());
  }
  return out;
}

/**
 * The PCRs to seal under: the candidates that something measured (not all zero, not all ones).
 * Null when none is measured (no measured boot): then the TPM would protect nothing.
 */
export async function choosePcrs(r: TpmRunner = systemTpmRunner): Promise<{ selection: string; measured: number[] } | null> {
  const text = (await must(r, "tpm2_pcrread", [`sha256:${CANDIDATE_PCRS.join(",")}`])).toString("utf8");
  const vals = parsePcrRead(text);
  const measured = CANDIDATE_PCRS.filter((i) => {
    const v = vals.get(i);
    return v !== undefined && !/^0{64}$/.test(v) && !/^f{64}$/.test(v);
  });
  return measured.length > 0 ? { selection: `sha256:${measured.join(",")}`, measured: [...measured] } : null;
}

/**
 * Flush transient objects and sessions: without a resource manager (`/dev/tpm0`, swtpm's socket)
 * loaded objects stay in the TPM's few slots and the next createprimary fails.
 */
async function flush(r: TpmRunner): Promise<void> {
  await r.run("tpm2_flushcontext", ["-t"]).catch(() => undefined);
  await r.run("tpm2_flushcontext", ["-l"]).catch(() => undefined);
  await r.run("tpm2_flushcontext", ["-s"]).catch(() => undefined);
}

/** Seals `seedHex` under the current values of `selection` into `dir` (written whole, then renamed). */
export async function sealToTpm(dir: string, seedHex: string, selection: string, r: TpmRunner = systemTpmRunner): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(seedHex) || !/^sha256:\d{1,2}(,\d{1,2})*$/.test(selection)) throw new Error("bad seal input");
  const work = await mkdtemp(join(tmpdir(), "flagship-tpm-seal-"));
  const staged = `${dir}.new`;
  try {
    const primary = join(work, "primary.ctx");
    const pcrBin = join(work, "pcr.bin");
    const policy = join(work, "policy.digest");
    await must(r, "tpm2_createprimary", [...PRIMARY_ARGS, "-c", primary]);
    await must(r, "tpm2_pcrread", ["-o", pcrBin, selection]);
    await must(r, "tpm2_createpolicy", ["--policy-pcr", "-l", selection, "-f", pcrBin, "-L", policy]);
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true, mode: 0o700 });
    await must(r, "tpm2_create", [
      "-C", primary, "-g", "sha256", "-L", policy, "-a", "fixedtpm|fixedparent|noda",
      "-i", "-", "-u", join(staged, "seal.pub"), "-r", join(staged, "seal.priv"),
    ], `${seedHex}\n`);
    await writeFile(join(staged, "pcrs"), `${selection}\n`, { mode: 0o600 });
    await writeFile(join(staged, "policy.digest"), `${(await readFile(policy)).toString("hex")}\n`, { mode: 0o600 });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await rename(staged, dir);
  } finally {
    await flush(r);
    await rm(work, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
}

/** Unseals the seed (hex) from `dir`, or throws when the TPM refuses (a changed boot chain). */
export async function unsealFromTpm(dir: string, r: TpmRunner = systemTpmRunner): Promise<string> {
  const selection = (await readFile(join(dir, "pcrs"), "utf8")).trim();
  if (!/^sha256:\d{1,2}(,\d{1,2})*$/.test(selection)) throw new Error("bad pcrs file");
  const work = await mkdtemp(join(tmpdir(), "flagship-tpm-unseal-"));
  try {
    const primary = join(work, "primary.ctx");
    const obj = join(work, "seal.ctx");
    await must(r, "tpm2_createprimary", [...PRIMARY_ARGS, "-c", primary]);
    await must(r, "tpm2_load", ["-C", primary, "-u", join(dir, "seal.pub"), "-r", join(dir, "seal.priv"), "-c", obj]);
    const seed = (await must(r, "tpm2_unseal", ["-c", obj, "-p", `pcr:${selection}`])).toString("utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("the sealed seed is not 32 bytes of hex");
    return seed;
  } finally {
    await flush(r);
    await rm(work, { recursive: true, force: true });
  }
}
