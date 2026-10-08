/**
 * Verifies the H4 cross-check (#14) in scripts/flagship-bootstrap.start.
 *
 * The check ensures the trailer's embedded IRK pubkey matches the
 * CA-signed binding for the trailer's username. Without this, an
 * evil-maid USB swap with attacker-IRK-signed content would pass
 * parseTrailer's self-validation.
 *
 * We don't run the whole bootstrap; instead we assert the script
 * contains the load-bearing lines that constitute the gate.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOTSTRAP = readFileSync(
  join(__dirname, "..", "scripts", "flagship-bootstrap.start"),
  "utf8",
);

describe("bootstrap H4 cross-check (#14)", () => {
  it("fetches the CA pubkey-cert before running the installer", () => {
    expect(BOOTSTRAP).toMatch(/curl[\s\S]{0,200}flagshipserver\.com\/api\/users\/[\s\S]{0,200}pubkey-cert/);
  });

  it("extracts username + IRK from the trailer JSON", () => {
    expect(BOOTSTRAP).toMatch(/jq -r \.username[^\n]+BLOB/);
    expect(BOOTSTRAP).toMatch(/jq -r \.userPubKey[^\n]+BLOB/);
  });

  it("compares trailer IRK to CA IRK (case-insensitive hex compare)", () => {
    expect(BOOTSTRAP).toMatch(/tr '\[:upper:\]' '\[:lower:\]'/);
    expect(BOOTSTRAP).toMatch(/!=/);
    expect(BOOTSTRAP).toMatch(/refusing to install/);
  });

  it("rejects malformed username shape before the URL fetch (no metacharacter injection)", () => {
    // The case-glob enumerates the SAFE charset; any byte outside
    // [A-Za-z0-9.-] in the username trips the negation.
    expect(BOOTSTRAP).toMatch(/\*\[!A-Za-z0-9\.-\]\*/);
  });

  it("requires the CA cross-check to PRECEDE the installerGitRef use", () => {
    const caIdx = BOOTSTRAP.indexOf("/api/users/");
    const refIdx = BOOTSTRAP.indexOf('jq -r .installerGitRef');
    expect(caIdx).toBeGreaterThan(0);
    expect(refIdx).toBeGreaterThan(caIdx); // CA cross-check runs first
  });

  it("treats curl failure as install-refused (no fallthrough on empty response)", () => {
    expect(BOOTSTRAP).toMatch(/CA_CERT=/);
    expect(BOOTSTRAP).toMatch(/curl[\s\S]*pubkey-cert/);
    // Empty-result handling exits non-zero with a refusing-to-install message.
    expect(BOOTSTRAP).toMatch(/-z "\$CA_CERT"[\s\S]+refusing to install/);
  });
});
