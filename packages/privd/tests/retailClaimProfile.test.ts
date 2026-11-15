// The retail claim helper (docs/retail-box-setup.md §16): flagship-privd with --profile retail-claim
// answers the claim service's two root steps and refuses everything else the full broker would run.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivdClient, PrivdError, PrivdServer, RETAIL_CLAIM_STEPS, SETUP_STEPS, validateRetailClaimRequest, type Exec, type RunResult } from "../src/index.js";

describe("the claim helper's policy", () => {
  it("runs exactly the two claim steps through the release's setup.js", () => {
    expect([...RETAIL_CLAIM_STEPS]).toEqual(["retail-wipe", "retail-first-boot"]);
    for (const step of RETAIL_CLAIM_STEPS) {
      expect(validateRetailClaimRequest("setup", { step })).toMatchObject({ file: "/usr/local/bin/node", args: ["/opt/flagship/packages/server-daemon/dist/setup.js", step] });
    }
  });

  it("refuses every other step, every other operation and extra fields", () => {
    const refused = (f: () => unknown) => expect(f).toThrow(PrivdError);
    for (const step of SETUP_STEPS.filter((s) => s !== "retail-wipe")) refused(() => validateRetailClaimRequest("setup", { step }));
    for (const op of ["power", "systemd.restart", "systemctl", "docker", "docker.file", "host", "iptables.restore", "nft.apply", "release", "wipe", "wasi.unit", "wasi.logs"] as const) {
      refused(() => validateRetailClaimRequest(op, { action: "reboot" }));
    }
    refused(() => validateRetailClaimRequest("setup", { step: "retail-wipe", extra: 1 }));
    refused(() => validateRetailClaimRequest("setup", { step: "retail-wipe; reboot" }));
  });

  it("the full broker never gets the restart into a first boot", () => {
    expect(SETUP_STEPS).toContain("retail-wipe");
    expect(SETUP_STEPS as readonly string[]).not.toContain("retail-first-boot");
  });
});

describe("the claim helper over its socket", () => {
  it("runs a claim step, refuses power and docker without running them, and audits all three", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claim-helper-"));
    const socketPath = join(dir, "helper.sock");
    const auditPath = join(dir, "audit.log");
    const ran: Exec[] = [];
    const run = async (e: Exec): Promise<RunResult> => (ran.push(e), { code: 0, stdout: '{"rebooting":true}', stderr: "", timedOut: false });
    const server = new PrivdServer({ socketPath, run, auditPath, profile: "retail-claim" });
    await server.start();
    const client = new PrivdClient(socketPath);
    try {
      expect(await client.setup("retail-first-boot")).toMatchObject({ stdout: '{"rebooting":true}' });
      await expect(client.power("reboot")).rejects.toMatchObject({ code: "forbidden" });
      await expect(client.docker(["ps"])).rejects.toMatchObject({ code: "forbidden" });
      await expect(client.setup("server-code")).rejects.toMatchObject({ code: "forbidden" });
      expect(ran.map((e) => e.args[1])).toEqual(["retail-first-boot"]);
      const audit = await readFile(auditPath, "utf8");
      expect(audit.match(/"ok":false/g)).toHaveLength(3);
    } finally {
      client.close();
      await server.stop();
    }
  });
});
