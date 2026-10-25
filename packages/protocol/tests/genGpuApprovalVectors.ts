// Builds test-vectors/gpu-approval/vectors.json: the owner's signed GPU approval that
// flagship-gpud checks itself (rust/crates/flagship-gpu/tests/owner_approval.rs reads the same file).
// Regenerate with:  npx tsx packages/protocol/tests/genGpuApprovalVectors.ts
// Inputs are fixed and Ed25519 is deterministic, so the output is byte-stable;
// gpuApprovalVectors.test.ts fails when the file drifts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "../src/edSync.js";
import {
  gpuApprovalCanonicalBytes,
  gpuApprovalWithdrawCanonicalBytes,
  signGpuApproval,
  signGpuApprovalWithdraw,
  type GpuApprovalTerms,
  type GpuApprovalWithdraw,
} from "../src/gpuApproval.js";

export const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/gpu-approval/vectors.json");

const fill = (b: number) => new Uint8Array(32).fill(b);
const SERVER = "home.alice.flagship.services";
const ISSUED = 1_800_000_000_000;

export function buildGpuApprovalVectors(): unknown {
  const adminRoot = fill(0x22);
  const irk = fill(0x11);
  const stranger = fill(0x33);
  const pub = (seed: Uint8Array) => bytesToHex(ed.getPublicKey(seed));
  const exclusive: GpuApprovalTerms = {
    app: { appId: "alice--render", installationId: "inst-7f3a", generation: 3 },
    backend: "nvidia-cuda",
    maxCount: 1,
    capabilities: ["compute"],
    policies: ["exclusive"],
    isolation: "gvisor-nvproxy",
    secrecy: true,
    trustDomain: null,
    ownerConsent: null,
  };
  const cooperative: GpuApprovalTerms = {
    app: { appId: "alice--photos", installationId: "inst-01", generation: 1 },
    backend: "nvidia-cuda",
    maxCount: 1,
    capabilities: ["video-encode", "compute", "compute"],
    policies: ["cooperative", "exclusive"],
    isolation: "gvisor-nvproxy",
    secrecy: false,
    trustDomain: "family",
    ownerConsent: "consent-2026-10-25",
  };
  const vm: GpuApprovalTerms = {
    app: { appId: "alice--train", installationId: "inst-9", generation: 12 },
    backend: "amd-rocm",
    maxCount: 4,
    capabilities: ["compute", "graphics"],
    policies: ["exclusive"],
    isolation: "vm-passthrough",
    secrecy: true,
    trustDomain: null,
    ownerConsent: null,
  };
  const sig = (a: GpuApprovalTerms, by: Uint8Array, server = SERVER, issuedAt = ISSUED) =>
    bytesToHex(signGpuApproval(server, a, issuedAt, { privateKey: by, publicKey: ed.getPublicKey(by) }));
  const ok = (name: string, a: GpuApprovalTerms) => ({
    name,
    approval: a,
    proof: { issuedAt: ISSUED, signature: sig(a, adminRoot) },
    canonical: new TextDecoder().decode(gpuApprovalCanonicalBytes(SERVER, a, ISSUED)),
    expect: true,
  });
  const bad = (name: string, approval: GpuApprovalTerms, signature: string, issuedAt = ISSUED) => ({ name, approval, proof: { issuedAt, signature }, expect: false });
  const kp = (by: Uint8Array) => ({ privateKey: by, publicKey: ed.getPublicKey(by) });
  const w: GpuApprovalWithdraw = { appId: exclusive.app.appId, installationId: exclusive.app.installationId, generation: exclusive.app.generation, issuedAt: ISSUED + 60_000 };
  const wsig = (x: GpuApprovalWithdraw, by: Uint8Array, server = SERVER) => bytesToHex(signGpuApprovalWithdraw(server, x, kp(by)));
  const wbad = (name: string, withdraw: GpuApprovalWithdraw, signature: string) => ({ name, withdraw, signature, expect: false });
  return {
    about: "flagship/gpu-approval/v1: the owner's GPU approval for one app installation on one box, signed by the admin root (else the IRK); flagship-gpud verifies it against keyd's owner.json and policy.json.",
    anchor: { server: SERVER, signerHex: pub(adminRoot) },
    keys: { adminRootPubHex: pub(adminRoot), irkPubHex: pub(irk), strangerPubHex: pub(stranger) },
    cases: [
      ok("exclusive, secret, in gVisor", exclusive),
      ok("cooperative in a trust domain; sets are sorted and deduplicated", cooperative),
      ok("a dedicated VM with four AMD devices", vm),
      bad("signed by the IRK while the account pins an admin root", exclusive, sig(exclusive, irk)),
      bad("signed by a stranger", exclusive, sig(exclusive, stranger)),
      bad("signed for another server", exclusive, sig(exclusive, adminRoot, "home2.alice.flagship.services")),
      bad("secrecy dropped after signing", { ...exclusive, secrecy: false }, sig(exclusive, adminRoot)),
      bad("cooperative sharing added after signing", { ...exclusive, policies: ["exclusive", "cooperative"] }, sig(exclusive, adminRoot)),
      bad("graphics added after signing", { ...exclusive, capabilities: ["compute", "graphics"] }, sig(exclusive, adminRoot)),
      bad("more devices after signing", { ...exclusive, maxCount: 2 }, sig(exclusive, adminRoot)),
      bad("another trust domain after signing", { ...cooperative, trustDomain: "work" }, sig(cooperative, adminRoot)),
      bad("another app generation", { ...exclusive, app: { ...exclusive.app, generation: 4 } }, sig(exclusive, adminRoot)),
      bad("another app", { ...exclusive, app: { ...exclusive.app, appId: "bob--render" } }, sig(exclusive, adminRoot)),
      bad("the container sandbox swapped for a VM", { ...exclusive, isolation: "vm-passthrough" }, sig(exclusive, adminRoot)),
      bad("another issuedAt", exclusive, sig(exclusive, adminRoot), ISSUED + 1),
      bad("an upper-case signature", exclusive, sig(exclusive, adminRoot).toUpperCase()),
      bad("a truncated signature", exclusive, sig(exclusive, adminRoot).slice(0, 126)),
      bad("no signature", exclusive, ""),
    ],
    withdraw: [
      { name: "withdrawn by the admin root", withdraw: w, signature: wsig(w, adminRoot), canonical: new TextDecoder().decode(gpuApprovalWithdrawCanonicalBytes(SERVER, w)), expect: true },
      wbad("withdrawn by the IRK while the account pins an admin root", w, wsig(w, irk)),
      wbad("withdrawn by a stranger", w, wsig(w, stranger)),
      wbad("signed for another server", w, wsig(w, adminRoot, "home2.alice.flagship.services")),
      wbad("another generation", { ...w, generation: 4 }, wsig(w, adminRoot)),
      wbad("another installation", { ...w, installationId: "inst-other" }, wsig(w, adminRoot)),
      wbad("another issuedAt", { ...w, issuedAt: w.issuedAt + 1 }, wsig(w, adminRoot)),
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, JSON.stringify(buildGpuApprovalVectors(), null, 2) + "\n");
}
