import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import {
  HEALTH_SCRIPT_PATH,
  HEALTH_TIMER_PATH,
  buildHealthReportScript,
  installHealthReporter,
} from "../src/healthReporter.js";

const OPENSSL3 = "/opt/homebrew/opt/openssl@3/bin/openssl";
const ARGS = { controlPlaneBaseUrl: "https://flagshipserver.com", serverDomain: "home2.harry.flagship.services" };

describe("box health reporter", () => {
  it("generates a script bash accepts, posting to this box's health route", () => {
    const script = buildHealthReportScript(ARGS);
    const dir = mkdtempSync(join(tmpdir(), "health-"));
    try {
      writeFileSync(join(dir, "r.sh"), script);
      execFileSync("bash", ["-n", join(dir, "r.sh")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(script).toContain("https://flagshipserver.com/api/server/home2.harry.flagship.services/health");
    expect(script).toContain("openssl pkeyutl -sign -inkey /boot/identity.pem -rawin");
    // Only fixed fields and enums leave the box: no journal, no logs.
    expect(script).not.toMatch(/journalctl|\/var\/log/);
  });

  it("refuses URLs or domains that could break out of the script", () => {
    expect(() => buildHealthReportScript({ ...ARGS, controlPlaneBaseUrl: "https://x.com/$(reboot)" })).toThrow();
    expect(() => buildHealthReportScript({ ...ARGS, serverDomain: "a;rm -rf /" })).toThrow();
  });

  it("installs once, then only re-enables the timer", async () => {
    const files = new Map<string, string>();
    const runs: string[] = [];
    const opts = {
      ...ARGS,
      hasSystemd: () => true,
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      run: async (cmd: string, args: string[]) => void runs.push([cmd, ...args].join(" ")),
    };
    expect(await installHealthReporter(opts)).toBe(true);
    expect(files.has(HEALTH_SCRIPT_PATH) && files.has(HEALTH_TIMER_PATH)).toBe(true);
    expect(await installHealthReporter(opts)).toBe(false);
    expect(runs).toEqual([
      "systemctl daemon-reload",
      "systemctl enable --now flagship-health.timer",
      "systemctl enable --now flagship-health.timer",
    ]);
    expect(await installHealthReporter({ ...opts, hasSystemd: () => false })).toBe(false);
  });

  it.skipIf(!existsSync(OPENSSL3))("signs bytes that .com's Ed25519 check accepts (openssl pkeyutl, as on the box)", () => {
    const dir = mkdtempSync(join(tmpdir(), "health-sig-"));
    try {
      const seed = new Uint8Array(32).fill(7);
      // The same PKCS8 wrapping install-helper writes to /boot/identity.pem.
      const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
      const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
      writeFileSync(join(dir, "key.pem"), pem);
      const report = '{"v":1,"domain":"home2.harry.flagship.services","at":1}';
      writeFileSync(join(dir, "r"), report);
      const sig = execFileSync(OPENSSL3, ["pkeyutl", "-sign", "-inkey", join(dir, "key.pem"), "-rawin", "-in", join(dir, "r")]);
      expect(sig.length).toBe(64);
      expect(ed.verify(new Uint8Array(sig), new TextEncoder().encode(report), ed.getPublicKey(seed))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
