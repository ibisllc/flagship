// Our private relay failing breaks nothing (owner rule 2026-11-17; docs/outbound-proxy.md "Failure handling"). The
// gym's interim OHTTP relay is really taken down (its Fly machine stopped, autostart off) while an admin device of a
// fresh real account runs the webapp's payment code: an unhurried trickle spend waits (nothing leaves the device,
// nothing is spent, the next tick doesn't even try before the retry time), a spend whose plan would lapse within a
// day goes straight to `.com` marked `x-flagship-relay-fallback` (and `.com` counts it), and once the relay is back
// the next spend after the retry time goes through it again and the "went direct" note clears.
//
// The plan can't be moved near its lapse inside a run (one voucher is 3 days, and a plan keeps 72 h of grace), so
// that one tick is given the plan as it would read 12 h before the lapse; `.com` still credits from the real plan.
import { createRealAccount, type Account } from "../lib/fleet.js";
import { assert, sleep } from "../lib/harness.js";
import { Plan, planAttestation, primaryDevice, relayArrivals, setRelay, type WebDevice } from "../lib/payments.js";
import type { Group } from "./types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const ohttpFailure: Group = {
  name: "ohttp-failure",
  title: "OHTTP relay down: trickle spends wait, a spend near lapse goes direct with the marker, recovery through the relay",
  needs: [],
  phase: 4,
  parallel: false,
  async run({ rec }) {
    let acct: Account | null = null;
    let d: WebDevice | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cfg: any = null;
    const nextSpendKey = () => `flagship.vouchers.nextSpendAt.${acct!.username}`;
    const due = () => d!.kv.set(nextSpendKey(), String(Date.now() - 1000));

    const ready = await rec.check("a fresh real account: 20 test vouchers, Pro chosen, the first spend through the relay (3 days of Pro)", async () => {
      acct = await createRealAccount();
      d = primaryDevice(acct);
      cfg = await Plan.loadPaymentsConfig(d.deps());
      assert(cfg.ohttp.relays.length >= 1, "no relay configured on the gym");
      await Plan.addTestVouchers(20, d.deps());
      await Plan.saveSettings(cfg.config, { plan: "pro", autoPay: true }, d.deps());
      const t0 = Date.now();
      const did = await Plan.spendTick(d.deps({ interactive: true }));
      assert(did.planSpent === 1, `first spend ${did.planSpent}`);
      assert(d.since(t0, (r) => r.to === "relay").length >= 1 && d.since(t0, (r) => r.path === "/api/vouchers/redeem").length === 0, "the first spend didn't go through the relay");
      const a = await planAttestation(d);
      assert(a.tier === "hobby", `tier ${a.tier}`);
      return `${acct.username}: Pro until +${((a.paidUntil - Date.now()) / DAY).toFixed(2)} d`;
    });
    if (!ready || !d || !acct) return;
    const dev: WebDevice = d;

    let relayDown = false;
    try {
      await rec.check("take the relay down (Fly machine stopped, autostart off)", async () => {
        const out = await setRelay(false);
        relayDown = true;
        return out;
      });
      if (!relayDown) return;

      let paidUntil = 0;
      await rec.check("relay down: an unhurried trickle spend waits; nothing reaches `.com`, nothing is spent, the retry is ~5 min out", async () => {
        const w0 = (await Plan.loadWallet(cfg.config, dev.deps())).wallet.vouchers.length;
        paidUntil = (await planAttestation(dev)).paidUntil;
        due();
        const t0 = Date.now();
        const did = await Plan.spendTick(dev.deps());
        assert(did.waiting === true && did.planSpent === 0, `tick ${JSON.stringify({ waiting: did.waiting, planSpent: did.planSpent })}`);
        const tried = dev.since(t0, (r) => r.to === "relay");
        assert(tried.length >= 1 && tried.every((r) => r.status !== 200), `relay attempts ${tried.map((r) => r.status)}`);
        assert(dev.since(t0, (r) => r.path === "/api/vouchers/redeem" || (r.to === "com" && r.method === "POST")).length === 0, "a request went straight to .com");
        const relay = Plan.relayStateOf(dev.deps());
        const wait = relay.retryAt - Date.now();
        assert(relay.failures === 1 && wait > 4 * 60_000 && wait <= 5 * 60_000, `relay state ${JSON.stringify(relay)}`);
        assert(Plan.relayPrivacyLine(cfg.ohttp, relay).id === "waiting", "the Plan line doesn't say payments wait");
        assert((await Plan.loadWallet(cfg.config, dev.deps())).wallet.vouchers.length === w0, "the wallet changed");
        assert((await planAttestation(dev)).paidUntil === paidUntil, "the plan moved");
        return `waited; ${tried.length} relay attempt(s) (${[...new Set(tried.map((r) => r.status))].join("/")}); retry in ${(wait / 60_000).toFixed(1)} min`;
      });

      await rec.check("the next tick before the retry time doesn't even try the relay", async () => {
        due();
        const t0 = Date.now();
        const did = await Plan.spendTick(dev.deps());
        assert(did.waiting === true && did.planSpent === 0, `tick ${JSON.stringify({ waiting: did.waiting, planSpent: did.planSpent })}`);
        const sent = dev.since(t0, (r) => r.to === "relay" || r.path === "/api/vouchers/redeem");
        assert(sent.length === 0, `${sent.length} spend request(s) left the device`);
        return "no spend request left the device";
      });

      await rec.check("relay down, plan lapsing within a day: the spend goes straight to `.com`, marked, and is credited; `.com` counts the fallback", async () => {
        const arr0 = await relayArrivals();
        const grace = cfg.config.graceHours * HOUR;
        const nearLapse = { plan: "pro", paidUntil: Date.now() - grace + 12 * HOUR };
        due();
        const t0 = Date.now();
        const did = await Plan.spendTick(dev.deps({ planState: nearLapse }));
        assert(did.planSpent >= 1 && !did.waiting, `tick ${JSON.stringify({ waiting: did.waiting, planSpent: did.planSpent })}`);
        const direct = dev.since(t0, (r) => r.to === "com" && r.path === "/api/vouchers/redeem");
        assert(direct.length >= 1 && direct.every((r) => r.headers["x-flagship-relay-fallback"]), `direct sends ${JSON.stringify(direct.map((r) => r.headers))}`);
        assert(dev.since(t0, (r) => r.to === "relay").length >= 1, "it went direct without trying the relay first");
        const relay = Plan.relayStateOf(dev.deps());
        assert(relay.wentDirect === true && Plan.relayPrivacyLine(cfg.ohttp, relay).id === "waiting", `relay state ${JSON.stringify(relay)}`);
        const a = await planAttestation(dev);
        assert(a.paidUntil >= paidUntil + did.planSpent * 3 * DAY - 60_000, `credited? ${paidUntil} → ${a.paidUntil}`);
        paidUntil = a.paidUntil;
        const arr1 = await relayArrivals();
        assert(arr1.directFallback > arr0.directFallback, `direct-fallback arrivals ${arr0.directFallback} → ${arr1.directFallback}`);
        return `${did.planSpent} spent directly with the marker (${direct[0]!.headers["x-flagship-relay-fallback"]}); .com direct-fallback ${arr0.directFallback} → ${arr1.directFallback}`;
      });

      await rec.check("bring the relay back", async () => {
        const out = await setRelay(true);
        relayDown = false;
        return out;
      });

      await rec.check("recovery: after the retry time the next spend goes through the relay again and the notes clear", async () => {
        const relay0 = Plan.relayStateOf(dev.deps());
        const wait = relay0.retryAt - Date.now();
        if (wait > 0) await sleep(wait + 2000);
        const arr0 = await relayArrivals();
        due();
        const t0 = Date.now();
        const did = await Plan.spendTick(dev.deps());
        assert(did.planSpent >= 1 && !did.waiting, `tick ${JSON.stringify({ waiting: did.waiting, planSpent: did.planSpent })} (ahead ${((paidUntil - Date.now()) / DAY).toFixed(2)} d)`);
        const viaRelay = dev.since(t0, (r) => r.to === "relay" && r.status === 200);
        assert(viaRelay.length >= 1 && dev.since(t0, (r) => r.path === "/api/vouchers/redeem").length === 0, "the spend did not go through the relay");
        const relay = Plan.relayStateOf(dev.deps());
        assert(relay.failures === 0 && relay.wentDirect === false, `relay state ${JSON.stringify(relay)}`);
        assert(Plan.relayPrivacyLine(cfg.ohttp, relay).id === "interim", "the Plan line didn't return to the relay's");
        const arr1 = await relayArrivals();
        assert(arr1.ohttp > arr0.ohttp, `ohttp arrivals ${arr0.ohttp} → ${arr1.ohttp}`);
        return `waited ${(Math.max(0, wait) / 1000).toFixed(0)} s for the retry time; spent ${did.planSpent} through the relay; ohttp arrivals ${arr0.ohttp} → ${arr1.ohttp}`;
      });
    } finally {
      if (relayDown) await setRelay(true).catch(() => {});
    }
  },
};
