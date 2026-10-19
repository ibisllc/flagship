import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// test-vectors/device-pairing-relay.json is what Android and iOS read. The
// generator runs the web for real and checks it against node:crypto before it
// writes, so a file that passes --check holds only values the web agrees with.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "test-vectors/device-pairing-relay.json");

describe("device-pairing-relay vectors", () => {
  it("the file is what the generator writes", () => {
    execFileSync("node", [join(ROOT, "tools/device-pairing-relay-vectors.mjs"), "--check"], { cwd: ROOT });
  });

  it("holds a six-digit code and two sealed payloads", () => {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    expect(v.sas).toMatch(/^\d{6}$/);
    expect(v.leg1Payload.ciphertextB64u.length).toBeGreaterThan(40);
    expect(v.bundle.ciphertextB64u.length).toBeGreaterThan(40);
  });
});
