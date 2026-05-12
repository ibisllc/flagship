import { describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import { AppPlatform } from "../src/appPlatform.js";
import { AppRunner, type CommandRunner } from "../src/appRunner.js";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
} from "../src/dataLayer/index.js";
import {
  InMemoryJournalStore,
  readJournalDecrypted,
  reissueStableIds,
} from "../src/postRecovery/stableIdReissuer.js";

const HOST_USERNAME = "alice";
const HOST_FQDN = `home.${HOST_USERNAME}.flagship.services`;

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fakeRunner(): AppRunner {
  const cmd: CommandRunner = {
    run: async () => undefined,
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  return new AppRunner(cmd);
}

function fakeSwk(seed = 1): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed + i) & 0xff;
  return out;
}

const MANIFEST = (slug: string) =>
  JSON.stringify({
    schema_version: 1,
    name: slug,
    version: "0.1.0",
    runtime: { image: "nginx:1.27", port: 80 },
    data: {},
    network: { subdomain: slug },
    access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" },
  });

async function buildPlatformWith(memberKeys: Keypair[]): Promise<AppPlatform> {
  const hostIrk = makeKey();
  const platform = new AppPlatform({
    host: { username: HOST_USERNAME, irkPub: hostIrk.publicKey },
    swk: fakeSwk(),
    appRunner: fakeRunner(),
    dataProvisioner: new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      objects: new InMemoryMinioAdmin(),
      kv: new InMemoryRedisAdmin(),
    }),
  });
  for (const slug of ["habits", "notes", "photos"]) {
    const r = await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST_USERNAME,
        slug,
        manifestJson: MANIFEST(slug),
        addOwnerToMembership: false,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    for (const k of memberKeys) {
      r.app.membership.members.internalAdd(k.publicKey, "member");
    }
  }
  return platform;
}

describe("J.4 stable-id re-issuer", () => {
  it("rewrites every app's row that matched the OLD IRK and wipes the OLD pubkey from membership", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const friend = makeKey();
    const platform = await buildPlatformWith([oldIrk, friend]);
    const journal = new InMemoryJournalStore();
    const report = await reissueStableIds({
      deps: { appPlatform: platform, swk: fakeSwk(), journal },
      oldIrkPubHex: bytesToHex(oldIrk.publicKey),
      newIrkPubHex: bytesToHex(newIrk.publicKey),
    });
    expect(report.status).toBe("complete");
    expect(report.apps.length).toBe(3);
    expect(report.totalRewritten).toBe(3);
    expect(report.reattachedCount).toBe(3);
    for (const app of platform.list()) {
      const members = app.membership.members.list().map((m) => m.irkPubHex);
      expect(members).not.toContain(bytesToHex(oldIrk.publicKey));
      expect(members).toContain(bytesToHex(newIrk.publicKey));
      expect(members).toContain(bytesToHex(friend.publicKey));
    }
  });

  it("leaves apps unchanged when the OLD IRK isn't a member", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const stranger = makeKey();
    const platform = await buildPlatformWith([stranger]);
    const journal = new InMemoryJournalStore();
    const report = await reissueStableIds({
      deps: { appPlatform: platform, swk: fakeSwk(), journal },
      oldIrkPubHex: bytesToHex(oldIrk.publicKey),
      newIrkPubHex: bytesToHex(newIrk.publicKey),
    });
    expect(report.totalRewritten).toBe(0);
    expect(report.reattachedCount).toBe(0);
    expect(report.unchangedCount).toBe(3);
  });

  it("emits an encrypted journal that round-trips via the SWK-derived key + salt", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const platform = await buildPlatformWith([oldIrk]);
    const journal = new InMemoryJournalStore();
    const swk = fakeSwk(42);
    const report = await reissueStableIds({
      deps: { appPlatform: platform, swk, journal },
      oldIrkPubHex: bytesToHex(oldIrk.publicKey),
      newIrkPubHex: bytesToHex(newIrk.publicKey),
    });
    const rows = await journal.listAll();
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // App ID is plaintext (the index keeps it queryable) but the
      // OLD→NEW pubkey mapping is not retrievable without SWK + salt.
      expect(row.appId).toMatch(/^alice--/);
      expect(row.ciphertextHex.length).toBeGreaterThan(0);
      expect(row.ivHex.length).toBe(24);
      expect(row.tagHex.length).toBe(32);
    }
    const decrypted = await readJournalDecrypted(
      { appPlatform: platform, swk, journal },
      report.journalSaltHex,
    );
    expect(decrypted.length).toBe(3);
    for (const e of decrypted) {
      expect(e.oldIrkPubHex).toBe(bytesToHex(oldIrk.publicKey));
      expect(e.newIrkPubHex).toBe(bytesToHex(newIrk.publicKey));
      expect(e.role).toBe("member");
    }
  });

  it("journal cannot be decrypted with a different SWK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const platform = await buildPlatformWith([oldIrk]);
    const journal = new InMemoryJournalStore();
    const goodSwk = fakeSwk(1);
    const report = await reissueStableIds({
      deps: { appPlatform: platform, swk: goodSwk, journal },
      oldIrkPubHex: bytesToHex(oldIrk.publicKey),
      newIrkPubHex: bytesToHex(newIrk.publicKey),
    });
    const decrypted = await readJournalDecrypted(
      { appPlatform: platform, swk: fakeSwk(99), journal },
      report.journalSaltHex,
    );
    expect(decrypted.length).toBe(0);
  });

  it("rejects identical old/new pubkey (nothing to do)", async () => {
    const irk = makeKey();
    const platform = await buildPlatformWith([irk]);
    const journal = new InMemoryJournalStore();
    await expect(
      reissueStableIds({
        deps: { appPlatform: platform, swk: fakeSwk(), journal },
        oldIrkPubHex: bytesToHex(irk.publicKey),
        newIrkPubHex: bytesToHex(irk.publicKey),
      }),
    ).rejects.toThrow(/equals/);
  });

  it("undo-window expiry is 7 days from completion by default", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const platform = await buildPlatformWith([oldIrk]);
    const journal = new InMemoryJournalStore();
    const fixed = 1_700_000_000_000;
    const report = await reissueStableIds({
      deps: {
        appPlatform: platform,
        swk: fakeSwk(),
        journal,
        now: () => fixed,
      },
      oldIrkPubHex: bytesToHex(oldIrk.publicKey),
      newIrkPubHex: bytesToHex(newIrk.publicKey),
    });
    expect(report.undoWindowExpiresAt).toBe(fixed + 7 * 24 * 60 * 60_000);
  });
});
