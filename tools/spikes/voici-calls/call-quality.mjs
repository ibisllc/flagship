// T3: call quality of option A (WebRTC over TURNS to the phone) and option B (own frames over a WebSocket),
// both through the SNI-passthrough relay and the same emulated link, audio both ways, every frame AES-256-GCM sealed.
// Usage: node call-quality.mjs [seconds] [scenario...]
import fs from "node:fs";
import * as env from "./lib/env.mjs";
import { openPage } from "./lib/browser.mjs";
import { delayStats, playout, neteq } from "./lib/analyze.mjs";

const SECONDS = +(process.argv[2] ?? 45);
const SCENARIOS = {
  good: { delayMs: 40, jitterMs: 5, loss: 0 },
  typical: { delayMs: 60, jitterMs: 10, loss: 0.01 },
  lossy: { delayMs: 60, jitterMs: 10, loss: 0.03 },
  far: { delayMs: 100, jitterMs: 15, loss: 0.01 },
  handover: { delayMs: 60, jitterMs: 10, loss: 0.01, outageEveryS: 10, outageMs: 300 },
};
const pick = process.argv.slice(3);
const names = pick.length ? pick : Object.keys(SCENARIOS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = fs.existsSync("results/call-quality.json") ? JSON.parse(fs.readFileSync("results/call-quality.json", "utf8")) : {};

async function runB(name) {
  await env.relay("127.0.0.1:7443");
  const { browser, page } = await openPage({ resolve: env.RESOLVE });
  const run = `${name}-B`;
  const r = await page.evaluate((a) => callB(a), { url: `wss://alice.calls.test/api/phone/call?run=${run}`, seconds: SECONDS });
  await browser.close();
  await sleep(500);
  const ph = JSON.parse(fs.readFileSync(`results/${run}-phone-received.json`, "utf8"));
  return {
    callerToPhone: { sent: r.sent, droppedAtSender: r.droppedAtSender, received: ph.got.length, bad: ph.bad, delay: delayStats(ph.got), playout: playout(ph.got, r.sent + r.droppedAtSender) },
    phoneToCaller: { sent: ph.sentN, droppedAtSender: ph.droppedAtSender, received: r.got.length, bad: r.bad, delay: delayStats(r.got), playout: playout(r.got, ph.sentN + ph.droppedAtSender) },
  };
}

async function runA(name) {
  await env.relay("127.0.0.1:5349");
  const caller = await openPage({ resolve: env.RESOLVE });
  const phone = await openPage({ netns: "phone" });
  const common = { policy: "relay", cbr: true, stripAudioLevel: true, encrypt: true };
  await caller.page.evaluate((o) => aSetup(o), { ...common, role: "caller", iceServers: [{ urls: "turns:alice.calls.test:443?transport=tcp", username: "spike", credential: "spike" }] });
  await phone.page.evaluate((o) => aSetup(o), { ...common, role: "phone", iceServers: [{ urls: "turn:127.0.0.1:3478?transport=tcp", username: "spike", credential: "spike" }] });
  const offer = await caller.page.evaluate(() => aOffer());
  const answer = await phone.page.evaluate((o) => aAnswer(o), offer);
  await caller.page.evaluate((a) => aAccept(a), answer);
  const conn = [await caller.page.evaluate(() => aWaitConnected()), await phone.page.evaluate(() => aWaitConnected())];
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const [cs, ps] = [await caller.page.evaluate(() => aStats()), await phone.page.evaluate(() => aStats())];
  const [cc, pc] = [await caller.page.evaluate(() => aCollect()), await phone.page.evaluate(() => aCollect())];
  const sdpHasAudioLevel = /ssrc-audio-level/.test(await caller.page.evaluate(() => aSdp()));
  const sdpCbr = /cbr=1/.test(await caller.page.evaluate(() => aSdp()));
  await caller.page.evaluate(() => aClose()); await phone.page.evaluate(() => aClose());
  await caller.browser.close(); await phone.browser.close();
  const frameSizes = (s) => ({ min: Math.min(...s.slice(25)), max: Math.max(...s.slice(25)) });
  return {
    connected: conn, ranForMs: Date.now() - t0, sdpCbr, sdpHasAudioLevel,
    callerTransport: { ...cs.transport, local: cs.local, rttMs: cs.pair?.currentRoundTripTime ? Math.round(cs.pair.currentRoundTripTime * 1000) : null },
    callerToPhone: { sent: cc.sizes.length, received: pc.got.length, bad: pc.bad, encodedFrameBytes: frameSizes(cc.sizes), delay: delayStats(pc.got), playout: playout(pc.got, cc.sizes.length), neteq: neteq(ps.inbound) },
    phoneToCaller: { sent: pc.sizes.length, received: cc.got.length, bad: cc.bad, encodedFrameBytes: frameSizes(pc.sizes), delay: delayStats(cc.got), playout: playout(cc.got, pc.sizes.length), neteq: neteq(cs.inbound) },
  };
}

try {
  for (const name of names) {
    const sc = SCENARIOS[name];
    console.log(`== ${name} ${JSON.stringify(sc)}`);
    results[name] = { link: sc, seconds: SECONDS };
    for (const [opt, fn] of [["B", runB], ["A", runA]]) {
      await env.link(sc); await env.phoneB(); await env.coturn("leaf");
      try { results[name][opt] = await fn(name); } catch (e) { results[name][opt] = { error: String(e?.stack ?? e) }; }
      const r = results[name][opt];
      console.log(opt, JSON.stringify({ c2p: r.callerToPhone?.playout, p2c: r.phoneToCaller?.playout, c2pNeteq: r.callerToPhone?.neteq?.concealedPct, err: r.error?.slice(0, 200) }));
      fs.writeFileSync("results/call-quality.json", JSON.stringify(results, null, 2));
      env.stopAll();
    }
  }
} finally { env.stopAll(); }
process.exit(0);
