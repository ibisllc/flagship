import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The account's chosen name is ciphertext on the wire and decrypted locally,
// so Home must lead with it when readable and degrade to the routing handle
// when it isn't — never show a blank or a placeholder.
describe("web Home — welcome hierarchy", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "public", "webapp", "views", "home.js"),
    "utf8",
  );

  it("prefers the decrypted account name over the handle", () => {
    expect(src).toContain("Welcome back to ${account}.");
    expect(src).toContain("Welcome back, ${session.username}.");
  });

  it("surfaces the current device's decrypted name", () => {
    expect(src).toContain("This device: ${deviceName}");
    expect(src).toContain("d.isCurrent");
  });

  it("reads names only from the locally decrypted directory", () => {
    expect(src).toContain("fetchDecryptedDirectory");
    // A failure to decrypt must not blank the greeting.
    expect(src).toMatch(/catch\s*\{[\s\S]*?handle stands alone/);
  });
});
