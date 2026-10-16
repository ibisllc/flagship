/**
 * Building apps in the webapp (docs/build-modes.md) with no backend: the
 * Build chooser, the AI-key step, a build chat continued after it is ready or
 * failed (docs/build-modes.md "Continuing a chat"), the model menu grouped by
 * provider with a saved key's models, effort and the compaction notice,
 * Deploy, Build sessions (reopen, discard), git imports and IDE builds, a
 * git or IDE build a restart cut off (the box keeps its files and says so),
 * and the install tracker.
 *
 * `.com` and every box are one recorded router (gymKit `mock`); anything it
 * doesn't know is a 404, so nothing reaches a network. Each test asserts what
 * the stubbed POSTs received, not only what renders.
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, livePod, mock, reachHome, shot, type Call, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

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

const CATALOG = {
  models: [
    { id: "low", tier: "Low", model: "Qwen3.6-35B-A3B", multiplier: 1, label: "Low 1× (Qwen3.6-35B-A3B)",
      descriptor: "Quick and thrifty.", contextTokens: 262144, modalities: ["text", "image"], reasoning: true, default: true },
    { id: "medium", tier: "Medium", model: "DeepSeek-V4-Flash", multiplier: 1, label: "Medium 1× (DeepSeek-V4-Flash)",
      descriptor: "A larger model with a 1M-token memory.", contextTokens: 1048576, modalities: ["text"], reasoning: true },
  ],
  defaultModel: "low",
  creditTokens: 1000,
  inputWeight: 1,
  outputWeight: 4,
};

const PASS = { provider: "flagship", apiKey: "fa.gym-pass", baseUrl: "https://inference.flagshipserver.com/v1", source: "promo", relay: true };
const OWN_KEY = "sk-gymfixture-0123456789abcdef";
const SESSION = "gym-sess-1";
const INTERRUPTED_AI =
  "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy.";
const INTERRUPTED_LIVE = "The server restarted while it was putting this build live. Its files are kept: deploy it again.";

const path = (p: string) => (u: URL) => u.pathname === p;
const onBox = (p: string) => (u: URL) => u.host === HOME && u.pathname === p;

/** Flagship Inference answered: status, a pass per mint, the catalog, and the account's one server. */
function aiRules(m: Mock): Mock {
  return m
    .on(undefined, path("/api/free-ai/status"), { available: true, ended: false, reason: null, credits: CREDITS })
    .on(undefined, path("/api/free-ai/token"), { ok: true, credential: PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits: CREDITS })
    .on(undefined, path("/api/inference/models"), CATALOG)
    .get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
}

/** The Build chooser, reached by tapping from the Services tab. */
async function openChooser(page: Page): Promise<void> {
  await page.click('[data-tab-target="apps"]');
  await expect(page.locator("#view-services-list")).toBeVisible();
  await page.click("#services-list-open-vibe-code");
  await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
}

async function openBuildSessions(page: Page): Promise<void> {
  await openChooser(page);
  await page.click("#build-source-journal-link");
  await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });
}

async function saveKey(page: Page, label = "Work key", relay = true): Promise<void> {
  await page.evaluate(
    async ({ label, key, relay }) => {
      const { addProvider } = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      await addProvider(getSession().umk, { provider: "openai", label, apiKey: key, relay });
    },
    { label, key: OWN_KEY, relay },
  );
}

async function savedKeys(page: Page): Promise<Array<{ label: string; relay?: boolean; baseUrl?: string; provider: string }>> {
  return page.evaluate(async () => {
    const { loadProviders } = await import("/providers.js");
    const { getSession } = await import("/lib/state.js");
    return (await loadProviders(getSession().umk)).entries;
  });
}

/** A chat session's public state on the box. */
function chat(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    status,
    provider: "flagship",
    model: "medium",
    messages: [
      { role: "user", text: "A simple habit tracker" },
      { role: "assistant", text: "Done: a table of habits, one checkbox per day.", credits: 1.2 },
    ],
    files: { "server.js": "// the app\nconsole.log('hi')" },
    ...extra,
  };
}

/** Box rules for one open chat: listed in Build sessions, its state from `state()`, replies recorded. */
function chatRules(m: Mock, state: () => unknown, listed: () => string): Mock {
  return m
    .get(onBox("/api/llm/sessions"), () => ({
      json: { sessions: [{ sessionId: SESSION, status: listed(), startedAt: Date.now() - 3_600_000, name: "habits" }] },
    }))
    .get(onBox("/api/build/sessions"), { builds: [] })
    .post(onBox(`/api/screens/llm/sessions/${SESSION}/reply`), { ok: true })
    .get(onBox(`/api/screens/llm/sessions/${SESSION}`), () => ({ json: state() }));
}

const replies = (m: Mock) => m.sent(`/api/screens/llm/sessions/${SESSION}/reply`);
const mints = (m: Mock) => m.sent("/api/free-ai/token");

test.describe("gym webapp builds", () => {
  test("gym builds the chooser's help, Build sessions badge and each tile open their screens", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = aiRules(await mock(page));
    // One chat still writing on the box: the chooser counts it.
    m.get(onBox("/api/llm/sessions"), { sessions: [{ sessionId: SESSION, status: "streaming", startedAt: Date.now() }] });
    m.post(onBox("/api/build/mcp"), {
      buildId: "gym-mcp-1",
      connection: { url: `https://${HOME}/mcp/build/gym-mcp-1`, key: "mcpk_gym", ideConfig: { mcpServers: {} } },
    });
    await openChooser(page);
    await expect(page.locator("#build-source-active-count")).toHaveText("1", { timeout: 10_000 });

    // Help explains every option, Done closes it.
    await page.click("#build-source-help");
    const help = page.locator('dialog[aria-label="How building works"]');
    await expect(help.locator("h4")).toHaveText([
      "Resume or view past builds",
      "Start from scratch with AI",
      "Import from a Git repo",
      "Connect your IDE",
    ]);
    await shot(page, testInfo, "build-help");
    await help.locator("[data-help-done]").click();
    await expect(help).toHaveCount(0);

    // Git, then back; IDE, then back; then back to the Services list.
    await page.click("#build-src-git");
    await expect(page.locator("#view-build-git")).toBeVisible();
    await page.click("#build-git-back");
    await expect(page.locator("#view-build-source")).toBeVisible();
    await page.click("#build-src-mcp");
    await expect(page.locator("#view-build-mcp")).toBeVisible();
    await page.click("#build-mcp-back");
    await expect(page.locator("#view-build-source")).toBeVisible();
    await page.click("#build-source-back");
    await expect(page.locator("#view-services-list")).toBeVisible();
  });

  test("gym builds reopening a ready chat from Build sessions continues it with a change", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let state: unknown = chat("ready-to-deploy", { canContinue: true });
    const m = chatRules(aiRules(await mock(page)), () => state, () => "ready-to-deploy");
    await openBuildSessions(page);
    const row = page.locator(`#build-journal-list [data-session="${SESSION}"]`);
    await expect(row).toContainText("habits", { timeout: 10_000 });
    await expect(row.locator(".build-session-action")).toHaveText("Continue");
    await shot(page, testInfo, "sessions-ready-chat");
    await row.click();

    // The chat opens on its transcript; the first-turn fields are gone and
    // the composer asks for a change.
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#vc-status")).toHaveText("Ready to deploy", { timeout: 10_000 });
    await expect(page.locator("#vc-first-turn")).toBeHidden();
    const prompt = page.locator("#vc-prompt");
    await expect(prompt).toBeEnabled();
    await expect(prompt).toHaveAttribute("placeholder", "Ask for a change…");
    await expect(page.locator("#vc-deploy-box")).toBeVisible();
    await expect(page.locator("#vc-model-bar .mm-trigger-text")).toHaveText("Medium 1×", { timeout: 10_000 });
    await shot(page, testInfo, "chat-ready-continue");

    await prompt.fill("Add a weekly chart");
    await page.click("#vc-send");
    await m.waitFor(`/api/screens/llm/sessions/${SESSION}/reply`);
    state = chat("streaming", { canContinue: false });
    expect(replies(m)[0]!.body).toMatchObject({ text: "Add a weekly chart", attachments: [], model: "medium", effort: null, credential: PASS });
    // A Flagship pass is always fresh, minted for this box.
    expect(mints(m).length).toBeGreaterThan(0);
    expect(mints(m).at(-1)!.body.request.serverFqdn).toBe(HOME);
    // While the AI writes, the composer waits.
    await expect(page.locator("#vc-status")).toHaveText("Writing…", { timeout: 10_000 });
    await expect(prompt).toBeDisabled();
    await expect(prompt).toHaveValue("");
    await shot(page, testInfo, "chat-continued");
  });

  test("gym builds a failed chat takes what to try next, and a deployed one takes nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let state: unknown = chat("failed", { canContinue: true, errorReason: "The app didn't start: port 3000 is already in use." });
    const m = chatRules(aiRules(await mock(page)), () => state, () => "failed");
    await openBuildSessions(page);
    await page.locator(`#build-journal-list [data-session="${SESSION}"]`).click();
    await expect(page.locator("#vc-status")).toHaveText("Something went wrong", { timeout: 10_000 });
    await expect(page.locator("#vc-result")).toContainText("The app didn't start: port 3000 is already in use.");
    const prompt = page.locator("#vc-prompt");
    await expect(prompt).toHaveAttribute("placeholder", "Tell the AI what to try next…");
    await expect(page.locator("#vc-deploy-box")).toBeHidden();
    await shot(page, testInfo, "chat-failed-continue");
    await prompt.fill("Use port 8080 instead");
    await page.click("#vc-send");
    await m.waitFor(`/api/screens/llm/sessions/${SESSION}/reply`);
    expect(replies(m)[0]!.body).toMatchObject({ text: "Use port 8080 instead", credential: PASS, model: "medium" });

    // Deployed: the chat is done, the composer stays off.
    state = chat("deployed", { canContinue: false, deployedUrl: `https://habits.${HOME}` });
    await expect(page.locator("#vc-status")).toHaveText("Deployed", { timeout: 10_000 });
    await expect(prompt).toBeDisabled();
    await expect(page.locator("#vc-send")).toBeDisabled();
    await expect(page.locator("#vc-result a")).toHaveAttribute("href", `https://habits.${HOME}`);
    await shot(page, testInfo, "chat-deployed-closed");
  });

  test("gym builds switching to a saved key's model sends that key, model and effort with the next message", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    await saveKey(page);
    const state = chat("ready-to-deploy", { canContinue: true, conversationTokens: 250_000, summarised: true });
    const m = chatRules(aiRules(await mock(page)), () => state, () => "ready-to-deploy");
    m.post(onBox("/api/screens/ai/models"), {
      kind: "own",
      listed: true,
      defaultModel: "gpt-5",
      models: [
        { id: "gpt-5", label: "GPT-5", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextTokens: 400_000 },
        { id: "gpt-5-mini", label: "GPT-5 mini", contextTokens: 128_000 },
      ],
    });
    await openBuildSessions(page);
    await page.locator(`#build-journal-list [data-session="${SESSION}"]`).click();
    await expect(page.locator("#vc-status")).toHaveText("Ready to deploy", { timeout: 10_000 });
    // The box summarised older turns already.
    await expect(page.locator("#vc-messages .vc-summarised").first()).toHaveText("Earlier conversation summarised");
    const bar = page.locator("#vc-model-bar");
    await expect(bar.locator(".mm-trigger-text")).toHaveText("Medium 1×", { timeout: 10_000 });

    // One menu, grouped by provider: Flagship Inference first, then the key.
    await bar.locator(".mm-trigger").click();
    const groups = bar.locator(".mm-panel .mm-group");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator(".mm-head")).toHaveText("Flagship Inference");
    await expect(groups.nth(1).locator(".mm-head")).toHaveText("openai · Work key");
    await expect(groups.nth(1).locator("[data-mm-model]")).toHaveCount(2, { timeout: 10_000 });
    await shot(page, testInfo, "model-menu-grouped");

    // A model too small for the conversation says older turns get summarised.
    await groups.nth(1).locator('[data-mm-model="gpt-5-mini"]').click();
    await expect(bar.locator(".mm-trigger-text")).toHaveText("GPT-5 mini · Work key");
    await expect(bar.locator(".mm-context")).toHaveText("Older messages will be summarised to fit this model.");
    await expect(bar.locator("[data-mm-effort]")).toHaveCount(0);
    await shot(page, testInfo, "model-compaction-notice");

    // A model that lists effort levels gets the picker, on its default.
    await bar.locator(".mm-trigger").click();
    await bar.locator('.mm-panel [data-mm-model="gpt-5"]').click();
    await expect(bar.locator(".mm-context")).toHaveCount(0);
    const effort = bar.locator("[data-mm-effort]");
    await expect(effort).toHaveValue("medium");
    await expect(effort.locator("option")).toHaveText(["Low", "Medium", "High"]);
    await effort.selectOption("high");
    await shot(page, testInfo, "model-effort");

    const mintsBefore = mints(m).length;
    await page.fill("#vc-prompt", "Make it faster");
    await page.click("#vc-send");
    await m.waitFor(`/api/screens/llm/sessions/${SESSION}/reply`);
    const body = replies(m)[0]!.body;
    expect(body).toMatchObject({ text: "Make it faster", model: "gpt-5", effort: "high" });
    expect(body.credential).toMatchObject({ provider: "openai", apiKey: OWN_KEY, relay: true });
    // This turn runs on the owner's key: no Flagship pass was minted for it.
    expect(mints(m).length).toBe(mintsBefore);
  });

  test("gym builds Deploy puts a ready chat live, then New build and Back", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let state: unknown = chat("ready-to-deploy", { canContinue: true });
    const m = chatRules(aiRules(await mock(page)), () => state, () => "ready-to-deploy");
    const URL_LIVE = `https://habits.${HOME}`;
    // An older box answers the deploy with the finished result; it couldn't
    // make the app invite only.
    m.post(onBox(`/api/llm/sessions/${SESSION}/deploy`), () => {
      state = chat("deployed", { deployedUrl: URL_LIVE });
      return { json: { url: URL_LIVE, inviteOnly: false } };
    });
    await openBuildSessions(page);
    await page.locator(`#build-journal-list [data-session="${SESSION}"]`).click();
    await expect(page.locator("#vc-deploy-box")).toBeVisible({ timeout: 10_000 });

    // The files the AI wrote, behind the Files disclosure.
    await expect(page.locator("#vc-files-count")).toHaveText("(1)");
    await page.locator("#vc-files-box > summary").click();
    await page.locator("#vc-files summary.file-summary").click();
    await expect(page.locator("#vc-files .file-body")).toContainText("console.log('hi')");
    await shot(page, testInfo, "chat-files");

    await page.click("#vc-deploy-go");
    await m.waitFor(`/api/llm/sessions/${SESSION}/deploy`);
    await expect(page.locator("#toast")).toContainText("Deployed", { timeout: 10_000 });
    await expect(page.locator("#vc-result")).toContainText("Deployed ✓");
    await expect(page.locator("#vc-result a")).toHaveAttribute("href", URL_LIVE);
    await expect(page.locator("#vc-result .vc-left-open")).toContainText("anyone with the link can open it");
    await expect(page.locator("#vc-deploy-box")).toBeHidden();
    await shot(page, testInfo, "chat-deployed");

    // New build: the first-turn form is back, empty.
    await page.click("#vc-reset");
    await expect(page.locator("#vc-status")).toHaveText("idle");
    await expect(page.locator("#vc-first-turn")).toBeVisible();
    await expect(page.locator("#vc-prompt")).toHaveValue("");
    await expect(page.locator("#vc-result")).toBeHidden();
    await page.click("#vibe-code-back");
    await expect(page.locator("#view-build-source")).toBeVisible();
  });

  test("gym builds a new chat's examples, visibility, a taken name and env Decline", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let state: unknown = chat("awaiting-tool-response", {
      appId: "smoketest--habits",
      pendingRequest: { kind: "requestEnvVar", toolUseId: "t9", payload: { name: "WEATHER_API_KEY", why: "To fetch the forecast" } },
    });
    const m = chatRules(aiRules(await mock(page)), () => state, () => "awaiting-tool-response");
    m.get(onBox("/api/screens/vibe-code/name-check"), (call: Call) =>
      call.url.searchParams.get("name") === "taken"
        ? { json: { ok: false, kind: "session", name: "taken" } }
        : { json: { ok: true, name: call.url.searchParams.get("name") } },
    );
    m.post(onBox("/api/screens/vibe-code/start"), { sessionId: SESSION });
    await openChooser(page);
    await page.click("#build-src-scratch");
    // No saved key, credits left: the AI-key step is skipped.
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });

    // An example fills the description.
    await page.locator('#vc-examples [data-example="0"]').click();
    await expect(page.locator("#vc-prompt")).toHaveValue(/^A habit tracker: I tick off my daily habits/);
    // Who can open it, with its explanation.
    await page.selectOption("#vc-visibility", "link");
    await expect(page.locator("#vc-visibility-note")).toHaveText(
      "Anyone with the address can open it. Where it needs to know who someone is, they sign in with Flagship.",
    );
    // A name another build session holds: the conflict offers Build sessions.
    await page.fill("#vc-name", "taken");
    await expect(page.locator("#vc-name-status")).toHaveClass(/is-taken/, { timeout: 10_000 });
    await shot(page, testInfo, "chat-name-taken");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    const start = await m.waitFor("/api/screens/vibe-code/start");
    expect(start.body).toMatchObject({ name: "habits", visibility: "link", credential: PASS });
    expect(start.body.prompt).toMatch(/^A habit tracker/);

    // The AI asks for an env var; Decline answers without sending a value.
    await expect(page.locator("#vc-envvar")).toContainText("WEATHER_API_KEY", { timeout: 10_000 });
    await page.click("#vc-envvar-decline");
    await m.waitFor(`/api/screens/llm/sessions/${SESSION}/reply`);
    state = chat("streaming");
    expect(replies(m)[0]!.body).toMatchObject({ envVarStatus: "declined", credential: PASS });
    expect(m.sent("/env/set")).toHaveLength(0);
    await expect(page.locator("#toast")).toContainText("Declined");
    await shot(page, testInfo, "chat-env-declined");
  });

  test("gym builds a name another build took at start opens Build sessions or lets the owner pick another", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = aiRules(await mock(page));
    // The name looked free, but another session claimed it before start.
    m.get(onBox("/api/screens/vibe-code/name-check"), (call: Call) => ({ json: { ok: true, name: call.url.searchParams.get("name") } }));
    m.post(onBox("/api/screens/vibe-code/start"), (call: Call) => ({
      status: 409,
      json: { ok: false, kind: "session", name: call.body.name, error: "name taken" },
    }));
    m.get(onBox("/api/llm/sessions"), { sessions: [] });
    m.get(onBox("/api/build/sessions"), { builds: [] });
    await openChooser(page);
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await page.fill("#vc-prompt", "A habit tracker");
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });

    // Pick another name: the dialog closes, the form stays.
    await page.click("#vc-send");
    await expect(page.locator(".modal-title")).toHaveText("That name is taken", { timeout: 10_000 });
    await expect(page.locator(".modal-card")).toContainText('A build session already uses "habits".');
    await shot(page, testInfo, "chat-conflict-dialog");
    await page.click("[data-modal-cancel]");
    await expect(page.locator("#view-vibe-code")).toBeVisible();
    await expect(page.locator("#vc-name-status")).toHaveClass(/is-taken/);

    // Open build sessions: the list where the other build can be discarded.
    await page.fill("#vc-name", "habits2");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#vc-send");
    await expect(page.locator(".modal-title")).toHaveText("That name is taken", { timeout: 10_000 });
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });
    expect(m.sent("/api/screens/vibe-code/start")).toHaveLength(2);
  });

  test("gym builds Discard asks first, then removes a chat and an open build", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let sessionThere = true;
    let buildThere = true;
    const m = aiRules(await mock(page));
    m.get(onBox("/api/llm/sessions"), () => ({
      json: { sessions: sessionThere ? [{ sessionId: SESSION, status: "streaming", startedAt: Date.now(), name: "habits" }] : [] },
    }));
    m.get(onBox("/api/build/sessions"), () => ({
      json: { builds: buildThere ? [{ buildId: "gym-git-open", mode: "git", name: "blog", startedAt: Date.now(), open: true }] : [] },
    }));
    m.post(onBox(`/api/llm/sessions/${SESSION}/discard`), () => {
      sessionThere = false;
      return { json: { ok: true } };
    });
    m.post(onBox("/api/build/sessions/gym-git-open/discard"), () => {
      buildThere = false;
      return { json: { ok: true } };
    });
    await openBuildSessions(page);
    const list = page.locator("#build-journal-list");
    await expect(list.locator(`[data-discard="${SESSION}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(list.locator('[data-discard-build="gym-git-open"]')).toBeVisible();
    await shot(page, testInfo, "sessions-open");

    // Cancel sends nothing.
    await list.locator(`[data-discard="${SESSION}"]`).click();
    await expect(page.locator(".modal-title")).toHaveText("Discard this build?");
    await expect(page.locator(".modal-card")).toContainText('Its name, "habits", becomes free again.');
    await page.click("[data-modal-cancel]");
    expect(m.sent("/discard")).toHaveLength(0);

    await list.locator(`[data-discard="${SESSION}"]`).click();
    await page.click("[data-modal-ok]");
    await m.waitFor(`/api/llm/sessions/${SESSION}/discard`);
    await expect(list.locator(`[data-session="${SESSION}"]`)).toHaveCount(0, { timeout: 10_000 });

    await list.locator('[data-discard-build="gym-git-open"]').click();
    await expect(page.locator(".modal-card")).toContainText('Its name, "blog", becomes free again.');
    await page.click("[data-modal-ok]");
    await m.waitFor("/api/build/sessions/gym-git-open/discard");
    await expect(list).toContainText("No builds yet.", { timeout: 10_000 });
    await shot(page, testInfo, "sessions-discarded");
    await page.click("#build-journal-back");
    await expect(page.locator("#view-build-source")).toBeVisible();
  });

  test("gym builds a git build a restart cut off reopens with the box's reason and runs the AI again", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const ID = "gym-git-r";
    let adapt: Record<string, unknown> = { status: "failed", reason: INTERRUPTED_AI };
    const m = aiRules(await mock(page));
    m.get(onBox("/api/llm/sessions"), { sessions: [] });
    m.get(onBox("/api/build/sessions"), { builds: [{ buildId: ID, mode: "git", name: "blog", startedAt: Date.now(), open: true }] });
    m.post(onBox(`/api/build/sessions/${ID}/adapt`), () => {
      adapt = { status: "done", fileCount: 3, deployed: true, deployedUrl: `https://blog.${HOME}` };
      return { json: { ok: true, started: true } };
    });
    m.get(onBox(`/api/build/sessions/${ID}/journal`), { entries: [] });
    m.get(onBox(`/api/build/sessions/${ID}`), () => ({
      json: { state: { buildId: ID, mode: "git", serverFqdn: HOME, createdAt: 1, gitFit: false, name: "blog", adapt }, files: ["a", "b", "c"] },
    }));
    await openBuildSessions(page);
    const row = page.locator(`#build-journal-list .build-session-row[data-build="${ID}"]`);
    await expect(row).toContainText("blog", { timeout: 10_000 });
    await row.click();

    // The git screen says what the box said and offers both ways on.
    await expect(page.locator("#view-build-git")).toBeVisible({ timeout: 10_000 });
    const card = page.locator("#build-git-verdict [data-build-failed]");
    await expect(card.locator(".err-text")).toHaveText(INTERRUPTED_AI);
    await expect(card.locator("#build-git-adapt")).toHaveText("Use AI to adapt and deploy");
    await expect(card.locator("#build-git-deploy")).toHaveText("Install it");
    await expect(page.locator("#build-git-runs-on [data-runs-on-select]")).toHaveCount(0);
    await shot(page, testInfo, "git-resumed-failed");

    // Run the AI again: through the AI-key step (Flagship Inference, no
    // saved key), then the adapt on THIS build, followed to its end.
    await card.locator("#build-git-adapt").click();
    const post = await m.waitFor(`/api/build/sessions/${ID}/adapt`);
    expect(post.url.host).toBe(HOME);
    expect(post.body).toMatchObject({ credential: PASS });
    await expect(page.locator("#build-git-verdict")).toContainText("Installed ✓", { timeout: 15_000 });
    await expect(page.locator("#build-git-verdict a")).toHaveAttribute("href", `https://blog.${HOME}`);
    expect(m.sent(`/api/build/sessions/${ID}/deploy`)).toHaveLength(0);
    await shot(page, testInfo, "git-resumed-installed");
  });

  test("gym builds a sealed git build a restart cut off offers only Install it, and an IDE one deploys from Build sessions", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const GIT = "gym-git-s";
    const IDE = "gym-mcp-s";
    const m = aiRules(await mock(page));
    m.get(onBox("/api/llm/sessions"), { sessions: [] });
    m.get(onBox("/api/build/sessions"), {
      builds: [
        { buildId: GIT, mode: "git", name: "blog", startedAt: Date.now(), open: true },
        { buildId: IDE, mode: "mcp", name: "notes", startedAt: Date.now() - 1000, open: true },
      ],
    });
    m.post(onBox(`/api/build/sessions/${GIT}/deploy`), { url: `https://blog.${HOME}` });
    m.post(onBox(`/api/build/sessions/${IDE}/deploy`), { url: `https://notes.${HOME}` });
    m.get(onBox(`/api/build/sessions/${IDE}/journal`), {
      entries: [{ ts: Date.now(), kind: "finish", actor: "ide", summary: "The IDE finished the build", detail: "" }],
    });
    m.get(onBox(`/api/build/sessions/${GIT}`), {
      state: { buildId: GIT, mode: "git", sealed: true, name: "blog", adapt: { status: "failed", reason: INTERRUPTED_LIVE } },
      files: ["a"],
    });
    m.get(onBox(`/api/build/sessions/${IDE}`), {
      state: { buildId: IDE, mode: "mcp", name: "notes", adapt: { status: "failed", reason: INTERRUPTED_LIVE } },
      files: ["index.html"],
    });
    await openBuildSessions(page);
    await page.locator(`#build-journal-list .build-session-row[data-build="${GIT}"]`).click();
    const card = page.locator("#build-git-verdict [data-build-failed]");
    await expect(card.locator(".err-text")).toHaveText(INTERRUPTED_LIVE, { timeout: 10_000 });
    // Sealed: the AI's work is done, only installing is left.
    await expect(card.locator("#build-git-adapt")).toHaveCount(0);
    await shot(page, testInfo, "git-sealed-resumed");
    await card.locator("#build-git-deploy").click();
    await m.waitFor(`/api/build/sessions/${GIT}/deploy`);
    await expect(page.locator("#build-git-verdict")).toContainText("Installed ✓", { timeout: 10_000 });

    // The IDE build: its journal with the box's reason and Install it.
    await page.click("#build-git-back");
    await page.click("#build-source-journal-link");
    await page.locator(`#build-journal-list .build-session-row[data-build="${IDE}"]`).click();
    const detail = page.locator("#build-journal-detail");
    await expect(detail.locator("[data-build-failed] .err-text")).toHaveText(INTERRUPTED_LIVE, { timeout: 10_000 });
    await expect(detail.locator(".build-journal-timeline")).toContainText("The IDE finished the build");
    await shot(page, testInfo, "ide-resumed-failed");
    await page.click("#build-journal-deploy");
    const dep = await m.waitFor(`/api/build/sessions/${IDE}/deploy`);
    expect(dep.url.host).toBe(HOME);
    await expect(page.locator("#toast")).toContainText(`Deployed → https://notes.${HOME}`, { timeout: 10_000 });
  });

  test("gym builds a git import installs, checks again, exports its adapter and opens its journal", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const ID = "gym-git-fit";
    const m = aiRules(await mock(page));
    m.get(onBox("/api/screens/vibe-code/name-check"), (call: Call) => ({ json: { ok: true, name: call.url.searchParams.get("name") } }));
    m.post(onBox("/api/build/git"), { buildId: ID, fit: true, reason: "Has a Flagship manifest", fileCount: 12, name: "blog" });
    m.post(onBox(`/api/build/sessions/${ID}/deploy`), { url: `https://blog.${HOME}` });
    m.get(onBox(`/api/build/sessions/${ID}/adapter`), { file: '{"name":"blog"}\n' });
    m.get(onBox(`/api/build/sessions/${ID}/journal`), {
      entries: [{ ts: Date.now(), kind: "fitness-check", actor: "system", summary: "Has a Flagship manifest", detail: "" }],
    });
    m.get(onBox(`/api/build/sessions/${ID}`), { state: { buildId: ID, mode: "git", gitFit: true }, files: [] });
    await openChooser(page);
    await page.click("#build-src-git");
    await page.fill("#build-git-url", "https://github.com/you/blog");
    await page.fill("#build-git-ref", "v2");
    await expect(page.locator("#build-git-name-status")).toHaveText("Leave it blank to name it after the repo and branch.");
    await page.fill("#build-git-name", "blog");
    await expect(page.locator("#build-git-address")).toContainText(`blog.${HOME}`);
    await expect(page.locator("#build-git-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await page.click("#build-git-check");
    await expect(page.locator("#build-git-verdict")).toContainText("Flagship-ready ✓", { timeout: 10_000 });
    expect(m.sent("/api/build/git")[0]!.body).toEqual({ gitUrl: "https://github.com/you/blog", ref: "v2", name: "blog" });

    // ↻ checks the repo again.
    await page.click("#build-git-recheck");
    await m.waitFor("/api/build/git", "POST", 2);
    await expect(page.locator("#build-git-deploy")).toBeVisible({ timeout: 10_000 });

    await page.click("#build-git-deploy");
    await m.waitFor(`/api/build/sessions/${ID}/deploy`);
    await expect(page.locator("#build-git-verdict")).toContainText("Installed ✓", { timeout: 10_000 });
    await expect(page.locator("#build-git-verdict a")).toHaveAttribute("href", `https://blog.${HOME}`);
    await shot(page, testInfo, "git-installed");

    // For the repo's author: the adapter file as a download.
    const download = page.waitForEvent("download");
    await page.click("#build-git-export");
    expect((await download).suggestedFilename()).toBe("flagship.app.json");
    await expect(page.locator("#build-git-export")).toHaveText("Get flagship.app.json");

    // Back to the fit verdict's journal link via a fresh check.
    await page.click("#build-git-back");
    await page.click("#build-src-git");
    await page.fill("#build-git-url", "https://github.com/you/blog");
    await page.click("#build-git-check");
    await page.click("#build-git-journal");
    await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".build-journal-timeline")).toContainText("Has a Flagship manifest", { timeout: 10_000 });
  });

  test("gym builds a git adapt carries the share switch, offers Try again when not live, and closes when sealed", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let n = 0;
    let adapt: Record<string, unknown> = {};
    let sealed = false;
    const m = aiRules(await mock(page));
    m.post(onBox("/api/build/git"), () => {
      n++;
      return { json: { buildId: `gym-git-${n}`, fit: false, reason: "no flagship.app.json in the repo root", fileCount: 40 } };
    });
    m.post(/\/api\/build\/sessions\/gym-git-\d\/adapt$/, (call: Call) => {
      adapt = call.url.pathname.includes("gym-git-1")
        ? { status: "done", fileCount: 5, deployed: false, reason: "The tested app didn't answer on its port." }
        : { status: "failed", reason: "The AI gave up on this repo." };
      sealed = !call.url.pathname.includes("gym-git-1");
      return { json: { ok: true, started: true } };
    });
    m.get(/\/api\/build\/sessions\/gym-git-\d\/journal$/, { entries: [] });
    m.get(/\/api\/build\/sessions\/gym-git-\d$/, () => ({ json: { state: { mode: "git", adapt, sealed } } }));
    await openChooser(page);
    await page.click("#build-src-git");
    await page.fill("#build-git-url", "https://github.com/you/some-saas");
    await page.click("#build-git-check");
    await expect(page.locator("#build-git-verdict")).toContainText("This repo is not yet adapted for Flagship.", { timeout: 10_000 });
    // Keep the adaptation private.
    await page.uncheck("#build-git-share");
    await page.click("#build-git-adapt");
    const first = await m.waitFor("/gym-git-1/adapt");
    expect(first.body).toMatchObject({ share: false, credential: PASS });
    await expect(page.locator("#build-git-verdict .build-git-adapting")).toBeVisible();

    // The tested copy didn't go live: the box's reason and Try again.
    await expect(page.locator("#build-git-verdict")).toContainText("The app didn't go live.", { timeout: 15_000 });
    await expect(page.locator("#build-git-verdict .err-text")).toHaveText("The tested app didn't answer on its port.");
    await shot(page, testInfo, "git-not-live");
    await page.click("#build-git-retry");
    // A fresh check, adapted again with the same key.
    await m.waitFor("/api/build/git", "POST", 2);
    await m.waitFor("/gym-git-2/adapt");

    // This time it fails sealed: no more AI on it, Check again starts afresh.
    await expect(page.locator("#build-git-verdict")).toContainText("The AI's work on this build is done.", { timeout: 15_000 });
    await expect(page.locator("#build-git-adapt")).toHaveCount(0);
    await shot(page, testInfo, "git-closed");
    await page.click("#build-git-recheck-full");
    await m.waitFor("/api/build/git", "POST", 3);
    await expect(page.locator("#build-git-adapt")).toBeVisible({ timeout: 10_000 });
  });

  test("gym builds an IDE connection copies its config, regenerates its key, deploys and refreshes its requests", async ({ page, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const ID = "gym-mcp-1";
    const ideConfig = { mcpServers: { flagship: { url: `https://${HOME}/mcp/build/${ID}` } } };
    let set = false;
    const m = aiRules(await mock(page));
    m.post(onBox("/api/build/mcp"), { buildId: ID, connection: { url: `https://${HOME}/mcp/build/${ID}`, key: "mcpk_first", ideConfig } });
    m.post(onBox(`/api/build/sessions/${ID}/mcp/rotate`), { url: `https://${HOME}/mcp/build/${ID}`, key: "mcpk_second", ideConfig });
    m.post(onBox(`/api/build/sessions/${ID}/deploy`), { url: `https://notes.${HOME}` });
    m.get(onBox(`/api/build/sessions/${ID}/env-requests`), () => ({
      json: { requests: [{ name: "STRIPE_API_KEY", why: "billing", secret: true, currentlySet: set }] },
    }));
    m.get(onBox(`/api/build/sessions/${ID}/journal`), {
      entries: [{ ts: Date.now(), kind: "mcp-connect", actor: "owner", summary: "IDE connected", detail: "" }],
    });
    await openChooser(page);
    await page.click("#build-src-mcp");
    await page.click("#build-mcp-create");
    await expect(page.locator("#mcp-key")).toHaveText("mcpk_first", { timeout: 10_000 });

    await page.click("#mcp-copy-cfg");
    await expect(page.locator("#toast")).toContainText("config copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify(ideConfig, null, 2));

    await page.click("#mcp-rotate");
    await expect(page.locator("#mcp-key")).toHaveText("mcpk_second", { timeout: 10_000 });
    await expect(page.locator("#toast")).toContainText("Key regenerated — update your IDE");

    await expect(page.locator("#mcp-env-requests")).toContainText("needs you", { timeout: 10_000 });
    set = true;
    await page.click("#mcp-env-refresh");
    await expect(page.locator("#mcp-env-requests")).toContainText("set ✓", { timeout: 10_000 });

    await page.click("#mcp-deploy");
    await m.waitFor(`/api/build/sessions/${ID}/deploy`);
    await expect(page.locator("#toast")).toContainText(`Deployed → https://notes.${HOME}`, { timeout: 10_000 });
    await expect(page.locator("#mcp-deploy")).toHaveText("Deploy now");
    await shot(page, testInfo, "mcp-deployed");

    await page.click("#mcp-journal");
    await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".build-journal-timeline")).toContainText("IDE connected", { timeout: 10_000 });
  });

  test("gym builds the AI-key step adds, cancels, relays, deletes and uses saved keys", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    await saveKey(page, "Work key");
    aiRules(await mock(page));
    await openChooser(page);
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-key-saved .build-key-row")).toHaveCount(2, { timeout: 10_000 });

    // Back returns to the chooser; the step opens again from Scratch.
    await page.click("#build-key-back");
    await expect(page.locator("#view-build-source")).toBeVisible();
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-build-key")).toBeVisible();

    // + Add an API key opens the form; Cancel closes it.
    await expect(page.locator("#build-key-form")).toBeHidden();
    await page.click("#build-key-add");
    await expect(page.locator("#build-key-form")).toBeVisible();
    await page.click("#bk-cancel");
    await expect(page.locator("#build-key-form")).toBeHidden();
    await expect(page.locator("#build-key-add")).toBeVisible();

    // Add a second key with a base URL and a label, off the relay.
    await page.click("#build-key-add");
    await page.selectOption("#bk-provider", "openai");
    await page.fill("#bk-base", "https://llm.example.com/v1");
    await page.fill("#bk-key", "sk-second-key-0123456789");
    await page.fill("#bk-label", "Lab key");
    await page.uncheck("#bk-relay");
    await page.click("#bk-add");
    await expect(page.locator("#build-key-saved .build-key-row")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator("#build-key-form")).toBeHidden();
    const added = (await savedKeys(page)).find((e) => e.label === "Lab key")!;
    expect(added).toMatchObject({ provider: "openai", baseUrl: "https://llm.example.com/v1", relay: false });
    await shot(page, testInfo, "build-key-added");

    // The Work key's relay switch turns its relay off.
    const work = page.locator("#build-key-saved .build-key-row", { hasText: "Work key" });
    await work.locator("[data-relay-id]").uncheck();
    await expect.poll(async () => (await savedKeys(page)).find((e) => e.label === "Work key")?.relay).toBe(false);

    // Delete asks first; Cancel keeps it, Delete key removes it.
    const lab = page.locator("#build-key-saved .build-key-row", { hasText: "Lab key" });
    await lab.locator(".build-key-delete").click();
    await expect(page.locator(".modal-title")).toHaveText("Delete this key?");
    await page.click("[data-modal-cancel]");
    await expect(page.locator("#build-key-saved .build-key-row")).toHaveCount(3);
    await lab.locator(".build-key-delete").click();
    await page.click("[data-modal-ok]");
    await expect(page.locator("#build-key-saved .build-key-row")).toHaveCount(2, { timeout: 10_000 });
    expect((await savedKeys(page)).map((e) => e.label)).toEqual(["Work key"]);

    // Use this: the chat opens on that key's group.
    await page.locator("#build-key-saved [data-use-id]").click();
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#vc-model-bar .mm-trigger-text")).toContainText("Work key", { timeout: 10_000 });
    await shot(page, testInfo, "build-key-used");
  });

  test("gym builds the install tracker follows a serial and offers a way out when the status read fails", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let failing = false;
    const m = await mock(page);
    m.get("/api/order/SN-GYM1/status", () =>
      failing ? { status: 500, json: { error: "boom" } } : { json: { phase: "installing", serverDomain: HOME } },
    );
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    await page.click('[data-tab-target="activity"]');
    await page.click("#activity-open-install-progress");
    await expect(page.locator("#view-install-progress")).toBeVisible({ timeout: 10_000 });

    await page.click("#ip-go");
    await expect(page.locator("#toast")).toContainText("Enter the serial first");
    await page.fill("#ip-serial", "SN-GYM1");
    await page.click("#ip-go");
    await expect(page.locator("#install-progress-content")).toContainText("Installing", { timeout: 10_000 });
    await expect(page.locator("#install-progress-content")).toContainText(HOME);
    await shot(page, testInfo, "install-progress");

    await page.click("#ip-reset");
    await expect(page.locator("#ip-serial")).toHaveValue("");
    await expect(page.locator("#install-progress-content")).toContainText("waiting for your box to phone home");

    // A failed status read: the reason and two ways out.
    failing = true;
    await page.fill("#ip-serial", "SN-GYM1");
    await page.click("#ip-go");
    await expect(page.locator("#ip-escape-retry")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "install-progress-escape");
    const reads = m.sent("/api/order/SN-GYM1/status", "GET").length;
    await page.click("#ip-escape-retry");
    await expect.poll(() => m.sent("/api/order/SN-GYM1/status", "GET").length).toBeGreaterThan(reads);
    await expect(page.locator("#ip-escape-home")).toBeVisible({ timeout: 10_000 });
    await page.click("#ip-escape-home");
    await expect(page.locator("#view-home")).toBeVisible();

    // Back from the tracker returns to Activity, where it was opened.
    await page.click('[data-tab-target="activity"]');
    await page.click("#activity-open-install-progress");
    await page.click("#install-progress-back");
    await expect(page.locator("#view-activity")).toBeVisible();
  });
});
