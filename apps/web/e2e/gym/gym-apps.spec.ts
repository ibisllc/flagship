/**
 * The app page (docs/service-access-gating.md "Open mode + members",
 * docs/ai-privacy-and-staging.md §3a, docs/app-apis.md §3 + §6,
 * docs/app-placement.md §4-§5) with no backend: Access control and ranks, the
 * app's internet access list, API keys, the Database section and Runs on.
 *
 * Crypto is real: every signed order is signed with this browser's unlocked
 * keys, and each test re-verifies the signature the box would check over the
 * exact canonical bytes. `.com` and the boxes are a single page.route router
 * that records every request; anything it doesn't know is a 404.
 */

import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { stubAccountReadToken } from "../fixtures/accountRead.js";

const PASSPHRASE = "correct-horse-battery-staple-gym";
const HOME = "home.smoketest.flagship.services";
const MEDIA = "media.smoketest.flagship.services";
const ATTIC = "attic.smoketest.flagship.services";
const SERVICE_ID = "smoketest--notes";

test.use({ viewport: { width: 430, height: 932 } });

async function shot(page: Page, testInfo: TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function reachHome(page: Page): Promise<void> {
  await stubAccountReadToken(page);
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.click("#bootstrap-create");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });
  await page.goto("/index.html?view=home");
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(150);
  await page.evaluate(
    async ({ HOME, MEDIA }) => {
      const store = await import("/lib/profilesStore.js");
      store.ensureProfile("smoketest");
      store.setActiveCloudName("smoketest");
      store.set("username", "smoketest");
      const { getSession } = await import("/lib/state.js");
      getSession().username = "smoketest";
      const api = await import("/lib/api.js");
      api.setPodBaseUrl(`https://${HOME}`);
      api.setSessionToken("gym-home-token");
      api.setSessionTokenForPod(HOME, "gym-home-token");
      api.setSessionTokenForPod(MEDIA, "gym-media-token");
      (await import("/lib/apex.js")).setApexOverride({ control: "https://flagshipserver.com" });
    },
    { HOME, MEDIA },
  );
}

interface Call {
  method: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}
type Answer = { status?: number; json: unknown } | null;
type Rule = { method?: string; match: (url: URL) => boolean; answer: (call: Call) => Answer };

/** One router for every foreign request; returns the recorded calls. */
async function stub(page: Page, rules: Rule[]): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route(
    (url) => !url.href.startsWith("http://127.0.0.1"),
    async (route) => {
      const req = route.request();
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      const call: Call = { method: req.method(), url: new URL(req.url()), body, headers: req.headers() };
      calls.push(call);
      for (const rule of rules) {
        if (rule.method && rule.method !== call.method) continue;
        if (!rule.match(call.url)) continue;
        const a = rule.answer(call);
        if (!a) continue;
        await route.fulfill({ status: a.status ?? 200, contentType: "application/json", body: JSON.stringify(a.json) });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
    },
  );
  return calls;
}

const on = (host: string, path: string) => (u: URL) => u.host === host && u.pathname === path;
const svc = (sub = "") => `/api/screens/services/${SERVICE_ID}${sub}`;

/** The app-detail answer for notes; `access` is the box's §3a summary. */
function appDetail(access: Record<string, unknown> | null = { rules: 0, pending: 0, draft: false }) {
  return {
    app: {
      serviceId: SERVICE_ID,
      slug: "notes",
      creator: "smoketest",
      summary: "Shared notes for the house",
      status: "running",
      version: "1.2.0",
      url: `https://notes.${HOME}`,
      ...(access ? { access } : {}),
    },
    manifest: { name: "notes", runtime: { base: "node-24" } },
    dataLayerInstances: [],
    members: [],
    editable: false,
  };
}

/** Rules every app-page test needs: the detail read, and quiet 404-free
 *  answers for the sections a test doesn't look at. */
function baseRules(detail: unknown, extra: { apiKeys?: boolean; db?: boolean } = {}): Rule[] {
  const rules: Rule[] = [
    { method: "GET", match: on(HOME, `/api/screens/app-detail/${SERVICE_ID}`), answer: () => ({ json: detail }) },
    { method: "GET", match: (u) => u.pathname.endsWith("/api/users/smoketest/pods"), answer: () => ({ json: { pods: [{ serverDomain: HOME, liveness: "live" }] } }) },
    { method: "GET", match: on(HOME, "/api/screens/apps-list"), answer: () => ({ json: { apps: [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }] } }) },
  ];
  if (!extra.apiKeys) rules.push({ method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ status: 404, json: { error: "not found" } }) });
  if (!extra.db) rules.push({ method: "GET", match: on(HOME, svc("/db")), answer: () => ({ status: 404, json: { error: "not found" } }) });
  return rules;
}

async function openApp(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const { enterServiceDetail } = await import("/views/service-detail.js");
    await enterServiceDetail(id);
  }, SERVICE_ID);
  await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#service-detail-content .card-title").first()).toContainText("notes", { timeout: 10_000 });
}

/** Whether `sigHex` is this browser's signature over `canonical`: the
 *  sensitive-order key (admin root when held, else the IRK) or the IRK. */
async function signedBy(page: Page, canonical: string, sigHex: string, key: "sensitive" | "irk" = "sensitive"): Promise<boolean> {
  return page.evaluate(
    async ({ canonical, sigHex, key }) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const s = getSession();
      const pub =
        key === "sensitive" && s.adminRootSeed
          ? ks.hexToBytes(await ks.adminRootPubHex(s.adminRootSeed))
          : (await ks.deriveIrkFromSeed(s.umk)).publicKey;
      return ks.verifyWithEd25519Pub(pub, ks.hexToBytes(sigHex), new TextEncoder().encode(canonical));
    },
    { canonical, sigHex, key },
  );
}

const fresh = (issuedAt: unknown) => typeof issuedAt === "number" && Math.abs(Date.now() - issuedAt) < 5 * 60_000;

test.describe("gym webapp apps", () => {
  test("gym apps access control goes members-only and sets a rank with signed orders", async ({ page }, testInfo) => {
    await reachHome(page);
    const SAM_AID = "5a".repeat(32);
    const invites = await page.evaluate(async () => {
      const ks = await import("/keystore.js");
      const si = await import("/lib/serviceInvite.js");
      const { getSession } = await import("/lib/state.js");
      const hk = await ks.deriveHouseholdKeyFromSeed(getSession().umk);
      return {
        sam: await si.sealInviteBundle({ name: "Sam" }, hk, "inv-sam"),
        chess: await si.sealInviteBundle({ name: "Chess club" }, hk, "inv-chess"),
      };
    });
    let samRole = "member";
    let mode = "open";
    const members = () => ({
      mode,
      roles: ["member", "manager", "master"],
      defaultRole: "member",
      descriptions: { member: "Reads notes", manager: "Edits notes", master: "Manages who's in" },
      members: [{ aid: SAM_AID, role: samRole, grants: [{ inviteId: "inv-sam", role: samRole }], direct: false }],
      invites: [
        { inviteId: "inv-sam", role: samRole, set: samRole !== "member" },
        { inviteId: "inv-chess", role: "manager", set: true },
      ],
    });
    const calls = await stub(page, [
      ...baseRules(appDetail()),
      {
        method: "GET",
        match: (u) => u.pathname === "/api/users/smoketest/service-invites",
        answer: () => ({
          json: {
            invites: [
              { inviteId: "inv-sam", serviceRef: SERVICE_ID, encryptedBundle: invites.sam, boundAID: SAM_AID, boundAt: Date.now() - 86_400_000, createdAt: Date.now() - 2 * 86_400_000, approvalMode: "auto" },
              { inviteId: "inv-chess", serviceRef: SERVICE_ID, encryptedBundle: invites.chess, createdAt: Date.now() - 86_400_000, maxRedemptions: 10, redemptions: 3, boundAIDs: [], approvalMode: "auto" },
            ],
          },
        }),
      },
      { method: "GET", match: on(HOME, svc("/members")), answer: () => ({ json: members() }) },
      {
        method: "POST",
        match: on(HOME, "/api/service-access"),
        answer: (c) => {
          mode = c.body.request.mode;
          return { json: { ok: true, mode } };
        },
      },
      {
        method: "POST",
        match: on(HOME, svc("/members/role")),
        answer: (c) => {
          samRole = c.body.order.role;
          return { json: { ok: true, target: c.body.order.target, role: samRole } };
        },
      },
    ]);
    await openApp(page);
    await page.click("#sd-access");
    await expect(page.locator("#view-service-access")).toBeVisible({ timeout: 10_000 });

    // Both modes keep the same list: two invites, each with its rank.
    await expect(page.locator("#sa-members-title")).toHaveText("Members (2)", { timeout: 10_000 });
    const sam = page.locator("#sa-people .card", { hasText: "Sam" });
    const chess = page.locator("#sa-people .card", { hasText: "Chess club" });
    await expect(sam).toContainText("active");
    await expect(sam.locator('select[data-action="sa-role"]')).toHaveValue("member");
    await expect(chess).toContainText("3 of 10 joined");
    await expect(chess.locator('select[data-action="sa-role"]')).toHaveValue("manager");
    await expect(chess.locator('[data-action="sa-remove"]')).toHaveText("Revoke");
    await expect(page.locator('#sa-mode [data-mode="open"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#sa-mode-status")).toHaveText("Anyone can open it. Members who sign in get their rank.");
    await shot(page, testInfo, "access-control-open");

    // Members only asks once, saying how many people that leaves in.
    await page.click('#sa-mode [data-mode="restricted"]');
    await expect(page.locator(".modal-title")).toHaveText("Members only?");
    await expect(page.locator(".modal-message")).toHaveText("Only this 1 person will be able to open it.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#sa-mode-status")).toHaveText("Only members and you can open it. Anyone else is asked to sign in.", { timeout: 10_000 });
    await expect(page.locator('#sa-mode [data-mode="restricted"]')).toHaveAttribute("aria-checked", "true");
    const modeCall = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/service-access");
    expect(modeCall).toBeTruthy();
    const req = modeCall!.body.request;
    expect(req).toMatchObject({ serverId: HOME, serviceRef: SERVICE_ID, mode: "restricted" });
    expect(fresh(req.issuedAt)).toBe(true);
    expect(
      await signedBy(page, ["flagship/service-access-mode/v1", req.serverId, req.serviceRef, req.mode, req.issuedAt].join("|"), modeCall!.body.signature, "irk"),
    ).toBe(true);

    // Raising Sam to Master signs flagship/app-member-role/v1 for their invite.
    await sam.locator('select[data-action="sa-role"]').selectOption("master");
    await expect(sam.locator(".sa-crown")).toBeVisible({ timeout: 10_000 });
    await expect(sam.locator('select[data-action="sa-role"]')).toHaveValue("master");
    const roleCall = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/members/role"));
    expect(roleCall).toBeTruthy();
    const order = roleCall!.body.order;
    expect(order).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, target: "invite:inv-sam", role: "master" });
    expect(fresh(order.issuedAt)).toBe(true);
    expect(
      await signedBy(page, ["flagship/app-member-role/v1", order.serverDomain, order.serviceId, order.target, order.role, order.issuedAt].join("|"), roleCall!.body.signature),
    ).toBe(true);
    // The box session rides every box call; the members list itself was never changed by the mode switch.
    expect(roleCall!.headers["x-flagship-session"]).toBe("gym-home-token");
    await expect(page.locator("#sa-members-title")).toHaveText("Members (2)");
    await shot(page, testInfo, "access-control-ranks");
  });

  test("gym apps internet access requests are allowed and denied with a signed access list", async ({ page }, testInfo) => {
    await reachHome(page);
    let list = "allow api.github.com\n";
    let pending = [
      { host: "api.openai.com", source: "attempt", attempts: 3, firstSeen: Date.now() - 60_000, lastSeen: Date.now() },
      { host: "tracker.example.com", source: "app", attempts: 0 },
    ];
    const state = () => ({ access: { list, listSha256: sha256(list), pending, draft: null } });
    const calls = await stub(page, [
      ...baseRules(appDetail({ rules: 1, pending: 2, draft: false })),
      { method: "GET", match: on(HOME, svc("/access")), answer: () => ({ json: state() }) },
      {
        method: "POST",
        match: on(HOME, svc("/access")),
        answer: (c) => {
          list = c.body.list;
          const decided = new Set(list.split("\n").map((l: string) => l.split(" ")[1]));
          pending = pending.filter((p) => !decided.has(p.host));
          return { json: state() };
        },
      },
    ]);
    await openApp(page);
    const section = page.locator("#sd-egress");
    await expect(section.locator("#sd-access-count")).toHaveText("1 rule", { timeout: 10_000 });
    const openai = section.locator('[data-access-host="api.openai.com"]');
    const tracker = section.locator('[data-access-host="tracker.example.com"]');
    await expect(openai).toContainText("It tried to connect 3 times.");
    await expect(tracker).toContainText("It asked for this when it was installed.");
    await shot(page, testInfo, "access-requests");

    await openai.locator('[data-access-act="allow"]').click();
    await expect(page.locator("#toast")).toContainText("notes can now reach api.openai.com", { timeout: 10_000 });
    await expect(section.locator('[data-access-host="api.openai.com"]')).toHaveCount(0);
    await expect(section.locator("#sd-access-count")).toHaveText("2 rules");
    const allow = calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/access"))[0]!;
    expect(allow.body.list).toBe("allow api.openai.com\nallow api.github.com\n");
    const g1 = allow.body.grant;
    expect(g1).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, listSha256: sha256(allow.body.list) });
    expect(fresh(g1.issuedAt)).toBe(true);
    expect(await signedBy(page, ["flagship/app-access/v1", g1.serverDomain, g1.serviceId, g1.listSha256, g1.issuedAt].join("|"), allow.body.signature)).toBe(true);

    await section.locator('[data-access-host="tracker.example.com"] [data-access-act="deny"]').click();
    await expect(page.locator("#toast")).toContainText("notes won't reach tracker.example.com", { timeout: 10_000 });
    await expect(section.locator("[data-access-host]")).toHaveCount(0);
    await expect(section.locator("#sd-access-count")).toHaveText("3 rules");
    const deny = calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/access"))[1]!;
    expect(deny.body.list).toBe("deny tracker.example.com\nallow api.openai.com\nallow api.github.com\n");
    const g2 = deny.body.grant;
    expect(g2.listSha256).toBe(sha256(deny.body.list));
    expect(await signedBy(page, ["flagship/app-access/v1", g2.serverDomain, g2.serviceId, g2.listSha256, g2.issuedAt].join("|"), deny.body.signature)).toBe(true);
    await shot(page, testInfo, "access-answered");
  });

  test("gym apps access list editor reviews a suggested list, flags bad lines and saves it signed", async ({ page }, testInfo) => {
    await reachHome(page);
    let list = "# Uncomment the following line to allow all hosts\n#allow all\n";
    const draftList = "allow api.stripe.com\nallow *.tiles.example.com\n";
    let draft: unknown = {
      list: draftList,
      listSha256: sha256(draftList),
      hosts: [
        { host: "api.stripe.com", why: "Takes payments for the bake sale" },
        { host: "*.tiles.example.com", why: "Map tiles" },
      ],
      createdAt: Date.now() - 60_000,
    };
    const state = () => ({ access: { list, listSha256: sha256(list), pending: [], draft } });
    const calls = await stub(page, [
      ...baseRules(appDetail({ rules: 0, pending: 0, draft: true })),
      { method: "GET", match: on(HOME, svc("/access")), answer: () => ({ json: state() }) },
      {
        method: "POST",
        match: on(HOME, svc("/access")),
        answer: (c) => {
          list = c.body.list;
          draft = null;
          return { json: state() };
        },
      },
    ]);
    await openApp(page);
    const card = page.locator("#sd-egress [data-access-draft]");
    await expect(card).toContainText("This app suggests letting it reach these hosts", { timeout: 10_000 });
    await expect(card).toContainText("Takes payments for the bake sale");
    await expect(page.locator("#sd-access-count")).toHaveText("No rules: this app can't reach the internet.");
    await shot(page, testInfo, "access-draft-card");

    await card.locator('[data-access-draft-act="review"]').click();
    await expect(page.locator("#view-app-access")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-access-draft-note]")).toBeVisible();
    const editor = page.locator("#app-access-text");
    await expect(editor).toHaveValue(draftList);
    await expect(page.locator("#app-access-count")).toHaveText("2 rules");
    await expect(page.locator("#app-access-save")).toBeEnabled();

    // A bad line is flagged by its number and Save goes off.
    await editor.fill(`${draftList}allow https://evil.example.com/x\n`);
    await expect(page.locator("#app-access-errors")).toContainText("Line 3: write the host only, without http:// or https://");
    await expect(page.locator("#app-access-save")).toBeDisabled();
    await shot(page, testInfo, "access-editor-error");

    await editor.fill(`${draftList}deny ads.example.com   \n\n`);
    await expect(page.locator("#app-access-errors")).toBeEmpty();
    await expect(page.locator("#app-access-count")).toHaveText("3 rules");
    await page.click("#app-access-save");
    await expect(page.locator("#toast")).toContainText("Access list saved", { timeout: 10_000 });
    await expect(page.locator("[data-access-draft-note]")).toHaveCount(0);
    const save = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/access"))!;
    // The normalized list is what's hashed and signed.
    expect(save.body.list).toBe(`${draftList}deny ads.example.com\n`);
    const g = save.body.grant;
    expect(g).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, listSha256: sha256(save.body.list) });
    expect(await signedBy(page, ["flagship/app-access/v1", g.serverDomain, g.serviceId, g.listSha256, g.issuedAt].join("|"), save.body.signature)).toBe(true);
    await expect(editor).toHaveValue(save.body.list);
    await expect(page.locator("#app-access-save")).toBeDisabled();
    await shot(page, testInfo, "access-editor-saved");
  });

  test("gym apps API key is created signed, its secret shown once, and a key revoked", async ({ page }, testInfo) => {
    await reachHome(page);
    const OLD = { keyId: "0123456789abcdef", label: "Old script", scope: "write", createdAt: Date.now() - 5 * 86_400_000, lastUsedAt: Date.now() - 3_600_000, expiresAt: 0 };
    let keys: Array<Record<string, unknown>> = [OLD];
    let secret = "";
    const calls = await stub(page, [
      ...baseRules(appDetail(), { apiKeys: true }),
      { method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ json: { keys } }) },
      {
        method: "POST",
        match: on(HOME, svc("/api-keys")),
        answer: (c) => {
          const g = c.body.grant;
          secret = `fsk_${g.keyId}_gymSecretValueShownOnce0123456789`;
          keys = [{ keyId: g.keyId, label: c.body.label, scope: g.scope, createdAt: g.issuedAt, lastUsedAt: 0, expiresAt: 0 }, ...keys];
          return { json: { key: secret, keyId: g.keyId } };
        },
      },
      {
        method: "DELETE",
        match: (u) => u.host === HOME && u.pathname.startsWith(svc("/api-keys/")),
        answer: (c) => {
          const id = decodeURIComponent(c.url.pathname.split("/").pop()!);
          keys = keys.filter((k) => k.keyId !== id);
          return { json: { ok: true } };
        },
      },
    ]);
    await openApp(page);
    const section = page.locator("#sd-api-keys");
    await expect(section).toContainText("Let scripts, devices and other servers call this app. Each key works until you revoke it.", { timeout: 10_000 });
    const oldRow = section.locator(`[data-api-key="${OLD.keyId}"]`);
    await expect(oldRow).toContainText("Old script");
    await expect(oldRow.locator(".pill")).toHaveText("Read & write");

    await page.click("#sd-api-key-new");
    await expect(page.locator("#sd-api-key-scope")).toHaveValue("read");
    await page.click("#sd-api-key-go");
    await expect(page.locator("#sd-api-key-error")).toHaveText("Give the key a name, so you know what uses it.");
    expect(calls.some((c) => c.method === "POST" && c.url.pathname === svc("/api-keys"))).toBe(false);
    await page.fill("#sd-api-key-label", "  Kitchen display  ");
    await page.click("#sd-api-key-go");

    await expect(page.locator("#sd-api-key-secret")).toHaveText(/^fsk_[0-9a-f]{16}_gymSecretValueShownOnce/, { timeout: 10_000 });
    expect(await page.locator("#sd-api-key-secret").textContent()).toBe(secret);
    await expect(section).toContainText("Copy it now. Flagship can't show it again.");
    await expect(section.locator(".sd-api-key-usage")).toHaveText("Authorization: Bearer <key>");
    const post = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/api-keys"))!;
    const g = post.body.grant;
    expect(post.body.label).toBe("Kitchen display");
    expect(g).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, scope: "read", expiresAt: 0 });
    expect(g.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(fresh(g.issuedAt)).toBe(true);
    expect(
      await signedBy(page, ["flagship/app-api-key/v1", g.serverDomain, g.serviceId, g.keyId, g.scope, g.expiresAt, g.issuedAt].join("|"), post.body.signature),
    ).toBe(true);
    // The check is real: the same signature over any other bytes fails.
    expect(
      await signedBy(page, ["flagship/app-api-key/v1", g.serverDomain, g.serviceId, g.keyId, "write", g.expiresAt, g.issuedAt].join("|"), post.body.signature),
    ).toBe(false);
    await expect(section.locator(`[data-api-key="${g.keyId}"]`)).toContainText("Never used");
    await shot(page, testInfo, "api-key-revealed");

    // Done: the secret is gone from the page for good.
    await page.click("#sd-api-key-done");
    await expect(page.locator("#sd-api-key-secret")).toHaveCount(0);
    await expect(page.locator("#view-service-detail")).not.toContainText(secret);

    await oldRow.locator("[data-api-key-revoke]").click();
    await expect(page.locator(".modal-title")).toHaveText('Revoke "Old script"?');
    await expect(page.locator(".modal-message")).toHaveText("Anything using this key stops working right away. This can't be undone.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("Key revoked", { timeout: 10_000 });
    await expect(section.locator(`[data-api-key="${OLD.keyId}"]`)).toHaveCount(0);
    expect(calls.some((c) => c.method === "DELETE" && c.url.pathname === svc(`/api-keys/${OLD.keyId}`))).toBe(true);
    await shot(page, testInfo, "api-key-revoked");
  });

  test("gym apps database browses read-only and a write runs only after a signed confirm", async ({ page }, testInfo) => {
    await reachHome(page);
    const SQL = "UPDATE items SET done = true WHERE done IS NULL";
    const calls = await stub(page, [
      ...baseRules(appDetail(), { db: true }),
      {
        method: "GET",
        match: on(HOME, svc("/db")),
        answer: () => ({
          json: {
            stores: [
              {
                store: "default",
                tables: [
                  { name: "items", kind: "table", rows: 2, bytes: 16_384 },
                  { name: "recent", kind: "view", rows: null, bytes: null },
                ],
              },
            ],
          },
        }),
      },
      {
        method: "GET",
        match: on(HOME, svc("/db/default/tables/items")),
        answer: () => ({
          json: {
            columns: [
              { name: "id", type: "int4" },
              { name: "title", type: "text" },
              { name: "done", type: "bool" },
            ],
            rows: [
              [1, "Milk", null],
              [2, "Eggs", true],
            ],
            total: 2,
          },
        }),
      },
      {
        method: "POST",
        match: on(HOME, svc("/db/default/query")),
        answer: (c) =>
          c.body.signature
            ? { json: { command: "UPDATE", rowCount: 1, columns: [], rows: [] } }
            : { status: 400, json: { error: "this statement changes data", needsGrant: true } },
      },
    ]);
    await openApp(page);
    const entry = page.locator("#sd-database");
    await expect(entry).toContainText("Database", { timeout: 10_000 });
    await expect(entry).toContainText("2 tables");
    await page.click("#sd-db-open");
    await expect(page.locator("#view-app-db")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-db-table="items"]')).toContainText("~2 rows · 16 KB", { timeout: 10_000 });
    await expect(page.locator('[data-db-table="recent"]')).toContainText("view");

    await page.click('[data-db-table="items"]');
    await expect(page.locator("#app-db-range")).toHaveText("Rows 1–2 of 2", { timeout: 10_000 });
    await expect(page.locator(".db-grid td.db-null")).toHaveText("NULL");
    await expect(page.locator("#app-db-next")).toBeDisabled();
    await expect(page.locator("#app-db-prev")).toBeDisabled();
    await shot(page, testInfo, "db-table");

    await page.click("#app-db-back");
    await page.click("#app-db-sql");
    await page.fill("#app-db-sql-text", SQL);
    await page.click("#app-db-run");
    // The first run is read-only and unsigned; the box answers needsGrant.
    await expect(page.locator("[data-db-needs-grant]")).toContainText("This changes data. Confirm to run it.", { timeout: 10_000 });
    const queries = () => calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/db/default/query"));
    expect(queries()).toHaveLength(1);
    expect(queries()[0]!.body).toEqual({ sql: SQL });
    await shot(page, testInfo, "db-needs-grant");

    await page.click("#app-db-confirm");
    await expect(page.locator("[data-db-result]")).toContainText("UPDATE · 1 row", { timeout: 10_000 });
    expect(queries()).toHaveLength(2);
    const signed = queries()[1]!.body;
    expect(signed.sql).toBe(SQL);
    expect(signed.grant).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, store: "default", sqlSha256: sha256(SQL) });
    expect(fresh(signed.grant.issuedAt)).toBe(true);
    const gr = signed.grant;
    expect(
      await signedBy(page, ["flagship/app-db-write/v1", gr.serverDomain, gr.serviceId, gr.store, gr.sqlSha256, gr.issuedAt].join("|"), signed.signature),
    ).toBe(true);
    await shot(page, testInfo, "db-write-ran");
  });

  test("gym apps runs-on ticks a copy to another server and unticks it with a signed uninstall", async ({ page }, testInfo) => {
    await reachHome(page);
    let mediaApps: Array<Record<string, unknown>> = [];
    const calls = await stub(page, [
      { method: "GET", match: on(HOME, `/api/screens/app-detail/${SERVICE_ID}`), answer: () => ({ json: appDetail() }) },
      { method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ status: 404, json: {} }) },
      { method: "GET", match: on(HOME, svc("/db")), answer: () => ({ status: 404, json: {} }) },
      {
        method: "GET",
        match: (u) => u.pathname.endsWith("/api/users/smoketest/pods"),
        answer: () => ({
          json: {
            pods: [
              { serverDomain: HOME, liveness: "live" },
              { serverDomain: MEDIA, liveness: "live" },
              { serverDomain: ATTIC, liveness: "live" },
            ],
          },
        }),
      },
      { method: "GET", match: on(HOME, "/api/screens/apps-list"), answer: () => ({ json: { apps: [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }] } }) },
      { method: "GET", match: on(MEDIA, "/api/screens/apps-list"), answer: () => ({ json: { apps: mediaApps } }) },
      {
        method: "POST",
        match: on(MEDIA, "/api/screens/services/copy"),
        answer: () => {
          mediaApps = [{ serviceId: SERVICE_ID, slug: "notes", status: "running", copying: { state: "copying", progress: 0.4 } }];
          return { json: { copyId: "copy-1" } };
        },
      },
      {
        method: "DELETE",
        match: on(MEDIA, `/api/services/${SERVICE_ID}`),
        answer: () => {
          mediaApps = [];
          return { json: { ok: true } };
        },
      },
    ]);
    await openApp(page);
    const card = page.locator("#sd-runs-on-card");
    const row = (fqdn: string) => card.locator(`[data-runs-on-fqdn="${fqdn}"]`);
    const box = (fqdn: string) => page.locator(`[data-runs-on-toggle="${fqdn}"]`);
    await expect(row(HOME)).toBeVisible({ timeout: 10_000 });
    // home holds the only copy: ticked and locked.
    await expect(box(HOME)).toBeChecked();
    await expect(box(HOME)).toBeDisabled();
    await expect(row(HOME)).toContainText("This is the app's only copy, so it can't be unticked.");
    // media is reachable and doesn't have it; attic has no session here: unknown, never ticked.
    await expect(box(MEDIA)).not.toBeChecked();
    await expect(box(MEDIA)).toBeEnabled();
    await expect(box(ATTIC)).not.toBeChecked();
    await expect(box(ATTIC)).toBeDisabled();
    await expect(row(ATTIC)).toContainText("Can't reach this server, so it isn't known whether the app is there.");
    await shot(page, testInfo, "runs-on");

    await box(MEDIA).check();
    await expect(page.locator("#toast")).toContainText("Copying the app. It appears on that server when it's ready.", { timeout: 10_000 });
    await expect(row(MEDIA)).toContainText("Copying…");
    const copy = calls.find((c) => c.method === "POST" && c.url.host === MEDIA && c.url.pathname === "/api/screens/services/copy")!;
    expect(copy.headers["x-flagship-session"]).toBe("gym-media-token");
    const g = copy.body.grant;
    expect(g).toMatchObject({ sourceServer: HOME, targetServer: MEDIA, serviceId: SERVICE_ID });
    expect(fresh(g.issuedAt)).toBe(true);
    expect(await signedBy(page, ["flagship/app-copy/v1", g.sourceServer, g.targetServer, g.serviceId, g.issuedAt].join("|"), copy.body.signature)).toBe(true);
    await shot(page, testInfo, "runs-on-copying");

    // The page re-reads while the copy runs; once media has it, both copies can be unticked.
    mediaApps = [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }];
    await expect(box(MEDIA)).toBeEnabled({ timeout: 15_000 });
    await expect(box(MEDIA)).toBeChecked();
    await expect(box(HOME)).toBeEnabled();

    await box(MEDIA).uncheck();
    await expect(page.locator(".modal-title")).toHaveText("Remove from this server?");
    await expect(page.locator(".modal-message")).toHaveText("notes and its data on media are deleted. Your other servers keep their copies.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("Removed from media.", { timeout: 10_000 });
    await expect(box(MEDIA)).not.toBeChecked();
    await expect(box(HOME)).toBeDisabled();
    const del = calls.find((c) => c.method === "DELETE" && c.url.host === MEDIA)!;
    const r = del.body.request;
    expect(r).toMatchObject({ serverId: MEDIA, creator: "smoketest", slug: "notes" });
    expect(await signedBy(page, ["flagship/uninstall-service/v1", r.serverId, r.creator, r.slug, r.issuedAt].join("|"), del.body.signature)).toBe(true);
    // Nothing was ever sent to home or to the unreachable attic.
    expect(calls.some((c) => c.method !== "GET" && c.url.host !== MEDIA && c.url.host.endsWith("flagship.services"))).toBe(false);
    await shot(page, testInfo, "runs-on-removed");
  });
});
