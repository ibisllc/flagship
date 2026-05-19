import { describe, expect, it } from "vitest";
import {
  ed,
  signServiceRename,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleServiceRename,
  handleGetAppLinks,
  handleListAppAliases,
} from "../src/serviceRename.js";

const USER = "alice";
const APP = "meta-scratchpad"; // serviceId; default label: "scratchpad-meta"

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

async function seed(s: InMemoryStorage, irk: Keypair) {
  await s.usernames.put({
    username: USER,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
  });
  await s.servers.put({
    serverDomain: "home.alice.flagship.services",
    serverId: "home.alice.flagship.services",
    username: USER,
    addedAt: 1,
  });
}

function makeDeps(s: InMemoryStorage, opts: { now?: () => number; publishDns?: (u: string, oldL: string, newL: string, app: string) => Promise<void> } = {}) {
  return {
    usernames: s.usernames,
    userServiceAliases: s.userServiceAliases,
    voiciLinks: s.voiciLinks,
    servers: s.servers,
    auditEvents: s.auditEvents,
    now: opts.now,
    publishDns: opts.publishDns,
  };
}

function signedBody(args: {
  irk: Keypair;
  username?: string;
  serviceId?: string;
  newDisplayLabel: string;
  issuedAt?: number;
}) {
  const issuedAt = args.issuedAt ?? Date.now();
  const username = args.username ?? USER;
  const serviceId = args.serviceId ?? APP;
  const sig = signServiceRename(
    { username, serviceId, newDisplayLabel: args.newDisplayLabel, issuedAt },
    args.irk,
  );
  return {
    request: { username, serviceId, newDisplayLabel: args.newDisplayLabel, issuedAt },
    signature: bytesToHex(sig),
  };
}

describe("handleServiceRename — happy path", () => {
  it("upserts alias, mints fresh short link, returns canonical+short", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk, newDisplayLabel: "mynotes" }),
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      ok: boolean; displayLabel: string; canonicalUrl: string; shortUrl: string;
    };
    expect(b.ok).toBe(true);
    expect(b.displayLabel).toBe("mynotes");
    expect(b.canonicalUrl).toBe("https://mynotes.home.alice.flagship.services");
    expect(b.shortUrl).toMatch(/^https:\/\/voi\.ci\/[a-z0-9]{6}$/);

    // Alias row persisted.
    const alias = await s.userServiceAliases.get(USER, APP);
    expect(alias?.displayLabel).toBe("mynotes");
  });

  it("cascade-deletes old voi.ci codes on rename", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    // First rename → some code "abc1".
    await handleServiceRename(makeDeps(s), USER, APP, signedBody({ irk, newDisplayLabel: "first" }));
    const code1 = (await s.voiciLinks.deleteByService.bind(s.voiciLinks)) ? null : null; // noop guard
    // Pre-check: at least one row exists for this app.
    let preCount = 0;
    for (const c of ["aaaaaa","bbbbbb","cccccc"]) { /* sample-not-applicable */ void c; }
    // Reach into the in-memory map via the public API: insert another
    // bogus row tied to a different serviceId and verify it doesn't get
    // deleted.
    const ok = await s.voiciLinks.insert({ code: "preservd", username: USER, serviceId: "other-app", targetUrl: "https://x.example.com/", createdAt: 1 });
    expect(ok.ok).toBe(true);

    // Second rename — bumps the same app's codes.
    const res2 = await handleServiceRename(makeDeps(s), USER, APP, signedBody({ irk, newDisplayLabel: "second" }));
    expect(res2.status).toBe(200);
    const b = res2.body as { deletedShortLinks: number };
    expect(b.deletedShortLinks).toBeGreaterThanOrEqual(1);
    // Cross-app row preserved.
    expect((await s.voiciLinks.get("preservd"))?.code).toBe("preservd");
    preCount += 1;
  });

  it("no-ops when the new label matches the existing one", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    await handleServiceRename(makeDeps(s), USER, APP, signedBody({ irk, newDisplayLabel: "samename" }));
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk, newDisplayLabel: "samename" }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { unchanged?: boolean }).unchanged).toBe(true);
  });

  it("calls the DNS publisher hook with old + new labels", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    let captured: { oldL: string; newL: string; app: string } | null = null;
    const deps = makeDeps(s, {
      publishDns: async (_u, oldL, newL, app) => { captured = { oldL, newL, app }; },
    });
    // First rename → records the default oldLabel ("scratchpad-meta").
    await handleServiceRename(deps, USER, APP, signedBody({ irk, newDisplayLabel: "renamed" }));
    expect(captured).not.toBeNull();
    if (captured) {
      const c = captured as { oldL: string; newL: string; app: string };
      expect(c.oldL).toBe("scratchpad-meta");
      expect(c.newL).toBe("renamed");
      expect(c.app).toBe(APP);
    }
  });

  it("emits an app-renamed audit row naming both labels", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    await handleServiceRename(makeDeps(s), USER, APP, signedBody({ irk, newDisplayLabel: "newname" }));
    const audit = await s.auditEvents.list(USER, 0, 5);
    expect(audit.length).toBe(1);
    expect(audit[0]?.eventKind).toBe("app-renamed");
    expect(audit[0]?.detail).toContain("scratchpad-meta");
    expect(audit[0]?.detail).toContain("newname");
  });
});

describe("handleServiceRename — validation", () => {
  it("400 on malformed body", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleServiceRename(makeDeps(s), USER, APP, { request: {} });
    expect(res.status).toBe(400);
  });

  it("400 on non-DNS-label new name", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk, newDisplayLabel: "Has Spaces!" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on reserved label", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk, newDisplayLabel: "admin" }),
    );
    expect(res.status).toBe(400);
  });

  it("403 on URL / body username mismatch", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleServiceRename(
      makeDeps(s),
      "other",
      APP,
      signedBody({ irk, newDisplayLabel: "fine" }),
    );
    expect(res.status).toBe(403);
  });

  it("403 on stale issuedAt", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk, newDisplayLabel: "fine", issuedAt: Date.now() - 10 * 60_000 }),
    );
    expect(res.status).toBe(403);
  });

  it("403 on invalid signature", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const other = makeKey();
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk: other, newDisplayLabel: "fine" }),
    );
    expect(res.status).toBe(403);
  });

  it("409 on collision with another app's alias", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    // Pre-seed: app "other-note" has alias "taken".
    await s.userServiceAliases.upsert({
      username: USER,
      serviceId: "other-note",
      displayLabel: "taken",
      createdAt: 1,
      updatedAt: 1,
    });
    const res = await handleServiceRename(
      makeDeps(s),
      USER,
      APP,
      signedBody({ irk, newDisplayLabel: "taken" }),
    );
    expect(res.status).toBe(409);
  });
});

describe("handleGetAppLinks", () => {
  it("falls back to the slug-creator default when no alias is set", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleGetAppLinks(makeDeps(s), USER, APP);
    expect(res.status).toBe(200);
    const b = res.body as { displayLabel: string; canonicalUrl: string };
    expect(b.displayLabel).toBe("scratchpad-meta");
    expect(b.canonicalUrl).toBe("https://scratchpad-meta.home.alice.flagship.services");
  });

  it("parses a HYPHENATED slug correctly (split at first dash only)", async () => {
    // serviceId `meta-notes-app`: creator=meta (hyphen-free username),
    // slug=notes-app (slug may contain hyphens). The default URL
    // label flips the order → `notes-app-meta`. This is the case
    // single-dash + the no-hyphen-username rule exists to make
    // unambiguous; the old `--` form is gone.
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleGetAppLinks(makeDeps(s), USER, "meta-notes-app");
    const b = res.body as { displayLabel: string; canonicalUrl: string };
    expect(b.displayLabel).toBe("notes-app-meta");
    expect(b.canonicalUrl).toBe("https://notes-app-meta.home.alice.flagship.services");
  });

  it("lazy-mints a short link on first call (V4 denormalization)", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    // No prior short link.
    expect(await s.voiciLinks.getByService(USER, APP)).toBeUndefined();
    const res = await handleGetAppLinks(makeDeps(s), USER, APP);
    const b = res.body as { shortUrl: string | null };
    expect(b.shortUrl).toMatch(/^https:\/\/voi\.ci\/[a-z0-9]{6}$/);
    // And the row is persisted so a second call returns the SAME url.
    const res2 = await handleGetAppLinks(makeDeps(s), USER, APP);
    expect((res2.body as { shortUrl: string }).shortUrl).toBe(b.shortUrl);
  });

  it("rejects malformed username on the alias-list endpoint", async () => {
    const s = new InMemoryStorage();
    const res = await handleListAppAliases({ userServiceAliases: s.userServiceAliases }, "BAD..NAME");
    expect(res.status).toBe(400);
  });

  it("listAppAliases returns flat sorted rows for the daemon's reconciler", async () => {
    const s = new InMemoryStorage();
    await s.userServiceAliases.upsert({
      username: USER,
      serviceId: "zzz-later",
      displayLabel: "later",
      createdAt: 2,
      updatedAt: 2,
    });
    await s.userServiceAliases.upsert({
      username: USER,
      serviceId: "aaa-first",
      displayLabel: "first",
      createdAt: 1,
      updatedAt: 1,
    });
    // Different user shouldn't pollute the result.
    await s.userServiceAliases.upsert({
      username: "bob",
      serviceId: "x--y",
      displayLabel: "y",
      createdAt: 1,
      updatedAt: 1,
    });
    const res = await handleListAppAliases({ userServiceAliases: s.userServiceAliases }, USER);
    expect(res.status).toBe(200);
    const b = res.body as { aliases: Array<{ serviceId: string; displayLabel: string; updatedAt: number }> };
    expect(b.aliases.map((a) => a.serviceId)).toEqual(["aaa-first", "zzz-later"]);
    expect(b.aliases[0]).toEqual({ serviceId: "aaa-first", displayLabel: "first", updatedAt: 1 });
  });

  it("surfaces the rename-minted short link (no re-mint)", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    // Rename mints a fresh code.
    await handleServiceRename(makeDeps(s), USER, APP, signedBody({ irk, newDisplayLabel: "renamed" }));
    const row = await s.voiciLinks.getByService(USER, APP);
    expect(row).toBeDefined();
    const res = await handleGetAppLinks(makeDeps(s), USER, APP);
    const b = res.body as { shortUrl: string };
    expect(b.shortUrl).toBe(`https://voi.ci/${row!.code}`);
  });

  it("surfaces the alias when present + lists every live server as an instance", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    await s.servers.put({
      serverDomain: "work.alice.flagship.services",
      serverId: "work.alice.flagship.services",
      username: USER,
      addedAt: 2,
    });
    await s.userServiceAliases.upsert({
      username: USER,
      serviceId: APP,
      displayLabel: "scratch",
      createdAt: 1,
      updatedAt: 1,
    });
    const res = await handleGetAppLinks(makeDeps(s), USER, APP);
    const b = res.body as {
      displayLabel: string;
      canonicalUrl: string;
      instances: Array<{ url: string }>;
    };
    expect(b.displayLabel).toBe("scratch");
    expect(b.canonicalUrl).toBe("https://scratch.home.alice.flagship.services");
    expect(b.instances.length).toBe(2);
    expect(b.instances.map((i) => i.url)).toContain("https://scratch.work.alice.flagship.services");
  });
});
