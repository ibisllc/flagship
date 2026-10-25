/**
 * Milestone 6 drill (docs/architecture-v2/drills/m6-upcloud.md), run as root on a throwaway Debian
 * 13 VM laid out by setup-box.sh:
 *
 *   npx tsx tools/arch-drills/m6/drill.ts before-reboot     # unlocks, refusals, TPM, PCR mismatch
 *   (reboot the VM)
 *   npx tsx tools/arch-drills/m6/drill.ts after-reboot      # the TPM-held lease key after a reboot
 *
 * Real: the generated premount (/bin/sh), the Go unseal helper and the Rust flagship-boot as its
 * drop-in, cryptsetup on a LUKS2 loop volume, curl over TLS, tpm2-tools against swtpm, the box's own
 * bootPq.ts sealing, and the boot worker router (packages/boot-core) behind a local HTTPS server.
 * The phone is scripted with the protocol's own TS code (verifyBootPq, verifySecretRequestV2,
 * buildBootReplyV2, sealLeaseV3): the same checks and seals the iOS/Android ports run. Stubbed:
 * curl's DNS (--connect-to the local worker), `mount` of the FLAGSHIP_BOOT label (the drill's /boot
 * is a directory), and `reboot`.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildAutoUnlockLeaseV2,
  buildBootReplyV2,
  buildSealedSecretResponse,
  hybridSign,
  hybridSigKeygen,
  sealLeaseV3,
  signAutoUnlockLeaseV2,
  signPqKeyBinding,
  TAG_PQ_KEY_BINDING,
  verifyBootPq,
  verifyPqKeyBinding,
  verifySecretRequest,
  verifySecretRequestV2,
  type BootPqWire,
} from "@flagship/protocol";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemoryPqTrustStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { InMemoryNonceStore, routeBoot, type BootRouteDeps, type DirectoryClient } from "@flagship/boot-core";
import { buildUnlockPremountScript } from "../../../packages/boot-chain/src/unlockPremount.js";
import { bootPqPaths, buildBootPqWire, ensureLeaseCustody } from "../../../packages/server-daemon/src/bootPq.js";

const W = "/var/lib/flagship-m6";
// swtpm behind the kernel vTPM proxy: the box sees /dev/tpmrm0 (with the kernel resource manager), as on metal.
const TCTI = "device:/dev/tpmrm0";
const DOMAIN = "home.drill.flagship.services";
const CRYPT = "m6_crypt";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const results: Array<{ phase: string; name: string; ok: boolean; detail?: string }> = [];
let phase = "";
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ phase, name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${phase}: ${name}${detail ? ` (${detail})` : ""}`);
}

// ── long-lived drill state (on disk, so it survives the reboot) ─────────────────────────────
interface State {
  stkEd: string; stkMl: string; bootEd: string; bootMl: string; ownerEd: string; ownerMl: string;
  diskKey: string; loop?: string;
}
function state(): State {
  const f = join(W, "state.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as State;
  const r = () => hex(randomBytes(32));
  const s: State = { stkEd: r(), stkMl: r(), bootEd: r(), bootMl: r(), ownerEd: r(), ownerMl: r(), diskKey: hex(randomBytes(64)) };
  mkdirSync(W, { recursive: true });
  writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
  return s;
}
const S = state();
const stk = hybridSigKeygen(unhex(S.stkEd), unhex(S.stkMl));
const boot = hybridSigKeygen(unhex(S.bootEd), unhex(S.bootMl));
const owner = hybridSigKeygen(unhex(S.ownerEd), unhex(S.ownerMl));
const stkPub = hex(stk.publicKey.subarray(0, 32));
const bootPub = hex(boot.publicKey.subarray(0, 32));
const ownerPub = hex(owner.publicKey.subarray(0, 32));
const DISK_KEY = unhex(S.diskKey);

// ── the LUKS2 volume: a loop file with a marker file inside ────────────────────────────────
function ensureVolume(): void {
  const img = join(W, "disk.img");
  const keyFile = join(W, "disk.key.tmp");
  if (!existsSync(img)) {
    sh("truncate", ["-s", "64M", img]);
    writeFileSync(keyFile, DISK_KEY, { mode: 0o600 });
    sh("cryptsetup", ["luksFormat", "--type", "luks2", "--batch-mode", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", keyFile, img]);
    sh("cryptsetup", ["open", "--key-file", keyFile, img, CRYPT]);
    sh("mkfs.ext4", ["-q", `/dev/mapper/${CRYPT}`]);
    mkdirSync(join(W, "mnt"), { recursive: true });
    sh("mount", [`/dev/mapper/${CRYPT}`, join(W, "mnt")]);
    writeFileSync(join(W, "mnt", "marker"), "the owner's data\n");
    sh("umount", [join(W, "mnt")]);
    sh("cryptsetup", ["close", CRYPT]);
    rmSync(keyFile);
  }
  const attached = sh("losetup", ["-j", img]).trim();
  if (!attached) sh("losetup", ["-f", img]);
  const dev = sh("losetup", ["-j", img]).split(":")[0]!;
  S.loop = dev;
}
function closeVolume(): void {
  try {
    sh("cryptsetup", ["close", CRYPT]);
  } catch {
    /* not open */
  }
}
function opened(): boolean {
  if (!existsSync(`/dev/mapper/${CRYPT}`)) return false;
  mkdirSync(join(W, "mnt"), { recursive: true });
  sh("mount", ["-o", "ro", `/dev/mapper/${CRYPT}`, join(W, "mnt")]);
  const ok = readFileSync(join(W, "mnt", "marker"), "utf8") === "the owner's data\n";
  sh("umount", [join(W, "mnt")]);
  return ok;
}

// ── the box: /boot as the premount reads it, the v2 material the daemon makes ──────────────
const pkcs8 = (seed: Uint8Array) =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]).toString("base64")}\n-----END PRIVATE KEY-----\n`;
const stkBindingWire = signPqKeyBinding(
  { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: stkPub, mldsaPubHex: hex(stk.publicKey.subarray(32)), issuedAt: 1 },
  (m) => hybridSign(stk.secretKey, TAG_PQ_KEY_BINDING, m),
);
const ownerBindingWire = signPqKeyBinding(
  { role: "account-irk", subjectId: "drill", ed25519PubHex: ownerPub, mldsaPubHex: hex(owner.publicKey.subarray(32)), issuedAt: 1 },
  (m) => hybridSign(owner.secretKey, TAG_PQ_KEY_BINDING, m),
);

/** The daemon's side: seal the lease key (TPM when it answers), build the v3 material. */
async function boxMaterial(R: string): Promise<{ wire: BootPqWire; custody: string; note: string }> {
  process.env.TPM2TOOLS_TCTI = TCTI;
  const p = bootPqPaths(join(W, "data"), join(R, "boot"));
  mkdirSync(join(W, "data", "boot-pq"), { recursive: true });
  if (!existsSync(p.escrow)) writeFileSync(p.escrow, `${hex(randomBytes(32))}\n`, { mode: 0o600 });
  const lease = readFileSync(p.escrow, "utf8").trim();
  writeFileSync(p.mldsa, `${S.bootMl}\n`, { mode: 0o600 });
  const custody = await ensureLeaseCustody(p, lease);
  const wire = buildBootPqWire({
    serverDomain: DOMAIN, bootSeed: unhex(S.bootEd), bootMldsaSeedHex: S.bootMl, leaseSeedHex: lease, custody: custody.custody,
    issuedAt: Date.now(), stkHybrid: (m) => hybridSign(stk.secretKey, "flagship/boot-key-binding/v3", m),
  });
  // What the box's daemon mirrors to /boot from its verified state.
  writeFileSync(p.ownerPq, `${hex(verifyPqKeyBinding(ownerBindingWire, { role: "account-irk", subjectId: "drill", ed25519PubHex: ownerPub, now: Date.now() }).hybridPublicKey)}\n`);
  return { wire, custody: custody.custody, note: custody.note + (custody.pcrs ? ` (${custody.pcrs})` : "") };
}

// ── the boot worker and the scripted phone ─────────────────────────────────────────────────
type PhoneMode = "v2" | "v1" | "none";
let phone: PhoneMode = "v2";
let material: BootPqWire | null = null;
const requests: string[] = [];
let deps: BootRouteDeps;
const pqStore = new InMemoryPqTrustStorage();
const directory: DirectoryClient = {
  async boxStkForDomain(d) { return d === DOMAIN ? stkPub : null; },
  async ownerIrkForDomain(d) { return d === DOMAIN ? ownerPub : null; },
  async activeBootDelegatesForDomain() { return []; },
  async usernameForDomain(d) { return d === DOMAIN ? "drill" : null; },
  async boxBootKeyForDomain(d) { return d === DOMAIN ? bootPub : null; },
};
function freshWorker(): void {
  const susp = new InMemoryBootSuspensionStorage();
  deps = {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(susp),
    bootSuspensions: susp,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify: { notifyOwner: async () => true },
    gate: { directory, nonces: new InMemoryNonceStore() },
    requestPq: { put: (d, n, j, e) => pqStore.putRequestPq(d, n, j, e) },
  };
}

/** The phone's answer, through the same checks the native ports run. */
async function answer(body: { request: Record<string, unknown>; signature: string; pq?: unknown }): Promise<void> {
  const r = body.request as { serverDomain: string; stkPub: string; purpose: "unlock-key"; nonce: string; issuedAt: number };
  const v1ok = verifySecretRequest({ serverDomain: r.serverDomain, stkPub: unhex(r.stkPub), purpose: r.purpose, nonce: unhex(r.nonce), issuedAt: r.issuedAt }, unhex(body.signature), unhex(r.stkPub));
  if (!v1ok || r.stkPub !== bootPub) return;
  let sealed: Uint8Array;
  if (phone === "v2") {
    const stkBinding = verifyPqKeyBinding(stkBindingWire, { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: stkPub, now: Date.now() });
    const m = verifyBootPq(material, { serverDomain: DOMAIN, bootPubHex: bootPub, stkBinding, now: Date.now() });
    const parked = await pqStore.getRequestPq(DOMAIN, r.nonce, Date.now());
    const kem = verifySecretRequestV2({ serverDomain: r.serverDomain, bootPubHex: r.stkPub, purpose: r.purpose, nonceHex: r.nonce, issuedAt: r.issuedAt }, parked ? JSON.parse(parked) : null, m);
    sealed = buildBootReplyV2({
      ctx: { serverDomain: DOMAIN, bootPubHex: bootPub, nonceHex: r.nonce, replyKemPubHex: hex(kem) },
      diskKey: DISK_KEY, ownerHybridPublicKey: owner.publicKey, sign: (p, msg) => hybridSign(owner.secretKey, p, msg), issuedAt: Date.now(),
    });
  } else if (phone === "v1") {
    sealed = buildSealedSecretResponse(DISK_KEY, { serverDomain: r.serverDomain, stkPub: unhex(r.stkPub), purpose: r.purpose, nonce: unhex(r.nonce), issuedAt: r.issuedAt }).sealed;
  } else {
    return;
  }
  await deps.secretMailbox.putResponse(DOMAIN, r.nonce, hex(sealed), Date.now(), Date.now());
}

async function depositLease(version: 2 | 3): Promise<void> {
  const now = Date.now();
  const leaseId = hex(randomBytes(16));
  const expiresAt = now + 86_400_000;
  const outer = buildAutoUnlockLeaseV2({ serverDomain: DOMAIN, stkPub: unhex(bootPub), leaseId, luksKey: DISK_KEY, issuedAt: now, expiresAt });
  if (version === 3) {
    const stkBinding = verifyPqKeyBinding(stkBindingWire, { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: stkPub, now });
    const m = verifyBootPq(material, { serverDomain: DOMAIN, bootPubHex: bootPub, stkBinding, now });
    outer.sealedKey = sealLeaseV3({
      lease: { serverDomain: DOMAIN, bootPubHex: bootPub, leaseId, issuedAt: now, expiresAt },
      leaseKemPublicKey: m.leaseKemPublicKey, diskKey: DISK_KEY, ownerHybridPublicKey: owner.publicKey, sign: (p, msg) => hybridSign(owner.secretKey, p, msg),
    });
  }
  const ownerKp = { privateKey: unhex(S.ownerEd), publicKey: unhex(ownerPub) };
  await deps.boxSealedLeases.put({
    serverDomain: DOMAIN, leaseId, stkPubHex: bootPub, sealedKeyHex: hex(outer.sealedKey), issuedAt: now, expiresAt,
    maxUses: null, usesConsumed: 0, signatureHex: hex(signAutoUnlockLeaseV2(outer, ownerKp)), depositedAt: now,
  });
}

let port = 0;
async function startWorker(): Promise<() => void> {
  const certDir = join(W, "tls");
  mkdirSync(certDir, { recursive: true });
  if (!existsSync(join(certDir, "cert.pem"))) {
    sh("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "3", "-subj", "/CN=boot.flagshipserver.com",
      "-addext", "subjectAltName=DNS:boot.flagshipserver.com", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")]);
  }
  const server = createServer({ cert: readFileSync(join(certDir, "cert.pem")), key: readFileSync(join(certDir, "key.pem")) }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const path = (req.url ?? "/").split("?")[0]!;
      const parsed = body ? JSON.parse(body) : null;
      const out = await routeBoot(deps, req.method ?? "GET", path, (req.headers.authorization as string) ?? null, parsed);
      if (out && req.method === "POST" && path === "/api/boot/request" && out.status === 200) {
        requests.push(parsed.pq ? "v2" : "v1");
        await answer(parsed);
      }
      res.writeHead(out?.status ?? 404, { "content-type": "application/json" });
      res.end(JSON.stringify(out?.body ?? { error: "not found" }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
  return () => server.close();
}

// ── a premount run ─────────────────────────────────────────────────────────────────────────
function stage(name: string, o: { mode: "auto" | "approve"; policy: "strict" | "compat"; helper: "go" | "rust" }): string {
  const R = join(W, "roots", name);
  rmSync(R, { recursive: true, force: true });
  for (const d of ["boot", "bin", "run", "stub", "etc/ssl/certs", "cryptroot"]) mkdirSync(join(R, d), { recursive: true });
  writeFileSync(join(R, "boot/server-domain"), `${DOMAIN}\n`);
  writeFileSync(join(R, "boot/flagship-boot-host"), "https://boot.flagshipserver.com\n");
  writeFileSync(join(R, "boot/flagship-boot-unlock-mode"), `${o.mode}\n`);
  writeFileSync(join(R, "boot/flagship-boot-key.pem"), pkcs8(unhex(S.bootEd)), { mode: 0o600 });
  writeFileSync(join(R, "boot/flagship-owner-key.pub"), `${ownerPub}\n`);
  writeFileSync(join(R, "boot/flagship-unlock-policy"), `${o.policy}\n`);
  writeFileSync(join(R, "etc/ssl/certs/ca-certificates.crt"), readFileSync(join(W, "tls", "cert.pem")));
  writeFileSync(join(R, "etc/resolv.conf"), "nameserver 127.0.0.1\n");
  writeFileSync(join(R, "cryptroot/crypttab"), `${CRYPT} UUID=x none luks\n`);
  const helper = o.helper === "go" ? "/usr/local/lib/flagship-unseal-go" : "/usr/local/lib/flagship-boot-rust";
  writeFileSync(join(R, "bin/flagship-unseal"), `#!/bin/sh\necho "$@" >> "${R}/run/helper-argv.log"\nexec "${helper}" "$@"\n`);
  chmodSync(join(R, "bin/flagship-unseal"), 0o755);
  const stub = (n: string, body: string) => {
    writeFileSync(join(R, "stub", n), `#!/bin/sh\n${body}\n`);
    chmodSync(join(R, "stub", n), 0o755);
  };
  stub("curl", `first="$1"; shift\nexec /usr/bin/curl "$first" --connect-to boot.flagshipserver.com:443:127.0.0.1:${port} "$@"`);
  stub("mount", "exit 1");
  stub("reboot", `touch "${R}/run/rebooted"`);
  // blkid: the drill's own loop volume (the VM's root is not LUKS).
  stub("blkid", `echo ${S.loop}`);
  writeFileSync(join(R, "premount.sh"), buildUnlockPremountScript());
  return R;
}
function premount(R: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    const p = spawn("/bin/sh", [join(R, "premount.sh")], {
      env: { PATH: `${join(R, "stub")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, FLAGSHIP_PREMOUNT_TEST_ROOT: R, TPM2TOOLS_TCTI: TCTI, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code: code ?? -1, out }));
  });
}
const pcr7 = () => sh("tpm2_pcrread", ["sha256:7"], { TPM2TOOLS_TCTI: TCTI }).trim().split("\n").pop()!.trim();
const extend7 = (v: string) => sh("tpm2_pcrextend", [`7:sha256=${v}`], { TPM2TOOLS_TCTI: TCTI });
const FIRMWARE = "a1".repeat(32);
const KERNEL_V2 = "b2".repeat(32);

async function beforeReboot(): Promise<void> {
  phase = "setup";
  ensureVolume();
  check("LUKS2 loop volume ready", S.loop !== undefined, S.loop);
  check("/dev/tpmrm0 is swtpm through the kernel vTPM proxy (UpCloud has no vTPM)", sh("tpm2_getcap", ["properties-fixed"], { TPM2TOOLS_TCTI: TCTI }).includes("0x49424D00"), "manufacturer IBM (swtpm)");
  extend7(FIRMWARE);
  check("swtpm answers and PCR 7 carries the stand-in firmware measurement", /0x/i.test(pcr7()), pcr7());
  freshWorker();
  const stop = await startWorker();
  try {
    for (const helper of ["go", "rust"] as const) {
      phase = `relay-${helper}`;
      closeVolume();
      const R = stage(`relay-${helper}`, { mode: "approve", policy: "strict", helper });
      const box = await boxMaterial(R);
      material = box.wire;
      check("the daemon sealed the lease key to the TPM", box.custody === "tpm", box.note);
      phone = "v2";
      requests.length = 0;
      const r = await premount(R);
      check("the request was hybrid-signed (v2)", requests[0] === "v2", requests.join(","));
      check("strict: the hybrid reply opened the real LUKS volume", r.code === 0 && opened(), r.out.split("\n").filter((l) => /unlocked|refused|v2/.test(l)).join(" / "));
      check("the per-boot reply key is gone after its one open", !existsSync(join(R, "run/flagship-reply.key")));
      const argv = readFileSync(join(R, "run/helper-argv.log"), "utf8");
      check("no key seed or disk key on any helper command line", !argv.includes(S.bootEd) && !argv.includes(S.bootMl) && !argv.includes(S.diskKey));
    }

    phase = "downgrade";
    closeVolume();
    {
      const R = stage("downgrade", { mode: "approve", policy: "strict", helper: "go" });
      material = (await boxMaterial(R)).wire;
      phone = "v1";
      const r = await premount(R, { FLAGSHIP_RELAY_WINDOW_SECS: "40" });
      check("strict: a classical-only reply is refused", r.out.includes("boot-unlock-v2: strict-refuses-v1"));
      check("strict: the disk stayed shut and the box restarts to ask again", !existsSync(`/dev/mapper/${CRYPT}`) && existsSync(join(R, "run/rebooted")));
    }
    phase = "compat";
    closeVolume();
    {
      const R = stage("compat", { mode: "approve", policy: "compat", helper: "go" });
      material = (await boxMaterial(R)).wire;
      phone = "v1";
      const r = await premount(R);
      check("compatibility: an old phone's classical reply still opens", r.code === 0 && opened());
    }

    phase = "tpm-lease";
    closeVolume();
    freshWorker();
    {
      const R = stage("tpm-lease", { mode: "auto", policy: "strict", helper: "go" });
      material = (await boxMaterial(R)).wire;
      await depositLease(3);
      phone = "none";
      requests.length = 0;
      const r = await premount(R);
      check("auto: the v3 lease opened with the lease key the TPM released", r.code === 0 && r.out.includes("unlocked from the auto-unlock lease") && opened());
      check("auto: the phone was not asked", requests.length === 0);
    }
    phase = "v1-lease";
    closeVolume();
    freshWorker();
    {
      const R = stage("v1-lease", { mode: "auto", policy: "strict", helper: "go" });
      material = (await boxMaterial(R)).wire;
      await depositLease(2);
      phone = "v2";
      const r = await premount(R);
      check("strict: a classical v1 lease is refused", r.out.includes("strict-refuses-v1"));
      check("strict: the box asked the phone and opened with its hybrid reply", r.code === 0 && opened());
    }

    phase = "pcr-mismatch";
    closeVolume();
    freshWorker();
    {
      const R = stage("pcr-mismatch", { mode: "auto", policy: "strict", helper: "go" });
      material = (await boxMaterial(R)).wire;
      await depositLease(3);
      extend7(KERNEL_V2); // the boot chain changed (a new kernel, a tampered loader)
      phone = "v2";
      requests.length = 0;
      const r = await premount(R);
      check("a PCR mismatch: the TPM refuses the lease key", r.out.includes("the TPM did not release the lease key"));
      check("a PCR mismatch: the box falls back to the phone, which opens it", r.code === 0 && requests[0] === "v2" && opened());
      // After the approved boot the daemon reseals the same seed to the new chain.
      const again = await boxMaterial(R);
      check("after the approved boot the daemon reseals under the new chain", again.custody === "tpm" && /current boot chain/.test(again.note), again.note);
      closeVolume();
      phone = "none";
      requests.length = 0;
      const r2 = await premount(R);
      check("the same lease opens again from the TPM, no phone", r2.code === 0 && requests.length === 0 && opened());
      writeFileSync(join(W, "lease-for-reboot.json"), JSON.stringify(await deps.boxSealedLeases.release(DOMAIN, Date.now())));
    }
  } finally {
    stop();
    closeVolume();
  }
}

async function afterReboot(): Promise<void> {
  phase = "after-reboot";
  ensureVolume();
  check("swtpm came back with its state", sh("systemctl", ["is-active", "flagship-m6-swtpm.service"]).trim() === "active");
  // PCRs reset at boot; the stand-in firmware measures the same chain again.
  extend7(FIRMWARE);
  extend7(KERNEL_V2);
  freshWorker();
  const stop = await startWorker();
  try {
    const saved = JSON.parse(readFileSync(join(W, "lease-for-reboot.json"), "utf8"));
    await deps.boxSealedLeases.put({ ...saved, usesConsumed: 0 });
    const R = stage("after-reboot", { mode: "auto", policy: "strict", helper: "rust" });
    // Keep the TPM object sealed before the reboot: rebuild only the files the box keeps on /boot.
    for (const f of ["flagship-boot-mldsa.key", "flagship-owner-pq.pub"]) {
      writeFileSync(join(R, "boot", f), readFileSync(join(W, "roots", "pcr-mismatch", "boot", f)));
    }
    sh("cp", ["-r", join(W, "roots", "pcr-mismatch", "boot", "flagship-lease-kem.tpm"), join(R, "boot")]);
    phone = "none";
    requests.length = 0;
    const r = await premount(R);
    check("after a reboot the lease key still comes from the TPM (Rust helper)", r.code === 0 && requests.length === 0 && r.out.includes("unlocked from the auto-unlock lease") && opened());
    closeVolume();
    extend7("c3".repeat(32));
    phone = "v2";
    material = (await boxMaterialNoReseal(R)).wire;
    const r2 = await premount(R);
    check("after a reboot a changed chain still falls back to the phone", r2.out.includes("the TPM did not release the lease key") && r2.code === 0 && opened());
  } finally {
    stop();
    closeVolume();
  }
}

/** The material for the phone without touching the TPM object (what .com still serves). */
async function boxMaterialNoReseal(R: string): Promise<{ wire: BootPqWire }> {
  const p = bootPqPaths(join(W, "data"), join(R, "boot"));
  const lease = readFileSync(p.escrow, "utf8").trim();
  return {
    wire: buildBootPqWire({
      serverDomain: DOMAIN, bootSeed: unhex(S.bootEd), bootMldsaSeedHex: S.bootMl, leaseSeedHex: lease, custody: "tpm", issuedAt: Date.now(),
      stkHybrid: (m) => hybridSign(stk.secretKey, "flagship/boot-key-binding/v3", m),
    }),
  };
}

const which = process.argv[2];
(which === "after-reboot" ? afterReboot() : beforeReboot()).then(
  () => {
    const f = join(W, `results-${which ?? "before-reboot"}.json`);
    writeFileSync(f, JSON.stringify(results, null, 2));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed} of ${results.length} checks pass (${f})`);
    process.exit(failed ? 1 : 0);
  },
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
