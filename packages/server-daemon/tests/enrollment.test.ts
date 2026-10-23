import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverCode, verifyEnrollmentProof } from "@flagship/protocol";
import { enrollmentDeviceInfo, forgetEnrollmentSecret, showServerCode } from "../src/enrollment.js";

const STK = "ab".repeat(32);
const SECRET = "77".repeat(32);

function blob(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  const p = join(dir, "install-blob.json");
  writeFileSync(p, JSON.stringify({ serverDomain: "home.alice.flagship.services", authCode: { serial: "AC-7Q2M-91XZ" }, ...extra }));
  return p;
}

describe("first contact on the box", () => {
  it("proves the key with the recipe's secret, which the creating device can check", async () => {
    const p = blob({ enrollmentKeyHex: SECRET });
    const info = await enrollmentDeviceInfo({ blobPath: p, serverDomain: "home.alice.flagship.services", stkPubHex: STK });
    expect(verifyEnrollmentProof(Buffer.from(SECRET, "hex"), { serverDomain: "home.alice.flagship.services", stkPubHex: STK, authCodeSerial: "AC-7Q2M-91XZ" }, info.enrollmentProof)).toBe(true);
    expect(verifyEnrollmentProof(Buffer.from(SECRET, "hex"), { serverDomain: "home.alice.flagship.services", stkPubHex: "cd".repeat(32), authCodeSerial: "AC-7Q2M-91XZ" }, info.enrollmentProof)).toBe(false);
  });

  it("sends nothing without a secret, and forgets the secret after the blessing, leaving the rest", async () => {
    expect(await enrollmentDeviceInfo({ blobPath: blob(), serverDomain: "home.alice.flagship.services", stkPubHex: STK })).toEqual({});
    const p = blob({ enrollmentKeyHex: SECRET });
    await forgetEnrollmentSecret(p);
    const after = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    expect(after.enrollmentKeyHex).toBeUndefined();
    expect(after.authCode).toEqual({ serial: "AC-7Q2M-91XZ" });
    await forgetEnrollmentSecret(join(tmpdir(), "nope", "install-blob.json"));
  });

  it("shows the six-digit code on the login banner and the console", async () => {
    const dir = mkdtempSync(join(tmpdir(), "code-"));
    const code = await showServerCode({ stkPubHex: STK, serverDomain: "home.alice.flagship.services", issuePath: join(dir, "issue.d", "x.issue"), consolePath: join(dir, "console"), studioPortPath: join(dir, "port") });
    expect(code).toBe(serverCode(STK));
    const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(readFileSync(join(dir, "issue.d", "x.issue"), "utf8")).toContain(pretty);
    expect(readFileSync(join(dir, "console"), "utf8")).toContain(pretty);
    expect(readFileSync(join(dir, "console"), "utf8")).toContain(`flagship-server-code home.alice.flagship.services ${code} ${STK}\n`);
    expect(readFileSync(join(dir, "port"), "utf8")).toBe(`flagship-server-code home.alice.flagship.services ${code} ${STK}\n`);
  });
});
