import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTAINER_LINKS_NETWORK, ensureContainerLinksUnmanaged } from "../src/containerLinks.js";
import type { CommandRunner } from "../src/serviceRunner.js";

function runner() {
  const calls: string[][] = [];
  const cmd: CommandRunner = { run: async (c, a) => void calls.push([c, ...a]) };
  return { cmd, calls };
}

describe("containers stay on their Docker bridges", () => {
  it("writes the unmanaged rule once and reloads networkd", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "links-")), "network");
    mkdirSync(dir);
    const path = join(dir, "10-flagship-containers.network");
    const { cmd, calls } = runner();
    expect(await ensureContainerLinksUnmanaged(cmd, { path })).toBe("written");
    expect(readFileSync(path, "utf-8")).toBe(CONTAINER_LINKS_NETWORK);
    expect(calls).toEqual([["networkctl", "reload"]]);
    expect(await ensureContainerLinksUnmanaged(cmd, { path })).toBe("present");
    expect(calls).toHaveLength(1);
  });

  it("rewrites a changed file and skips hosts without systemd-networkd", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "links-")), "network");
    mkdirSync(dir);
    const path = join(dir, "10-flagship-containers.network");
    writeFileSync(path, "[Match]\nName=*\n");
    const { cmd } = runner();
    expect(await ensureContainerLinksUnmanaged(cmd, { path })).toBe("written");
    expect(await ensureContainerLinksUnmanaged(cmd, { path: "/nonexistent-dir/x.network" })).toBe("skipped");
  });

  it("sorts before the appliance's catch-all wired rule", () => {
    expect("10-flagship-containers.network" < "20-flagship-wired.network").toBe(true);
    expect(CONTAINER_LINKS_NETWORK).toMatch(/Kind=veth bridge/);
    expect(CONTAINER_LINKS_NETWORK).toMatch(/Unmanaged=yes/);
  });
});
