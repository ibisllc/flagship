import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hybridSign, hybridSigKeygen, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, signPqKeyBinding, TAG_PQ_KEY_BINDING, verifyBootPq, verifyPqKeyBinding } from "@flagship/protocol";
import { bootPqPaths, buildBootPqWire, ensureLeaseCustody, seedFromPkcs8Pem, syncBootUnlockFiles } from "../src/bootPq.js";
import { choosePcrs, parsePcrRead, systemTpmRunner, unsealFromTpm, type TpmRunner } from "../src/bootPqTpm.js";

const DOMAIN = "home.alice.flagship.services";
const fill = (v: number) => new Uint8Array(32).fill(v);
const SEED = "ab".repeat(32);

/** A TPM that seals to a digest of the selected PCR values: enough to test the daemon's logic. */
function fakeTpm(pcrs: Map<number, string>): TpmRunner {
  const digestOf = (sel: string) => {
    const idx = sel.replace("sha256:", "").split(",").map(Number);
    return createHash("sha256").update(idx.map((i) => `${i}=${pcrs.get(i) ?? "0".repeat(64)}`).join(";")).digest("hex");
  };
  const arg = (a: readonly string[], f: string) => a[a.indexOf(f) + 1]!;
  return {
    async run(cmd, args, input) {
      const ok = (s = "") => ({ code: 0, stdout: Buffer.from(s), stderr: "" });
      switch (cmd) {
        case "tpm2_getcap":
          return ok("TPM2_PT_FAMILY_INDICATOR:\n  raw: 0x322E3000\n");
        case "tpm2_pcrread": {
          const sel = args[args.length - 1]!;
          if (args.includes("-o")) writeFileSync(arg(args, "-o"), digestOf(sel));
          return ok(["sha256:", ...sel.replace("sha256:", "").split(",").map((i) => `  ${i} : 0x${(pcrs.get(Number(i)) ?? "0".repeat(64)).toUpperCase()}`)].join("\n"));
        }
        case "tpm2_createprimary":
          writeFileSync(arg(args, "-c"), "primary");
          return ok();
        case "tpm2_createpolicy":
          writeFileSync(arg(args, "-L"), readFileSync(arg(args, "-f")));
          return ok();
        case "tpm2_create":
          writeFileSync(arg(args, "-u"), readFileSync(arg(args, "-L")));
          writeFileSync(arg(args, "-r"), input ?? "");
          return ok();
        case "tpm2_load":
          writeFileSync(arg(args, "-c"), JSON.stringify({ pub: readFileSync(arg(args, "-u"), "utf8"), priv: readFileSync(arg(args, "-r"), "utf8") }));
          return ok();
        case "tpm2_unseal": {
          const o = JSON.parse(readFileSync(arg(args, "-c"), "utf8")) as { pub: string; priv: string };
          return o.pub === digestOf(arg(args, "-p").replace("pcr:", "")) ? ok(o.priv) : { code: 1, stdout: Buffer.alloc(0), stderr: "ERROR: policy check failed" };
        }
      }
      return { code: 127, stdout: Buffer.alloc(0), stderr: "no such tool" };
    },
  };
}

describe("boot unlock v2 on the box", () => {
  it("parses tpm2_pcrread output and keeps only measured PCRs", async () => {
    expect(parsePcrRead("sha256:\n  0 : 0x" + "A".repeat(64) + "\n  7 : 0x" + "0".repeat(64)).get(0)).toBe("a".repeat(64));
    const pcrs = new Map([[0, "11".repeat(32)], [7, "22".repeat(32)], [9, "f".repeat(64)]]);
    expect(await choosePcrs(fakeTpm(pcrs))).toEqual({ selection: "sha256:0,7", measured: [0, 7] });
    expect(await choosePcrs(fakeTpm(new Map()))).toBeNull();
  });

  it("seals the lease seed to the TPM, keeps it while the chain holds, reseals the same seed after it changed", async () => {
    process.env.TPM2TOOLS_TCTI = "fake";
    try {
      const dir = mkdtempSync(join(tmpdir(), "boot-pq-"));
      const p = bootPqPaths(join(dir, "data"), join(dir, "boot"));
      const pcrs = new Map([[0, "11".repeat(32)], [7, "22".repeat(32)]]);
      const tpm = fakeTpm(pcrs);
      writeFileSync(join(dir, "boot-placeholder"), "");
      expect((await ensureLeaseCustody(p, SEED, tpm)).custody).toBe("tpm");
      expect(await unsealFromTpm(p.leaseTpmDir, tpm)).toBe(SEED);
      expect(existsSync(p.leaseFile)).toBe(false);
      expect((await ensureLeaseCustody(p, SEED, tpm)).note).toBe("sealed to the TPM");
      pcrs.set(7, "33".repeat(32));
      await expect(unsealFromTpm(p.leaseTpmDir, tpm)).rejects.toThrow(/policy check failed/);
      expect((await ensureLeaseCustody(p, SEED, tpm)).note).toMatch(/current boot chain/);
      expect(await unsealFromTpm(p.leaseTpmDir, tpm)).toBe(SEED);
    } finally {
      delete process.env.TPM2TOOLS_TCTI;
    }
  });

  it("falls back to a software file when no TPM answers, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-pq-"));
    const p = bootPqPaths(join(dir, "data"), join(dir, "boot"));
    const none: TpmRunner = { run: async () => ({ code: 127, stdout: Buffer.alloc(0), stderr: "" }) };
    const r = await ensureLeaseCustody(p, SEED, none);
    expect(r.custody).toBe("software");
    expect(readFileSync(p.leaseFile, "utf8")).toBe(`${SEED}\n`);
  });

  it("builds material a phone verifies under the STK's binding", () => {
    const stk = hybridSigKeygen(fill(0x11), fill(0x12));
    const stkBinding = verifyPqKeyBinding(
      signPqKeyBinding(
        { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: Buffer.from(stk.publicKey.subarray(0, 32)).toString("hex"), mldsaPubHex: Buffer.from(stk.publicKey.subarray(32)).toString("hex"), issuedAt: 1 },
        (m) => hybridSign(stk.secretKey, TAG_PQ_KEY_BINDING, m),
      ),
      { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: Buffer.from(stk.publicKey.subarray(0, 32)).toString("hex"), now: 2 },
    );
    const wire = buildBootPqWire({
      serverDomain: DOMAIN,
      bootSeed: fill(0x21),
      bootMldsaSeedHex: "22".repeat(32),
      leaseSeedHex: SEED,
      custody: "tpm",
      issuedAt: 5,
      stkHybrid: (m) => hybridSign(stk.secretKey, "flagship/boot-key-binding/v3", m),
    });
    const v = verifyBootPq(wire, { serverDomain: DOMAIN, bootPubHex: wire.bootPubHex, stkBinding, now: 10 });
    expect(v.custody).toBe("tpm");
    expect(Buffer.from(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, v.bootHybridPublicKey)).length).toBe(32);
  });

  it("reads the install helper's PKCS#8 boot key and mirrors owner key and policy to /boot", async () => {
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(fill(0x21))]);
    expect(seedFromPkcs8Pem(`-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`)).toEqual(fill(0x21));
    const dir = mkdtempSync(join(tmpdir(), "boot-pq-"));
    const p = bootPqPaths(join(dir, "data"), dir);
    expect(await syncBootUnlockFiles(p, { ownerHybridPub: null, strict: true })).toBe(false);
    writeFileSync(p.bootPem, "pem");
    expect(await syncBootUnlockFiles(p, { ownerHybridPub: new Uint8Array(1984).fill(1), strict: true })).toBe(true);
    expect(readFileSync(p.policy, "utf8")).toBe("strict\n");
    expect(await syncBootUnlockFiles(p, { ownerHybridPub: new Uint8Array(1984).fill(1), strict: true })).toBe(false);
    await syncBootUnlockFiles(p, { ownerHybridPub: null, strict: false });
    expect(readFileSync(p.policy, "utf8")).toBe("compat\n");
  });
});

// A real software TPM (swtpm) with the real tpm2-tools: runs where both exist (the drill VM, CI).
const have = (c: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${c}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const SWTPM = have("swtpm") && have("tpm2_createprimary") && have("tpm2_unseal");

describe.skipIf(!SWTPM)("with swtpm and tpm2-tools", () => {
  let tpm: ChildProcess;
  let state: string;
  beforeAll(async () => {
    state = mkdtempSync(join(tmpdir(), "swtpm-"));
    const port = 23000 + Math.floor(Math.random() * 2000);
    tpm = spawn("swtpm", ["socket", "--tpm2", "--tpmstate", `dir=${state}`, "--server", `type=tcp,port=${port}`, "--ctrl", `type=tcp,port=${port + 1}`, "--flags", "not-need-init,startup-clear"], { stdio: "ignore" });
    process.env.TPM2TOOLS_TCTI = `swtpm:host=127.0.0.1,port=${port}`;
    for (let i = 0; i < 50; i++) {
      if ((await systemTpmRunner.run("tpm2_getcap", ["properties-fixed"])).code === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // swtpm measures nothing: stand in for firmware measuring the boot chain.
    execFileSync("tpm2_pcrextend", [`7:sha256=${"aa".repeat(32)}`]);
  }, 30_000);
  afterAll(() => {
    tpm?.kill();
    delete process.env.TPM2TOOLS_TCTI;
  });

  it("seals under PCR 7, refuses after the chain changes, reseals the same seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-pq-"));
    const p = bootPqPaths(join(dir, "data"), join(dir, "boot"));
    const r = await ensureLeaseCustody(p, SEED);
    expect(r).toMatchObject({ custody: "tpm", pcrs: "sha256:7" });
    expect(await unsealFromTpm(p.leaseTpmDir)).toBe(SEED);
    execFileSync("tpm2_pcrextend", [`7:sha256=${"bb".repeat(32)}`]);
    await expect(unsealFromTpm(p.leaseTpmDir)).rejects.toThrow();
    await ensureLeaseCustody(p, SEED);
    expect(await unsealFromTpm(p.leaseTpmDir)).toBe(SEED);
  }, 60_000);
});
