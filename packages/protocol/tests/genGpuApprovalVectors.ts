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
    container: "flagship-alice--render",
    userspace: null,
    maxRuntimeMs: null,
    share: null,
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
    container: "flagship-alice--photos",
    userspace: "cuda-12.9-runtime",
    maxRuntimeMs: null,
    share: { computePercent: 50, memoryMib: 8000 },
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
    container: "flagship-aitrain-0123456789abcdef",
    userspace: null,
    maxRuntimeMs: 3_600_000,
    share: null,
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
  const v1 = (a: GpuApprovalTerms) =>
    bytesToHex(
      ed.sign(
        new TextEncoder().encode(
          new TextDecoder()
            .decode(gpuApprovalCanonicalBytes(SERVER, a, ISSUED))
            .replace("flagship/gpu-approval/v2", "flagship/gpu-approval/v1")
            .split("|")
            .filter((_, i) => i < 13 || i === 17)
            .join("|"),
        ),
        adminRoot,
      ),
    );
  const kp = (by: Uint8Array) => ({ privateKey: by, publicKey: ed.getPublicKey(by) });
  const w: GpuApprovalWithdraw = { appId: exclusive.app.appId, installationId: exclusive.app.installationId, generation: exclusive.app.generation, issuedAt: ISSUED + 60_000 };
  const wsig = (x: GpuApprovalWithdraw, by: Uint8Array, server = SERVER) => bytesToHex(signGpuApprovalWithdraw(server, x, kp(by)));
  const wbad = (name: string, withdraw: GpuApprovalWithdraw, signature: string) => ({ name, withdraw, signature, expect: false });
  return {
    about: "flagship/gpu-approval/v2: the owner's GPU approval for one app installation on one box, with the container, userspace, run-time limit and share its claim must carry, signed by the admin root (else the IRK); flagship-gpud verifies it against keyd's owner.json and policy.json, and refuses one signed at or before the owner's withdrawal (flagship/gpu-approval-withdraw/v1).",
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
      bad("another container after signing", { ...exclusive, container: "flagship-bob--bank" }, sig(exclusive, adminRoot)),
      bad("a userspace image picked after signing", { ...exclusive, userspace: "cuda-12.9-runtime" }, sig(exclusive, adminRoot)),
      bad("the run-time limit lifted after signing", { ...vm, maxRuntimeMs: null }, sig(vm, adminRoot)),
      bad("a run-time limit stretched after signing", { ...vm, maxRuntimeMs: 7_200_000 }, sig(vm, adminRoot)),
      bad("a bigger share after signing", { ...cooperative, share: { computePercent: 100, memoryMib: 8000 } }, sig(cooperative, adminRoot)),
      bad("the share dropped after signing", { ...cooperative, share: null }, sig(cooperative, adminRoot)),
      bad("a v1 signature over the same terms", exclusive, v1(exclusive)),
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
