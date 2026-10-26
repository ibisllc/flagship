import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeEngine, rootEngine, setActiveEngine, type ArchV2Config } from "../src/engine/engine.js";

let dir = "";
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "root-engine-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const cfg = (engine: "docker" | "podman"): (() => ArchV2Config) => () => ({ version: 1, rust: "off", engine });

describe("the engine as a root setup step sees it", () => {
  it("takes the engine-active record first, then the switch file, else Docker", () => {
    const rec = join(dir, "engine-active");
    expect(rootEngine(rec, cfg("podman"))).toBe("podman"); // no record: the switch says Podman
    expect(rootEngine(rec, cfg("docker"))).toBe("docker");
    writeFileSync(rec, "podman\n");
    expect(rootEngine(rec, cfg("docker"))).toBe("podman"); // the record wins (a failed move stays on Docker)
    writeFileSync(rec, "docker\n");
    expect(rootEngine(rec, cfg("podman"))).toBe("docker");
    writeFileSync(rec, "garbage");
    expect(rootEngine(rec, cfg("podman"))).toBe("podman");
  });

  it("is what the root entry point installs before any step runs (the gVisor step assumed Docker on every Podman box)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "setup.ts"), "utf8");
    const entry = src.slice(src.indexOf("if (invokedDirectly)"));
    expect(entry.indexOf("setActiveEngine(rootEngine())")).toBeGreaterThan(-1);
    expect(entry.indexOf("setActiveEngine(rootEngine())")).toBeLessThan(entry.indexOf("step().then"));
  });

  it("changes what ensureGvisor registers with: Podman when the process was told so", () => {
    const before = activeEngine();
    setActiveEngine("podman");
    expect(activeEngine()).toBe("podman");
    setActiveEngine(before);
  });
});
