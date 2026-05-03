#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { planBuild, type BuildSpec } from "./buildPlan.js";
import { invokeMkosi, materializePlan } from "./imageBuilder.js";

const program = new Command()
  .name("flagship-bootkey-builder")
  .description("Build a personalized Flagship server boot image")
  .requiredOption("--spec <path>", "path to BuildSpec JSON")
  .requiredOption("--out <dir>", "output directory")
  .option("--no-mkosi", "skip mkosi invocation; only materialize the rootfs tree")
  .action(async (opts: { spec: string; out: string; mkosi: boolean }) => {
    const raw = await readFile(opts.spec, "utf8");
    const spec = parseSpec(JSON.parse(raw));
    const plan = planBuild(spec);
    const artifacts = await materializePlan(plan, opts.out);

    console.log(`Build plan written to ${artifacts.planJsonPath}`);
    console.log(`rootfs config files: ${artifacts.configFilePaths.length}`);
    console.log(`partitions: ${plan.partitions.map((p) => `${p.name}=${p.sizeGb}GB`).join(", ")}`);

    if (opts.mkosi === false) {
      console.log("\n--no-mkosi: stopping after rootfs materialization");
      return;
    }

    console.log("\nInvoking mkosi...");
    const result = await invokeMkosi(artifacts);
    if (result.ok) {
      console.log(`disk image: ${result.diskImagePath}`);
    } else if (result.reason === "mkosi-not-installed") {
      console.log("mkosi is not installed on this host.");
      console.log(`The rootfs tree at ${result.rootfsDir} is the build artifact.`);
      console.log("Install mkosi (https://github.com/systemd/mkosi) and re-run, or feed");
      console.log("the rootfs to your image builder of choice.");
    } else {
      console.error(`mkosi failed: ${result.stderr}`);
      process.exit(1);
    }
  });

program.parseAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});

function parseSpec(raw: unknown): BuildSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("spec must be an object");
  const r = raw as Record<string, unknown>;
  const wifi = r.wifi as { ssid?: string; psk?: string } | undefined;
  if (!wifi || typeof wifi.ssid !== "string" || typeof wifi.psk !== "string") {
    throw new Error("spec.wifi must be { ssid, psk }");
  }
  return {
    userId: requireString(r, "userId"),
    newServerId: requireString(r, "newServerId"),
    irkPublicKey: requireHexBytes(r, "irkPublicKey", 32),
    bakPublicKey: requireHexBytes(r, "bakPublicKey", 32),
    swkProvisioningTokenHash: requireHexBytes(r, "swkProvisioningTokenHash", 32),
    wifi: { ssid: wifi.ssid, psk: wifi.psk },
    shareRatio: requireNumber(r, "shareRatio"),
    totalDiskGb: requireNumber(r, "totalDiskGb"),
    issuedAt: requireNumber(r, "issuedAt"),
  };
}

function requireString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new Error(`spec.${k} must be a string`);
  return v;
}

function requireNumber(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`spec.${k} must be a finite number`);
  }
  return v;
}

function requireHexBytes(o: Record<string, unknown>, k: string, len: number): Uint8Array {
  const v = o[k];
  if (typeof v !== "string" || v.length !== len * 2 || !/^[0-9a-f]+$/.test(v)) {
    throw new Error(`spec.${k} must be ${len * 2}-char hex`);
  }
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
