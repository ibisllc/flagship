import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ed, parseRelayHint, verifyRelayHint } from "@flagship/protocol";
// @ts-expect-error plain ESM script
import * as rh from "./relay-hint.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "relay-hint.mjs");
const NOW = Date.parse("2026-10-19T12:00:00Z");
const DAY = 24 * 3600_000;
const ADDRS = ["--address", "149.248.216.86", "--address", "2a09:8280:1::110:d2b6:0"];

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "hint-root-"));
const args = (...a: string[]) => rh.parseArgs(a);

const seed = new Uint8Array(32).fill(0x55);
const pub = Buffer.from(ed.getPublicKey(seed)).toString("hex");
const signer = {
  pubKey: pub,
  sign: async (bytes: Uint8Array) => Buffer.from(ed.sign(bytes, seed)).toString("hex"),
};

describe("relay-hint arguments", () => {
  it("reads repeated addresses", () => {
    expect(args(...ADDRS).address).toEqual(["149.248.216.86", "2a09:8280:1::110:d2b6:0"]);
  });

  it("refuses unknown flags and stray arguments", () => {
    expect(() => args("--bogus")).toThrow(/unknown option/);
    expect(() => args("extra")).toThrow(/unexpected argument/);
  });

  it("parses times and refuses vague ones", () => {
    expect(rh.parseTime("now", NOW, "x")).toBe(NOW);
    expect(rh.parseTime("+7d", NOW, "x")).toBe(NOW + 7 * DAY);
    expect(() => rh.parseTime("soon", NOW, "--until")).toThrow(/cannot read the time/);
  });
});

describe("relay-hint body", () => {
  it("defaults to 90 days from now and the next seq", () => {
    const body = rh.buildBody(args(...ADDRS), { now: NOW, root: tmpRoot() });
    expect(body).toEqual({ seq: 1, validFrom: NOW, validUntil: NOW + 90 * DAY, addresses: ["149.248.216.86", "2a09:8280:1::110:d2b6:0"] });
  });

  it("needs an address and keeps within 180 days", () => {
    expect(() => rh.buildBody(args(), { now: NOW, root: tmpRoot() })).toThrow(/at least one --address/);
    expect(() => rh.buildBody(args(...ADDRS, "--until", "+181d"), { now: NOW, root: tmpRoot() })).toThrow(/180 days/);
  });

  it("refuses what the apps would refuse", () => {
    const body = rh.buildBody(args("--address", "10.0.0.7"), { now: NOW, root: tmpRoot() });
    expect(() => rh.canonicalOrExplain(body, pub)).toThrow(/not-public/);
  });

  it("refuses a seq at or below the highest ever signed", async () => {
    const root = tmpRoot();
    const body = rh.buildBody(args(...ADDRS), { now: NOW, root });
    await rh.signAndWrite({ body, signer, root, authorityKeys: [pub] });
    expect(() => rh.buildBody(args(...ADDRS, "--seq", "1"), { now: NOW, root })).toThrow(/rollback/);
    expect(rh.buildBody(args(...ADDRS), { now: NOW, root }).seq).toBe(2);
  });
});

describe("relay-hint signing", () => {
  it("writes current.json and history, and an app accepts it", async () => {
    const root = tmpRoot();
    const body = rh.buildBody(args(...ADDRS), { now: NOW, root });
    const hint = await rh.signAndWrite({ body, signer, root, authorityKeys: [pub] });
    const text = fs.readFileSync(path.join(root, "relay-hints", "current.json"), "utf8");
    expect(JSON.parse(text)).toEqual(hint);
    expect(fs.existsSync(path.join(root, "relay-hints", "history", "0001.json"))).toBe(true);
    const parsed = parseRelayHint(JSON.parse(text));
    expect(parsed).not.toBeNull();
    expect(verifyRelayHint(parsed!, [pub])).toEqual({ ok: true });
  });

  it("writes nothing when the signer is not the authority", async () => {
    const root = tmpRoot();
    const body = rh.buildBody(args(...ADDRS), { now: NOW, root });
    await expect(rh.signAndWrite({ body, signer, root, authorityKeys: ["0".repeat(64)] })).rejects.toThrow(/unauthorized-signer/);
    expect(fs.existsSync(path.join(root, "relay-hints", "current.json"))).toBe(false);
  });
});

describe("relay-hint command line", () => {
  it("previews without signing or writing", () => {
    const root = tmpRoot();
    const r = spawnSync("node", [SCRIPT, ...ADDRS, "--path", root], { encoding: "utf8", env: { ...process.env, FLAGSHIP_MAINTAINERS_DIR: "/nonexistent" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN: nothing signed/);
    expect(r.stdout).toMatch(/flagship\/relay-hint\/v1\|/);
    expect(fs.existsSync(path.join(root, "relay-hints"))).toBe(false);
  });

  it("refuses to sign without the maintainers CLI", () => {
    const root = tmpRoot();
    const r = spawnSync("node", [SCRIPT, ...ADDRS, "--path", root, "--sign"], { encoding: "utf8", env: { ...process.env, FLAGSHIP_MAINTAINERS_DIR: "/nonexistent" } });
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(root, "relay-hints"))).toBe(false);
  });

  it("exits 2 for no address", () => {
    expect(spawnSync("node", [SCRIPT], { encoding: "utf8" }).status).toBe(2);
  });
});
