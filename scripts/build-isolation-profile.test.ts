import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const profile = JSON.parse(readFileSync(resolve(root, "release/build-isolation-profile.json"), "utf8")) as {
  holds: Array<{ id: string; claim: string; where: string; marker: string }>;
  doesNotHold: Array<{ id: string; claim: string }>;
};

describe("build isolation profile", () => {
  it("every claim it makes is still in the source it names", () => {
    for (const h of profile.holds) {
      const text = readFileSync(resolve(root, h.where), "utf8");
      expect(text.includes(h.marker), `${h.id}: "${h.marker}" is not in ${h.where}`).toBe(true);
    }
  });

  it("states what it does not hold, and never claims a boundary the code does not build", () => {
    expect(profile.doesNotHold.map((d) => d.id)).toEqual(expect.arrayContaining(["build-not-rootless", "build-not-gvisor"]));
    const all = JSON.stringify(profile.holds).toLowerCase();
    expect(all).not.toMatch(/microvm|rootless|tamper-proof|unbreakable/);
  });
});
