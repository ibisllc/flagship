import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostExec } from "../src/policy.js";

// The daemon's "Lock and restart" asked for the marker with an argv both helpers refuse, so every lock from an
// unprivileged daemon became a shutdown (gym run 53). Pin the daemon's exact call to what the policy allows.
describe("the daemon's bootlock call", () => {
  it("is one the policy accepts", () => {
    const src = readFileSync(fileURLToPath(new URL("../../server-daemon/src/hostPower.ts", import.meta.url)), "utf8");
    const m = /privd\(\)\.host\("bootlock", (\[[^\]]*\])\)/.exec(src);
    expect(m).not.toBeNull();
    const argv = JSON.parse(m![1]!) as string[];
    const e = hostExec({ file: "bootlock", argv }, () => "");
    expect(e.file).toBe("/bin/sh");
    expect(e.args.join(" ")).toContain("/boot/flagship-lock-once");
  });
});
