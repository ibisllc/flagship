/**
 * The owner's promise (docs/voici-calls.md; privacy policy §2.12): a visitor who opens voi.ci/<username> places a
 * call straight to the owner's phone, and every audio frame is sealed under keys from the call's X-Wing exchange.
 * This test opens the public page address, calls (anonymously on a page open to anyone, and signed in through the
 * app's handoff), the phone answers with its own WebRTC and the voi.ci site's frame code, and audio flows both ways:
 * the tab's worker seals what it sends and opens what the phone sealed, and the phone opens what the tab sealed.
 *
 * One stand-in: the real call's only ICE server is TURN on the phone's bare name (`turns:<user>.flagship.services`),
 * which this machine doesn't have, so an init script lets the tab use host candidates on loopback. Everything above
 * ICE (the request, the room, the answer and its checks, X-Wing, the frame layer) is the product's own code.
 * It also checks that no API address the call uses names the account: only the page's own loads do.
 */
import { expect, test, type Page } from "@playwright/test";
import { VOICI_CALL_SEALED_FRAME } from "@flagship/protocol";
import { startCallWorld, type CallWorld } from "./callWorld.js";

test.setTimeout(90_000);
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone", "camera"],
});

const LOOPBACK_ICE = `(() => {
  const Real = window.RTCPeerConnection;
  const local = (c) => ({ ...(c || {}), iceServers: [], iceTransportPolicy: "all" });
  class Loopback extends Real {
    constructor(c, ...rest) { super(local(c), ...rest); }
    setConfiguration(c) { return super.setConfiguration(local(c)); }
  }
  window.RTCPeerConnection = Loopback;
})();`;

/** The tab's own frame counts, from the call engine's diagnostics ("frames audio: seal ok N … open ok M fail F"). */
function frameStats(tab: Page) {
  const seen = { sealOk: 0, openOk: 0, openFail: 0, openSize: 0, connected: false };
  tab.on("console", (m) => {
    const t = m.text();
    if (t.includes("[voici-call] connection connected")) seen.connected = true;
    const f = /frames audio: seal ok (\d+) refused \d+ .*?; open ok (\d+) size (\d+) fail (\d+)/.exec(t);
    if (f) {
      seen.sealOk += Number(f[1]);
      seen.openOk += Number(f[2]);
      seen.openSize += Number(f[3]);
      seen.openFail += Number(f[4]);
    }
  });
  return seen;
}

async function phoneCounts(phone: Page) {
  return JSON.parse((await phone.locator("#f").textContent()) ?? "{}") as { sealOk?: number; openOk?: number; openFail?: number; openSize?: number; openNoKey?: number; inSizes?: number[] };
}

async function expectSealedMediaBothWays(world: CallWorld, tab: Page, phone: Page, seen: ReturnType<typeof frameStats>) {
  await expect(phone.locator("#s")).toHaveText("connected", { timeout: 30_000 });
  await expect.poll(() => seen.connected, { timeout: 30_000 }).toBe(true);
  // The phone opened the tab's frames with keys only the X-Wing exchange gave both ends, and every frame it got was
  // the sealed size (a padded 20 ms Opus frame plus its tag): nothing arrived in the clear.
  await expect.poll(async () => (await phoneCounts(phone)).openOk ?? 0, { timeout: 30_000 }).toBeGreaterThan(20);
  const p = await phoneCounts(phone);
  expect(p.openFail).toBe(0);
  expect(p.openSize).toBe(0);
  expect(p.inSizes).toEqual([VOICI_CALL_SEALED_FRAME]);
  expect(p.sealOk).toBeGreaterThan(20);
  // The tab sealed what it sent and opened what the phone sealed.
  await expect.poll(() => seen.openOk, { timeout: 30_000 }).toBeGreaterThan(20);
  expect(seen.sealOk).toBeGreaterThan(20);
  expect(seen.openFail).toBe(0);
  expect(seen.openSize).toBe(0);
  // No address the call used names the account; only the page's own loads (its account lookup and, for an anonymous
  // call, its proof-of-work challenge) carry the page's name.
  const callAddresses = world.log.apiAddresses.filter((a) => !/^GET \/api\/username\/alice$/.test(a) && !/^GET \/api\/voici\/pages\/alice\/call-challenge$/.test(a));
  expect(callAddresses.length).toBeGreaterThan(0);
  for (const a of callAddresses) expect(a).not.toContain("alice");
}

test("a visitor opens voi.ci/<username>, calls anonymously, and the phone answers with sealed frames both ways", async ({ browser }) => {
  const world = await startCallWorld({ callsFrom: "anyone", frames: true });
  try {
    const phoneCtx = await browser.newContext();
    const phone = await phoneCtx.newPage();
    await phone.goto(`${world.origin}/__phone`);
    const ctx = await browser.newContext();
    await ctx.addInitScript(LOOPBACK_ICE);
    const tab = await ctx.newPage();
    const seen = frameStats(tab);
    await tab.goto(`${world.origin}/alice`);
    expect(new URL(tab.url()).pathname).toBe("/alice");
    await tab.locator("#app").getByRole("button", { name: "Call" }).click();
    await tab.getByRole("button", { name: "Call anonymously" }).click();
    await expectSealedMediaBothWays(world, tab, phone, seen);
    expect(world.log.requestRefusal).toBeUndefined();
    expect((world.log.request as unknown as { kind: string }).kind).toBe("voici-call-request-anon");
    await tab.getByRole("button", { name: "End", exact: true }).click();
    await expect(tab.getByText("Call ended")).toBeVisible();
    await ctx.close();
    await phoneCtx.close();
  } finally {
    await world.close();
  }
});

test("a signed-in visitor on voi.ci/<username> (the app's handoff) calls and the phone answers with sealed frames", async ({ browser }) => {
  const world = await startCallWorld({ frames: true });
  try {
    const phoneCtx = await browser.newContext();
    const phone = await phoneCtx.newPage();
    await phone.goto(`${world.origin}/__phone`);
    const ctx = await browser.newContext();
    await ctx.addInitScript(LOOPBACK_ICE);
    const tab = await ctx.newPage();
    const seen = frameStats(tab);
    await tab.goto(await world.handoffUrl());
    expect(new URL(tab.url()).pathname).toBe("/alice");
    await expect(tab.getByText("Your Flagship app is ready to call Alice Martin.")).toBeVisible({ timeout: 30_000 });
    await tab.getByLabel("Alice Martin").getByRole("button", { name: "Call" }).click();
    await expectSealedMediaBothWays(world, tab, phone, seen);
    expect(world.log.requestRefusal).toBeUndefined();
    expect(world.log.request?.kind).toBe("voici-call-request");
    await tab.getByRole("button", { name: "End", exact: true }).click();
    await expect(tab.getByText("Call ended")).toBeVisible();
    await ctx.close();
    await phoneCtx.close();
  } finally {
    await world.close();
  }
});
