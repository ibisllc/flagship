/**
 * A voi.ci call from a browser to the owner's phone, set up end to end between two browser contexts (docs/voici-calls.md
 * §10; "Calling from the app"): the visitor's tab gets its session from the app's handoff over /qr-pipe, taps Call,
 * the stand-in `.com` runs the real request check and room, the phone context answers with its own WebRTC, the
 * owner's signed answer reaches the tab, which checks it (signature, request hash, SDP profile and hashes) and
 * applies both descriptions. ICE stops there: the only ICE server is the phone's TURN on its bare name, which this
 * machine doesn't have (the frame layer over a loopback TURN is the media CI lane's, once libwebrtc is in).
 */
import { expect, test } from "@playwright/test";
import * as P from "@flagship/protocol";
import { startCallWorld, type CallWorld } from "./callWorld.js";

let world: CallWorld;
test.beforeAll(async () => {
  world = await startCallWorld();
});
test.afterAll(async () => {
  await world?.close();
});

test("a handed-off voi.ci call is requested, rung, answered and checked", async ({ browser }) => {
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await phone.goto(`${world.origin}/__phone`);

  const visitorCtx = await browser.newContext();
  const tab = await visitorCtx.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (e) => errors.push(e.message));
  await tab.goto(await world.handoffUrl());
  // The pipe secret leaves the address bar before anything else.
  await expect.poll(() => new URL(tab.url()).hash).toBe("");
  await expect(tab.getByText("Your Flagship app is ready to call Alice Martin.")).toBeVisible({ timeout: 30_000 });
  await tab.getByLabel("Alice Martin").getByRole("button", { name: "Call" }).click();

  await expect(phone.locator("#s")).toHaveText("won", { timeout: 30_000 });
  await expect(tab.getByText("Connecting…")).toBeVisible({ timeout: 30_000 });

  const req = world.log.request!;
  const ans = world.log.answer!;
  expect(world.log.requestRefusal).toBeUndefined();
  // The signed request carries the offer whose hash it signs; the answer names that request and its own SDP.
  expect(P.checkVoiciCallSdp(req.offerSdp, req.media ?? "audio")).toBeNull();
  expect(ans.requestHash).toBe(P.voiciCallRequestHash(req));
  expect(P.checkVoiciCallSdp(ans.answerSdp, ans.media ?? "audio")).toBeNull();
  expect(P.voiciCallSdpFingerprint(ans.answerSdp)).not.toBeNull();
  expect(world.log.roomSentToCaller).toEqual(["ringing", "answer"]);
  // The tab neither failed the answer check nor the descriptions: it is still connecting, not "couldn't connect".
  await expect(tab.getByText("The call couldn't connect.", { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);

  await tab.getByRole("button", { name: "Hang up" }).click();
  await expect(tab.getByText("Call ended")).toBeVisible();
  await visitorCtx.close();
  await phoneCtx.close();
});

test("a handoff link opens once: a second tab with the same link is refused", async ({ browser }) => {
  const ctx = await browser.newContext();
  const url = await world.handoffUrl();
  const a = await ctx.newPage();
  await a.goto(url);
  await expect(a.getByText("Your Flagship app is ready to call Alice Martin.")).toBeVisible({ timeout: 30_000 });
  const b = await ctx.newPage();
  await b.goto(url);
  await expect(b.getByText("This call link was already used or has expired.", { exact: false })).toBeVisible({ timeout: 30_000 });
  await ctx.close();
});

test("an anonymous visitor calls a page open to anyone from the pop-up (proof of work, no account)", async ({ browser }) => {
  const open = await startCallWorld({ callsFrom: "anyone" });
  try {
    const phoneCtx = await browser.newContext();
    const phone = await phoneCtx.newPage();
    await phone.goto(`${open.origin}/__phone`);
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(`${open.origin}/alice`);
    await tab.locator("#app").getByRole("button", { name: "Call" }).click();
    await expect(tab.getByText("Let Alice Martin call you back?")).toBeVisible();
    await expect(tab.getByText("Alice Martin won't learn who you are. Flagship will know this conversation can ring your phone.")).toBeVisible();
    await tab.getByRole("button", { name: "Call anonymously" }).click();
    await expect(phone.locator("#s")).toHaveText("won", { timeout: 30_000 });
    await expect(tab.getByText("Connecting…")).toBeVisible({ timeout: 30_000 });
    expect(open.log.requestRefusal).toBeUndefined();
    expect((open.log.request as unknown as { kind: string }).kind).toBe("voici-call-request-anon");
    await ctx.close();
    await phoneCtx.close();
  } finally {
    await open.close();
  }
});
