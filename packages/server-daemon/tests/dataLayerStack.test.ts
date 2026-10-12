/**
 * The data layer's stack at boot (dataLayer/stack.ts): an older box whose
 * unit never retried gets the current unit and its core store (Postgres)
 * brought up, in the background, and provisioning fails fast with the reason
 * while it is down.
 */

import { describe, expect, it } from "vitest";
import {
  CORE_CONTAINERS,
  DataProvisioner,
  DataStack,
  InMemoryFilesAdmin,
  InMemoryPostgresAdmin,
  isDataLayerUnavailable,
  pgDatabase,
  type DataStackFs,
} from "../src/dataLayer/index.js";
import type { CommandRunner } from "../src/serviceRunner.js";

const COMPOSE = "/opt/flagship/installer/data-services/docker-compose.yml";
const ENV = "/var/flagship/data-services.env";
const UNIT = "/etc/systemd/system/flagship-data-services.service";
const UNIT_SRC = "/opt/flagship/installer/data-services/flagship-data-services.service";
const OLD_UNIT = "[Unit]\nConditionPathExists=!/var/flagship/data-services.env\n";
const NEW_UNIT = "[Unit]\n[Service]\nRestart=on-failure\n";

type Health = "healthy" | "starting" | "exited" | "missing";

function rig(
  over: {
    health?: Partial<Record<string, Health>>;
    files?: Record<string, string>;
    composeFails?: boolean;
    unit?: string;
    /** The stores turn healthy on their own after this many polls (a unit at work). */
    healAfterPolls?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const files: Record<string, string> = { [COMPOSE]: "services: {}", [ENV]: "X=1", [UNIT]: OLD_UNIT, [UNIT_SRC]: NEW_UNIT, ...(over.files ?? {}) };
  const health: Record<string, Health> = {
    [CORE_CONTAINERS.postgres]: "missing",
    ...(over.health ?? {}),
  };
  const calls: string[][] = [];
  let t = 0;
  let polls = 0;
  const reply = (args: string[]): { stdout: string; stderr: string } => {
    if (args[0] === "inspect" && over.healAfterPolls !== undefined && polls >= over.healAfterPolls) {
      for (const k of Object.keys(health)) health[k] = "healthy";
    }
    if (args[0] === "inspect") {
      const h = health[args[args.length - 1]!]!;
      if (h === "missing") throw new Error("Error: No such object");
      if (h === "exited") return { stdout: "exited|\n", stderr: "" };
      return { stdout: `running|${h}\n`, stderr: "" };
    }
    if (args[0] === "compose" && args.includes("up")) {
      if (over.composeFails) throw new Error("docker exited with code 1: pull access denied for pgvector/pgvector");
      // The containers come up and turn healthy on the next look.
      for (const k of Object.keys(health)) health[k] = "healthy";
    }
    return { stdout: "", stderr: "" };
  };
  const cmd: CommandRunner = {
    run: async (c, args) => {
      calls.push([c, ...args]);
      if (c === "docker") reply(args);
    },
    capture: async (c, args) => {
      calls.push([c, ...args]);
      if (c === "systemctl" && args[0] === "is-active") return { stdout: `${over.unit ?? "inactive"}\n`, stderr: "" };
      if (c === "docker") return reply(args);
      return { stdout: "", stderr: "" };
    },
  };
  const fs: DataStackFs = {
    exists: (p) => p in files,
    read: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    write: async (p, c) => {
      files[p] = c;
    },
  };
  const logs: string[] = [];
  const stack = new DataStack({
    cmd,
    fs,
    sleep:
      over.sleep ??
      (async (ms) => {
        t += ms;
        polls++;
      }),
    now: () => t,
    log: (m) => logs.push(m),
    maxRetries: 0,
  });
  return { stack, calls, files, health, logs };
}

describe("DataStack at boot", () => {
  it("installs the current unit over the old one and brings the missing core stores up", async () => {
    const r = rig();
    expect(await r.stack.ensure()).toBe("healthy");
    expect(r.files[UNIT]).toBe(NEW_UNIT);
    expect(r.calls).toContainEqual(["systemctl", "daemon-reload"]);
    expect(r.calls).toContainEqual(["docker", "compose", "-f", COMPOSE, "--env-file", ENV, "up", "-d", "postgres"]);
    // Then the (now current) unit brings the optional services up.
    expect(r.calls).toContainEqual(["systemctl", "start", "--no-block", "flagship-data-services.service"]);
    expect(r.stack.status()).toEqual({ state: "healthy" });
  });

  it("leaves a healthy stack alone", async () => {
    const r = rig({ health: { "flagship-postgres": "healthy" }, files: { [UNIT]: NEW_UNIT } });
    expect(await r.stack.ensure()).toBe("healthy");
    expect(r.calls.some((c) => c.includes("up"))).toBe(false);
    expect(r.calls.some((c) => c[0] === "systemctl" && c[1] === "start")).toBe(false);
    expect(r.calls).not.toContainEqual(["systemctl", "daemon-reload"]);
  });

  it("starts the unit instead when the secrets don't exist yet", async () => {
    // init.sh (via the unit) brings them up meanwhile.
    const r = rig({ healAfterPolls: 2 });
    delete r.files[ENV];
    expect(await r.stack.ensure()).toBe("healthy");
    expect(r.calls).toContainEqual(["systemctl", "start", "--no-block", "flagship-data-services.service"]);
    expect(r.calls.some((c) => c.includes("up"))).toBe(false);
  });

  it("waits for a unit that is already bringing the stack up, rather than racing it", async () => {
    const r = rig({ unit: "activating", healAfterPolls: 2 });
    expect(await r.stack.ensure()).toBe("healthy");
    expect(r.calls.some((c) => c.includes("up"))).toBe(false);
  });

  it("a bring-up that fails leaves it down with the reason, and provisioning fails fast with it", async () => {
    const r = rig({ composeFails: true });
    expect(await r.stack.ensure()).toBe("down");
    expect(r.stack.status().reason).toMatch(/compose couldn't start the core stores/);
    const p = new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      ready: () => r.stack.ready(),
    });
    const err = await p.provisionApp({ creator: "harry", slug: "notes", stores: { postgres: true } }).catch((e: unknown) => e);
    expect(isDataLayerUnavailable(err)).toBe(true);
    expect((err as Error).message).toMatch(/isn't running/);
  });

  it("stores that never turn healthy end down after the bound", async () => {
    const r = rig({ health: { "flagship-postgres": "starting" } });
    expect(await r.stack.ensure()).toBe("down");
    expect(r.stack.status().reason).toMatch(/postgres starting/);
  });

  it("is never in the way on a host without the compose stack", async () => {
    const r = rig();
    delete r.files[COMPOSE];
    expect(await r.stack.ensure()).toBe("absent");
    await expect(r.stack.ready()).resolves.toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it("attaches the provisioner's admins once healthy, before anything waiting on ready() proceeds", async () => {
    // Real (short) timers: the provisioner's wait outlasts the bring-up.
    const r = rig({ sleep: (ms) => new Promise((res) => setTimeout(res, ms >= 60_000 ? 500 : 1)) });
    // As the runtime does: files from the start, Postgres attached once healthy.
    const p = new DataProvisioner({ files: new InMemoryFilesAdmin(), ready: () => r.stack.ready({ waitMs: 60_000 }) });
    const key = "n".repeat(40);
    r.stack.onHealthy(() => p.attach({ postgres: new InMemoryPostgresAdmin(), nameKey: key }));
    expect(p.hasAdmins()).toBe(false);
    const pending = p.provisionApp({ creator: "harry", slug: "notes", stores: { postgres: true, files: true } });
    await r.stack.ensure();
    const creds = await pending;
    expect(creds.postgres!.default!.database).toBe(pgDatabase({ creator: "harry", slug: "notes" }, key));
    expect(creds.files!.volume).toBe("flagship-files-harry-notes");
  });
});
