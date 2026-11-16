// The owner's call hours in the webapp (apps/web/public/webapp/lib/voiciCallSettings.js) against
// packages/protocol/test-vectors/voici-call-modes/ section callSettings: sealed and synced, never on the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as S from "../public/webapp/lib/voiciCallSettings.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors/voici-call-modes/vectors.json"), "utf8"));
const X = V.callSettings;
const h = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

describe("webapp call settings", () => {
  it("key, seal and open as the TypeScript reference", () => {
    const key = S.deriveVoiciCallSettingsKey({ seed: h(X.ownerUmk) });
    expect(Buffer.from(key).toString("hex")).toBe(X.key);
    expect(S.sealVoiciCallSettings(key, X.username, X.sealed.version, X.plain, h(X.nonce))).toEqual(X.sealed);
    expect(S.openVoiciCallSettings(key, X.username, X.sealed)).toEqual(X.plain);
    expect(S.openVoiciCallSettings(key, "bob", X.sealed)).toBeNull();
  });
  it("hours shapes and when a call may ring", () => {
    for (const c of X.hoursShapes) expect(S.parseVoiciCallHours(c.value) !== null, c.name).toBe(c.expect);
    for (const c of X.hoursAllow) expect(S.voiciCallHoursAllow(c.hours, c.now), c.name).toBe(c.expect);
  });
});
