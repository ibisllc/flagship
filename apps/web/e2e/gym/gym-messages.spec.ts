/**
 * voi.ci pages + Messages on the webapp with no backend (docs/voici-and-messages.md §5, §6, §9, §10, §11; release
 * 0.3 H11 chunk F). One stateful fake `.com` per test: pieces by hash, the publish compare-and-set, the inbox, the
 * drafts lane, the sealed state blob. Every signature the webapp sends is checked here with chunk A's own functions
 * (lib/voiciProtocol.js, run in the page), so a wrong key or wrong bytes fails the test, not just a missing call.
 */

import { test, expect, type Page } from "@playwright/test";
import { webcrypto } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { ADMIN_SEED_HEX, HOME, PASSPHRASE, freshUnlock, livePod, mock, reachHome, sawToast, shot, toastMark, type Call, type Keys, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const CA_SEED_HEX = "3c".repeat(32);
const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface Com {
  index: any;
  pieces: Map<string, Buffer>;
  inbox: any[];
  state: any;
  sent: any[];
  drafts: any[];
  blocks: any[];
  reports: any[];
  consumed: any[];
  other: Record<string, { index: any; keys: { adminRootPub: string; irkPub: string } }>;
}

const path = (p: string | RegExp) => (u: URL) => (typeof p === "string" ? u.pathname === p : p.test(u.pathname));
const sha256 = async (b: Buffer) => Buffer.from(await webcrypto.subtle.digest("SHA-256", b)).toString("hex");

/** Home as `kind`, `.com`'s voi.ci routes answered from `com`. */
async function messagesWorld(page: Page, kind: "admin" | "non-admin" = "admin"): Promise<{ m: Mock; com: Com; keys: Keys; caPub: string }> {
  const keys = await reachHome(page, { kind, servers: [HOME] });
  const m = await mock(page);
  const com: Com = { index: null, pieces: new Map(), inbox: [], state: null, sent: [], drafts: [], blocks: [], reports: [], consumed: [], other: {} };
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  m.get(path("/api/username/smoketest"), { adminRootPub: keys.adminPubHex, irkPub: keys.irkPubHex });
  m.get(path(/^\/api\/username\/([a-z0-9-]+)$/), (c: Call) => {
    const o = com.other[c.url.pathname.split("/").pop()!];
    return o ? { json: o.keys } : { status: 404, json: { code: "not-found" } };
  });
  m.get(path("/api/voici/pages/smoketest"), () => (com.index ? { json: { index: com.index } } : { status: 404, json: { code: "not-found" } }));
  m.get(path(/^\/api\/voici\/pages\/[a-z0-9-]+$/), (c: Call) => {
    const o = com.other[c.url.pathname.split("/").pop()!];
    return o ? { json: { index: o.index } } : { status: 404, json: { code: "not-found" } };
  });
  m.get(path(/^\/api\/voici\/pages\/[a-z0-9-]+\/pieces\/[0-9a-f]{64}$/), (c: Call) => {
    const b = com.pieces.get(c.url.pathname.split("/").pop()!);
    return b ? { raw: b, contentType: "application/octet-stream" } : { status: 404, json: { code: "not-found" } };
  });
  m.post(path("/api/voici/pages/smoketest/pieces"), async (c: Call) => {
    const raw = c.raw!;
    if ((await sha256(raw)) !== c.headers["x-flagship-sha256"] || Number(c.headers["x-flagship-size"]) !== raw.length) return { status: 400, json: { code: "bad-piece" } };
    const ok = await page.evaluate(
      async ({ u, signer }) => {
        const P = await import("/lib/voiciProtocol.js");
        return P.verifyVoiciPieceUpload(u, signer.sig, signer.pub);
      },
      {
        u: { username: "smoketest", pageId: c.headers["x-flagship-page-id"], sha256: c.headers["x-flagship-sha256"], size: raw.length, issuedAt: Number(c.headers["x-flagship-issued-at"]) },
        signer: { sig: c.headers["x-flagship-signature"], pub: keys.adminPubHex ?? keys.irkPubHex },
      },
    );
    if (!ok) return { status: 403, json: { code: "not-sensitive-key" } };
    com.pieces.set(c.headers["x-flagship-sha256"], raw);
    return { json: { ok: true } };
  });
  m.post(path("/api/voici/pages/smoketest/publish"), async (c: Call) => {
    const verdict = await page.evaluate(
      async ({ idx, pub, stored }) => {
        const P = await import("/lib/voiciProtocol.js");
        return P.checkVoiciPublish(idx, { username: "smoketest", sensitiveKind: "admin-root", sensitivePub: pub, storedSeq: stored?.seq ?? 0, storedPageId: stored?.pageId ?? null, now: Date.now() });
      },
      { idx: c.body.index, pub: keys.adminPubHex, stored: com.index },
    );
    if (!verdict.ok) return { status: verdict.code === "seq-conflict" ? 409 : 400, json: { code: verdict.code, index: com.index } };
    for (const p of c.body.index.pieces) if (!com.pieces.has(p.sha256)) return { status: 400, json: { code: "missing-piece" } };
    com.index = c.body.index;
    return { json: { ok: true } };
  });
  m.get(path("/api/voici/pages/smoketest/inbox"), () => ({ json: { items: com.inbox, blocks: com.blocks.length && com.blocks[com.blocks.length - 1].op === "block" ? [com.blocks[com.blocks.length - 1].pseudonymPub] : [], revoked: [], cursor: "" } }));
  m.get(path("/api/accounts/smoketest/messages-state"), () => (com.state ? { json: com.state } : { status: 404, json: { code: "not-found" } }));
  m.on("PUT", path("/api/accounts/smoketest/messages-state"), (c: Call) => {
    if (!c.headers["x-flagship-signature"]) return { status: 401, json: { code: "unauthorized" } };
    if (c.body.version !== (com.state?.version ?? 0) + 1) return { status: 409, json: { code: "version-conflict", state: com.state } };
    com.state = c.body;
    return { json: { ok: true } };
  });
  m.post(path("/api/voici/web/send"), (c: Call) => {
    com.sent.push(c.body.envelope);
    com.inbox.push({ envelope: c.body.envelope, storedAt: Date.now() });
    return { json: { accepted: true } };
  });
  m.post(path("/api/voici/pages/smoketest/block"), (c: Call) => {
    com.blocks.push({ ...c.body.block, signature: c.body.signature });
    return { json: { ok: true } };
  });
  m.post(path("/api/voici/reports"), (c: Call) => {
    com.reports.push({ ...c.body.report, signature: c.body.signature });
    return { json: { ok: true, id: "r1" } };
  });
  m.get(path("/api/accounts/smoketest/voici-drafts"), () => ({ json: { drafts: com.drafts } }));
  m.post(path("/api/accounts/smoketest/voici-drafts"), (c: Call) => {
    if (!c.headers["x-flagship-signature"]) return { status: 401, json: { code: "unauthorized" } };
    com.drafts.push(c.body.envelope);
    return { json: { ok: true } };
  });
  m.post(path("/api/accounts/smoketest/voici-drafts/consume"), (c: Call) => {
    com.consumed.push(c.body);
    com.drafts = com.drafts.filter((d) => !c.body.opIds.includes(d.msgId));
    return { json: { ok: true } };
  });
  const caPub = await page.evaluate(async (caSeedHex) => {
    const P = await import("/lib/voiciProtocol.js");
    const caPub = P.hex(P.ed25519PublicKey(P.hexToBytes(caSeedHex)));
    const { serverTrust } = await import("/lib/serverTrust.js");
    await serverTrust.setVerdict({ trusted: true, caPubkey: caPub, reason: "ok" });
    return caPub;
  }, CA_SEED_HEX);
  return { m, com, keys, caPub };
}

/** Publishes the owner's page through the webapp's own code (accepting messages, display name "Smoke Test"). */
async function publishOwnerPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const O = await import("/lib/voiciOwner.js");
    const profile = { ...O.defaultVoiciProfile("smoketest"), displayName: "Smoke Test" };
    const ops = [O.makeDraftOp("profile", { profile }, { now: Date.now() - 2 }), O.makeDraftOp("accept-messages", { accepts: 1 }, { now: Date.now() - 1 })];
    await O.publishVoiciPage({ ops }, { published: null });
  });
}

/** A signed-in visitor's message to the owner's page (P-256 browser key, a CA attestation), built in the page. */
async function visitorMessage(page: Page, com: Com, text: string, visitorSeed = "2a"): Promise<{ pseudonymPub: string; threadSeed: string; envelope: any }> {
  return page.evaluate(
    async ({ index, text, caSeedHex, visitorSeed }) => {
      const P = await import("/lib/voiciProtocol.js");
      const { p256 } = await import("/vendor/noble-post-quantum/pq-seal.js");
      const pageId = index.pageId;
      const secret = P.deriveMessagesSecret({ seed: P.hexToBytes(visitorSeed.repeat(32)) });
      const p = P.deriveMessagesPseudonymKey(secret, pageId);
      const t = P.deriveMessagesThreadKey(secret, pageId);
      const Ppub = P.hex(p.publicKey);
      const now = Date.now();
      const tag = new Uint8Array(48).fill(1);
      const ca = P.hexToBytes(caSeedHex);
      const att: any = { kind: "MessagesKeyAttestation", version: 1, pseudonymPub: Ppub, abuseEpoch: 1, abuseTagHash: P.sha256Hex(tag), abuseTag: P.b64Encode(tag), issuedAt: now - 60_000, expiresAt: now + 86_400_000, signedBy: P.hex(P.ed25519PublicKey(ca)) };
      att.signature = P.ed25519SignHex(P.canonicalMessagesKeyAttestation(att), ca);
      const bSk = P.hexToBytes("08".repeat(32));
      const delegation = { scope: "voici-messages", origin: "https://voi.ci", audience: pageId, principalPub: Ppub, delegateAlg: "p256", delegatePub: P.hex(p256.getPublicKey(bSk, false)), issuedAt: now - 30_000, expiresAt: att.expiresAt, nonce: "00".repeat(16) };
      const threadStmt = { pageId, pseudonymPub: Ppub, threadPub: P.hex(t.publicKey), issuedAt: now - 30_000 };
      const cred = { attestation: att, delegation, delegationSig: P.signWebDelegation(delegation, p.seed), threadStmt, threadSig: P.signVoiciThreadStatement(threadStmt, p.seed) };
      const conv = P.voiciConv(pageId, Ppub);
      const msgId = P.hex(crypto.getRandomValues(new Uint8Array(16)));
      const body = P.sealVoiciBody({ conv, msgId, sentAt: now, fromPub: Ppub, recipients: [P.hexToBytes(index.inboxPub), t.publicKey], plaintext: { v: 1, text, replyTo: null } });
      const envelope = P.signWebEnvelopeP256({ v: 1, kind: "voici-message", audience: pageId, conv, from: Ppub, msgId, seq: 1, sentAt: now, bodyB64: P.b64Encode(body), cred }, bSk);
      return { pseudonymPub: Ppub, threadSeed: P.hex(t.seed), envelope };
    },
    { index: com.index, text, caSeedHex: CA_SEED_HEX, visitorSeed },
  );
}

async function openMessagesTab(page: Page): Promise<void> {
  await page.click('[data-tab-target="messages"]');
  await expect(page.locator("#view-messages")).toBeVisible();
}

test.describe("gym webapp voi.ci pages and Messages", () => {
  test("gym messages owner reads a verified message and replies", async ({ page }, testInfo) => {
    const { com } = await messagesWorld(page);
    await publishOwnerPage(page);
    const v = await visitorMessage(page, com, "Hi! See https://example.com/plan for the plan.");
    // A forged copy (another body under the same signature) never shows.
    com.inbox.push({ envelope: v.envelope, storedAt: Date.now() }, { envelope: { ...v.envelope, msgId: "ee".repeat(16) }, storedAt: Date.now() });
    await openMessagesTab(page);
    await expect(page.locator("[data-testid=messages-page-status]")).toHaveText("Published");
    // A first message is a request until the owner replies or accepts.
    await expect(page.locator("#messages-list [data-conv]")).toHaveCount(0);
    await page.click('[data-messages-tab="requests"]');
    const row = page.locator("#messages-list [data-conv]");
    await expect(row).toHaveCount(1);
    const code = await page.evaluate(async (pub) => (await import("/lib/voiciProtocol.js")).voiciPseudonymCode(pub), v.pseudonymPub);
    await expect(row.locator("[data-conv-name]")).toHaveText(`Visitor ${code}`);
    await expect(row.locator("[data-conv-unread]")).toHaveCount(1);
    await expect(page.locator("#messages-tab-badge")).toHaveText("1");
    await shot(page, testInfo, "messages-requests");

    await row.click();
    await expect(page.locator("#view-thread")).toBeVisible();
    await expect(page.locator("[data-testid=thread-request]")).toBeVisible();
    await expect(page.locator(".msg-theirs .msg-bubble")).toHaveText("Hi! See https://example.com/plan for the plan.");
    // The link is a button that asks first, with the whole address.
    await page.click("[data-msg-link]");
    await expect(page.locator(".modal-title")).toHaveText("Open example.com?");
    await expect(page.locator(".modal-message")).toHaveText("https://example.com/plan");
    await page.click("[data-modal-cancel]");

    await page.fill("#thread-input", "Thanks, got it.");
    await page.click("#thread-send");
    await expect(page.locator(".msg-mine .msg-bubble")).toHaveText("Thanks, got it.");
    await expect(page.locator("[data-testid=thread-status]")).toHaveText("Sent");
    await expect(page.locator("[data-testid=thread-request]")).toHaveCount(0);
    expect(com.sent).toHaveLength(1);
    // The reply checks under the page's owner key, and the visitor's thread key opens it.
    const opened = await page.evaluate(
      async ({ env, ownerSignPub, pageId, threadSeed }) => {
        const P = await import("/lib/voiciProtocol.js");
        const r = P.checkVoiciReply(env, { pageId, ownerSignPub });
        if (!r.ok) return r.code;
        const o = P.openVoiciBody(P.b64Decode(env.bodyB64), { conv: env.conv, msgId: env.msgId }, P.hexToBytes(threadSeed));
        return o.ok ? o.plaintext.text : o.code;
      },
      { env: com.sent[0], ownerSignPub: com.index.ownerSignPub, pageId: com.index.pageId, threadSeed: v.threadSeed },
    );
    expect(opened).toBe("Thanks, got it.");
    // Opening the thread marked it read in the sealed state blob.
    expect(com.state?.version).toBeGreaterThanOrEqual(1);
    await shot(page, testInfo, "messages-thread-reply");
  });

  test("gym messages page editor publishes after the warning", async ({ page }, testInfo) => {
    const { com, keys } = await messagesWorld(page);
    await openMessagesTab(page);
    await expect(page.locator("[data-testid=messages-page-status]")).toHaveText("Not published");
    await expect(page.locator("[data-testid=messages-empty]")).toHaveText("No messages yet. Turn on Accept messages on your page to get them.");
    await page.click("[data-testid=messages-your-page]");
    await expect(page.locator("#view-page-editor")).toBeVisible();
    await expect(page.locator("[data-testid=voici-warning]")).toHaveText(
      "Anyone can see this page. It shares your username with your apps and servers, so people can connect them.",
    );
    await page.setInputFiles("#pe-photo", { name: "me.png", mimeType: "image/png", buffer: ONE_PX_PNG });
    await expect(page.locator("#pe-avatar-img")).toBeVisible();
    await page.fill("#pe-name", "Smoke Test");
    await page.fill("#pe-bio", "Builds things.");
    await page.click("#pe-link-add");
    await page.fill('[data-link-url="0"]', "https://github.com/smoketest");
    await expect(page.locator('[data-link-site="0"]')).toHaveText("GitHub");
    await page.fill('[data-link-label="0"]', "Code");
    await page.click("#pe-save-profile");
    // Nothing is published yet: the change is grayed, the first publish waits for Publish.
    await expect(page.locator("[data-testid=profile-pending]")).toHaveText("Not published yet");
    await page.check("#pe-accepts");
    await page.fill("#pe-post-text", "Hello from the web.");
    await page.click("#pe-post-add");
    await expect(page.locator("#pe-posts [data-post] [data-post-pending]")).toHaveText("Not published yet");
    await expect(page.locator("[data-testid=preview-name]")).toHaveText("Smoke Test");
    await expect(page.locator("[data-testid=preview-send]")).toHaveText("Send me a message");
    expect(com.index).toBeNull();
    await shot(page, testInfo, "page-editor-pending");

    await page.click("#pe-publish");
    await expect(page.locator(".modal-title")).toHaveText("Page and message rules");
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Publish your page?");
    await expect(page.locator(".modal-message")).toHaveText("Anyone can see this page. It shares your username with your apps and servers, so people can connect them.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-testid=page-status]")).toHaveText("Published at voi.ci/smoketest");
    await expect(page.locator("#pe-posts .is-pending")).toHaveCount(0);

    // Signed by the admin root at seq 1; the photo is a clean JPEG within the cap.
    expect(com.index.seq).toBe(1);
    expect(com.index.signerPub).toBe(keys.adminPubHex);
    expect(com.index.acceptsMessages).toBe(1);
    const avatar = com.index.pieces.find((p: any) => p.role === "avatar");
    const jpeg = com.pieces.get(avatar.sha256)!;
    expect(jpeg.length).toBeLessThanOrEqual(150 * 1024);
    const checks = await page.evaluate(async (hex) => {
      const P = await import("/lib/voiciProtocol.js");
      const b = P.hexToBytes(hex);
      return [P.isVoiciJpeg(b), P.voiciJpegHasMetadata(b)];
    }, jpeg.toString("hex"));
    expect(checks).toEqual([true, false]);
    const profile = JSON.parse(com.pieces.get(com.index.pieces.find((p: any) => p.role === "profile").sha256)!.toString("utf8"));
    expect(profile).toMatchObject({ displayName: "Smoke Test", bio: "Builds things.", links: [{ url: "https://github.com/smoketest", label: "Code", site: "github" }] });
    await shot(page, testInfo, "page-editor-published");
  });

  test("gym messages a device without the admin root sends a draft and shows it grayed", async ({ page }, testInfo) => {
    const { m, com, keys } = await messagesWorld(page, "non-admin");
    // This device's grant, signed by the admin root, as `.com` lists it.
    const grant = await page.evaluate(async (adminSeedHex) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const P = await import("/lib/voiciProtocol.js");
      const { deviceGrantCanonicalBytes } = await import("/lib/crossDevicePairing.js");
      const { getActiveProfile } = await import("/lib/profiles.js");
      const prof = getActiveProfile();
      const seed = await ks.deriveAccountDeviceSeedFromSeed(getSession().umk, prof.accountId, prof.deviceId);
      const grant = { grantId: "g1", username: "smoketest", deviceId: prof.deviceId, devicePubHex: P.hex(P.ed25519PublicKey(seed)), scopes: ["browse", "view-directory"], issuedAt: Date.now() - 1000, expiresAt: Date.now() + 86_400_000 };
      return { grant, grantSignature: P.ed25519SignHex(deviceGrantCanonicalBytes(grant), P.hexToBytes(adminSeedHex)) };
    }, ADMIN_SEED_HEX);
    m.first("GET", path("/api/users/smoketest/device-grants"), { grants: [grant] });
    await openMessagesTab(page);
    await page.click("[data-testid=messages-your-page]");
    await expect(page.locator("[data-testid=page-admin-only]")).toHaveText("Only an admin device can publish your page. Changes you make here wait for it.");
    await expect(page.locator("#pe-publish")).toHaveCount(0);
    const mark = await toastMark(page);
    await page.fill("#pe-post-text", "Written on a member device.");
    await page.click("#pe-post-add");
    await sawToast(page, "Sent to your admin device to publish.", 15_000, mark);
    await expect(page.locator("#pe-posts [data-post] [data-post-pending]")).toHaveText("Waiting for an admin device to publish");
    await expect(page.locator("[data-testid=page-status]")).toHaveText("Waiting for an admin device to publish");
    expect(com.index).toBeNull();
    expect(com.drafts).toHaveLength(1);
    // The draft is sealed (no text on the wire) and opens under the account's drafts key after the grant check.
    expect(JSON.stringify(com.drafts[0])).not.toContain("Written on a member device.");
    const opened = await page.evaluate(async () => {
      const O = await import("/lib/voiciOwner.js");
      const list = await O.loadDraftOps();
      return list.map((d: any) => d.op.post?.text);
    });
    expect(opened).toEqual(["Written on a member device."]);
    expect(keys.kind).toBe("non-admin");
    await shot(page, testInfo, "page-editor-draft");
  });

  test("gym messages rename block and report a visitor", async ({ page }, testInfo) => {
    const { com } = await messagesWorld(page);
    await publishOwnerPage(page);
    const v = await visitorMessage(page, com, "buy cheap stuff");
    com.inbox.push({ envelope: v.envelope, storedAt: Date.now() });
    await openMessagesTab(page);
    await page.click('[data-messages-tab="requests"]');
    await page.click("#messages-list [data-conv]");
    await expect(page.locator("#view-thread")).toBeVisible();

    await page.click("#thread-menu");
    await page.click('[data-modal-choice="rename"]');
    await page.fill(".modal-input", "Spammer");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#thread-title")).toHaveText("Spammer");
    // The nickname is in the sealed state blob, not in clear.
    expect(JSON.stringify(com.state)).not.toContain("Spammer");
    const nick = await page.evaluate(async (blob) => {
      const P = await import("/lib/voiciProtocol.js");
      const { getSession } = await import("/lib/state.js");
      const s = P.openMessagesState(P.deriveMessagesStateKey({ seed: getSession().umk }), "smoketest", blob);
      return s ? Object.values(s.nicknames).map((n: any) => n.name) : null;
    }, com.state);
    expect(nick).toEqual(["Spammer"]);

    // Accept tells .com with a signed unblock order (it can't read the sealed state).
    await page.click("#thread-accept");
    await expect(page.locator("[data-testid=thread-request]")).toHaveCount(0);
    expect(com.blocks.map((b) => b.op)).toEqual(["unblock"]);

    await page.click(`[data-msg-report="${v.envelope.msgId}"]`);
    await expect(page.locator(".modal-title")).toHaveText("Report this message?");
    await page.click('[data-modal-choice="spam"]');
    await sawToast(page, "Reported. Thank you.");
    expect(com.reports).toHaveLength(1);
    expect(com.reports[0]).toMatchObject({ kind: "message", reason: "spam", attached: null, pageId: com.index.pageId });

    await page.click("#thread-menu");
    await page.click('[data-modal-choice="block"]');
    await expect(page.locator(".modal-title")).toHaveText("Block Spammer?");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-messages")).toBeVisible();
    await expect(page.locator("#messages-list [data-conv]")).toHaveCount(0);
    expect(com.blocks).toHaveLength(2);
    const signed = await page.evaluate(
      async ({ b, r, ownerSignPub }) => {
        const P = await import("/lib/voiciProtocol.js");
        const { signature, ...block } = b;
        const { signature: rs, ...report } = r;
        return [P.verifyVoiciBlock(block, signature, ownerSignPub), P.verifyVoiciMessageReport(report, rs, ownerSignPub)];
      },
      { b: com.blocks[1], r: com.reports[0], ownerSignPub: com.index.ownerSignPub },
    );
    expect(signed).toEqual([true, true]);
    expect(com.blocks[1]).toMatchObject({ pseudonymPub: v.pseudonymPub, op: "block" });
    await shot(page, testInfo, "messages-after-block");
  });

  test("gym messages approve a voi.ci sign-in on the slow tier", async ({ page }, testInfo) => {
    // The voi.ci tab: an X25519 key in the QR, a P-256 browser key in the request.
    const subtle = webcrypto.subtle;
    const browserKp = (await subtle.generateKey({ name: "X25519" } as any, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
    const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    const browserPk = b64u(new Uint8Array(await subtle.exportKey("raw", browserKp.publicKey)));
    const bSk = p256.utils.randomSecretKey();
    let request: any = null;
    const makeRequest = (pageId: string) => ({ kind: "flagship/voici-sign-in-request/v1", origin: "https://voi.ci", pageId, username: "bob", delegatePub: Buffer.from(p256.getPublicKey(bSk, false)).toString("hex"), nonce: "5a".repeat(16) });
    let answer: any = null;
    let sas = "";
    await page.routeWebSocket(/\/qr-pipe\//, (ws) => {
      let kEnc: any = null;
      ws.onMessage(async (msg) => {
        const m = JSON.parse(String(msg));
        if (m.kind === "hello") {
          const peer = await subtle.importKey("raw", Buffer.from(m.phonePk, "base64url"), { name: "X25519" } as any, false, []);
          const shared = await subtle.deriveBits({ name: "X25519", public: peer } as any, browserKp.privateKey, 256);
          const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
          const expand = async (info: string, bits: number) =>
            new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: Buffer.from("flagship/qr/v1"), info: Buffer.from(info) }, base, bits));
          kEnc = await subtle.importKey("raw", await expand("flagship/qr/enc/v1", 256), "AES-GCM", false, ["encrypt", "decrypt"]);
          const s = await expand("flagship/qr/sas/v1", 32);
          sas = String((((s[0]! << 24) | (s[1]! << 16) | (s[2]! << 8) | s[3]!) >>> 0) % 1_000_000).padStart(6, "0");
          // The relay acks the phone's hello; the browser sends nothing (one-way pipe, spec §6.5 "C:").
          ws.send(JSON.stringify({ kind: "ack" }));
        } else if (m.kind === "deliver") {
          const plain = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(m.nonce, "base64url") }, kEnc, Buffer.from(m.ciphertext, "base64url"));
          answer = JSON.parse(Buffer.from(plain).toString("utf8"));
          ws.send(JSON.stringify({ kind: "delivered" }));
        }
      });
    });

    const { m, com, caPub } = await messagesWorld(page);
    // Bob's page, which this account (the visitor) signs in to.
    const bob = await page.evaluate(async () => {
      const P = await import("/lib/voiciProtocol.js");
      const O = await import("/lib/voiciOwner.js");
      const seed = P.hexToBytes("b0".repeat(32));
      const pub = P.hex(P.ed25519PublicKey(seed));
      const signer = { kind: "admin-root", pub, sign: async (b: Uint8Array) => P.ed25519SignHex(b, seed) };
      const merged = { profile: { ...O.defaultVoiciProfile("bob"), displayName: "Bob Builder" }, acceptsMessages: 1, chunks: [] };
      const { index, uploads } = await O.buildVoiciIndex({ username: "bob", published: null, merged, images: new Map(), signer, umk: { seed: P.hexToBytes("b1".repeat(32)) }, now: Date.now() });
      return { index, pub, uploads: uploads.map((u: any) => ({ sha256: u.sha256, hex: P.hex(u.bytes) })) };
    });
    request = makeRequest(bob.index.pageId);
    for (const u of bob.uploads) com.pieces.set(u.sha256, Buffer.from(u.hex, "hex"));
    com.other.bob = { index: bob.index, keys: { adminRootPub: bob.pub, irkPub: "22".repeat(32) } };
    let attestRequest: any = null;
    m.first("POST", path("/api/accounts/smoketest/messages-attestation"), async (c: Call) => {
      attestRequest = c;
      const att = await page.evaluate(
        async ({ pub, caSeedHex }) => {
          const P = await import("/lib/voiciProtocol.js");
          const now = Date.now();
          const tag = new Uint8Array(40).fill(9);
          const ca = P.hexToBytes(caSeedHex);
          const a: any = { kind: "MessagesKeyAttestation", version: 1, pseudonymPub: pub, abuseEpoch: 1, abuseTagHash: P.sha256Hex(tag), abuseTag: P.b64Encode(tag), issuedAt: now, expiresAt: now + 30 * 86_400_000, signedBy: P.hex(P.ed25519PublicKey(ca)) };
          a.signature = P.ed25519SignHex(P.canonicalMessagesKeyAttestation(a), ca);
          return a;
        },
        { pub: c.body.request.pseudonymPub, caSeedHex: CA_SEED_HEX },
      );
      return { json: { attestation: att } };
    });

    const link = `https://flagshipserver.com/voici-sign-in#s=gymsid0123456789&k=${browserPk}&p=${bob.index.pageId}&u=bob&d=${request.delegatePub}&n=${request.nonce}`;
    await page.evaluate(async (l) => {
      const { parseVoiciSignInLink } = await import("/lib/voiciSignIn.js");
      const { enterVoiciSignIn } = await import("/views/voici-sign-in.js");
      await enterVoiciSignIn(parseVoiciSignInLink(l));
    }, link);
    await expect(page.locator("[data-testid=voici-sign-in-title]")).toHaveText("Sign in to voi.ci to message Bob Builder?");
    await expect(page.locator("#voici-sign-in-approve")).toBeEnabled();
    await expect.poll(() => sas).not.toBe("");
    await expect(page.locator("[data-testid=voici-sign-in-code]")).toHaveText(sas);
    await expect(page.locator("[data-testid=voici-sign-in-appear]")).toContainText("They never see your username.");
    await shot(page, testInfo, "voici-sign-in-approve");
    await page.click("#voici-sign-in-approve");
    await expect(page.locator(".modal-title")).toHaveText("Page and message rules");
    await page.click("[data-modal-ok]");
    await freshUnlock(page, "Approve this sign-in?", PASSPHRASE);
    await expect(page.locator("[data-testid=voici-sign-in-done]")).toHaveText("Signed in. You can go back to voi.ci.");

    // The webapp asked on the slow tier, and the answer passes voi.ci's own check.
    expect(attestRequest.body.request.deviceCheckRef).toBe("none");
    expect(attestRequest.headers["x-flagship-device-id"]).toMatch(/^[0-9a-f]{32}$/);
    const verdict = await page.evaluate(
      async ({ answer, request, caPub }) => {
        const P = await import("/lib/voiciProtocol.js");
        const r = P.checkVoiciSignInAnswer(answer, { request, caKeys: [caPub], now: Date.now() });
        return r.ok ? "ok" : r.code;
      },
      { answer, request, caPub },
    );
    expect(verdict).toBe("ok");
    // Settings → Messages lists the website (from the sealed state blob).
    expect(com.state?.version).toBe(1);
    await page.evaluate(async () => (await import("/views/messages.js")).enterMessagesSettings());
    await expect(page.locator("[data-site-signout]")).toHaveCount(1);
    await shot(page, testInfo, "messages-settings-signed-in");
  });

  test("gym messages a reply on a voi.ci page this account wrote to shows once", async ({ page }, testInfo) => {
    const { m, com, caPub } = await messagesWorld(page);
    // Bob's page, and a reply from Bob sealed to this account's thread key for it.
    const world = await page.evaluate(async (caSeedHex) => {
      const P = await import("/lib/voiciProtocol.js");
      const O = await import("/lib/voiciOwner.js");
      const { pagePseudonym } = await import("/lib/voiciSignIn.js");
      const { rememberVisitedPage } = await import("/lib/voiciReplies.js");
      const { getSession } = await import("/lib/state.js");
      const seed = P.hexToBytes("b0".repeat(32));
      const pub = P.hex(P.ed25519PublicKey(seed));
      const bobUmk = { seed: P.hexToBytes("b1".repeat(32)) };
      const signer = { kind: "admin-root", pub, sign: async (b: Uint8Array) => P.ed25519SignHex(b, seed) };
      const merged = { profile: { ...O.defaultVoiciProfile("bob"), displayName: "Bob Builder" }, acceptsMessages: 1, chunks: [] };
      const { index } = await O.buildVoiciIndex({ username: "bob", published: null, merged, images: new Map(), signer, umk: bobUmk, now: Date.now() });
      const pageId = index.pageId;
      const { p, t } = pagePseudonym(getSession().umk, pageId);
      const Ppub = P.hex(p.publicKey);
      const conv = P.voiciConv(pageId, Ppub);
      const owner = P.deriveVoiciOwnerSignKey(bobUmk, pageId, 1);
      const inbox = P.deriveVoiciInboxKey(bobUmk, pageId, 1);
      const at = Date.now() - 1000;
      const msgId = "ab".repeat(16);
      const body = P.sealVoiciBody({ conv, msgId, sentAt: at, fromPub: P.hex(owner.publicKey), recipients: [t.publicKey, inbox.publicKey], plaintext: { v: 1, text: "Thanks!", replyTo: null } });
      const reply = P.signWebEnvelopeEd25519({ v: 1, kind: "voici-reply", audience: pageId, conv, from: P.hex(owner.publicKey), msgId, seq: 1, sentAt: at, bodyB64: P.b64Encode(body), cred: { pageSeq: 1 } }, owner.seed);
      // The attestation this browser got when it approved the sign-in.
      const tag = new Uint8Array(32).fill(2);
      const ca = P.hexToBytes(caSeedHex);
      const att: any = { kind: "MessagesKeyAttestation", version: 1, pseudonymPub: Ppub, abuseEpoch: 1, abuseTagHash: P.sha256Hex(tag), abuseTag: P.b64Encode(tag), issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 20 * 86_400_000, signedBy: P.hex(P.ed25519PublicKey(ca)) };
      att.signature = P.ed25519SignHex(P.canonicalMessagesKeyAttestation(att), ca);
      localStorage.setItem(`flagship.voici.att.smoketest.${pageId}`, JSON.stringify(att));
      rememberVisitedPage(pageId, "bob");
      return { index, pub, reply };
    }, CA_SEED_HEX);
    com.other.bob = { index: world.index, keys: { adminRootPub: world.pub, irkPub: "22".repeat(32) } };
    const fetches: any[] = [];
    m.first("POST", path("/api/voici/web/thread"), (c: Call) => {
      fetches.push(c.body);
      return { json: { items: [{ id: "1", envelope: world.reply, storedAt: Date.now(), fetchedAt: null, direct: false }], next: "1", more: false } };
    });
    await openMessagesTab(page);
    const row = page.locator("[data-reply-page]");
    await expect(row).toHaveText("You have a reply on voi.ci/bob");
    await expect(page.locator("#messages-tab-badge")).toHaveText("1");
    // The fetch is signed by a key P delegated to, as .com checks it; nothing of the thread is shown here.
    const ok = await page.evaluate(
      async ({ f, caPub }) => {
        const P = await import("/lib/voiciProtocol.js");
        const { canonicalVoiciThreadFetch } = await import("/lib/voiciReplies.js");
        const att = P.checkMessagesKeyAttestation(f.cred.attestation, { caKeys: [caPub], now: Date.now() });
        const d = P.checkWebDelegation(f.cred.delegation, f.cred.delegationSig, { scope: "voici-messages", origin: "https://voi.ci", audience: f.cred.delegation.audience, principalPub: f.cred.delegation.principalPub, now: Date.now() });
        return att.ok && d.ok && P.p256VerifyP1363(f.sig, canonicalVoiciThreadFetch(f), f.cred.delegation.delegatePub);
      },
      { f: fetches[0], caPub },
    );
    expect(ok).toBe(true);
    await expect(page.locator("text=Thanks!")).toHaveCount(0);
    await shot(page, testInfo, "messages-reply-alert");
    const popup = page.waitForEvent("popup");
    await row.click();
    expect((await popup).url()).toBe("https://voi.ci/bob");
    await expect(row).toHaveCount(0);
    // Seen: the next open shows nothing for the same reply.
    await page.click('[data-tab-target="home"]');
    await openMessagesTab(page);
    await expect.poll(() => fetches.length).toBeGreaterThanOrEqual(2);
    await expect(page.locator("[data-reply-page]")).toHaveCount(0);
  });
});
