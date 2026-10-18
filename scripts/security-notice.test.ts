import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ed, parseSecurityNotice, verifySecurityNotice, securityNoticeOutcome } from "@flagship/protocol";
// @ts-expect-error plain ESM script
import * as sn from "./security-notice.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "security-notice.mjs");
const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 24 * 3600_000;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "notice-root-"));
}
const args = (...a: string[]) => sn.parseArgs(a);
const REQUIRED = [
  "required", "--message", "You must update Flagship by {date}.", "--event", "2026-11-01T00:00:00Z",
  "--lock-at", "2026-11-01T00:00:00Z", "--platform", "ios:12", "--platform", "android:40",
  "--advisory", "FSA-2026-001", "--security-reason", "A flaw lets an attacker act as you.",
];

describe("security-notice arguments", () => {
  it("reads repeated platforms and both flag spellings", () => {
    const a = args("advisory", "--platform", "ios:12", "--platform=android:40:2", "--message=Hello.");
    expect(a.verb).toBe("advisory");
    expect(a.platform).toEqual(["ios:12", "android:40:2"]);
    expect(a.message).toBe("Hello.");
  });

  it("refuses unknown flags and stray arguments", () => {
    expect(() => args("advisory", "--bogus")).toThrow(/unknown flag/);
    expect(() => args("advisory", "extra")).toThrow(/unexpected argument/);
    expect(() => args("advisory", "--sign=1")).toThrow(/takes no value/);
  });

  it("parses times and refuses vague ones", () => {
    expect(sn.parseTime("now", NOW, "x")).toBe(NOW);
    expect(sn.parseTime("+7d", NOW, "x")).toBe(NOW + 7 * DAY);
    expect(sn.parseTime("2026-10-21T09:00:00Z", NOW, "x")).toBe(Date.parse("2026-10-21T09:00:00Z"));
    expect(sn.parseTime("2026-10-21", NOW, "x")).toBe(Date.parse("2026-10-21T00:00:00Z"));
    expect(() => sn.parseTime("next tuesday", NOW, "x")).toThrow(/not a time/);
    expect(() => sn.parseTime("2026-10-21T09:00:00", NOW, "x")).toThrow(/not a time/);
  });
});

describe("security-notice body", () => {
  const root = tmpRoot();

  it("refuses update-required without an advisory or a security reason", () => {
    const base = ["required", "--message", "Update.", "--lock-at", "now", "--platform", "ios:12"];
    expect(() => sn.buildBody(args(...base, "--security-reason", "x."), { now: NOW, root })).toThrow(/--advisory/);
    expect(() => sn.buildBody(args(...base, "--advisory", "FSA-1"), { now: NOW, root })).toThrow(/--security-reason/);
    expect(() => sn.buildBody(args(...base.filter((x) => x !== "--lock-at" && x !== "now"), "--advisory", "FSA-1", "--security-reason", "x."), { now: NOW, root })).toThrow(/--lock-at/);
  });

  it("builds a complete update-required body the protocol accepts", () => {
    // Protocol 2 does not exist in this checkout yet, so the minimum needs the override.
    const { body, errors } = sn.buildBody(args(...REQUIRED, "--deprecate-protocol", "1", "--allow-unshipped"), { now: NOW, root });
    expect(errors).toEqual([]);
    expect(body.kind).toBe("update-required");
    expect(body.platforms.ios).toEqual({ minBuild: 12, minProtocol: 2 });
    expect(body.validUntil - body.validFrom).toBe(30 * DAY);
    expect(body.seq).toBe(1);
    expect(() => sn.canonicalOrExplain(body, "ab".repeat(32))).not.toThrow();
  });

  it("explains a rule the protocol enforces instead of leaking the code", () => {
    const { body } = sn.buildBody(args(...REQUIRED, "--until", "+31d"), { now: NOW, root });
    expect(() => sn.canonicalOrExplain(body, "ab".repeat(32))).toThrow(/at most 30 days/);
  });

  it("lints em dashes, emoji and overlong text as errors", () => {
    const e = (msg: string) => sn.buildBody(args("maintenance", "--message", msg), { now: NOW, root }).errors.join(" ");
    expect(e("We update soon — sorry.")).toMatch(/em dashes/);
    expect(e("We update soon \u{1F680}.")).toMatch(/emoji/);
    expect(e("x".repeat(281))).toMatch(/limit is 280/);
    expect(e("We update soon.")).toBe("");
  });

  it("clear takes nothing else", () => {
    expect(() => sn.buildBody(args("clear", "--message", "x"), { now: NOW, root })).toThrow(/clear takes no/);
    const { body, errors } = sn.buildBody(args("clear"), { now: NOW, root });
    expect(errors).toEqual([]);
    expect(body.kind).toBe("none");
    expect(body.message).toBe("");
  });

  it("keeps seq above everything ever signed and refuses a lower one", () => {
    const r = tmpRoot();
    fs.mkdirSync(path.join(r, "notices", "history"), { recursive: true });
    fs.writeFileSync(path.join(r, "notices", "history", "0007-maintenance.json"), "{}");
    fs.writeFileSync(path.join(r, "notices", "current.json"), JSON.stringify({ seq: 5, kind: "none" }));
    expect(sn.highestSignedSeq(r)).toBe(7);
    expect(sn.buildBody(args("clear"), { now: NOW, root: r }).body.seq).toBe(8);
    expect(sn.buildBody(args("clear", "--seq", "6"), { now: NOW, root: r }).errors.join(" ")).toMatch(/rollback/);
  });

  it("will not lift a lock in force without --supersede-lock", () => {
    const r = tmpRoot();
    fs.mkdirSync(path.join(r, "notices"), { recursive: true });
    fs.writeFileSync(
      path.join(r, "notices", "current.json"),
      JSON.stringify({ seq: 3, kind: "update-required", advisoryId: "FSA-9", validFrom: NOW - DAY, validUntil: NOW + DAY }),
    );
    const weak = ["maintenance", "--message", "We update soon."];
    expect(sn.buildBody(args(...weak), { now: NOW, root: r }).errors.join(" ")).toMatch(/replaces it and would unlock everyone/);
    expect(sn.buildBody(args(...weak, "--supersede-lock"), { now: NOW, root: r }).errors).toEqual([]);
    expect(sn.buildBody(args("clear"), { now: NOW, root: r }).errors.join(" ")).toMatch(/would unlock everyone/);
  });

  it("refuses a minimum no shipped build could satisfy, unless told", () => {
    const web = sn.shippedWebBuild();
    expect(web).toBeGreaterThan(100);
    const noPlatforms = REQUIRED.filter((x, i) => x !== "--platform" && REQUIRED[i - 1] !== "--platform");
    const mk = (spec: string, ...extra: string[]) =>
      sn.buildBody(args(...noPlatforms, "--platform", spec, ...extra), { now: NOW, root });
    expect(mk(`web:${web}`).errors).toEqual([]);
    expect(mk(`web:${web + 1}`).errors.join(" ")).toMatch(/no webapp could ever satisfy it/);
    expect(mk(`web:${web}:99`).errors.join(" ")).toMatch(/no build could ever satisfy it/);
    const forced = mk(`web:${web + 1}`, "--allow-unshipped");
    expect(forced.errors).toEqual([]);
    expect(forced.warnings.join(" ")).toMatch(/no webapp could ever satisfy it/);
    expect(mk("ios:12").warnings.join(" ")).toMatch(/confirm a store build/);
  });

  it("warns that a grace window keeps the old protocol alive", () => {
    const { warnings } = sn.buildBody(args(...REQUIRED), { now: NOW, root });
    expect(warnings.join(" ")).toMatch(/keeps the old protocol alive/);
    const lockAt = REQUIRED.indexOf("--lock-at") + 1;
    const immediate = sn.buildBody(args(...REQUIRED.map((x, i) => (i === lockAt ? "now" : x))), { now: NOW, root });
    expect(immediate.warnings.join(" ")).not.toMatch(/keeps the old protocol alive/);
  });
});

describe("security-notice signing", () => {
  it("signs with an injected signer, verifies as an app would, and writes current + history", async () => {
    const seed = new Uint8Array(32).fill(0x31);
    const pub = Buffer.from(ed.getPublicKey(seed)).toString("hex");
    const signer = {
      pubKey: pub,
      sign: (m: Uint8Array) => Buffer.from(ed.sign(m, seed)).toString("hex"),
    };
    const root = tmpRoot();
    const { body } = sn.buildBody(args(...REQUIRED, "--deprecate-protocol", "1", "--allow-unshipped"), { now: NOW, root });
    const notice = await sn.signAndWrite({ body, signer, root, authorityKeys: [pub] });
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "notices", "current.json"), "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(notice)));
    expect(fs.readdirSync(path.join(root, "notices", "history"))).toEqual(["0001-update-required.json"]);
    const parsed = parseSecurityNotice(onDisk)!;
    expect(verifySecurityNotice(parsed, [pub])).toEqual({ ok: true });
    expect(securityNoticeOutcome(parsed, { platform: "ios", build: 11, protocol: 1 }, Date.parse("2026-11-02T00:00:00Z")).action).toBe("lock");
    expect(sn.highestSignedSeq(root)).toBe(1);
  });

  it("writes nothing when the signer is not the authority", async () => {
    const seed = new Uint8Array(32).fill(0x32);
    const pub = Buffer.from(ed.getPublicKey(seed)).toString("hex");
    const root = tmpRoot();
    const { body } = sn.buildBody(args("clear"), { now: NOW, root });
    await expect(
      sn.signAndWrite({ body, signer: { pubKey: pub, sign: (m: Uint8Array) => Buffer.from(ed.sign(m, seed)).toString("hex") }, root, authorityKeys: ["00".repeat(32)] }),
    ).rejects.toThrow(/does not verify/);
    expect(fs.existsSync(path.join(root, "notices", "current.json"))).toBe(false);
  });

  it("will not build bytes for a body that breaks a rule", async () => {
    const root = tmpRoot();
    const { body } = sn.buildBody(args(...REQUIRED), { now: NOW, root });
    body.advisoryId = "";
    await expect(sn.signAndWrite({ body, signer: { pubKey: "ab".repeat(32), sign: () => "" }, root, authorityKeys: [] })).rejects.toThrow(/--advisory/);
  });
});

describe("security-notice command line", () => {
  const run = (a: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync("node", [SCRIPT, ...a], { encoding: "utf8", env: { ...process.env, FLAGSHIP_MAINTAINERS_DIR: "/nonexistent", ...extraEnv } });

  it("previews by default and writes nothing", () => {
    const root = tmpRoot();
    const r = run(["maintenance", "--message", "We will update Flagship on {date}. Flagship may be briefly unavailable.", "--event", "+3d", "--path", root, "--signing-key", "file:/nonexistent"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN: nothing signed, nothing written/);
    expect(r.stdout).toMatch(/flagship\/security-notice\/v1\|/);
    expect(fs.existsSync(path.join(root, "notices"))).toBe(false);
  });

  it("exits 2 for update-required without a security reason", () => {
    const r = run(["required", "--message", "Update.", "--lock-at", "now", "--platform", "ios:12", "--advisory", "FSA-1", "--path", tmpRoot()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--security-reason/);
  });

  it("exits 1 when a rule is broken, even as a preview", () => {
    const r = run(["maintenance", "--message", "A — B.", "--path", tmpRoot(), "--signing-key", "file:/nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR: message: no em dashes/);
  });

  it("is import-safe: importing the module signs nothing and prints nothing", () => {
    const out = execFileSync("node", ["-e", `import("${SCRIPT}").then(()=>console.log("ok"))`], { encoding: "utf8" });
    expect(out.trim()).toBe("ok");
  });
});
