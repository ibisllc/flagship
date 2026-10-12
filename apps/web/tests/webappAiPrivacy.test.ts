// AI privacy on the webapp (docs/ai-privacy-and-staging.md): the one-step
// staged AI adapt, the chat's background Deploy, an app's signed internet
// approval, and the per-key Flagship relay switch.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveIRK } from "@flagship/protocol";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

async function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href);
}
const loadEgress = () => load("lib/appEgress.js");
const loadDeploy = () => load("lib/chatDeploy.js");
const loadGit = () => load("lib/gitImport.js");
const loadRelay = () => load("lib/aiRelay.js");
const loadProviders = () => load("providers.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const instant = { sleep: async () => {}, intervalMs: 1 };

// The UMK seed; the grant is signed by the IRK derived from it (the webapp's
// real signWithIrk), the same fixture the protocol test pins.
const SEED = new Uint8Array(32).fill(0x2a);
const PUB = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4";
const GRANT = {
  serverDomain: "home.harry.flagship.services",
  serviceId: "harry-weather",
  hosts: ["api.open-meteo.com", "*.tile.openstreetmap.org", "api.github.com"],
  issuedAt: 1700000000000,
};
const CANONICAL =
  "flagship/app-egress/v1|home.harry.flagship.services|harry-weather|*.tile.openstreetmap.org,api.github.com,api.open-meteo.com|1700000000000";
const SIG =
  "a3788a82b718af70e81db6b319229d1d469944a999dd7fbe1b77fa1da58c22bcc0d58241d7cbdd9c8954234d03f8d8cdf1e42ef24510eb100a373fdb1ba8f703";
const REVOKE_SIG =
  "332195add8c4f75eb5c472500c8b4d253c5024b58fab3dc81b7e84261fabd9f278c5b348991d20e08b7c4799e950b6ece4af2018cd897797de35e8aa3e6e3901";

describe("app internet approval — canonical bytes + golden vector", () => {
  it("sorts the hosts by code unit and joins them with commas", async () => {
    const { canonicalAppEgressBytes, normalizeEgressHosts } = await loadEgress();
    expect(utf8(canonicalAppEgressBytes(GRANT))).toBe(CANONICAL);
    expect(normalizeEgressHosts(["B.example.com", "a.example.com", "b.example.com"])).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
  });

  it("an empty host list revokes with an empty field", async () => {
    const { canonicalAppEgressBytes } = await loadEgress();
    expect(utf8(canonicalAppEgressBytes({ ...GRANT, hosts: [] }))).toBe(
      "flagship/app-egress/v1|home.harry.flagship.services|harry-weather||1700000000000",
    );
  });

  it("reproduces the golden signatures for allow and revoke", async () => {
    const { canonicalAppEgressBytes } = await loadEgress();
    const { signWithIrk } = await load("keystore.js");
    const irk = deriveIRK({ seed: SEED });
    expect(hex(irk.publicKey)).toBe(PUB);
    const sig = await signWithIrk(SEED, canonicalAppEgressBytes(GRANT));
    expect(hex(sig)).toBe(SIG);
    expect(hex(await signWithIrk(SEED, canonicalAppEgressBytes({ ...GRANT, hosts: [] })))).toBe(REVOKE_SIG);
  });

  it("signs with the sensitive-order key and posts the grant the box verifies", async () => {
    const { sendEgressGrant } = await loadEgress();
    const fetchJson = vi.fn(async () => ({ ok: true, egress: { declared: GRANT.hosts, approved: GRANT.hosts } }));
    const { signWithIrk } = await load("keystore.js");
    const egress = await sendEgressGrant(
      {
        ...GRANT,
        umk: SEED,
        signWithIrk,
        fetchJson,
        bytesToHex: hex,
      },
      { now: () => GRANT.issuedAt, requireOwnerProfile: () => {} },
    );
    expect(egress.approved).toEqual(GRANT.hosts);
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(path).toBe("/api/screens/services/harry-weather/egress");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.grant).toEqual({
      serverDomain: GRANT.serverDomain,
      serviceId: GRANT.serviceId,
      hosts: ["*.tile.openstreetmap.org", "api.github.com", "api.open-meteo.com"],
      issuedAt: GRANT.issuedAt,
    });
    expect(body.signature).toBe(SIG);
  });

  it("refuses on a companion profile before signing", async () => {
    const { sendEgressGrant } = await loadEgress();
    const sign = vi.fn();
    await expect(
      sendEgressGrant(
        { ...GRANT, umk: new Uint8Array(32), signWithIrk: sign, fetchJson: vi.fn(), bytesToHex: hex },
        { requireOwnerProfile: () => { throw new Error("A remote browser can't sign"); } },
      ),
    ).rejects.toThrow(/can't sign/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("routes the grant through the admin root when one is held", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/app-egress/v1")).toBe(true);
  });

  it("says the box's refusals plainly", async () => {
    const { egressErrorMessage } = await loadEgress();
    const err = (status: number, error: string) => new ScreensError(error, status, { error });
    expect(egressErrorMessage(err(403, "stale grant"))).toMatch(/clock/);
    expect(egressErrorMessage(err(403, "invalid signature"))).toMatch(/signature/);
    expect(egressErrorMessage(err(403, "grant is for a different server"))).toMatch(/different server/);
    expect(egressErrorMessage(err(404, "no such service"))).toMatch(/isn't installed/);
    expect(egressErrorMessage(err(409, "a newer grant is already applied"))).toMatch(/newer approval/);
    expect(egressErrorMessage(err(422, "not declared in the app's network.egress: x.com"))).toContain("x.com");
    expect(egressErrorMessage(err(400, "malformed grant"))).toBe("malformed grant");
  });
});

describe("app internet approval — what the app page and list show", () => {
  const app = (egress?: unknown) => ({ serviceId: "harry-weather", ...(egress ? { egress } : {}) });

  it("shows nothing for an older box, or an app that declares nothing", async () => {
    const { egressCardState, hasPendingEgress } = await loadEgress();
    expect(egressCardState(app())).toBeNull();
    expect(egressCardState(app({ declared: [], approved: [] }))).toBeNull();
    expect(hasPendingEgress(app())).toBe(false);
  });

  it("asks for the hosts not yet allowed, with the list badge", async () => {
    const { egressCardState, hasPendingEgress } = await loadEgress();
    const a = app({ declared: ["api.github.com", "api.open-meteo.com"], approved: [] });
    expect(egressCardState(a)).toMatchObject({ pending: ["api.github.com", "api.open-meteo.com"], approved: [], canSign: true });
    expect(hasPendingEgress(a)).toBe(true);
  });

  it("lists allowed hosts with Stop access, and no badge once all are allowed", async () => {
    const { egressCardState, hasPendingEgress } = await loadEgress();
    const a = app({ declared: ["api.github.com"], approved: ["api.github.com"] });
    expect(egressCardState(a)).toMatchObject({ pending: [], approved: ["api.github.com"], canSign: true });
    expect(hasPendingEgress(a)).toBe(false);
    const more = app({ declared: ["api.github.com", "x.example.com"], approved: ["api.github.com"] });
    expect(egressCardState(more)).toMatchObject({ pending: ["x.example.com"], approved: ["api.github.com"] });
  });

  it("a companion sees the hosts but can't approve", async () => {
    const { egressCardState } = await loadEgress();
    const a = app({ declared: ["api.github.com"], approved: [] });
    expect(egressCardState(a, { companion: true })).toMatchObject({ pending: ["api.github.com"], canSign: false });
  });

  it("the app page and list wire the card and the badge", async () => {
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain("renderEgressSection(s)");
    expect(detail).toContain("sd-egress-allow");
    expect(detail).toContain("sd-egress-stop");
    expect(detail).toContain("sensitiveSigner()");
    const list = await asset("/webapp/views/services-list.js");
    expect(list).toContain("hasPendingEgress(s)");
    const { EGRESS_TITLE, EGRESS_NOTE, EGRESS_STOP } = await loadEgress();
    expect(EGRESS_TITLE).toBe("This app wants to reach the internet");
    expect(EGRESS_NOTE).toBe(
      "Until you allow them, the app can't reach any of these. Only allow hosts you expect this app to need.",
    );
    expect(EGRESS_STOP).toBe("Stop access");
  });
});

describe("AI adapt is one step", () => {
  it("names the button and maps the box's phases to text", async () => {
    const g = await loadGit();
    expect(g.ADAPT_BUTTON).toBe("Use AI to adapt and deploy");
    expect(g.adaptingText("staging")).toBe("The AI is adapting and testing the app on a private copy with sample data…");
    expect(g.adaptingText("going-live")).toBe("Installing the tested app…");
    expect(g.adaptingText(undefined)).toBe(g.ADAPTING);
  });

  it("follows the phases to an installed app", async () => {
    const { followAdapt } = await loadGit();
    const states = [
      { state: { adapt: { status: "running", phase: "staging" } } },
      { state: { adapt: { status: "running", phase: "going-live" }, sealed: true } },
      { state: { adapt: { status: "done", fileCount: 3, deployed: true, deployedUrl: "https://w.example" }, sealed: true } },
    ];
    const phases: unknown[] = [];
    const out = await followAdapt({
      fetchState: async () => states.shift(),
      fetchJournal: async () => ({ entries: [] }),
      onPhase: (p: unknown) => phases.push(p),
      ...instant,
    });
    expect(out).toEqual({ phase: "installed", url: "https://w.example" });
    expect(phases).toEqual(["staging", "going-live"]);
  });

  it("a tested app that didn't go live shows the box's reason", async () => {
    const { adaptFinished } = await loadGit();
    expect(adaptFinished({ fileCount: 3, deployed: false, reason: "migration 0002 failed" })).toEqual({
      phase: "not-live",
      reason: "migration 0002 failed",
    });
    // An older box (or no tested copy): adapted files to install.
    expect(adaptFinished({ fileCount: 3, deployed: false })).toEqual({ phase: "adapted", fileCount: 3 });
  });

  it("a sealed build is closed to the AI: no second run on it", async () => {
    const g = await loadGit();
    const closed = new ScreensError(
      "This build is closed to the AI: it was handed to the box to go live. Start a new build to change the app.",
      409,
      { error: "This build is closed to the AI: it was handed to the box to go live. Start a new build to change the app." },
    );
    expect(g.closedToAi(closed)).toBe(true);
    expect(g.adaptAlreadyRunning(closed)).toBe(false);
    const follow = vi.fn();
    const out = await g.startAndFollowAdapt({ start: async () => { throw closed; }, follow });
    expect(out).toMatchObject({ phase: "failed", sealed: true });
    expect(follow).not.toHaveBeenCalled();
    // A run the box already started is still followed.
    const running = new ScreensError("the AI is already adapting this repo", 409, { error: "the AI is already adapting this repo" });
    expect(g.adaptAlreadyRunning(running)).toBe(true);

    const failed = await g.followAdapt({
      fetchState: async () => ({ state: { adapt: { status: "failed", reason: "x" }, sealed: true } }),
      fetchJournal: async () => ({ entries: [] }),
      ...instant,
    });
    expect(failed).toEqual({ phase: "failed", reason: "x", sealed: true });
  });

  it("the view offers Check again instead of the AI on a closed build, and a retry when not live", async () => {
    const view = await asset("/webapp/views/build-git.js");
    expect(view).toContain("CLOSED_NOTE");
    expect(view).toContain("build-git-recheck-full");
    expect(view).toContain("renderNotLive");
    expect(view).toContain('outcome.phase === "not-live"');
  });
});

describe("chat Deploy runs staged in the background", () => {
  it("maps the deploy phases to text", async () => {
    const d = await loadDeploy();
    expect(d.deployPhaseText("staging")).toBe("Testing the app on a private copy…");
    expect(d.deployPhaseText("fixing")).toBe("The AI is fixing a problem it found…");
    expect(d.deployPhaseText("going-live")).toBe("Installing…");
    expect(d.deployRequestBody()).toEqual({ background: true });
  });

  it("polls the session through its phases to the live URL", async () => {
    const { startAndFollowChatDeploy } = await loadDeploy();
    const snaps = [
      { status: "deploying", deployPhase: "staging" },
      { status: "deploying", deployPhase: "fixing" },
      { status: "deploying", deployPhase: "going-live" },
      { status: "deployed", deployedUrl: "https://notes.example" },
    ];
    const phases: unknown[] = [];
    const out = await startAndFollowChatDeploy({
      start: async () => ({ ok: true, started: true }),
      fetchSnapshot: async () => snaps.shift(),
      onPhase: (p: unknown) => phases.push(p),
      ...instant,
    });
    expect(out).toEqual({ ok: true, url: "https://notes.example" });
    expect(phases).toEqual(["staging", "staging", "fixing", "going-live"]);
  });

  it("reads meta.status / meta.deployPhase too, and a failure's reason", async () => {
    const { startAndFollowChatDeploy } = await loadDeploy();
    const snaps = [
      { meta: { status: "deploying", deployPhase: "staging" } },
      { meta: { status: "failed", failureReason: "the app never answered" } },
    ];
    const out = await startAndFollowChatDeploy({
      start: async () => ({ ok: true, started: true }),
      fetchSnapshot: async () => snaps.shift(),
      ...instant,
    });
    expect(out).toEqual({ ok: false, reason: "the app never answered" });
  });

  it("an older box answers with the finished result", async () => {
    const { startAndFollowChatDeploy } = await loadDeploy();
    const fetchSnapshot = vi.fn();
    const out = await startAndFollowChatDeploy({
      start: async () => ({ ok: true, serviceId: "harry-notes", url: "https://notes.example", inviteOnly: false }),
      fetchSnapshot,
      ...instant,
    });
    expect(out).toEqual({ ok: true, url: "https://notes.example", serviceId: "harry-notes", inviteOnly: false });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("a second Deploy while one runs follows the first", async () => {
    const { startAndFollowChatDeploy } = await loadDeploy();
    const out = await startAndFollowChatDeploy({
      start: async () => { throw new ScreensError("already deploying", 409, { error: "already deploying" }); },
      fetchSnapshot: async () => ({ status: "deployed", deployedUrl: "https://notes.example" }),
      ...instant,
    });
    expect(out).toEqual({ ok: true, url: "https://notes.example" });
    await expect(
      startAndFollowChatDeploy({
        start: async () => { throw new ScreensError("cannot deploy while awaiting a tool response", 409, {}); },
        fetchSnapshot: vi.fn(),
        ...instant,
      }),
    ).rejects.toThrow(/awaiting a tool response/);
  });

  it("the chat view sends background and shows the phase", async () => {
    const view = await asset("/webapp/views/vibe-code.js");
    expect(view).toContain("JSON.stringify(deployRequestBody())");
    expect(view).toContain("startAndFollowChatDeploy");
    expect(view).toContain("statusLabel(state.status, state.deployPhase)");
  });
});

describe("the per-key Flagship relay", () => {
  it("is on for keys saved before it existed, and stays off once turned off", async () => {
    const p = await loadProviders();
    const seed = new Uint8Array(32).fill(0x42);
    const old = {
      activeId: "a",
      entries: [
        { id: "a", provider: "anthropic", label: "personal", apiKey: "sk-a" },
        { id: "b", provider: "openai", label: "work", apiKey: "sk-b", relay: false },
      ],
    };
    const back = p.normalizeList(await p._testing.unwrapList(seed, await p._testing.wrapList(seed, old)));
    expect(back.entries.map((e: { relay: boolean }) => e.relay)).toEqual([true, false]);
    expect(p._testing.isValidEntry({ ...old.entries[0], relay: true })).toBe(true);
    expect(p._testing.isValidEntry({ ...old.entries[0], relay: "yes" })).toBe(false);
  });

  it("every credential carries relay explicitly", async () => {
    const p = await loadProviders();
    expect(p.credentialFor({ id: "a", provider: "anthropic", label: "x", apiKey: "sk-a" })).toEqual({
      provider: "anthropic",
      apiKey: "sk-a",
      relay: true,
    });
    expect(
      p.credentialFor({ id: "b", provider: "openai", label: "x", apiKey: "sk-b", baseUrl: "https://p.example", relay: false }),
    ).toEqual({ provider: "openai", apiKey: "sk-b", baseUrl: "https://p.example", relay: false });
    const { adaptRequestBody } = await loadGit();
    expect(adaptRequestBody({ credential: p.credentialFor({ provider: "anthropic", apiKey: "k", relay: false }) }).credential.relay).toBe(false);
  });

  it("finds the saved key behind a credential", async () => {
    const p = await loadProviders();
    const entries = [
      { id: "a", provider: "anthropic", label: "x", apiKey: "sk-a" },
      { id: "b", provider: "openai", label: "x", apiKey: "sk-b", baseUrl: "https://p.example" },
    ];
    expect(p.entryForCredential(entries, { provider: "openai", apiKey: "sk-b", baseUrl: "https://p.example" })?.id).toBe("b");
    expect(p.entryForCredential(entries, { provider: "openai", apiKey: "sk-b" })).toBeNull();
    expect(p.entryForCredential(entries, null)).toBeNull();
  });

  it("recognises the box's relay failures, worded as it words them", async () => {
    const r = await loadRelay();
    expect(r.isRelayFailure("the Flagship relay isn't reachable, so the AI call wasn't sent")).toBe(true);
    expect(
      r.isRelayFailure("agentic adapt failed: the Flagship relay didn't connect to api.anthropic.com because it timed out, so the AI call wasn't sent"),
    ).toBe(true);
    expect(r.isRelayFailure("relay-unavailable")).toBe(true);
    expect(r.isRelayFailure("provider-error")).toBe(false);
    expect(r.relayCaption(true)).toBe("Through the Flagship relay");
    expect(r.relayCaption(false)).toBe("Direct");
    expect(r.TURN_RELAY_OFF).toBe("Turn the relay off for this key");
  });

  it("both add-key forms carry the switch, on by default", async () => {
    const html = await asset("/webapp/index.html");
    expect(html).toMatch(/id="bk-relay" role="switch" checked \/> Send through the Flagship relay/);
    expect(html).toMatch(/id="np-relay" role="switch" checked \/> Send through the Flagship relay/);
    expect(html).toContain("Better for your anonymity: the AI provider sees Flagship's address, not yours.");
    const key = await asset("/webapp/views/build-key.js");
    expect(key).toContain("onChosenCb(credentialFor(e))");
    expect(key).toContain("relaySwitch(e)");
    const settings = await asset("/webapp/views/settings.js");
    expect(settings).toContain('data-action="relay"');
  });
});
