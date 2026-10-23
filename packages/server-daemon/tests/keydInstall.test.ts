import { describe, expect, it } from "vitest";
import { installKeyd } from "../src/keydInstall.js";

function harness(over: { socket?: boolean; entry?: boolean; systemd?: boolean; up?: boolean; failOn?: string } = {}) {
  const runs: string[] = [];
  const files = new Map<string, string>();
  const opts = {
    repoPath: "/opt/flagship",
    socketPath: "/run/flagship-keyd/keyd.sock",
    run: async (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(" ");
      runs.push(line);
      if (over.failOn && line.includes(over.failOn)) throw new Error("boom");
    },
    hasSystemd: () => over.systemd ?? true,
    fileExists: (p: string) => (p.endsWith("keyd.sock") ? !!over.socket : p.endsWith("packages/keyd/dist/main.js") ? over.entry ?? true : false),
    read: async (p: string) => files.get(p) ?? null,
    write: async (p: string, c: string) => void files.set(p, c),
    waitForSocket: async () => over.up ?? true,
  };
  return { opts, runs, files };
}

describe("installing keyd on a box that runs without it", () => {
  it("writes the hardened unit and the daemon drop-in, starts keyd and asks for a restart", async () => {
    const h = harness();
    expect(await installKeyd(h.opts)).toBe("installed");
    expect(h.files.get("/etc/systemd/system/flagship-keyd.service")).toContain("NoNewPrivileges=yes");
    expect(h.files.get("/etc/systemd/system/flagship-keyd.service")).toContain("/opt/flagship/packages/keyd/dist/main.js serve");
    expect(h.files.get("/etc/systemd/system/flagship-daemon.service.d/20-keyd.conf")).toContain("Requires=flagship-keyd.service");
    expect(h.runs.some((r) => r.includes("useradd --system"))).toBe(true);
    expect(h.runs.slice(-2)).toEqual(["systemctl daemon-reload", "systemctl enable --now flagship-keyd.service"]);
  });

  it("leaves a box alone when keyd already answers, there is no systemd, or this release has no keyd", async () => {
    expect(await installKeyd(harness({ socket: true }).opts)).toBe("already-running");
    expect(await installKeyd(harness({ systemd: false }).opts)).toBe("skipped-no-systemd");
    const h = harness({ entry: false });
    expect(await installKeyd(h.opts)).toBe("skipped-no-keyd-build");
    expect(h.runs).toEqual([]);
  });

  it("reports failure without throwing, so the daemon keeps running as before", async () => {
    expect(await installKeyd(harness({ up: false }).opts)).toBe("failed");
    expect(await installKeyd(harness({ failOn: "daemon-reload" }).opts)).toBe("failed");
  });
});
