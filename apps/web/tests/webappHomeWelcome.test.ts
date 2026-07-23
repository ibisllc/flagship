import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homeIdentityLine } from "../public/webapp/views/home.js";

// The account's chosen name is ciphertext on the wire and decrypted locally,
// so Home must lead with it when readable and degrade to the routing handle
// when it isn't — never show a blank or a placeholder.
describe("web Home — welcome hierarchy", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "public", "webapp", "views", "home.js"),
    "utf8",
  );

  it("renders the account and device breadcrumb", () => {
    expect(homeIdentityLine({
      accountDisplayName: "Johnson Family",
      username: "jolly-quince",
      deviceDisplayName: "MacBook",
    })).toBe("Johnson Family > MacBook");
  });

  it("falls back to the username when the account name is unavailable", () => {
    expect(homeIdentityLine({ username: "jolly-quince", deviceDisplayName: "MacBook" }))
      .toBe("jolly-quince > MacBook");
    expect(src).toContain("d.isCurrent");
  });

  it("reads names only from the locally decrypted directory", () => {
    expect(src).toContain("fetchDecryptedDirectory");
    // A failure to decrypt must not blank the greeting.
    expect(src).toMatch(/catch\s*\{[\s\S]*?username stands alone/);
  });
});
