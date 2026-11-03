import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { b64Encode, ed, hybridSealKeygen, sealVoiciAbuseTag, verifyAbuseKeyEntry } from "@flagship/protocol";
import { generate, parseArgs as parseKeyArgs, readList, sign, status } from "./abuse-key.mjs";
import { client, formatList, openReport, parseArgs } from "./voici-abuse.mjs";
import { format, report } from "./voici-namespace-report.mjs";
import { createFakeYubikeys, fakeVault, withSeed } from "./pq-release-key.mjs";

const V = JSON.parse(readFileSync(new URL("../packages/protocol/test-vectors/messages/vectors.json", import.meta.url), "utf8"));
const NOW = Date.UTC(2026, 10, 2);
const quiet = () => undefined;

describe("voici-abuse", () => {
  it("reads its arguments", () => {
    expect(parseArgs(["ban", "mallory", "a".repeat(32), "spam"]).args).toEqual(["mallory", "a".repeat(32), "spam"]);
    expect(() => parseArgs(["ban", "mallory", "x", "rude"])).toThrow(/reason/);
    expect(() => parseArgs(["takedown", "alice"])).toThrow();
    expect(() => parseArgs(["frob"])).toThrow();
    expect(parseArgs(["list", "--all"]).all).toBe(true);
  });

  it("opens a reported message's abuse tag and attached text with the quarter's seed", () => {
    const seed = Buffer.from(V.keys.abuseSeed, "hex");
    const report = { id: "f".repeat(32), kind: "message", reason: "spam", envelope: V.reports.messageWithText.report.envelope, attached: V.reports.messageWithText.report.attached };
    const lines = openReport(report, seed).join("\n");
    expect(lines).toContain("Sender account: bob");
    expect(lines).toContain("Hello Alice!");
    expect(lines).toContain(`ban bob ${"f".repeat(32)} spam`);
    expect(() => openReport({ ...report, kind: "page", envelope: null }, seed)).toThrow();
    expect(() => openReport(report, new Uint8Array(32).fill(1))).toThrow();
  });

  it("lists reports and talks to the admin API with the secret", async () => {
    const lines = formatList([{ id: "a".repeat(32), kind: "message", reason: "spam", username: "alice", createdAt: NOW - 30 * 3600_000, abuseEpoch: 3, hasText: true, status: "open" }], NOW);
    expect(lines[0]).toMatch(/voi\.ci\/alice +30 h ago +epoch 3, text attached +\[open\]/);
    const seen: { url: string; init: RequestInit }[] = [];
    const call = client({
      base: "https://gym.example",
      secret: "s3",
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return url.endsWith("/off") ? new Response("{}", { status: 404 }) : Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    expect(await call("POST", "ban", { username: "m" })).toEqual({ ok: true });
    expect(seen[0]!.url).toBe("https://gym.example/api/admin/voici/ban");
    expect(new Headers(seen[0]!.init.headers).get("x-admin-secret")).toBe("s3");
    await expect(call("GET", "off")).rejects.toThrow(/VOICI_ENABLED/);
  });
});

describe("abuse-key", () => {
  it("generates under fake YubiKeys, previews, signs only with --sign, and the seed opens a tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "abuse-key-"));
    const yk = mkdtempSync(join(tmpdir(), "abuse-yk-"));
    const recipients = createFakeYubikeys(yk);
    const o = parseKeyArgs(["generate", "--epoch", "1", "--path", root, "--fake-yubikey", yk, ...recipients.flatMap((r) => ["--recipient", r]), "--not-before", "2026-11-01", "--not-after", "2027-02-01"]);
    const entry = generate(o, { now: NOW, out: quiet });
    expect(entry).toMatchObject({ epoch: 1, notBefore: Date.UTC(2026, 10, 1), notAfter: Date.UTC(2027, 1, 1) });
    expect(JSON.parse(readFileSync(join(root, "abuse-keys", "1.pub.json"), "utf8"))).toEqual(entry);
    expect(() => generate(o, { now: NOW, out: quiet })).toThrow(/exists/);

    const trackSeed = new Uint8Array(32).fill(0x45);
    const keyFile = join(root, "track.hex");
    writeFileSync(keyFile, Buffer.from(trackSeed).toString("hex"));
    const authority = [Buffer.from(ed.getPublicKey(trackSeed)).toString("hex")];
    const out: string[] = [];
    const preview = await sign(parseKeyArgs(["sign", "--epoch", "1", "--path", root, "--signing-key", `file:${keyFile}`]), { now: NOW, out: (l: string) => out.push(l), authority });
    expect(preview).toBeNull();
    expect(out.join("\n")).toContain("DRY RUN");
    expect(out.join("\n")).toContain("signer matches:   yes");
    expect(readList(root).entries).toEqual([]);
    await expect(sign(parseKeyArgs(["sign", "--epoch", "1", "--path", root, "--signing-key", `file:${keyFile}`, "--sign"]), { now: NOW, out: quiet, authority: ["00".repeat(32)] })).rejects.toThrow(/not the current ca-track authority/);
    const signed = await sign(parseKeyArgs(["sign", "--epoch", "1", "--path", root, "--signing-key", `file:${keyFile}`, "--sign"]), { now: NOW, out: quiet, authority });
    const list = readList(root);
    expect(list.entries).toEqual([signed]);
    expect(verifyAbuseKeyEntry(list.entries[0], list.entries[0].signature, authority)).toBe(true);

    const p = Buffer.from(ed.getPublicKey(new Uint8Array(32).fill(9))).toString("hex");
    const tag = sealVoiciAbuseTag(Buffer.from(entry.xwingPub, "hex"), p, { v: 1, username: "mallory", accountCreatedAt: 5, issuedAt: NOW });
    const report = { id: "e".repeat(32), kind: "message", reason: "harassment", attached: null, envelope: { from: p, conv: "", msgId: "", cred: { attestation: { abuseEpoch: 1, abuseTag: b64Encode(tag) } } } };
    const vault = fakeVault({ dir: yk, env: { FLAGSHIP_PQ_FAKE_PIN: "123456" } });
    const opened = await withSeed(vault, join(root, "abuse-keys", "1.age"), (seed: Uint8Array) => {
      expect(Buffer.from(hybridSealKeygen(seed).publicKey).toString("hex")).toBe(entry.xwingPub);
      return openReport(report, seed);
    });
    expect(opened[0]).toBe("Sender account: mallory");
  });

  it("reports status; a fresh checkout has no key", async () => {
    const root = mkdtempSync(join(tmpdir(), "abuse-key-"));
    const out: string[] = [];
    expect(await status({ path: root }, { now: NOW, out: (l: string) => out.push(l) })).toBeNull();
    expect(out.join("\n")).toMatch(/503 no-abuse-key/);
    expect(existsSync(join(root, "abuse-keys", "list.json"))).toBe(false);
  });

  it("refuses bad arguments", () => {
    expect(() => parseKeyArgs(["generate"])).toThrow(/epoch/);
    expect(() => parseKeyArgs(["rotate", "--epoch", "1"])).toThrow();
  });
});

describe("voici-namespace-report (migration 0127's read-only checks)", () => {
  it("lists format failures, safety-key duplicates and reserved words already held, renaming nothing", () => {
    const r = report(
      {
        usernames: [
          { username: "plucky-avocet", claimedAt: 1 },
          { username: "openai-build", claimedAt: 2 },
          { username: "openaibuild", claimedAt: 3 },
          { username: "a--b", claimedAt: 4 },
          { username: "official", claimedAt: 5 },
        ],
        names: [{ display: "p1ucky-avocet", state: "live", username: "dave" }],
        codes: [{ code: "x7k2p9", username: "dave", retired: false }],
      },
      ["official", "admin"],
    );
    expect(r.invalid).toEqual([{ username: "a--b", problem: "hyphens" }]);
    expect(r.duplicates.map((d) => [d.key, d.keeps.name, d.without.name])).toEqual([
      ["openaibuild", "openai-build", "openaibuild"],
      ["pluckyavocet", "plucky-avocet", "p1ucky-avocet"],
    ]);
    expect(r.reservedHeld).toEqual([{ word: "official", heldBy: { kind: "username", name: "official", owner: "official" } }]);
    const text = format(r).join("\n");
    expect(text).toContain("openai-build keeps it");
    expect(format(report({ usernames: [{ username: "solar-guava", claimedAt: 1 }], names: [], codes: [] }, ["admin"])).join("\n")).toContain("No safety-key duplicates");
  });
});
