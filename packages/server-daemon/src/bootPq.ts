/**
 * Boot unlock v2 on the box (docs/architecture-v2/pq-suites.md §19): the /boot files the
 * premount and the boot client read, and the material `.com` serves to phones.
 *
 *   /boot/flagship-boot-mldsa.key   the boot key's ML-DSA-65 seed (hex, 0600): signs v2 requests
 *   /boot/flagship-lease-kem.tpm/   the lease key's seed sealed to the TPM (bootPqTpm.ts), or
 *   /boot/flagship-lease-kem.key    the same seed in a file (software custody, no TPM)
 *   /boot/flagship-owner-pq.pub     the owner's hybrid key (account IRK), from a binding the
 *                                   device book verified under the pinned IRK
 *   /boot/flagship-unlock-policy    `strict` or `compat`, from the box's own policy replay
 *
 * The lease seed is also escrowed inside the encrypted root (`<dataDir>/boot-pq/lease-kem.key`):
 * after an approved boot whose PCRs no longer match (a kernel update, a firmware change) the box
 * reseals the same seed to the new boot chain, so leases already deposited keep working. A PCR
 * mismatch never unlocks anything by itself: the premount asks the phone.
 *
 * Nothing here holds the STK: the v3 binding is signed by keyd's `sign.hybrid`.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  bootKeyBindingToWire,
  canonicalBootKeyBindingV3,
  hybridSign,
  hybridSigKeygen,
  hybridSealKeygen,
  signBootKeyBinding,
  signBootKeyBindingV2,
  signPqKeyBinding,
  TAG_PQ_KEY_BINDING,
  type BootKeyCustody,
  type BootPqWire,
  type HybridMsgSigner,
  type MsgSigner,
} from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";
import { choosePcrs, sealToTpm, systemTpmRunner, tpmAvailable, unsealFromTpm, type TpmRunner } from "./bootPqTpm.js";

export interface BootPqPaths {
  bootPem: string;
  mldsa: string;
  leaseFile: string;
  leaseTpmDir: string;
  ownerPq: string;
  policy: string;
  escrow: string;
}

export function bootPqPaths(dataDir: string, bootDir = "/boot"): BootPqPaths {
  return {
    bootPem: `${bootDir}/flagship-boot-key.pem`,
    mldsa: `${bootDir}/flagship-boot-mldsa.key`,
    leaseFile: `${bootDir}/flagship-lease-kem.key`,
    leaseTpmDir: `${bootDir}/flagship-lease-kem.tpm`,
    ownerPq: `${bootDir}/flagship-owner-pq.pub`,
    policy: `${bootDir}/flagship-unlock-policy`,
    escrow: `${dataDir}/boot-pq/lease-kem.key`,
  };
}

const PKCS8_PREFIX = "302e020100300506032b657004220420";

/** The 32-byte Ed25519 seed of the PKCS#8 v1 PEM install-helper writes. */
export function seedFromPkcs8Pem(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(body, "base64");
  if (der.length !== 48 || der.subarray(0, 16).toString("hex") !== PKCS8_PREFIX) throw new Error("the boot key is not an Ed25519 PKCS#8 key");
  return Uint8Array.from(der.subarray(16));
}

async function readSeed(path: string): Promise<string | null> {
  const t = (await readFile(path, "utf8").catch(() => "")).trim();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

async function seedAt(path: string): Promise<string> {
  const cur = await readSeed(path);
  if (cur) return cur;
  const fresh = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFileDurable(path, `${fresh}\n`, 0o600);
  return fresh;
}

export interface CustodyResult {
  custody: BootKeyCustody;
  /** What happened this run, for the log and the server page. */
  note: string;
  pcrs?: string;
}

/**
 * Puts the lease seed where the premount reads it: sealed to the TPM when one answers and some
 * PCR is measured (resealed when the boot chain changed since), else in the software file.
 */
export async function ensureLeaseCustody(p: BootPqPaths, seedHex: string, r: TpmRunner = systemTpmRunner): Promise<CustodyResult> {
  if (await tpmAvailable(r).catch(() => false)) {
    const pcrs = await choosePcrs(r).catch(() => null);
    if (pcrs) {
      if (existsSync(p.leaseTpmDir)) {
        const held = await unsealFromTpm(p.leaseTpmDir, r).catch(() => null);
        const sel = (await readFile(`${p.leaseTpmDir}/pcrs`, "utf8").catch(() => "")).trim();
        if (held === seedHex && sel === pcrs.selection) {
          await rm(p.leaseFile, { force: true });
          return { custody: "tpm", note: "sealed to the TPM", pcrs: pcrs.selection };
        }
      }
      await sealToTpm(p.leaseTpmDir, seedHex, pcrs.selection, r);
      await rm(p.leaseFile, { force: true });
      return { custody: "tpm", note: "sealed to the TPM under the current boot chain", pcrs: pcrs.selection };
    }
  }
  await rm(p.leaseTpmDir, { recursive: true, force: true });
  if ((await readSeed(p.leaseFile)) !== seedHex) await writeFileDurable(p.leaseFile, `${seedHex}\n`, 0o600);
  return { custody: "software", note: "no TPM with a measured boot: the lease key is a file on /boot" };
}

/** The v2 material for `.com`: the boot key's own binding and the STK's hybrid signature. */
export function buildBootPqWire(args: {
  serverDomain: string;
  bootSeed: Uint8Array;
  bootMldsaSeedHex: string;
  leaseSeedHex: string;
  custody: BootKeyCustody;
  issuedAt: number;
  stkHybrid: HybridMsgSigner;
}): BootPqWire {
  const domain = args.serverDomain.toLowerCase();
  const boot = hybridSigKeygen(args.bootSeed, Buffer.from(args.bootMldsaSeedHex, "hex"));
  const bootPubHex = Buffer.from(boot.publicKey.subarray(0, 32)).toString("hex");
  const bootMldsaPubHex = Buffer.from(boot.publicKey.subarray(32)).toString("hex");
  const leaseKemPubHex = Buffer.from(hybridSealKeygen(Buffer.from(args.leaseSeedHex, "hex")).publicKey).toString("hex");
  const bootBinding = signPqKeyBinding(
    { role: "boot-key", subjectId: domain, ed25519PubHex: bootPubHex, mldsaPubHex: bootMldsaPubHex, issuedAt: args.issuedAt },
    (m) => hybridSign(boot.secretKey, TAG_PQ_KEY_BINDING, m),
  );
  boot.secretKey.fill(0);
  const statement = { serverDomain: domain, bootPubHex, bootMldsaPubHex, leaseKemPubHex, custody: args.custody, issuedAt: args.issuedAt };
  const stkSignature = Buffer.from(args.stkHybrid(canonicalBootKeyBindingV3(statement))).toString("hex");
  return { v: 1, ...statement, bootBinding, stkSignature };
}

/**
 * Makes sure /boot holds the v2 files and `.com` serves the matching material. Needs the STK's
 * hybrid signer (only once `.com` holds the STK's key binding). Idempotent: re-sends only when
 * `.com` serves no material, or material for another lease key or custody.
 */
export async function ensureBootPqMaterial(args: {
  serverDomain: string;
  stkPub: Uint8Array;
  stk: MsgSigner;
  stkHybrid: HybridMsgSigner;
  controlPlaneBaseUrl: string;
  paths: BootPqPaths;
  tpm?: TpmRunner;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}): Promise<"no-boot-key" | "ok" | "sent"> {
  const p = args.paths;
  const pem = await readFile(p.bootPem, "utf8").catch(() => null);
  if (!pem) return "no-boot-key";
  const bootSeed = seedFromPkcs8Pem(pem);
  try {
    const mldsa = await seedAt(p.mldsa);
    const lease = await seedAt(p.escrow);
    const custody = await ensureLeaseCustody(p, lease, args.tpm ?? systemTpmRunner);
    args.log?.(`[boot-pq] lease key: ${custody.note}${custody.pcrs ? ` (${custody.pcrs})` : ""}`);
    const f = args.fetch ?? fetch;
    const base = args.controlPlaneBaseUrl.replace(/\/+$/, "");
    const domain = args.serverDomain.toLowerCase();
    const url = `${base}/api/server/${encodeURIComponent(domain)}/boot-key`;
    const leasePub = Buffer.from(hybridSealKeygen(Buffer.from(lease, "hex")).publicKey).toString("hex");
    const served = await f(url, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const pq = (served as { pq?: BootPqWire } | null)?.pq;
    const bootPubHex = Buffer.from(hybridSigKeygen(bootSeed, Buffer.from(mldsa, "hex")).publicKey.subarray(0, 32)).toString("hex");
    if (pq && pq.leaseKemPubHex === leasePub && pq.custody === custody.custody && pq.bootPubHex === bootPubHex) return "ok";
    const issuedAt = (args.now ?? Date.now)();
    const binding = { serverDomain: domain, bootPubHex, issuedAt };
    const body = {
      ...bootKeyBindingToWire(binding, signBootKeyBinding(binding, args.stk), signBootKeyBindingV2(binding, args.stkHybrid)),
      pq: buildBootPqWire({ serverDomain: domain, bootSeed, bootMldsaSeedHex: mldsa, leaseSeedHex: lease, custody: custody.custody, issuedAt, stkHybrid: args.stkHybrid }),
    };
    const res = await f(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`boot v2 material refused: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return "sent";
  } finally {
    bootSeed.fill(0);
  }
}

/** Keeps the owner's hybrid key and the unlock policy on /boot equal to what the box verified. */
export async function syncBootUnlockFiles(p: BootPqPaths, s: { ownerHybridPub: Uint8Array | null; strict: boolean }): Promise<boolean> {
  if (!existsSync(p.bootPem)) return false;
  let changed = false;
  const write = async (path: string, text: string, mode: number) => {
    const cur = await readFile(path, "utf8").catch(() => null);
    if (cur === text) return;
    await writeFileDurable(path, text, mode);
    changed = true;
  };
  if (s.ownerHybridPub && s.ownerHybridPub.length === 1984) await write(p.ownerPq, `${Buffer.from(s.ownerHybridPub).toString("hex")}\n`, 0o644);
  await write(p.policy, s.strict ? "strict\n" : "compat\n", 0o644);
  return changed;
}
