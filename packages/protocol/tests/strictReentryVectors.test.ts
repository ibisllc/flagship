import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StrictReentryError, TAG_STRICT_REENTRY, strictReentryEvidence, strictReentryTexts, type StrictReentryInputs } from "../src/strictReentry.js";

const PATH = new URL("../test-vectors/strict-reentry/vectors.json", import.meta.url);

const base: StrictReentryInputs = {
  account: "alice",
  scope: { kind: "installation", id: "home.alice.flagship.services" },
  leftStrictAt: 1_800_000_000_000,
  devices: [
    { role: "device", subjectId: "phone-b", ed25519PubHex: "bb".repeat(32), mldsaPubHex: "0b".repeat(48) },
    { role: "device", subjectId: "phone-a", ed25519PubHex: "aa".repeat(32), mldsaPubHex: "0a".repeat(48) },
  ],
  deviceCount: 2,
  adminRoot: { role: "admin-root", subjectId: "alice", ed25519PubHex: "cc".repeat(32), mldsaPubHex: "0c".repeat(48) },
  server: { role: "box", subjectId: "home.alice.flagship.services", ed25519PubHex: "dd".repeat(32), mldsaPubHex: "0d".repeat(48) },
  recoveryChecked: true,
  recoveryCheckedAt: 1_800_000_500_000,
  nonceHex: "ee".repeat(32),
  checkedAt: 1_800_000_900_000,
};

const cases: Array<{ name: string; inputs: StrictReentryInputs }> = [
  { name: "installation-with-admin-root", inputs: base },
  { name: "service-scope-no-admin-root", inputs: { ...base, scope: { kind: "service", id: "home.alice.flagship.services:alice--notes" }, adminRoot: null } },
];

function build() {
  return {
    tag: TAG_STRICT_REENTRY,
    cases: cases.map((c) => ({ name: c.name, inputs: c.inputs, texts: strictReentryTexts(c.inputs), evidence: strictReentryEvidence(c.inputs) })),
    refusals: [
      { name: "a device without its PQ key", inputs: { ...base, deviceCount: 3 }, code: "devices-not-enrolled" },
      { name: "recovery never checked", inputs: { ...base, recoveryChecked: false }, code: "recovery-not-checked" },
      { name: "short nonce", inputs: { ...base, nonceHex: "ee" }, code: "bad-input" },
    ],
  };
}

describe("strict re-entry evidence", () => {
  it("matches the committed vectors (regenerate with FLAGSHIP_WRITE_VECTORS=1)", () => {
    const v = build();
    if (process.env.FLAGSHIP_WRITE_VECTORS === "1") writeFileSync(PATH, JSON.stringify(v, null, 2) + "\n");
    expect(JSON.parse(readFileSync(PATH, "utf8"))).toEqual(JSON.parse(JSON.stringify(v)));
  });
  it("sorts bindings, so the order a client fetched them in does not matter", () => {
    const flipped = { ...base, devices: [...base.devices].reverse() };
    expect(strictReentryEvidence(flipped)).toEqual(strictReentryEvidence(base));
  });
  it("refuses what it cannot vouch for", () => {
    for (const r of build().refusals) {
      expect(() => strictReentryEvidence(r.inputs as StrictReentryInputs)).toThrow(StrictReentryError);
      try {
        strictReentryEvidence(r.inputs as StrictReentryInputs);
      } catch (e) {
        expect((e as StrictReentryError).code).toBe(r.code);
      }
    }
  });
});
