/**
 * Flagship Inference in the webapp (docs/build-modes.md, docs/ai-inference-costs.md
 * §15) with no backend: the built-in provider's credits line and refusals in
 * Settings, the AI-key step building on it straight away (or offering it next
 * to a saved key), the build chat's model menu riding start and every reply,
 * the "used N credits" line under a reply, and attachments (CSV/JSON sample
 * data, PDFs, images) staged and sent on start.
 *
 * Crypto is real: the status read and every pass mint are signed with the
 * session's IRK. `.com` (status, token, catalog) and the box (name check,
 * start, session state, reply) are answered by one page.route router; any
 * other foreign request is a 404, so nothing reaches the network. Each test
 * asserts what the stubbed POSTs received, not only what renders.
 */

import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { stubAccountReadToken } from "../fixtures/accountRead.js";

const PASSPHRASE = "correct-horse-battery-staple-gym";
const BOX = "home.smoketest.flagship.services";
const LINE = "1,840 free credits left · 500 added each week";

const CREDITS = {
  week: { used: 160_000, allowance: 500_000, remaining: 340_000, resetsAt: 0 },
  starter: { used: 500_000, allowance: 2_000_000, remaining: 1_500_000 },
  usedTokens: 660_000,
  allowanceTokens: 2_500_000,
  remainingTokens: 1_840_000,
  remainingCredits: 1_840,
  weeklyCredits: 500,
  tokensPerCredit: 1000,
};
const SPENT = { ...CREDITS, remainingTokens: 0, remainingCredits: 0 };

const CATALOG = {
  models: [
    { id: "low", tier: "Low", model: "Qwen3.6-35B-A3B", multiplier: 1, label: "Low 1× (Qwen3.6-35B-A3B)",
      descriptor: "Quick and thrifty. Handles most apps and reads screenshots.", contextTokens: 262144,
      modalities: ["text", "image"], reasoning: true, default: true },
    { id: "medium", tier: "Medium", model: "DeepSeek-V4-Flash", multiplier: 1, label: "Medium 1× (DeepSeek-V4-Flash)",
      descriptor: "A larger model with a 1M-token memory, for big apps. Text only.", contextTokens: 1048576,
      modalities: ["text"], reasoning: true, visionAlternative: "medium-vision" },
    { id: "medium-vision", tier: "Medium multimodal", model: "GLM-5.3-Flash", multiplier: 2,
      label: "Medium multimodal 2× (GLM-5.3-Flash)", descriptor: "Sees screenshots and sketches well.",
      contextTokens: 1048576, modalities: ["text", "image"], reasoning: true },
    { id: "high", tier: "High", model: "MiniMax-M3", multiplier: 3.5, label: "High 3.5× (MiniMax-M3)",
      descriptor: "The strongest model, for hard apps.", contextTokens: 1048576,
      modalities: ["text"], reasoning: true },
  ],
  defaultModel: "low",
  creditTokens: 1000,
  inputWeight: 1,
  outputWeight: 4,
};

const PASS = { provider: "flagship", apiKey: "fa.gym-pass", baseUrl: "https://inference.flagshipserver.com/v1", source: "promo", relay: true };

test.use({ viewport: { width: 430, height: 932 } });

async function shot(page: Page, testInfo: TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

/** Unlock a fresh identity, then seed an account with a username and one
 *  paired server so the status read is signed and builds have a box. */
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
  await page.evaluate(async (box) => {
    const store = await import("/lib/profilesStore.js");
    store.ensureProfile("smoketest");
    store.setActiveCloudName("smoketest");
    store.set("username", "smoketest");
    const { getSession } = await import("/lib/state.js");
    getSession().username = "smoketest";
    const api = await import("/lib/api.js");
    api.setPodBaseUrl(`https://${box}`);
    api.setSessionToken("gym-fixture-session-token");
    api.setSessionTokenForPod(box, "gym-fixture-session-token");
    (await import("/lib/apex.js")).setApexOverride({ control: "https://flagshipserver.com" });
  }, BOX);
}

interface Seen {
  method: string;
  host: string;
  path: string;
  body: any;
}

type Answer = { status?: number; json: unknown } | null;
type Rule = [string, (body: any, url: URL, method: string) => Answer];

/** One router for every foreign request: the first rule whose substring
 *  matches the path answers; anything else is a 404. Every request is logged. */
async function stub(page: Page, rules: Rule[]): Promise<Seen[]> {
  const seen: Seen[] = [];
  await page.route(
    (url) => !url.href.startsWith("http://127.0.0.1"),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      let body: any = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      seen.push({ method: req.method(), host: url.host, path: url.pathname, body });
      for (const [needle, answer] of rules) {
        if (!`${url.pathname}${url.search}`.includes(needle)) continue;
        const r = answer(body, url, req.method());
        if (!r) continue;
        await route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.json) });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
    },
  );
  return seen;
}

const ok = (json: unknown): Answer => ({ json });
const statusBody = (over: Record<string, unknown> = {}) => ({ available: true, ended: false, reason: null, credits: CREDITS, ...over });

/** The signed promo request shape every status read and mint carries. */
function expectSigned(body: any, serverFqdn: string): void {
  expect(body.request).toMatchObject({
    username: "smoketest",
    serverFqdn,
    provider: "flagship",
    desiredDailyInputTokenCap: 0,
    desiredDailyOutputTokenCap: 0,
  });
  expect(body.request.issuedAt).toBeGreaterThan(0);
  expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
}

async function reachSettingsDetail(page: Page): Promise<void> {
  await page.click('[data-tab-target="settings"]');
  await expect(page.locator("#view-settings-tab")).toBeVisible();
  await page.click("#settings-tab-providers");
  await expect(page.locator("#view-settings")).toBeVisible({ timeout: 10_000 });
}

async function openScratch(page: Page): Promise<void> {
  await page.click('[data-tab-target="apps"]');
  await expect(page.locator("#view-services-list")).toBeVisible();
  await page.click("#services-list-open-vibe-code");
  await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
  await page.click("#build-src-scratch");
}

/** Box rules for a scratch build: the name is free, start hands back a
 *  session, and the session state comes from `state()`. */
function boxRules(state: () => unknown): Rule[] {
  return [
    ["/api/screens/vibe-code/name-check", () => ok({ ok: true, name: "habits" })],
    ["/api/screens/vibe-code/start", () => ok({ sessionId: "gym-sess-1" })],
    ["/api/screens/llm/sessions/gym-sess-1/reply", () => ok({ ok: true })],
    ["/api/screens/llm/sessions/gym-sess-1", () => ok(state())],
  ];
}

test.describe("gym webapp inference", () => {
  test("gym inference settings lists Flagship Inference first with the credits line", async ({ page }, testInfo) => {
    await reachHome(page);
    const seen = await stub(page, [
      ["/api/free-ai/status", () => ok(statusBody())],
      ["/api/inference/models", () => ok(CATALOG)],
    ]);
    await reachSettingsDetail(page);
    const card = page.locator("#free-ai-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Flagship Inference");
    await expect(card).toContainText("We use third-party providers and anonymize your requests.");
    await expect(page.locator("#free-ai-line")).toHaveText(LINE);
    await expect(page.locator("#free-ai-line")).not.toHaveClass(/warn/);
    // No key saved: it is the active provider, says so, and can't be removed.
    await expect(card).toHaveClass(/is-active/);
    await expect(page.locator("#free-ai-use")).toHaveText("active");
    await expect(card).toContainText("Used automatically when you build with AI and haven't added your own key.");
    await expect(card.locator('[data-action="remove"]')).toHaveCount(0);
    // Its default-model menu comes from the public catalog.
    await expect(page.locator("#free-ai-default-model .mm-trigger-text")).toHaveText("Low 1×", { timeout: 10_000 });
    const reads = seen.filter((s) => s.path === "/api/free-ai/status");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expectSigned(r.body, "");
    await shot(page, testInfo, "settings-free-ai");
  });

  test("gym inference settings shows each refusal in its own words", async ({ page }, testInfo) => {
    await reachHome(page);
    let status: unknown = statusBody({ credits: SPENT });
    await stub(page, [
      ["/api/free-ai/status", () => ok(status)],
      ["/api/inference/models", () => ok(CATALOG)],
    ]);
    await reachSettingsDetail(page);
    const line = page.locator("#free-ai-line");
    const rerender = () =>
      page.evaluate(async () => {
        const { renderProviders } = await import("/views/settings.js");
        await renderProviders();
      });
    const cases: Array<{ status: unknown; text: string; ownKey: boolean; point: string }> = [
      {
        status: statusBody({ credits: SPENT }),
        text: "You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.",
        ownKey: true,
        point: "refusal-used-up",
      },
      {
        status: statusBody({ reason: "no-server" }),
        text: "Flagship Inference starts once one of your servers is running.",
        ownKey: false,
        point: "refusal-no-server",
      },
      {
        status: statusBody({ reason: "busy-today" }),
        text: "Flagship Inference is busy today. Try again tomorrow, or use your own AI key.",
        ownKey: true,
        point: "refusal-busy-today",
      },
      {
        status: statusBody({ available: false, ended: true }),
        text: "The free building period has ended — use your own AI key.",
        ownKey: true,
        point: "refusal-ended",
      },
    ];
    for (const c of cases) {
      status = c.status;
      await rerender();
      await expect(line).toHaveText(c.text, { timeout: 10_000 });
      await expect(line).toHaveClass(/warn/);
      // A refused entry is still listed (never hidden), but can't be chosen.
      await expect(page.locator("#free-ai-card")).toContainText("Flagship Inference");
      await expect(page.locator("#free-ai-use")).toHaveCount(0);
      await expect(page.locator("#free-ai-add-key")).toHaveCount(c.ownKey ? 1 : 0);
      await shot(page, testInfo, c.point);
    }
  });

  test("gym inference AI-key step builds on Flagship Inference straight away with no saved key", async ({ page }, testInfo) => {
    await reachHome(page);
    let polls = 0;
    const seen = await stub(page, [
      ["/api/free-ai/status", () => ok(statusBody())],
      ["/api/free-ai/token", () => ok({ ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })],
      ["/api/inference/models", () => ok(CATALOG)],
      ...boxRules(() => {
        polls++;
        return {
          status: "streaming",
          model: "high",
          messages: [
            { role: "user", text: "A simple habit tracker" },
            { role: "assistant", text: "Here's a plan: a table of habits, one checkbox per day.", credits: 2.84 },
          ],
          files: {},
        };
      }),
    ]);
    await openScratch(page);
    // No key saved and credits left: the step is skipped, never shown.
    await expect(page.locator("#toast")).toContainText("Using Flagship Inference", { timeout: 10_000 });
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    const mints = () => seen.filter((s) => s.path === "/api/free-ai/token");
    expect(mints().length).toBe(1);
    expectSigned(mints()[0]!.body, "");
    // The chat starts on the catalog's default model.
    const bar = page.locator("#vc-model-bar");
    await expect(bar).toBeVisible();
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Low 1×", { timeout: 10_000 });
    await shot(page, testInfo, "chat-on-flagship");
    // Pick another model for this build from the menu.
    await bar.locator(".mm-trigger").click();
    const panel = bar.locator(".mm-panel");
    await expect(panel.locator(".mm-head")).toHaveText("Flagship Inference");
    await expect(panel.locator("[data-mm-model]")).toHaveCount(4);
    await expect(panel.locator('[data-mm-model="low"]')).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator('[data-mm-model="high"]')).toContainText("The strongest model, for hard apps.");
    await shot(page, testInfo, "model-menu-open");
    await panel.locator('[data-mm-model="high"]').click();
    await expect(bar.locator(".mm-trigger-text")).toHaveText("High 3.5×");
    await page.fill("#vc-prompt", "A simple habit tracker");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    // A fresh pass for THIS box rides the start, with the chosen model.
    await expect.poll(() => seen.filter((s) => s.path === "/api/screens/vibe-code/start").length, { timeout: 10_000 }).toBe(1);
    expect(mints().length).toBe(2);
    expectSigned(mints()[1]!.body, BOX);
    const start = seen.find((s) => s.path === "/api/screens/vibe-code/start")!.body;
    expect(start).toMatchObject({ prompt: "A simple habit tracker", name: "habits", model: "high", credential: PASS });
    expect(start).not.toHaveProperty("effort");
    // A Flagship Inference reply says what it cost, one decimal at most.
    await expect(page.locator("#vc-messages .vc-msg-credits")).toHaveText("used 2.8 credits", { timeout: 10_000 });
    expect(polls).toBeGreaterThan(0);
    await shot(page, testInfo, "reply-credits");
  });

  test("gym inference each reply carries the model choice made for it", async ({ page }, testInfo) => {
    await reachHome(page);
    let replied = false;
    const seen = await stub(page, [
      ["/api/free-ai/status", () => ok(statusBody())],
      ["/api/free-ai/token", () => ok({ ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })],
      ["/api/inference/models", () => ok(CATALOG)],
      ...boxRules(() =>
        replied
          ? {
              status: "ready-to-deploy",
              model: "medium",
              messages: [
                { role: "user", text: "A simple habit tracker" },
                { role: "assistant", text: "Should it count weekends?", credits: 1.2 },
                { role: "user", text: "Yes, weekends too" },
                { role: "assistant", text: "Done: weekends count.", credits: 0.96 },
              ],
              files: { "server.js": "// app" },
            }
          : {
              status: "awaiting-tool-response",
              model: "low",
              messages: [
                { role: "user", text: "A simple habit tracker" },
                { role: "assistant", text: "Before I start, one question.", credits: 1.2 },
              ],
              pendingRequest: { kind: "talkToUser", toolUseId: "t1", payload: { message: "Should it count weekends?" } },
              files: {},
            },
      ),
    ]);
    await openScratch(page);
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    const bar = page.locator("#vc-model-bar");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Low 1×", { timeout: 10_000 });
    await page.fill("#vc-prompt", "A simple habit tracker");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    await expect(page.locator("#vc-status")).toHaveText("The AI has a question", { timeout: 10_000 });
    await expect(page.locator("#vc-messages")).toContainText("Should it count weekends?");
    const start = seen.find((s) => s.path === "/api/screens/vibe-code/start")!.body;
    expect(start.model).toBe("low");
    // Between messages: switch to Medium. Flagship Inference lists no effort
    // levels, so no effort picker shows and the reply clears any effort.
    await bar.locator(".mm-trigger").click();
    await bar.locator('.mm-panel [data-mm-model="medium"]').click();
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Medium 1×");
    await expect(bar.locator("[data-mm-effort]")).toHaveCount(0);
    await shot(page, testInfo, "reply-switch-model");
    await page.fill("#vc-prompt", "Yes, weekends too");
    const mintsBefore = seen.filter((s) => s.path === "/api/free-ai/token").length;
    replied = true;
    await page.click("#vc-send");
    await expect.poll(() => seen.filter((s) => s.path.endsWith("/reply")).length, { timeout: 10_000 }).toBe(1);
    const reply = seen.find((s) => s.path.endsWith("/reply"))!.body;
    expect(reply).toMatchObject({ text: "Yes, weekends too", attachments: [], model: "medium", effort: null, credential: PASS });
    // A pass is swapped for a fresh one on every reply.
    expect(seen.filter((s) => s.path === "/api/free-ai/token").length).toBe(mintsBefore + 1);
    await expect(page.locator("#vc-status")).toHaveText("Ready to deploy", { timeout: 10_000 });
    await expect(page.locator("#vc-messages .vc-msg-credits")).toHaveText(["used 1.2 credits", "used 1 credit"]);
    await shot(page, testInfo, "reply-sent");
  });

  test("gym inference AI-key step offers Flagship Inference beside a saved key", async ({ page }, testInfo) => {
    await reachHome(page);
    const seen = await stub(page, [
      ["/api/free-ai/status", () => ok(statusBody())],
      ["/api/free-ai/token", () => ok({ ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })],
      ["/api/inference/models", () => ok(CATALOG)],
    ]);
    await page.evaluate(async () => {
      const { addProvider } = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      await addProvider(getSession().umk, {
        provider: "openai",
        label: "Work key",
        apiKey: "sk-gymfixture-0123456789abcdef",
        relay: true,
      });
    });
    await openScratch(page);
    // A saved key: the step shows, Flagship Inference first, never deletable.
    await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
    const free = page.locator("#build-key-saved #build-key-free-ai");
    await expect(free).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-key-free-ai-status")).toHaveText(LINE);
    await expect(free).not.toHaveClass(/is-disabled/);
    await expect(free.locator(".build-key-delete")).toHaveCount(0);
    const rows = page.locator("#build-key-saved .build-key-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("id", "build-key-free-ai");
    await expect(rows.nth(1)).toContainText("Work key");
    await expect(rows.nth(1)).toContainText("sk-g••••cdef");
    await expect(rows.nth(1)).not.toContainText("sk-gymfixture-0123456789abcdef");
    await expect(rows.nth(1).locator(".build-key-delete")).toBeVisible();
    expect(seen.filter((s) => s.path === "/api/free-ai/token")).toHaveLength(0);
    await shot(page, testInfo, "build-key-with-saved");
    // Choosing it mints a pass and opens the chat on it.
    await page.click("#build-key-free-ai-use");
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#vc-model-bar .mm-trigger-text")).toHaveText("Low 1×", { timeout: 10_000 });
    const mints = seen.filter((s) => s.path === "/api/free-ai/token");
    expect(mints).toHaveLength(1);
    expectSigned(mints[0]!.body, "");
    const lastUsed = await page.evaluate(async () => {
      const { loadProviders, PROMO_ID } = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      return (await loadProviders(getSession().umk)).activeId === PROMO_ID;
    });
    expect(lastUsed).toBe(true);
  });

  test("gym inference attachments stage, refuse what the box would, and ride the start", async ({ page }, testInfo) => {
    await reachHome(page);
    const seen = await stub(page, [
      ["/api/free-ai/status", () => ok(statusBody())],
      ["/api/free-ai/token", () => ok({ ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })],
      ["/api/inference/models", () => ok(CATALOG)],
      ...boxRules(() => ({ status: "streaming", messages: [{ role: "user", text: "Track my plants" }], files: {} })),
    ]);
    await openScratch(page);
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    const bar = page.locator("#vc-model-bar");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Low 1×", { timeout: 10_000 });
    // Text-only Medium, so the screenshot below needs a model that can see it.
    await bar.locator(".mm-trigger").click();
    await bar.locator('.mm-panel [data-mm-model="medium"]').click();
    const notice = page.locator("#vc-attach-notice");
    await expect(notice).toHaveText("The AI will see what you attach.");
    const csv = "name,watered\nfern,2026-10-01\n";
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    await page.setInputFiles("#vc-attach-input", [
      { name: "plants.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
      { name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{not json") },
      { name: "care.pdf", mimeType: "application/pdf", buffer: pdf },
      { name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
      { name: "mockup.png", mimeType: "image/png", buffer: png },
    ]);
    const chips = page.locator("#vc-attach-chips .vc-chip");
    await expect(chips).toHaveCount(3, { timeout: 10_000 });
    await expect(chips.nth(0)).toContainText("plants.csv");
    await expect(chips.nth(0).locator(".vc-chip-icon")).toHaveText("📊");
    await expect(chips.nth(1)).toContainText("care.pdf");
    await expect(chips.nth(1).locator(".vc-chip-icon")).toHaveText("📑");
    await expect(chips.nth(2).locator("img.vc-chip-thumb")).toBeVisible();
    const err = page.locator("#vc-attach-error");
    await expect(err).toContainText('"broken.json" isn\'t valid JSON.');
    await expect(err).toContainText('"setup.exe" can\'t be attached. Try an image, a text or code file, CSV, JSON or a PDF.');
    // Sample data goes only to the private test copy, and the notice says so.
    await expect(notice).toContainText("Sample data goes only to the private test copy.");
    await shot(page, testInfo, "attachments-staged");
    // Removing a chip drops it from what will be sent.
    await page.locator('#vc-attach-chips .vc-chip-x[aria-label="Remove care.pdf"]').click();
    await expect(chips).toHaveCount(2);
    await expect(err).toBeHidden();
    await page.setInputFiles("#vc-attach-input", [{ name: "care.pdf", mimeType: "application/pdf", buffer: pdf }]);
    await expect(chips).toHaveCount(3);
    await page.fill("#vc-prompt", "Track my plants");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    // Medium can't see the screenshot: offered the multimodal model instead.
    await expect(page.locator(".modal-card")).toContainText("I'll have to switch to GLM-5.3-Flash (2×) for this.", { timeout: 10_000 });
    await shot(page, testInfo, "vision-switch");
    await page.click("[data-modal-ok]");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Medium multimodal 2×");
    await expect.poll(() => seen.filter((s) => s.path === "/api/screens/vibe-code/start").length, { timeout: 10_000 }).toBe(1);
    const start = seen.find((s) => s.path === "/api/screens/vibe-code/start")!.body;
    expect(start.model).toBe("medium-vision");
    expect(start.attachments).toEqual([
      { kind: "data", name: "plants.csv", mediaType: "text/csv", text: csv },
      { kind: "image", mediaType: "image/png", dataBase64: png.toString("base64"), name: "mockup.png" },
      { kind: "document", mediaType: "application/pdf", dataBase64: pdf.toString("base64"), name: "care.pdf" },
    ]);
    // Sent: the composer clears for the next turn.
    await expect(chips).toHaveCount(0);
  });

  // An AI-needs-you notification names only the session (and the server it
  // came from): the build chat opens on that server, signs the env value for
  // it, and the reply carries a fresh pass for it and the model choice.
  const OFFICE = "office.smoketest.flagship.services";
  const ENV_STATE = {
    id: "gym-sess-9",
    appId: "smoketest--weather",
    status: "awaiting-tool-response",
    provider: "flagship",
    model: "medium",
    messages: [
      { role: "user", text: "Add the forecast for tomorrow" },
      { role: "assistant", text: "The forecast needs a weather API key.", credits: 0.6 },
    ],
    pendingRequest: {
      kind: "requestEnvVar",
      toolUseId: "t9",
      payload: { name: "WEATHER_API_KEY", description: "The weather service's key", why: "To fetch the forecast" },
    },
    files: {},
  };

  /** The session lives on OFFICE only; every other box answers 404. */
  function officeRules(onReply: () => void): Rule[] {
    return [
      ["/api/free-ai/status", () => ok(statusBody())],
      ["/api/free-ai/token", () => ok({ ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })],
      ["/api/inference/models", () => ok(CATALOG)],
      ["/read-token", () => ok({ token: "art1.e2e.mac", expiresAt: Date.now() + 86_400_000 })],
      ["/api/users/smoketest/pods", () => ok({ pods: [{ serverDomain: BOX }, { serverDomain: OFFICE }] })],
      ["/api/screens/services/smoketest--weather/env/set", (_b, url) => (url.host === OFFICE ? ok({ ok: true }) : null)],
      [
        "/api/screens/llm/sessions/gym-sess-9/reply",
        (_b, url) => {
          if (url.host !== OFFICE) return null;
          onReply();
          return ok({ ok: true });
        },
      ],
      ["/api/screens/llm/sessions/gym-sess-9", (_b, url) => (url.host === OFFICE ? ok(ENV_STATE) : null)],
    ];
  }

  async function openFromLink(page: Page, query: string): Promise<void> {
    await page.evaluate(async (q) => {
      window.history.replaceState({}, "", `/index.html?${q}`);
      const { dispatchInitialView } = await import("/lib/deepLink.js");
      await dispatchInitialView();
    }, query);
  }

  test("gym inference a notification opens the build chat on the session's server", async ({ page }, testInfo) => {
    await reachHome(page);
    await page.evaluate(async (office) => {
      (await import("/lib/api.js")).setSessionTokenForPod(office, "gym-office-session-token");
    }, OFFICE);
    let replied = 0;
    const seen = await stub(page, officeRules(() => replied++));
    await openFromLink(page, `view=vibecode-chat&sessionId=gym-sess-9&server=${OFFICE}`);
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#vc-status")).toHaveText("The AI has a question", { timeout: 10_000 });
    const card = page.locator("#vc-envvar");
    await expect(card).toContainText("WEATHER_API_KEY");
    // The session's model on the Flagship Inference menu.
    await expect(page.locator("#vc-model-bar .mm-trigger-text")).toHaveText("Medium 1×", { timeout: 10_000 });
    await shot(page, testInfo, "notification-chat");
    await page.fill("#vc-envvar-value", "wx-secret-123");
    await page.click("#vc-envvar-send");
    await expect.poll(() => replied, { timeout: 10_000 }).toBe(1);
    // The value went to OFFICE, signed for OFFICE.
    const set = seen.find((s) => s.path.endsWith("/env/set"))!;
    expect(set.host).toBe(OFFICE);
    expect(set.body).toMatchObject({
      name: "WEATHER_API_KEY",
      value: "wx-secret-123",
      request: { serverId: OFFICE, creator: "smoketest", slug: "weather", env: { WEATHER_API_KEY: "wx-secret-123" } },
    });
    expect(set.body.signature).toMatch(/^[0-9a-f]{128}$/);
    // The ack carries a fresh pass minted for OFFICE and the model choice.
    const reply = seen.find((s) => s.path.endsWith("/reply"))!;
    expect(reply.host).toBe(OFFICE);
    expect(reply.body).toMatchObject({ envVarStatus: "set", credential: PASS, model: "medium", effort: null });
    const mints = seen.filter((s) => s.path === "/api/free-ai/token");
    expect(mints).toHaveLength(1);
    expectSigned(mints[0]!.body, OFFICE);
    // Nothing about this session went to the current server.
    expect(seen.filter((s) => s.path.includes("gym-sess-9") && s.host !== OFFICE)).toHaveLength(0);
    await expect(page.locator("#vc-envvar-value")).toHaveValue("");
  });

  test("gym inference a link without a server finds the one holding the session", async ({ page }, testInfo) => {
    await reachHome(page);
    await page.evaluate(async (office) => {
      (await import("/lib/api.js")).setSessionTokenForPod(office, "gym-office-session-token");
    }, OFFICE);
    const seen = await stub(page, officeRules(() => {}));
    await openFromLink(page, "view=vibecode-chat&sessionId=gym-sess-9");
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#vc-envvar")).toContainText("WEATHER_API_KEY", { timeout: 10_000 });
    // The current server was asked first, then the account's other server.
    const probes = seen.filter((s) => s.path === "/api/screens/llm/sessions/gym-sess-9");
    expect(probes[0]!.host).toBe(BOX);
    expect(probes.some((s) => s.host === OFFICE)).toBe(true);
    await shot(page, testInfo, "notification-chat-found");
  });

  test("gym inference a long build chat shows the newest messages and keeps the owner's place", async ({ page }, testInfo) => {
    await reachHome(page);
    await page.evaluate(async (office) => {
      (await import("/lib/api.js")).setSessionTokenForPod(office, "gym-office-session-token");
    }, OFFICE);
    let polls = 0;
    const messages = Array.from({ length: 45 }, (_, i) =>
      i % 2
        ? { role: "assistant", text: `Step ${i}.\n=== src/step${i}.js ===\nline a\nline b\nline c\n=== END ===` }
        : { role: "user", text: `Ask ${i}` },
    );
    const LONG = { ...ENV_STATE, status: "generating", pendingRequest: null, messages };
    await stub(page, [
      ...officeRules(() => {}).filter(([needle]) => needle !== "/api/screens/llm/sessions/gym-sess-9"),
      ["/api/screens/llm/sessions/gym-sess-9", (_b, url) => (url.host === OFFICE ? (polls++, ok(LONG)) : null)],
    ]);
    await openFromLink(page, `view=vibecode-chat&sessionId=gym-sess-9&server=${OFFICE}`);
    const log = page.locator("#vc-messages");
    await expect(log.locator("[data-vc-hidden]")).toHaveText("… 5 earlier messages not shown", { timeout: 10_000 });
    await expect(log.locator(".vc-msg")).toHaveCount(40);
    await expect(log).toContainText("wrote src/step43.js (3 lines)");
    await expect(log).not.toContainText("line b");
    await expect(page.locator("#vc-jump-latest")).toBeHidden();
    // Scroll up to read: the next polls leave the owner where they are.
    await log.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator("#vc-jump-latest")).toBeVisible();
    const before = polls;
    await expect.poll(() => polls, { timeout: 10_000 }).toBeGreaterThan(before + 1);
    expect(await log.evaluate((el) => el.scrollTop)).toBe(0);
    await shot(page, testInfo, "long-chat-scrolled-up");
    await page.click("#vc-jump-latest");
    await expect(page.locator("#vc-jump-latest")).toBeHidden();
    expect(await log.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 48)).toBe(true);
  });
});
