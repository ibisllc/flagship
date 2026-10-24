import { describe, expect, it } from "vitest";
import { bindOptions, migrateDockerToPodman, parseImageList, readMigrationMarker, rollbackToDocker, type MigrationDeps } from "../src/engine/migrate.js";

interface Call {
  cmd: string;
  args: string[];
}

function world(opts: { dockerAnswers?: boolean; podman?: boolean; failLoad?: boolean } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const volumes: Record<string, unknown> = {
    "flagship-files-alice--notes": { Name: "flagship-files-alice--notes", Driver: "local", Mountpoint: "/var/lib/docker/volumes/x/_data", Options: { type: "none", o: "bind", device: "/var/lib/flagship-files/flagship-files-alice--notes/data" } },
    "forgejo-cache": { Name: "forgejo-cache", Driver: "local", Mountpoint: "/var/lib/docker/volumes/forgejo-cache/_data", Options: null },
  };
  const answer = (cmd: string, args: string[]): string => {
    const k = `${cmd} ${args.join(" ")}`;
    if (k === "podman --version") {
      if (opts.podman === false) throw new Error("ENOENT");
      return "podman version 5.4.2";
    }
    if (k === "docker info --format {{.ServerVersion}}") return opts.dockerAnswers === false ? "" : "26.1.5";
    if (k.startsWith("docker ps -q")) return "c1\nc2\n";
    if (k.startsWith("docker images")) return "flagship-alice--notes 3\n<none> <none>\nnode 24-trixie-slim\n";
    if (k === "docker volume ls -q") return Object.keys(volumes).join("\n");
    if (k === "podman volume ls -q") return "";
    if (k.startsWith("docker volume inspect")) return JSON.stringify(volumes[args[args.length - 1]!]);
    if (k.startsWith("podman volume inspect")) return "/var/lib/containers/storage/volumes/forgejo-cache/_data\n";
    if (k.startsWith("podman load") && opts.failLoad) throw new Error("podman load failed");
    return "";
  };
  const deps: MigrationDeps = {
    cmd: {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        answer(cmd, args);
      },
      capture: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: answer(cmd, args), stderr: "" };
      },
    },
    exists: (p) => p === "/var/lib/docker",
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    spoolDir: "/tmp/flagship-test-spool-unused",
    now: () => new Date(0),
  };
  return { calls, files, deps };
}

describe("Docker to Podman, once", () => {
  it("moves tagged images one at a time and every named volume, then stops Docker", async () => {
    const w = world();
    const r = await migrateDockerToPodman(w.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marker.images).toEqual(["flagship-alice--notes:3", "node:24-trixie-slim"]);
    expect(r.marker.skipped).toEqual(["image <none> <none>"]);
    expect(r.marker.volumes).toEqual([
      { name: "flagship-files-alice--notes", how: "bind" },
      { name: "forgejo-cache", how: "copied" },
    ]);
    const k = w.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    // Writers stop before anything moves.
    expect(k.indexOf("docker stop c1 c2")).toBeLessThan(k.findIndex((x) => x.startsWith("docker save")));
    expect(k).toContain("podman volume create --opt type=none --opt o=bind --opt device=/var/lib/flagship-files/flagship-files-alice--notes/data flagship-files-alice--notes");
    expect(k).toContain("cp -a -- /var/lib/docker/volumes/forgejo-cache/_data/. /var/lib/containers/storage/volumes/forgejo-cache/_data/");
    expect(k).toContain("systemctl disable --now docker.socket docker.service");
    // Docker's data is never removed.
    expect(k.some((x) => /rm -rf|volume rm|rmi|image rm/.test(x))).toBe(false);
    expect(w.files.get("/var/lib/flagship/engine-active")).toBe("podman\n");
  });

  it("does nothing the second time", async () => {
    const w = world();
    await migrateDockerToPodman(w.deps);
    const before = w.calls.length;
    const again = await migrateDockerToPodman(w.deps);
    expect(again.ok && !again.ran).toBe(true);
    expect(w.calls.length).toBe(before);
  });

  it("records nothing-to-migrate on a box that never had Docker", async () => {
    const w = world();
    const r = await migrateDockerToPodman({ ...w.deps, exists: () => false });
    expect(r.ok && r.marker.result).toBe("nothing-to-migrate");
  });

  it("stays on Docker when Podman is missing or Docker does not answer", async () => {
    expect((await migrateDockerToPodman(world({ podman: false }).deps)).ok).toBe(false);
    const w = world({ dockerAnswers: false });
    const r = await migrateDockerToPodman(w.deps);
    expect(r.ok).toBe(false);
    expect(await readMigrationMarker(w.deps)).toBeNull();
  });

  it("restarts Docker and writes no marker when a step fails", async () => {
    const w = world({ failLoad: true });
    const r = await migrateDockerToPodman(w.deps);
    expect(r).toMatchObject({ ok: false, engine: "docker" });
    expect(w.calls.at(-1)).toEqual({ cmd: "systemctl", args: ["start", "docker.service"] });
    expect(await readMigrationMarker(w.deps)).toBeNull();
  });

  it("can go back: Docker comes up again and a later switch migrates again", async () => {
    const w = world();
    await migrateDockerToPodman(w.deps);
    expect((await rollbackToDocker(w.deps)).ok).toBe(true);
    expect((await readMigrationMarker(w.deps))?.result).toBe("rolled-back");
    expect(w.files.get("/var/lib/flagship/engine-active")).toBe("docker\n");
    const again = await migrateDockerToPodman(w.deps);
    expect(again.ok && again.ran).toBe(true);
  });
});

describe("parsing", () => {
  it("skips untagged and odd image names", () => {
    expect(parseImageList("a 1\n<none> <none>\nBAD;rm 1\na 1\n")).toEqual({ refs: ["a:1"], skipped: ["<none> <none>", "BAD;rm 1"] });
  });
  it("recognises only a local bind of an absolute folder", () => {
    expect(bindOptions({ Driver: "local", Options: { type: "none", o: "bind", device: "/x" } })).toEqual({ device: "/x" });
    expect(bindOptions({ Driver: "local", Options: { type: "none", o: "bind", device: "x" } })).toBeNull();
    expect(bindOptions({ Driver: "nfs", Options: { type: "none", o: "bind", device: "/x" } })).toBeNull();
  });
});
