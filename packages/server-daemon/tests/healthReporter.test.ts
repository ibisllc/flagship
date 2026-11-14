import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBoxHealthReport, ed, TAG_BOX_HEALTH } from "@flagship/protocol";
import {
  HEALTH_SCRIPT_PATH,
  HEALTH_TIMER_PATH,
  buildHealthReportScript,
  healthKeyPath,
  installHealthReporter,
} from "../src/healthReporter.js";

const OPENSSL3 = "/opt/homebrew/opt/openssl@3/bin/openssl";
const ARGS = { controlPlaneBaseUrl: "https://flagshipserver.com", serverDomain: "home2.harry.flagship.services" };

describe("box health reporter", () => {
  it("generates a script bash accepts, posting to this box's health route", () => {
    const script = buildHealthReportScript({ ...ARGS, keyPath: "/boot/identity.pem" });
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

  it("waits briefly for the relay tunnel, so the report that ends Studio's \"Unlocking\" comes as soon as it is up", () => {
    const script = buildHealthReportScript({ ...ARGS, keyPath: "/boot/identity.pem" });
    const wait = script.indexOf("tunnel_up && break; sleep 5");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(script.indexOf("uptime_s="));
    expect(script).toContain("tunnel_up && tunnel=true");
  });

  it("signs with the boot key when the box has one (no STK on /boot), else the STK PEM", () => {
    expect(healthKeyPath((p) => p === "/boot/flagship-boot-key.pem")).toBe("/boot/flagship-boot-key.pem");
    expect(healthKeyPath(() => false)).toBe("/boot/identity.pem");
    expect(buildHealthReportScript({ ...ARGS, keyPath: "/boot/flagship-boot-key.pem" })).toContain("-inkey /boot/flagship-boot-key.pem -rawin");
    expect(() => buildHealthReportScript({ ...ARGS, keyPath: "/boot/x;reboot" })).toThrow();
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

  it("signs the tagged flagship/box-health/v1 bytes, not the bare report (B2 #2)", () => {
    const script = buildHealthReportScript({ ...ARGS, keyPath: "/boot/identity.pem" });
    expect(script).toContain(`printf '%s|%s' '${TAG_BOX_HEALTH}' "$report" > "$tmp"`);
    expect(script).not.toContain(`printf '%s' "$report" > "$tmp"`);
    // The JSON body still carries the bare report: .com rebuilds the tagged bytes from it.
    expect(script).toContain("{report:$r, signature:$s}");
  });

  it("writes exactly the bytes .com verifies (the script's own printf, under bash)", () => {
    const script = buildHealthReportScript({ ...ARGS, keyPath: "/boot/identity.pem" });
    const line = script.split("\n").find((l) => l.startsWith("printf '%s|%s'"))!;
    const dir = mkdtempSync(join(tmpdir(), "health-tag-"));
    try {
      const report = '{"v":1,"domain":"home2.harry.flagship.services","at":1}';
      execFileSync("bash", ["-c", `report='${report}'; tmp=${join(dir, "m")}; ${line}`]);
      const written = execFileSync("cat", [join(dir, "m")]);
      expect(Buffer.from(written).equals(Buffer.from(canonicalBoxHealthReport(report)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("strict servers: the timer asks keyd for a hybrid signature", () => {
    // Runs the generated script with stand-ins for node (keyd's sign-health), openssl and curl.
    async function run(nodeOut: string | null): Promise<Record<string, unknown> | null> {
      const dir = mkdtempSync("/tmp/hr-");
      const sock = join(dir, "k.sock");
      const server = createServer();
      await new Promise<void>((r) => server.listen(sock, r));
      try {
        const stub = (name: string, body: string) => {
          writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
          chmodSync(join(dir, name), 0o755);
        };
        stub("node", nodeOut === null ? "exit 1" : `[ "$2" = sign-health ] && [ -f "$3" ] && printf '%s' '${nodeOut}'`);
        stub("openssl", "head -c 64 /dev/zero");
        stub("systemctl", "echo 0");
        stub("ss", "true");
        stub("curl", `while [ $# -gt 0 ]; do [ "$1" = --data ] && printf '%s' "$2" > ${join(dir, "body")}; shift; done`);
        writeFileSync(join(dir, "main.js"), "");
        writeFileSync(join(dir, "r.sh"), buildHealthReportScript({
          ...ARGS, keyPath: "/boot/identity.pem", nodePath: join(dir, "node"), keydEntry: join(dir, "main.js"), keydSocket: sock,
        }));
        execFileSync("bash", [join(dir, "r.sh")], { env: { PATH: `${dir}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin` }, stdio: "ignore" });
        return existsSync(join(dir, "body")) ? (JSON.parse(readFileSync(join(dir, "body"), "utf8")) as Record<string, unknown>) : null;
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("sends keyd's STK signature and its hybrid pqSignature", async () => {
      const sig = "ab".repeat(64);
      const hybrid = "cd".repeat(3373);
      const body = await run(JSON.stringify({ signature: sig, hybrid }));
      expect(body).toMatchObject({ signature: sig, pqSignature: { suite: "hybrid-ed25519-mldsa65/v1", signature: hybrid } });
    });

    it("falls back to the boot key, classical only, when keyd cannot sign or answers junk", async () => {
      for (const out of [null, JSON.stringify({ signature: "zz" }), JSON.stringify({ signature: "ab".repeat(64), hybrid: "cd" })]) {
        const body = await run(out);
        expect(body).not.toBeNull();
        if (out?.includes('"hybrid":"cd"')) {
          // A short hybrid is dropped; keyd's classical signature still goes.
          expect(body).toEqual({ report: expect.any(String), signature: "ab".repeat(64) });
        } else {
          expect(body).toEqual({ report: expect.any(String), signature: "00".repeat(64) });
        }
      }
    });
  });
});
