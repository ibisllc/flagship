// The generated initramfs premount (packages/boot-chain/src/unlockPremount.ts),
// run for real: /bin/sh, the real curl over TLS, the real openssl, the built Go
// unseal helper and the real boot worker router (packages/boot-core) behind a
// local HTTPS server. Only the system tools that need a real disk or network
// (cryptsetup, blkid, mount, ip, lvm, reboot) are stubs. The cryptsetup stub
// writes what it read on stdin to a file so the test can compare it: on a box
// the key only ever passes through the pipe.
import { execFileSync, spawn } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAutoUnlockLeaseV2,
  buildBootReplyV2,
  buildSealedSecretResponse,
  ed,
  hybridSealKeygen,
  hybridSign,
  hybridSigKeygen,
  sealLeaseV3,
  signAutoUnlockLeaseV2,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { InMemoryNonceStore, routeBoot, type BootRouteDeps, type DirectoryClient } from "@flagship/boot-core";
import { buildUnlockPremountScript } from "../../../packages/boot-chain/src/unlockPremount.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const DOMAIN = "home.alice.flagship.services";
const stk = kp(0x0b);
const bootKey = kp(0x1b);
const owner = kp(0x07);
const stranger = kp(0x0c);
const LUKS_KEY = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 5) & 0xff);

/**
 * The first of `names` that runs, as an absolute path: the stubs put their own directory first
 * on PATH, so a stub that exec'd a bare `openssl` would exec itself forever (the Linux hang: on
 * a Mac the Homebrew path came first and hid it).
 */
function findTool(names: string[]): string {
  for (const c of names) {
    const abs = c.includes("/")
      ? c
      : (process.env.PATH ?? "").split(":").map((d) => join(d, c)).find((p) => {
          try {
            accessSync(p, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
    if (!abs) continue;
    try {
      execFileSync(abs, ["version"], { stdio: "ignore" });
      return abs;
    } catch {
      /* next */
    }
  }
  throw new Error(`none of ${names.join(", ")} found`);
}

/**
 * The Go helper, built once per source tree: the build is the slow part of this file's setup
 * (tens of seconds on a loaded machine), and its output depends only on the helper's sources.
 */
function cachedHelper(go: string, into: string): void {
  const src = join(repoRoot, "installer", "unseal-helper");
  const h = createHash("sha256");
  for (const f of readdirSync(src).sort()) {
    if (!/\.(go|mod|sum)$/.test(f)) continue;
    h.update(f).update(readFileSync(join(src, f)));
  }
  h.update(execFileSync(go, ["version"], { encoding: "utf8" }));
  const dir = join(repoRoot, "node_modules", ".cache", "flagship-unseal-test");
  const cached = join(dir, h.digest("hex").slice(0, 24));
  if (!existsSync(cached)) {
    mkdirSync(dir, { recursive: true });
    execFileSync(go, ["build", "-o", `${cached}.tmp`, "."], { cwd: src, stdio: "pipe", env: { ...process.env, CGO_ENABLED: "0" } });
    renameSync(`${cached}.tmp`, cached);
  }
  copyFileSync(cached, into);
  chmodSync(into, 0o755);
}

let work: string;
let helperBin: string;
let opensslBin: string;
let certPem: string;
let keyPem: string;
let server: Server;
let port: number;
let deps: BootRouteDeps;
let requests: Array<{ method: string; path: string }>;
let answerRelay: boolean;
/** The phone answers with a v1 reply even to a v2 request (an old phone, or a downgrade). */
let replyV1: boolean;
// Boot unlock v2: the boot key's ML-DSA half, the owner's hybrid key and the lease key.
const BOOT_MLDSA = new Uint8Array(32).fill(0x2b);
const ownerHybrid = hybridSigKeygen(owner.privateKey, new Uint8Array(32).fill(0x17));
const LEASE_SEED = new Uint8Array(32).fill(0x5b);
const leaseKem = hybridSealKeygen(LEASE_SEED);

function pkcs8Pem(seed: Uint8Array): string {
  const der = Buffer.concat([
    Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
    Buffer.from(seed),
  ]);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

const directory: DirectoryClient = {
  async boxStkForDomain(d) { return d === DOMAIN ? hex(stk.publicKey) : null; },
  async ownerIrkForDomain(d) { return d === DOMAIN ? hex(owner.publicKey) : null; },
  async activeBootDelegatesForDomain() { return []; },
  async usernameForDomain(d) { return d === DOMAIN ? "alice" : null; },
  async boxBootKeyForDomain(d) { return d === DOMAIN ? hex(bootKey.publicKey) : null; },
};

function freshDeps(): BootRouteDeps {
  const susp = new InMemoryBootSuspensionStorage();
  return {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(susp),
    bootSuspensions: susp,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify: { notifyOwner: async () => true },
    gate: { directory, nonces: new InMemoryNonceStore() },
  };
}

beforeAll(async () => {
  const go = findTool(["go", "/opt/homebrew/bin/go", "/usr/local/go/bin/go"]);
  opensslBin = findTool(["/opt/homebrew/opt/openssl@3/bin/openssl", "openssl"]);
  work = mkdtempSync(join(tmpdir(), "flagship-premount-"));
  helperBin = join(work, "flagship-unseal.real");
  cachedHelper(go, helperBin);
  const certDir = join(work, "tls");
  mkdirSync(certDir);
  execFileSync(opensslBin, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2",
    "-subj", "/CN=boot.flagshipserver.com", "-addext", "subjectAltName=DNS:boot.flagshipserver.com",
    "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
  ], { stdio: "pipe" });
  certPem = readFileSync(join(certDir, "cert.pem"), "utf8");
  keyPem = readFileSync(join(certDir, "key.pem"), "utf8");
  server = createServer({ cert: certPem, key: keyPem }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const path = (req.url ?? "/").split("?")[0]!;
      requests.push({ method: req.method ?? "GET", path });
      const parsed = body ? JSON.parse(body) : null;
      const out = await routeBoot(deps, req.method ?? "GET", path, (req.headers.authorization as string) ?? null, parsed);
      if (out && req.method === "POST" && path === "/api/boot/request" && out.status === 200 && answerRelay) {
        const r = parsed.request;
        const sealed = parsed.pq && !replyV1
          ? buildBootReplyV2({
              ctx: { serverDomain: r.serverDomain, bootPubHex: r.stkPub, nonceHex: r.nonce, replyKemPubHex: parsed.pq.replyKemPubHex },
              diskKey: LUKS_KEY,
              ownerHybridPublicKey: ownerHybrid.publicKey,
              sign: (purpose, m) => hybridSign(ownerHybrid.secretKey, purpose, m),
              issuedAt: Date.now(),
            })
          : buildSealedSecretResponse(LUKS_KEY, {
              serverDomain: r.serverDomain,
              stkPub: Buffer.from(r.stkPub, "hex"),
              purpose: r.purpose,
              nonce: Buffer.from(r.nonce, "hex"),
              issuedAt: r.issuedAt,
            }).sealed;
        await deps.secretMailbox.putResponse(DOMAIN, r.nonce, hex(sealed), Date.now(), Date.now());
      }
      res.writeHead(out?.status ?? 404, { "content-type": "application/json" });
      res.end(JSON.stringify(out?.body ?? { error: "not found" }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
}, 180_000);

afterAll(() => {
  server?.close();
});

interface Setup {
  /** Boot unlock v2 files on /boot; `lease` picks how the lease key is held. */
  v2?: { policy?: string; lease?: "file" | "tpm" | "none"; tpmReleases?: boolean };
  mode?: string;
  bootHost?: string;
  ownerKey?: string | null;
  caBundle?: boolean;
  env?: Record<string, string>;
}

function stage(s: Setup): string {
  const R = mkdtempSync(join(work, "root-"));
  for (const d of ["boot", "bin", "run", "stub", "etc/ssl/certs", "cryptroot"]) mkdirSync(join(R, d), { recursive: true });
  writeFileSync(join(R, "boot/server-domain"), `${DOMAIN}\n`);
  writeFileSync(join(R, "boot/flagship-boot-host"), `${s.bootHost ?? "https://boot.flagshipserver.com"}\n`);
  writeFileSync(join(R, "boot/flagship-boot-unlock-mode"), s.mode ?? "auto\n");
  writeFileSync(join(R, "boot/flagship-boot-key.pem"), pkcs8Pem(bootKey.privateKey), { mode: 0o600 });
  if (s.ownerKey !== null) writeFileSync(join(R, "boot/flagship-owner-key.pub"), `${s.ownerKey ?? hex(owner.publicKey)}\n`);
  if (s.caBundle !== false) writeFileSync(join(R, "etc/ssl/certs/ca-certificates.crt"), certPem);
  writeFileSync(join(R, "etc/resolv.conf"), "nameserver 127.0.0.1\n");
  writeFileSync(join(R, "cryptroot/crypttab"), "sda4_crypt UUID=x none luks\n");
  const stub = (name: string, body: string) => {
    writeFileSync(join(R, "stub", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(R, "stub", name), 0o755);
  };
  // Logs the helper's argv so the test can prove no key material was on it.
  writeFileSync(join(R, "bin/flagship-unseal"), `#!/bin/sh\necho "$@" >> "${R}/run/helper-argv.log"\nexec "${helperBin}" "$@"\n`);
  chmodSync(join(R, "bin/flagship-unseal"), 0o755);
  stub("curl", `echo "$@" >> "${R}/run/curl-argv.log"\nfirst="$1"; shift\nexec /usr/bin/curl "$first" --connect-to boot.flagshipserver.com:443:127.0.0.1:${port} "$@"`);
  stub("openssl", `exec "${opensslBin}" "$@"`);
  stub("cryptsetup", `cat > "${R}/run/cryptsetup-stdin"\necho "$@" > "${R}/run/cryptsetup-argv"\ncmp -s "${R}/run/cryptsetup-stdin" "${R}/run/expected-key" || exit 2`);
  stub("blkid", "echo /dev/fake4");
  stub("mount", "exit 1");
  stub("umount", "exit 0");
  stub("ip", "echo 'default via 10.0.0.1 dev eth0'");
  stub("lvm", "exit 0");
  stub("reboot", `touch "${R}/run/rebooted"`);
  stub("sleep", `echo "$1" >> "${R}/run/sleeps"\nexec /bin/sleep 1`);
  writeFileSync(join(R, "run/expected-key"), LUKS_KEY);
  writeFileSync(join(R, "premount.sh"), buildUnlockPremountScript());
  if (s.v2) {
    writeFileSync(join(R, "boot/flagship-boot-mldsa.key"), `${hex(BOOT_MLDSA)}\n`, { mode: 0o600 });
    writeFileSync(join(R, "boot/flagship-owner-pq.pub"), `${hex(ownerHybrid.publicKey)}\n`);
    if (s.v2.policy !== undefined) writeFileSync(join(R, "boot/flagship-unlock-policy"), s.v2.policy);
    if (s.v2.lease === "file") writeFileSync(join(R, "boot/flagship-lease-kem.key"), `${hex(LEASE_SEED)}\n`, { mode: 0o600 });
    if (s.v2.lease === "tpm") {
      mkdirSync(join(R, "boot/flagship-lease-kem.tpm"));
      for (const f of ["seal.pub", "seal.priv"]) writeFileSync(join(R, "boot/flagship-lease-kem.tpm", f), "blob");
      writeFileSync(join(R, "boot/flagship-lease-kem.tpm/pcrs"), "sha256:0,7\n");
      // The TPM releases the seed only under the PCR policy the test sets.
      stub("tpm2_createprimary", `echo "$@" >> "${R}/run/tpm-argv.log"`);
      stub("tpm2_load", `echo "$@" >> "${R}/run/tpm-argv.log"`);
      stub("tpm2_unseal", `echo "$@" >> "${R}/run/tpm-argv.log"\n[ -f "${R}/run/pcr-ok" ] || { echo "ERROR: policy check failed" >&2; exit 1; }\necho ${hex(LEASE_SEED)}`);
      stub("modprobe", "exit 0");
      if (s.v2.tpmReleases !== false) writeFileSync(join(R, "run/pcr-ok"), "");
    }
  }
  return R;
}

function run(R: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    const p = spawn("/bin/sh", [join(R, "premount.sh")], {
      env: { PATH: `${join(R, "stub")}:/usr/bin:/bin:/usr/sbin:/sbin`, FLAGSHIP_PREMOUNT_TEST_ROOT: R, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code: code ?? -1, out }));
  });
}

async function depositLease(signer: Keypair, recipient = bootKey.publicKey): Promise<void> {
  const now = Date.now();
  const lease = buildAutoUnlockLeaseV2({ serverDomain: DOMAIN, stkPub: recipient, leaseId: "e".repeat(32), luksKey: LUKS_KEY, issuedAt: now, expiresAt: now + 3_600_000 });
  // Straight into storage: a worker that kept a lease it should not have.
  await deps.boxSealedLeases.put({
    serverDomain: DOMAIN,
    leaseId: lease.leaseId,
    stkPubHex: hex(recipient),
    sealedKeyHex: hex(lease.sealedKey),
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    maxUses: null,
    usesConsumed: 0,
    signatureHex: hex(signAutoUnlockLeaseV2(lease, signer)),
    depositedAt: now,
  });
}

function noSecretsLeft(R: string): void {
  const argv = existsSync(join(R, "run/helper-argv.log")) ? readFileSync(join(R, "run/helper-argv.log"), "utf8") : "";
  expect(argv).not.toContain(hex(bootKey.privateKey));
  expect(argv).not.toContain("--identity-priv-hex");
  expect(argv).not.toContain(hex(LUKS_KEY));
  expect(existsSync(join(R, "run/unlock-key"))).toBe(false);
  expect(existsSync(join(R, "run/unlock-key.hex"))).toBe(false);
}

function reset(): void {
  deps = freshDeps();
  requests = [];
  answerRelay = true;
  replyV1 = false;
}

async function depositLeaseV3(policy: { fields?: Partial<{ expiresAt: number }> } = {}): Promise<void> {
  const now = Date.now();
  const leaseId = "f".repeat(32);
  const expiresAt = policy.fields?.expiresAt ?? now + 3_600_000;
  const sealedKey = sealLeaseV3({
    lease: { serverDomain: DOMAIN, bootPubHex: hex(bootKey.publicKey), leaseId, issuedAt: now, expiresAt },
    leaseKemPublicKey: leaseKem.publicKey,
    diskKey: LUKS_KEY,
    ownerHybridPublicKey: ownerHybrid.publicKey,
    sign: (purpose, m) => hybridSign(ownerHybrid.secretKey, purpose, m),
  });
  const outer = buildAutoUnlockLeaseV2({ serverDomain: DOMAIN, stkPub: bootKey.publicKey, leaseId, luksKey: LUKS_KEY, issuedAt: now, expiresAt });
  outer.sealedKey = sealedKey;
  await deps.boxSealedLeases.put({
    serverDomain: DOMAIN,
    leaseId,
    stkPubHex: hex(bootKey.publicKey),
    sealedKeyHex: hex(sealedKey),
    issuedAt: now,
    expiresAt,
    maxUses: null,
    usesConsumed: 0,
    signatureHex: hex(signAutoUnlockLeaseV2(outer, owner)),
    depositedAt: now,
  });
}

describe("the generated premount, end to end", () => {
  it("auto: opens the owner-signed lease into cryptsetup, ignores proxy settings, puts no secret in argv or a file", async () => {
    reset();
    await depositLease(owner);
    const R = stage({});
    const r = await run(R, { https_proxy: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" });
    expect(r.out).toContain("unlocked from the auto-unlock lease");
    expect(r.code).toBe(0);
    expect(readFileSync(join(R, "run/cryptsetup-argv"), "utf8").trim()).toBe("luksOpen --key-file - /dev/fake4 sda4_crypt");
    expect(requests.map((q) => q.path)).toEqual([`/api/boot/lease/${DOMAIN}`]);
    const curlArgv = readFileSync(join(R, "run/curl-argv.log"), "utf8");
    expect(curlArgv).toContain("-q --proto =https --noproxy *");
    noSecretsLeft(R);
  }, 60_000);

  it("auto: refuses a lease the owner did not sign, asks the phone, and opens the phone's reply", async () => {
    reset();
    await depositLease(stranger);
    const R = stage({});
    const r = await run(R);
    expect(r.out).toContain("lease refused: flagship-unseal: lease signature does not verify under the owner key");
    expect(r.out).toContain("unlocked with the phone's reply");
    expect(r.code).toBe(0);
    expect(requests.map((q) => q.method + " " + q.path.split("/").slice(0, 4).join("/"))).toEqual([
      "GET /api/boot/lease",
      "POST /api/boot/request",
      "GET /api/boot/response",
    ]);
    noSecretsLeft(R);
  }, 60_000);

  for (const mode of ["", "Approve\n", "garbage", "auto approve\n"]) {
    it(`a damaged mode file (${JSON.stringify(mode)}) asks the phone and never reads the lease`, async () => {
      reset();
      await depositLease(owner);
      const R = stage({ mode });
      const r = await run(R);
      expect(r.out).toContain("asking the phone");
      expect(r.code).toBe(0);
      expect(requests.some((q) => q.path.startsWith("/api/boot/lease"))).toBe(false);
    }, 60_000);
  }

  for (const bootHost of ["http://boot.flagshipserver.com", "https://boot.evil.example", "https://boot.flagshipserver.com:8443", "https://boot.flagshipserver.com/x", ""]) {
    it(`refuses the boot host ${JSON.stringify(bootHost)} before any request`, async () => {
      reset();
      const R = stage({ bootHost });
      const r = await run(R);
      expect(r.code).toBe(1);
      expect(r.out).toContain("is not https on an approved host");
      expect(requests).toEqual([]);
    }, 30_000);
  }

  it("fails loudly without the CA bundle", async () => {
    reset();
    const R = stage({ caBundle: false });
    const r = await run(R);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FATAL: missing the CA bundle");
  }, 30_000);

  it("bounds the relay: re-asks with a fresh request, then restarts the box when the window ends", async () => {
    reset();
    answerRelay = false;
    const R = stage({ mode: "approve\n" });
    const r = await run(R, { FLAGSHIP_RELAY_WINDOW_SECS: "8", FLAGSHIP_RELAY_REQUEST_SECS: "2" });
    expect(r.out).toContain("no phone reply within 8s");
    expect(existsSync(join(R, "run/rebooted"))).toBe(true);
    const posts = requests.filter((q) => q.path === "/api/boot/request").length;
    expect(posts).toBeGreaterThan(1);
    // Every wait went through sleep (no console on a production burn).
    expect(readFileSync(join(R, "run/sleeps"), "utf8").trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("clamps an oversized relay window to seven days", () => {
    const s = buildUnlockPremountScript();
    expect(s).toContain("RELAY_MAX_SECS=604800");
    expect(s).toContain('RELAY_WINDOW_SECS="$(bounded "${FLAGSHIP_RELAY_WINDOW_SECS:-}" "$RELAY_MAX_SECS" 1 "$RELAY_MAX_SECS")"');
  });

  it("offers the 'manual' console fallback only on a debug burn, and still waits when the console is closed", async () => {
    const s = buildUnlockPremountScript();
    expect(s).toContain('[ -f "$R/boot/flagship-debug-mode" ] && DEBUG_BURN=yes');
    expect(s.indexOf("read -t")).toBeGreaterThan(s.indexOf('if [ "$DEBUG_BURN" = yes ]; then'));
    reset();
    answerRelay = false;
    const R = stage({ mode: "approve\n" });
    writeFileSync(join(R, "boot/flagship-debug-mode"), "1\n");
    const t0 = Date.now();
    const r = await run(R, { FLAGSHIP_RELAY_WINDOW_SECS: "4" });
    // No console here: read fails at once, and the wait still takes its time.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3_000);
    expect(r.out).toContain("no phone reply within 4s");
  }, 60_000);

  it("refuses to start without the owner key for the lease path, and asks the phone", async () => {
    reset();
    await depositLease(owner);
    const R = stage({ ownerKey: null });
    const r = await run(R);
    expect(r.out).toContain("no owner key on /boot; asking the phone");
    expect(r.code).toBe(0);
  }, 60_000);

  it("v2 strict: hybrid-signs the request with a fresh reply key and opens the phone's hybrid reply", async () => {
    reset();
    const R = stage({ mode: "approve\n", v2: { policy: "strict\n" } });
    const r = await run(R);
    expect(r.out).toContain("boot unlock v2: on (policy: strict)");
    expect(r.out).toContain("unlocked with the phone's reply");
    expect(r.code).toBe(0);
    expect(existsSync(join(R, "run/flagship-reply.key"))).toBe(false);
    const argv = readFileSync(join(R, "run/helper-argv.log"), "utf8");
    expect(argv).toContain("--v2-request");
    expect(argv).not.toContain(hex(BOOT_MLDSA));
    noSecretsLeft(R);
  }, 60_000);

  it("v2 strict: a classical v1 reply is refused (no downgrade), and the box asks again", async () => {
    reset();
    replyV1 = true;
    const R = stage({ mode: "approve\n", v2: { policy: "strict\n" } });
    const r = await run(R, { FLAGSHIP_RELAY_WINDOW_SECS: "25" });
    expect(r.out).toContain("boot-unlock-v2: strict-refuses-v1");
    expect(r.out).not.toContain("unlocked with the phone's reply");
    expect(existsSync(join(R, "run/rebooted"))).toBe(true);
  }, 90_000);

  it("v2 compat: an old phone's v1 reply still opens", async () => {
    reset();
    replyV1 = true;
    const R = stage({ mode: "approve\n", v2: { policy: "compat\n" } });
    const r = await run(R);
    expect(r.out).toContain("unlocked with the phone's reply");
    expect(r.code).toBe(0);
  }, 60_000);

  it("v2 strict: opens a v3 lease with the lease key file, and refuses a v1 lease", async () => {
    reset();
    await depositLeaseV3();
    const R = stage({ v2: { policy: "strict\n", lease: "file" } });
    const r = await run(R);
    expect(r.out).toContain("unlocked from the auto-unlock lease");
    reset();
    await depositLease(owner);
    const R2 = stage({ v2: { policy: "strict\n", lease: "file" } });
    const r2 = await run(R2);
    expect(r2.out).toContain("lease refused: flagship-unseal: boot-unlock-v2: strict-refuses-v1");
    expect(r2.out).toContain("unlocked with the phone's reply");
  }, 90_000);

  it("v2 TPM: the lease key comes from the TPM; a changed boot chain (PCR mismatch) asks the phone", async () => {
    reset();
    await depositLeaseV3();
    const R = stage({ v2: { policy: "strict\n", lease: "tpm" } });
    const r = await run(R);
    expect(r.out).toContain("unlocked from the auto-unlock lease");
    expect(readFileSync(join(R, "run/tpm-argv.log"), "utf8")).toContain("-p pcr:sha256:0,7");
    reset();
    await depositLeaseV3();
    const R2 = stage({ v2: { policy: "strict\n", lease: "tpm", tpmReleases: false } });
    const r2 = await run(R2);
    expect(r2.out).toContain("the TPM did not release the lease key");
    expect(r2.out).toContain("unlocked with the phone's reply");
    expect(r2.code).toBe(0);
  }, 90_000);

  it("v2: an expired v3 lease past the time floor asks the phone", async () => {
    reset();
    await depositLeaseV3({ fields: { expiresAt: Date.now() + 60_000 } });
    const R = stage({ v2: { policy: "strict\n", lease: "file" } });
    writeFileSync(join(R, "boot/flagship-time-floor"), `${Date.now() + 120_000}\n`);
    const r = await run(R);
    expect(r.out).toContain("boot-unlock-v2: lease-expired");
    expect(r.out).toContain("unlocked with the phone's reply");
  }, 60_000);
});
