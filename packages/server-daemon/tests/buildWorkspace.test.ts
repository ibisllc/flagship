import { describe, expect, it } from "vitest";
import { BuildWorkspace, isSafeBuildPath } from "../src/buildmodes/buildWorkspace.js";

describe("isSafeBuildPath", () => {
  it("accepts ordinary relative paths", () => {
    expect(isSafeBuildPath("flagship.app.json")).toBe(true);
    expect(isSafeBuildPath("src/index.js")).toBe(true);
    expect(isSafeBuildPath("migrations/0001_init.sql")).toBe(true);
  });
  it("rejects traversal, absolute, backslash, NUL, empty", () => {
    expect(isSafeBuildPath("../etc/passwd")).toBe(false);
    expect(isSafeBuildPath("a/../../b")).toBe(false);
    expect(isSafeBuildPath("/etc/passwd")).toBe(false);
    expect(isSafeBuildPath("a\\b")).toBe(false);
    expect(isSafeBuildPath("a\0b")).toBe(false);
    expect(isSafeBuildPath("")).toBe(false);
    expect(isSafeBuildPath("a/./b")).toBe(false);
  });
});

describe("BuildWorkspace", () => {
  it("writes, reads, lists, deletes", () => {
    const ws = new BuildWorkspace();
    expect(ws.write("src/a.js", "x").ok).toBe(true);
    expect(ws.write("flagship.app.json", "{}").ok).toBe(true);
    expect(ws.read("src/a.js")).toBe("x");
    expect(ws.list()).toEqual(["flagship.app.json", "src/a.js"]);
    expect(ws.manifestJson()).toBe("{}");
    expect(ws.delete("src/a.js")).toBe(true);
    expect(ws.read("src/a.js")).toBeNull();
  });
  it("rejects unsafe paths on write", () => {
    const ws = new BuildWorkspace();
    expect(ws.write("../escape", "x").ok).toBe(false);
  });
  it("seeds from an initial tree and snapshots back", () => {
    const ws = new BuildWorkspace({ "a.txt": "1", "b/c.txt": "2" });
    expect(ws.count()).toBe(2);
    expect(ws.snapshot()).toEqual({ "a.txt": "1", "b/c.txt": "2" });
  });
});
