/**
 * The confirm, prompt and menu dialogs on the app and build screens that no
 * other spec answers both ways: Refuse and "Remove from this server?" Cancel
 * (nothing sent, the rank and the Runs-on tick stay), Edit's refusals (Open
 * build sessions, Use your IDE), the build chat's model menu (a typed model id,
 * Escape and an outside click), the image check (Cancel keeps the model and
 * sends nothing; a model with no alternative is blocked), a git import's name
 * conflict, turning the relay off after a relay failure in the chat and the git
 * import, and the Runs-on picker sending a new chat, a git check and an IDE
 * connection to the server picked.
 *
 * `.com` and every box are one recorded router (gymKit `mock`); anything it
 * doesn't know is a 404.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  ACCOUNT_ID,
  DEVICE_ID,
  HOME,
  MEDIA,
  livePod,
  mock,
  reachHome,
  sawToast,
  shot,
  toastMark,
  type Call,
  type Mock,
} from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const SERVICE_ID = "smoketest--notes";
const svc = (sub = "") => `/api/screens/services/${SERVICE_ID}${sub}`;
const onBox = (host: string, p: string) => (u: URL) => u.host === host && u.pathname === p;
const onHome = (p: string) => onBox(HOME, p);
const path = (p: string) => (u: URL) => u.pathname === p;

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

/** Low sees images; Medium doesn't but has a multimodal alternative; High
 *  doesn't and has none. */
const CATALOG = {
  models: [
    { id: "low", tier: "Low", model: "Qwen3.6-35B-A3B", multiplier: 1, label: "Low 1× (Qwen3.6-35B-A3B)",
      descriptor: "Quick and thrifty.", contextTokens: 262144, modalities: ["text", "image"], reasoning: true, default: true },
    { id: "medium", tier: "Medium", model: "DeepSeek-V4-Flash", multiplier: 1, label: "Medium 1× (DeepSeek-V4-Flash)",
      descriptor: "A larger model.", contextTokens: 1048576, modalities: ["text"], reasoning: true, visionAlternative: "medium-vision" },
    { id: "medium-vision", tier: "Medium multimodal", model: "GLM-5.3-Flash", multiplier: 2, label: "Medium multimodal 2× (GLM-5.3-Flash)",
      descriptor: "Sees images.", contextTokens: 200000, modalities: ["text", "image"], reasoning: true },
    { id: "high", tier: "High", model: "MiniMax-M3", multiplier: 3.5, label: "High 3.5× (MiniMax-M3)",
      descriptor: "The strongest.", contextTokens: 1000000, modalities: ["text"], reasoning: true },
  ],
  defaultModel: "low",
  creditTokens: 1000,
  inputWeight: 1,
  outputWeight: 4,
};

const PASS = { provider: "flagship", apiKey: "fa.gym-pass", baseUrl: "https://inference.flagshipserver.com/v1", source: "promo", relay: true };
const OWN_KEY = "sk-gymfixture-0123456789abcdef";
const SESSION = "gym-sess-1";
const RELAY_DOWN = "the Flagship relay isn't reachable, so the AI call wasn't sent.";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

/** Flagship Inference answered, and the account's servers. */
function aiRules(m: Mock, pods: unknown[] = [livePod(HOME)]): Mock {
  return m
    .on(undefined, path("/api/free-ai/status"), { available: true, ended: false, reason: null, credits: CREDITS })
    .on(undefined, path("/api/free-ai/token"), { ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })
    .on(undefined, path("/api/inference/models"), CATALOG)
    .get("/api/users/smoketest/pods", { pods });
}

async function openChooser(page: Page): Promise<void> {
  await page.click('[data-tab-target="apps"]');
  await expect(page.locator("#view-services-list")).toBeVisible();
  await page.click("#services-list-open-vibe-code");
  await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
}

async function saveKey(page: Page, label = "Work key"): Promise<void> {
  await page.evaluate(
    async ({ label, key }) => {
      const { addProvider } = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      await addProvider(getSession().umk, { provider: "openai", label, apiKey: key, relay: true });
    },
    { label, key: OWN_KEY },
  );
}

async function keyRelay(page: Page, label = "Work key"): Promise<boolean | undefined> {
  return page.evaluate(async (label) => {
    const { loadProviders } = await import("/providers.js");
    const { getSession } = await import("/lib/state.js");
    return (await loadProviders(getSession().umk)).entries.find((e: { label: string }) => e.label === label)?.relay;
  }, label);
}

/** On the AI-key step, use the saved Work key. */
async function useWorkKey(page: Page): Promise<void> {
  await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
  await page.locator("#build-key-saved .build-key-row", { hasText: "Work key" }).locator("[data-use-id]").click();
}

function chat(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    status,
    provider: "flagship",
    model: "medium",
    messages: [
      { role: "user", text: "A simple habit tracker" },
      { role: "assistant", text: "Done: a table of habits.", credits: 1.2 },
    ],
    files: { "server.js": "console.log('hi')" },
    ...extra,
  };
}

const replies = (m: Mock) => m.sent(`/api/screens/llm/sessions/${SESSION}/reply`);

function appDetail(extra: Record<string, unknown> = {}) {
  return {
    app: { serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", summary: "Shared notes", status: "running", version: "1.2.0", url: `https://notes.${HOME}` },
    manifest: { name: "notes", runtime: { base: "node-24" } },
    dataLayerInstances: [],
    members: [],
    editable: false,
    ...extra,
  };
}

async function openApp(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const { enterServiceDetail } = await import("/views/service-detail.js");
    await enterServiceDetail(id);
  }, SERVICE_ID);
  await expect(page.locator("#service-detail-content .card-title").first()).toContainText("notes", { timeout: 10_000 });
}

async function thisDevicePub(page: Page): Promise<string> {
  return page.evaluate(
    async ({ accountId, deviceId }) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      return ks.bytesToHex((await ks.deriveAccountDeviceKeyFromSeed(getSession().umk, accountId, deviceId)).publicKey);
    },
    { accountId: ACCOUNT_ID, deviceId: DEVICE_ID },
  );
}

test.describe("gym webapp dialogs", () => {
  test("gym dialogs Refuse Cancel keeps a co-manager's rank and sends nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.get(onHome("/api/screens/apps-list"), { apps: [{ serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", status: "running", url: `https://notes.${HOME}` }] });
    m.get(onHome(`/api/screens/app-detail/${SERVICE_ID}`), appDetail());
    m.get(path("/api/users/smoketest/service-invites"), { invites: [] });
    m.get(onHome(svc("/members")), {
      mode: "open",
      roles: ["member", "manager", "master"],
      defaultRole: "member",
      descriptions: {},
      accountMembers: [
        { kind: "device", deviceId: DEVICE_ID, devicePub: myPub, tier: "admin", rank: "master", set: false, refused: false },
        { kind: "co-manager", shareId: "ab".repeat(16), label: "Mum", rank: "manager", set: false, refused: false },
      ],
      members: [],
      invites: [],
    });
    await openApp(page);
    await page.click("#sd-access");
    const mum = page.locator("#sa-account-people .card", { hasText: "Mum" });
    await expect(mum.locator('select[data-action="sa-acct-rank"]')).toHaveValue("manager", { timeout: 10_000 });

    await mum.locator('[data-action="sa-acct-refuse"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Refuse Mum?");
    await expect(page.locator(".modal-message")).toHaveText("They can't open this app until an admin gives them a rank again.");
    await shot(page, testInfo, "refuse-confirm");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    // Still at Manager, still refusable, and no rank order went out.
    await expect(mum.locator('select[data-action="sa-acct-rank"]')).toHaveValue("manager");
    await expect(mum.locator('[data-action="sa-acct-refuse"]')).toBeEnabled();
    expect(m.sent(svc("/members/rank"))).toHaveLength(0);
  });

  test("gym dialogs Remove from this server Cancel re-ticks Runs on and deletes nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, MEDIA] });
    const m = await mock(page);
    const app = { serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", status: "running", url: `https://notes.${HOME}` };
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(MEDIA)] });
    m.get(onHome("/api/screens/apps-list"), { apps: [app] });
    m.get(onBox(MEDIA, "/api/screens/apps-list"), { apps: [app] });
    m.get(onHome(`/api/screens/app-detail/${SERVICE_ID}`), appDetail());
    await openApp(page);
    const box = (fqdn: string) => page.locator(`[data-runs-on-toggle="${fqdn}"]`);
    // Both servers hold it, so either copy can go.
    await expect(box(MEDIA)).toBeChecked({ timeout: 15_000 });
    await expect(box(MEDIA)).toBeEnabled();

    await box(MEDIA).uncheck();
    await expect(page.locator(".modal-title")).toHaveText("Remove from this server?");
    await expect(page.locator(".modal-message")).toHaveText("notes and its data on media are deleted. Your other servers keep their copies.");
    await shot(page, testInfo, "runs-on-remove-confirm");
    await page.click("[data-modal-cancel]");
    await expect(box(MEDIA)).toBeChecked();
    await expect(box(HOME)).toBeChecked();
    expect(m.calls.filter((c) => c.method !== "GET" && c.url.host.endsWith("flagship.services"))).toEqual([]);
  });

  test("gym dialogs Edit's refusals open Build sessions or your IDE", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    await saveKey(page);
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.get(onHome("/api/screens/apps-list"), { apps: [{ serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", status: "running", url: `https://notes.${HOME}` }] });
    m.get(onHome(`/api/screens/app-detail/${SERVICE_ID}`), appDetail({ editable: true }));
    m.get(onHome("/api/llm/sessions"), { sessions: [] });
    m.get(onHome("/api/build/sessions"), { builds: [] });
    const answers = [
      { status: 409, json: { ok: false, kind: "session", error: "busy" } },
      { status: 413, json: { error: "This service has 4 MB of code; the AI chat takes up to 1 MB." } },
    ];
    m.post(onHome("/api/screens/vibe-code/start"), () => answers.shift() ?? { status: 500, json: { error: "unexpected" } });
    const describe = async () => {
      await openApp(page);
      await page.click("#sd-edit");
      await page.click("#edit-service-ai");
      await useWorkKey(page);
      await expect(page.locator("#view-edit-describe")).toBeVisible({ timeout: 10_000 });
      await page.fill("#edit-describe-prompt", "Add a due date to each note");
      await page.click("#edit-describe-start");
    };

    // Already being changed: Open build sessions goes to the list.
    await describe();
    await expect(page.locator(".modal-title")).toHaveText("Already being changed", { timeout: 10_000 });
    await shot(page, testInfo, "edit-busy");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });

    // Too big: Use your IDE opens the connect screen for this service.
    await describe();
    await expect(page.locator(".modal-title")).toHaveText("Too big for the AI chat", { timeout: 10_000 });
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-build-mcp")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-mcp-intro")).toContainText("notes");
    await shot(page, testInfo, "edit-too-big-ide");
    expect(m.sent("/api/screens/vibe-code/start")).toHaveLength(2);
  });

  test("gym dialogs the model menu takes a typed model id and closes on Escape and an outside click", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    await saveKey(page);
    const m = aiRules(await mock(page));
    m.get(onHome("/api/llm/sessions"), { sessions: [{ sessionId: SESSION, status: "ready-to-deploy", startedAt: Date.now() - 3_600_000, name: "habits" }] });
    m.get(onHome("/api/build/sessions"), { builds: [] });
    m.get(onHome(`/api/screens/llm/sessions/${SESSION}`), chat("ready-to-deploy", { canContinue: true }));
    m.post(onHome(`/api/screens/llm/sessions/${SESSION}/reply`), { ok: true });
    // The key's provider doesn't list its models: the menu takes a typed id.
    m.post(onHome("/api/screens/ai/models"), { kind: "own", listed: false, defaultModel: null, reason: "rejected" });
    await openChooser(page);
    await page.click("#build-source-journal-link");
    await page.locator(`#build-journal-list [data-session="${SESSION}"]`).click();
    await expect(page.locator("#vc-status")).toHaveText("Ready to deploy", { timeout: 10_000 });
    const bar = page.locator("#vc-model-bar");
    const panel = bar.locator(".mm-panel");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Medium 1×", { timeout: 10_000 });

    // Escape closes the open menu.
    await bar.locator(".mm-trigger").click();
    await expect(panel).toBeVisible();
    await expect(bar.locator(".mm-trigger")).toHaveAttribute("aria-expanded", "true");
    await bar.locator(".mm-trigger").press("Escape");
    await expect(panel).toHaveCount(0);
    // So does a click outside it.
    await bar.locator(".mm-trigger").click();
    await expect(panel).toBeVisible();
    await page.locator("header h1#title").click();
    await expect(panel).toHaveCount(0);

    // The key's group has a free model field.
    await bar.locator(".mm-trigger").click();
    const free = panel.locator("[data-mm-free]");
    await expect(free).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "model-free-text");
    await free.fill("my-tuned-model");
    await free.press("Enter");
    await expect(bar.locator(".mm-trigger-text")).toContainText("my-tuned-model", { timeout: 10_000 });
    // The field keeps focus after the choice, so Escape still closes the menu
    // and hands focus back to its button.
    await expect(panel.locator("[data-mm-free]")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(bar.locator(".mm-trigger")).toBeFocused();
    // The typed id stays chosen when the menu closes.
    await expect(bar.locator(".mm-trigger-text")).toContainText("my-tuned-model");

    await page.fill("#vc-prompt", "Add a weekly chart");
    await page.click("#vc-send");
    const reply = await m.waitFor(`/api/screens/llm/sessions/${SESSION}/reply`);
    expect(reply.body).toMatchObject({ text: "Add a weekly chart", model: "my-tuned-model" });
    expect(reply.body.credential).toMatchObject({ provider: "openai", apiKey: OWN_KEY });
  });

  test("gym dialogs an image on a text-only model: Cancel keeps it, and with no alternative it's blocked", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = aiRules(await mock(page));
    m.get(onHome("/api/screens/vibe-code/name-check"), (call: Call) => ({ json: { ok: true, name: call.url.searchParams.get("name") } }));
    m.post(onHome("/api/screens/vibe-code/start"), { sessionId: SESSION });
    m.get(onHome(`/api/screens/llm/sessions/${SESSION}`), chat("streaming"));
    await openChooser(page);
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    const bar = page.locator("#vc-model-bar");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Low 1×", { timeout: 10_000 });
    await bar.locator(".mm-trigger").click();
    await bar.locator('.mm-panel [data-mm-model="medium"]').click();
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Medium 1×");
    await page.setInputFiles("#vc-attach-input", [{ name: "mockup.png", mimeType: "image/png", buffer: PNG }]);
    await expect(page.locator("#vc-attach-chips .vc-chip")).toHaveCount(1, { timeout: 10_000 });
    await page.fill("#vc-prompt", "Make it look like this");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });

    // Medium can't see it: Cancel keeps Medium and sends nothing.
    await page.click("#vc-send");
    await expect(page.locator(".modal-card")).toContainText("I'll have to switch to GLM-5.3-Flash (2×) for this.", { timeout: 10_000 });
    await shot(page, testInfo, "vision-switch-offer");
    await page.click("[data-modal-cancel]");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Medium 1×");
    await expect(page.locator("#vc-attach-chips .vc-chip")).toHaveCount(1);
    expect(m.sent("/api/screens/vibe-code/start")).toHaveLength(0);

    // High can't see it and has no alternative: blocked, nothing sent.
    await bar.locator(".mm-trigger").click();
    await bar.locator('.mm-panel [data-mm-model="high"]').click();
    await page.click("#vc-send");
    await expect(page.locator(".modal-card")).toContainText("MiniMax-M3 can't see images. Remove them or pick another model.", { timeout: 10_000 });
    await shot(page, testInfo, "vision-blocked");
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-card")).toHaveCount(0);
    await expect(page.locator("#view-vibe-code")).toBeVisible();
    expect(m.sent("/api/screens/vibe-code/start")).toHaveLength(0);
  });

  test("gym dialogs a git import's name conflict offers Build sessions or another name", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = aiRules(await mock(page));
    const answers = [
      { status: 409, json: { ok: false, kind: "session", name: "blog", error: "name taken" } },
      { status: 409, json: { ok: false, kind: "session", name: "blog", error: "name taken" } },
      { status: 409, json: { ok: false, kind: "service", name: "blog", error: "name taken" } },
    ];
    m.post(onHome("/api/build/git"), () => answers.shift() ?? { status: 500, json: { error: "unexpected" } });
    m.get(onHome("/api/screens/vibe-code/name-check"), (call: Call) => ({ json: { ok: true, name: call.url.searchParams.get("name") } }));
    m.get(onHome("/api/llm/sessions"), { sessions: [] });
    m.get(onHome("/api/build/sessions"), { builds: [] });
    const check = async () => {
      await page.fill("#build-git-url", "https://github.com/you/blog");
      await page.fill("#build-git-name", "blog");
      await page.click("#build-git-check");
    };
    await openChooser(page);
    await page.click("#build-src-git");

    // Another build session holds it: Pick another name keeps the form.
    await check();
    await expect(page.locator(".modal-title")).toHaveText("That name is taken", { timeout: 10_000 });
    await shot(page, testInfo, "git-conflict-session");
    await page.click("[data-modal-cancel]");
    await expect(page.locator("#view-build-git")).toBeVisible();
    await expect(page.locator("#build-git-verdict")).toBeHidden();

    // Open build sessions: the list where that build can be discarded.
    await check();
    await expect(page.locator(".modal-title")).toHaveText("That name is taken", { timeout: 10_000 });
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });

    // An installed app holds it: only Pick another name.
    await page.click("#build-journal-back");
    await page.click("#build-src-git");
    await check();
    await expect(page.locator(".modal-title")).toHaveText("That name is taken", { timeout: 10_000 });
    await expect(page.locator("[data-modal-cancel]")).toHaveCount(0);
    await expect(page.locator("[data-modal-ok]")).toHaveText("Pick another name");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-build-git")).toBeVisible();
    expect(m.sent("/api/build/git")).toHaveLength(3);
  });

  test("gym dialogs Turn the relay off after a relay failure, in a chat and a git import", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    await saveKey(page);
    const m = aiRules(await mock(page));
    m.get(onHome("/api/screens/vibe-code/name-check"), (call: Call) => ({ json: { ok: true, name: call.url.searchParams.get("name") } }));
    m.post(onHome("/api/screens/vibe-code/start"), { sessionId: SESSION });
    m.get(onHome(`/api/screens/llm/sessions/${SESSION}`), chat("failed", { provider: "openai", model: "gpt-5", errorReason: RELAY_DOWN }));
    m.post(onHome("/api/screens/ai/models"), { kind: "own", listed: true, defaultModel: "gpt-5", models: [{ id: "gpt-5", label: "GPT-5" }] });

    // The chat: started on the saved key, the box couldn't reach the relay.
    await openChooser(page);
    await page.click("#build-src-scratch");
    await useWorkKey(page);
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await page.fill("#vc-prompt", "A habit tracker");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    const start = await m.waitFor("/api/screens/vibe-code/start");
    expect(start.body.credential).toMatchObject({ apiKey: OWN_KEY, relay: true });
    await expect(page.locator("#vc-result .err-text")).toHaveText(RELAY_DOWN, { timeout: 15_000 });
    await shot(page, testInfo, "chat-relay-failure");
    let mark = await toastMark(page);
    await page.click("#vc-relay-off");
    await sawToast(page, "The relay is off for this key.", 15_000, mark);
    await expect(page.locator("#vc-relay-off")).toHaveCount(0);
    expect(await keyRelay(page)).toBe(false);

    // The git import: the adapt on the same key failed the same way.
    await page.evaluate(async () => {
      const { addProvider } = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      // Back on the relay, so the git import can fail on it too.
      const { loadProviders, removeProvider } = await import("/providers.js");
      const umk = getSession().umk;
      const e = (await loadProviders(umk)).entries.find((x: { label: string }) => x.label === "Work key");
      if (e) await removeProvider(umk, e.id);
      await addProvider(umk, { provider: "openai", label: "Work key", apiKey: "sk-gymfixture-0123456789abcdef", relay: true });
    });
    let adapt: Record<string, unknown> = { status: "running", startedAt: Date.now() };
    m.post(onHome("/api/build/git"), { buildId: "gym-git-r", fit: false, reason: "no flagship.app.json in the repo root", fileCount: 12 });
    m.post(onHome("/api/build/sessions/gym-git-r/adapt"), () => {
      adapt = { status: "failed", reason: RELAY_DOWN };
      return { json: { ok: true, started: true } };
    });
    m.get(onHome("/api/build/sessions/gym-git-r/journal"), { entries: [] });
    m.get(onHome("/api/build/sessions/gym-git-r"), () => ({ json: { state: { mode: "git", adapt } } }));
    await openChooser(page);
    await page.click("#build-src-git");
    await page.fill("#build-git-url", "https://github.com/you/some-saas");
    await page.click("#build-git-check");
    await expect(page.locator("#build-git-adapt")).toBeVisible({ timeout: 10_000 });
    await page.click("#build-git-adapt");
    await useWorkKey(page);
    const ad = await m.waitFor("/api/build/sessions/gym-git-r/adapt");
    expect(ad.body.credential).toMatchObject({ apiKey: OWN_KEY, relay: true });
    await expect(page.locator("#build-git-verdict .err-text")).toHaveText(RELAY_DOWN, { timeout: 15_000 });
    await shot(page, testInfo, "git-relay-failure");
    mark = await toastMark(page);
    await page.click("#build-git-relay-off");
    await sawToast(page, "The relay is off for this key.", 15_000, mark);
    // The card is offered again, without the relay switch, so the adapt can be retried direct.
    await expect(page.locator("#build-git-relay-off")).toHaveCount(0);
    await expect(page.locator("#build-git-adapt")).toBeVisible();
    expect(await keyRelay(page)).toBe(false);
  });

  test("gym dialogs the Runs on picker sends a new chat, a git check and an IDE connection to the server picked", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, MEDIA] });
    const m = aiRules(await mock(page), [livePod(HOME), livePod(MEDIA)]);
    for (const host of [HOME, MEDIA]) {
      m.get(onBox(host, "/api/screens/vibe-code/name-check"), (call: Call) => ({ json: { ok: true, name: call.url.searchParams.get("name") } }));
      m.post(onBox(host, "/api/screens/vibe-code/start"), { sessionId: SESSION });
      m.get(onBox(host, `/api/screens/llm/sessions/${SESSION}`), chat("streaming"));
      m.post(onBox(host, "/api/build/git"), { buildId: "gym-git-m", fit: true, reason: "flagship.app.json found", fileCount: 3, name: "blog" });
      m.post(onBox(host, "/api/build/mcp"), {
        buildId: "gym-mcp-m",
        connection: { url: `https://${host}/mcp/build/gym-mcp-m`, key: "mcpk_gym", ideConfig: { mcpServers: {} } },
      });
    }

    // A new chat: pick media, the name check and the start go there.
    await openChooser(page);
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    const chatPick = page.locator("#vc-runs-on [data-runs-on-select]");
    await expect(chatPick).toBeVisible({ timeout: 10_000 });
    await chatPick.selectOption(MEDIA);
    await expect(page.locator("#vc-name-address")).toContainText(MEDIA);
    await shot(page, testInfo, "runs-on-chat-media");
    await page.fill("#vc-prompt", "A habit tracker");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    const start = await m.waitFor("/api/screens/vibe-code/start");
    expect(start.url.host).toBe(MEDIA);
    expect(m.sent("/api/screens/vibe-code/start").every((c) => c.url.host === MEDIA)).toBe(true);
    expect(m.sent("/api/free-ai/token").at(-1)!.body.request.serverFqdn).toBe(MEDIA);

    // A git check: switch back to home, the check goes to home.
    await openChooser(page);
    await page.click("#build-src-git");
    const gitPick = page.locator("#build-git-runs-on [data-runs-on-select]");
    await expect(gitPick).toBeVisible({ timeout: 10_000 });
    await gitPick.selectOption(HOME);
    await page.fill("#build-git-url", "https://github.com/you/blog");
    await page.click("#build-git-check");
    const git = await m.waitFor("/api/build/git");
    expect(git.url.host).toBe(HOME);
    await expect(page.locator("#build-git-verdict")).toContainText("Flagship-ready", { timeout: 10_000 });

    // An IDE connection: pick media, the connection is made there.
    await page.click("#build-git-back");
    await page.click("#build-src-mcp");
    const mcpPick = page.locator("#build-mcp-runs-on [data-runs-on-select]");
    await expect(mcpPick).toBeVisible({ timeout: 10_000 });
    await mcpPick.selectOption(MEDIA);
    await page.click("#build-mcp-create");
    const mcp = await m.waitFor("/api/build/mcp");
    expect(mcp.url.host).toBe(MEDIA);
    await expect(page.locator("#mcp-url")).toHaveText(`https://${MEDIA}/mcp/build/gym-mcp-m`, { timeout: 10_000 });
    await shot(page, testInfo, "runs-on-mcp-media");
  });
});
