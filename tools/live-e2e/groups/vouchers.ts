// Blind $1 vouchers on the gym (docs/payments-privacy-and-rails.md §5.11, §11 and "As built: OHTTP spends"), driven by
// the webapp's own payment code (lib/plan.js) as two admin devices of the real account R: the gym's free test issue,
// the sealed wallet synced between the devices (compare-and-set, a conflict merges), a spend through the private
// OHTTP relay, the plan attestation reaching R's box (its Pro gate stops refusing), a double spend refused, two
// devices spending at once without losing or double-counting a voucher, and the prepaid overage block (a Free
// account refused, the owner's cap stops the buying). The Stripe, Apple and Google rails have no keys in the gym:
// they must answer "off" cleanly.
import { randomBytes } from "node:crypto";
import { signBoxProxy, type BoxProxy } from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short } from "../lib/harness.js";
import {
  OHTTP_RELAY_URL,
  Plan,
  Vouchers,
  addAdminDevice,
  planAttestation,
  primaryDevice,
  rawTestVouchers,
  redeemDirect,
  relayArrivals,
  type WebDevice,
} from "../lib/payments.js";
import type { Group } from "./types.js";

const DAY = 86_400_000;
const GB = 1024 ** 3;
/** TEST-NET-1: never answers, so a proxy order the box takes past its Pro gate fails its own probe and changes nothing. */
const DEAD_PROXY = "192.0.2.1";

export const vouchers: Group = {
  name: "vouchers",
  title: "vouchers: rails off cleanly, test issue, wallet sync between two devices, a spend through the OHTTP relay, the plan reaching the box, double spend refused, two devices at once, overage blocks",
  needs: ["R1"],
  phase: 2,
  async run({ A, R, rec, box }) {
    const acct = R!;
    const user = acct.username;
    const b = box("R1");
    const d1 = primaryDevice(acct);
    let d2: WebDevice | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cfg: any = null;

    await rec.check("payments config: the gym's voucher key and test issue, every rail off, the gym's interim relay first", async () => {
      const r = await http(`https://${CONTROL}/api/payments/config`);
      assert(r.status === 200 && r.json, `config ${r.status}: ${short(r.text)}`);
      const j = r.json;
      assert(Array.isArray(j.keys) && j.keys.length >= 1, `no voucher key: ${short(j.keys)}`);
      assert(j.testIssue === true, "testIssue is not on in the gym");
      assert(j.rails && j.rails.stripe === false && j.rails.apple === false && j.rails.google === false, `rails: ${short(j.rails)}`);
      const relays = j.ohttp?.relays ?? [];
      assert(typeof j.ohttp?.keyConfigHex === "string" && relays.length >= 1, `ohttp: ${short(j.ohttp)}`);
      assert(relays[0].url === OHTTP_RELAY_URL && relays[0].interim === true, `first relay ${short(relays[0])}`);
      cfg = await Plan.loadPaymentsConfig(d1.deps());
      assert(cfg.keys.length >= 1 && cfg.ohttp.relays.length >= 1, "the webapp's config read dropped the key or the relay");
      return `key ${j.keys[0].keyId}; rails off; relay ${relays[0].operator}${relays[0].interim ? " (interim)" : ""}`;
    });
    if (!cfg) return;

    await rec.check("the rails without keys answer rail-off (paid-issue x3, Stripe checkout, Apple notifications); the webhook refuses without a 500 crash", async () => {
      const key = cfg.keys[0];
      const req = Vouchers.newVoucherRequest(key);
      const out: string[] = [];
      for (const [rail, proof] of [
        ["stripe", { sessionId: "cs_test_gym" }],
        ["apple", { jws: "x.y.z" }],
        ["google", { productId: "com.flagshipserver.app.vouchers.10", purchaseToken: "gym" }],
      ] as const) {
        const r = await postJson(`https://${CONTROL}/api/vouchers/paid-issue`, { v: 1, rail, proof, k: key.keyId, blinded: [req.blinded] });
        assert(r.status === 404 && r.json?.code === "rail-off", `${rail}: ${r.status} ${short(r.text)}`);
        out.push(`${rail} 404`);
      }
      const commit = Vouchers.voucherOrderCommit(key.keyId, [req.blinded]);
      const co = await postJson(`https://${CONTROL}/api/vouchers/stripe/checkout`, { v: 1, units: 10, k: key.keyId, commit });
      assert(co.status === 404 && co.json?.code === "rail-off", `checkout: ${co.status} ${short(co.text)}`);
      const ap = await postJson(`https://${CONTROL}/api/vouchers/apple/notifications`, { signedPayload: "x.y.z" });
      assert(ap.status === 404 && /rail-off/.test(ap.text), `apple notifications: ${ap.status} ${short(ap.text)}`);
      const wh = await http(`https://${CONTROL}/api/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
        body: JSON.stringify({ type: "charge.refunded", data: { object: { payment_intent: "pi_gym" } } }),
      });
      assert(wh.status === 503 || (wh.status >= 400 && wh.status < 500), `webhook: ${wh.status} ${short(wh.text)}`);
      return `${out.join(", ")}; checkout 404; apple 404; webhook ${wh.status} (${short(wh.json?.error ?? wh.text, 40)})`;
    });

    const session = await pair(acct, b);
    const s = { "x-flagship-session": session };
    const deadProxyOrder = () => {
      const p: BoxProxy = { serverDomain: b.fqdn.toLowerCase(), kind: "socks5", host: DEAD_PROXY, port: 1080, auth: false, fallbackDirect: true, issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      return { proxy: p, signature: signBoxProxy(p, acct.keys.adminRoot) };
    };
    await rec.check("before any spend R's box holds a Free plan: a proxy order is refused pro-required", async () => {
      const r = await postJson(`https://${b.fqdn}/api/screens/outbound-proxy`, deadProxyOrder(), s, 60_000);
      assert(r.status === 403 && r.json?.code === "pro-required", `${r.status}: ${short(r.text)}`);
      return "403 pro-required";
    });

    await rec.check("test issue: 30 free vouchers into device 1's wallet; `.com` holds only a padded ciphertext", async () => {
      const saved = await Plan.addTestVouchers(30, d1.deps());
      assert(saved.wallet.vouchers.length === 30 && saved.version === 1, `wallet: ${saved.wallet.vouchers.length} vouchers, version ${saved.version}`);
      const raw = await http(`https://${CONTROL}/api/accounts/${user}/voucher-wallet`, { headers: await d1.readHeaders() });
      assert(raw.status === 200, `wallet GET ${raw.status}`);
      assert(Object.keys(raw.json).sort().join(",") === "ct,nonce,version", `blob fields ${Object.keys(raw.json)}`);
      const ctLen = Buffer.from(raw.json.ct, "base64").length - 16;
      assert(ctLen % 4096 === 0 && (ctLen / 4096 & (ctLen / 4096 - 1)) === 0, `plaintext ${ctLen} bytes is not 4 KiB × 2^i`);
      assert(!raw.text.includes(saved.wallet.vouchers[0].n), "a voucher nonce is visible in the stored blob");
      const noAuth = await http(`https://${CONTROL}/api/accounts/${user}/voucher-wallet`);
      assert(noAuth.status === 401 || noAuth.status === 403, `wallet without a token: ${noAuth.status}`);
      return `30 vouchers, v1, ${ctLen} B padded plaintext; unauthenticated read ${noAuth.status}`;
    });

    await rec.check("wallet sync: device 2 (a second admin device) reads the same 30; its plan choice and device 1's late top-up both survive the conflict", async () => {
      d2 = await addAdminDevice(acct);
      const seen = await Plan.loadWallet(cfg.config, d2.deps());
      assert(seen.wallet.vouchers.length === 30 && seen.version === 1, `device 2 sees ${seen.wallet.vouchers.length} at v${seen.version}`);
      const stale = await Plan.loadWallet(cfg.config, d1.deps());
      const chose = await Plan.saveSettings(cfg.config, { plan: "pro", autoPay: true }, d2.deps());
      assert(chose.version === 2, `device 2 saved v${chose.version}`);
      const late = await Plan.addTestVouchers(5, d1.deps({ current: stale }));
      assert(late.version === 3, `device 1 saved v${late.version} (expected a merge onto v2)`);
      const both = await Promise.all([Plan.loadWallet(cfg.config, d1.deps()), Plan.loadWallet(cfg.config, d2.deps())]);
      for (const [i, w] of both.entries()) {
        assert(w.version === 3 && w.wallet.vouchers.length === 35, `device ${i + 1}: v${w.version}, ${w.wallet.vouchers.length} vouchers`);
        assert(w.wallet.settings.plan === "pro" && w.wallet.settings.autoPay === true, `device ${i + 1} settings ${short(w.wallet.settings)}`);
      }
      return "v1 → v2 (device 2: Pro, auto-pay) → 409 → merged v3: 35 vouchers, Pro, on both devices";
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let before: any[] = [];
    let paidUntil = 0;
    await rec.check("the first spend goes through the OHTTP relay: nothing reaches `.com`'s redeem route directly, the plan is Pro", async () => {
      before = (await Plan.loadWallet(cfg.config, d1.deps())).wallet.vouchers;
      const arr0 = await relayArrivals();
      const t0 = Date.now();
      const did = await Plan.spendTick(d1.deps({ interactive: true }));
      assert(did.planSpent >= 1 && !did.waiting, `spendTick: ${short({ planSpent: did.planSpent, waiting: did.waiting })}`);
      const viaRelay = d1.since(t0, (r) => r.to === "relay" && r.method === "POST");
      const direct = d1.since(t0, (r) => r.to === "com" && r.path === "/api/vouchers/redeem");
      assert(viaRelay.length >= 1 && viaRelay.every((r) => r.headers["content-type"] === "message/ohttp-req" && r.status === 200), `relay posts: ${short(viaRelay.map((r) => r.status))}`);
      assert(direct.length === 0, `${direct.length} redeem(s) went straight to .com`);
      const relay = Plan.relayStateOf(d1.deps());
      assert(relay.failures === 0 && relay.wentDirect === false, `relay state ${short(relay)}`);
      const line = Plan.relayPrivacyLine(cfg.ohttp, relay);
      assert(line.id === "interim", `privacy line ${line.id}`);
      const a = await planAttestation(d1);
      assert(a.tier === "hobby" && a.paidUntil > Date.now() + did.planSpent * 3 * DAY - 10 * 60_000, `attestation ${short(a)}`);
      paidUntil = a.paidUntil;
      const arr1 = await relayArrivals();
      const left = (await Plan.loadWallet(cfg.config, d1.deps())).wallet.vouchers.length;
      assert(left === 35 - did.planSpent, `wallet keeps ${left}`);
      return `${did.planSpent} spent via the relay (${viaRelay.length} POST); Pro until +${((paidUntil - Date.now()) / DAY).toFixed(2)} d; .com counted ohttp arrivals ${arr0.ohttp} → ${arr1.ohttp}`;
    });

    await rec.check("the plan reaches R's box: the same kind of proxy order now passes the Pro gate (it fails only its own reachability probe)", async () => {
      const r = await postJson(`https://${b.fqdn}/api/screens/outbound-proxy`, deadProxyOrder(), s, 90_000);
      assert(!(r.status === 403 && r.json?.code === "pro-required"), `still refused as Free: ${short(r.text)}`);
      assert(r.status === 422, `${r.status}: ${short(r.text)}`);
      const g = await http(`https://${b.fqdn}/api/screens/outbound-proxy`, { headers: s });
      assert(g.status === 200 && g.json?.available === true && g.json?.proxy === null, `summary ${short(g.text)}`);
      return `422 (${short(r.json?.error, 60)}); summary available, no proxy kept`;
    });

    await rec.check("double spend: a voucher already spent is refused voucher-spent; a forged one bad-voucher; the plan does not move", async () => {
      const left = new Set((await Plan.loadWallet(cfg.config, d1.deps())).wallet.vouchers.map(Vouchers.voucherNullifier));
      const spent = before.find((v) => !left.has(Vouchers.voucherNullifier(v)));
      assert(spent, "no spent voucher to replay");
      const again = await redeemDirect(user, "pro", [spent]);
      assert(again.status === 409 && again.json?.code === "voucher-spent" && again.json?.spent?.includes(Vouchers.voucherNullifier(spent)), `replay ${again.status}: ${short(again.text)}`);
      const forged = { ...before.find((v) => left.has(Vouchers.voucherNullifier(v))), n: randomBytes(32).toString("hex") };
      const bad = await redeemDirect(user, "pro", [forged]);
      assert(bad.status === 400 && bad.json?.code === "bad-voucher", `forged ${bad.status}: ${short(bad.text)}`);
      const a = await planAttestation(d1);
      assert(a.paidUntil === paidUntil, `paidUntil moved ${paidUntil} → ${a.paidUntil}`);
      return "replay 409 voucher-spent; forged 400 bad-voucher; plan unchanged";
    });

    await rec.check("two devices tick at once: every voucher that left the wallet was credited exactly once (none lost, none counted twice)", async () => {
      assert(d2, "no second device");
      const w0 = (await Plan.loadWallet(cfg.config, d1.deps())).wallet.vouchers.length;
      const p0 = (await planAttestation(d1)).paidUntil;
      const [x, y] = await Promise.all([Plan.spendTick(d1.deps()), Plan.spendTick(d2!.deps())]);
      const w1s = await Promise.all([Plan.loadWallet(cfg.config, d1.deps()), Plan.loadWallet(cfg.config, d2!.deps())]);
      assert(w1s[0].version === w1s[1].version, "the devices read different wallet versions");
      const w1 = w1s[0].wallet.vouchers.length;
      const p1 = (await planAttestation(d1)).paidUntil;
      const unit = Vouchers.planUnitMs(cfg.config, "pro");
      const credited = Math.round((p1 - p0) / unit);
      assert(x.planSpent + y.planSpent >= 1, `neither device spent (${x.planSpent}, ${y.planSpent})`);
      assert(Math.abs(p1 - p0 - credited * unit) < 5_000, `paidUntil moved by ${p1 - p0} ms, not a whole number of units`);
      assert(credited === w0 - w1, `${w0 - w1} voucher(s) left the wallet but ${credited} were credited`);
      assert(credited === x.planSpent + y.planSpent, `credited ${credited}, the devices report ${x.planSpent} + ${y.planSpent}`);
      paidUntil = p1;
      return `device 1 spent ${x.planSpent}, device 2 ${y.planSpent}; wallet ${w0} → ${w1}; plan +${credited} unit(s)`;
    });

    await rec.check("overage: a Free account is refused overage-needs-plan without spending; R buys blocks within its cap (two, then none)", async () => {
      const five = await rawTestVouchers(5);
      const free = await redeemDirect(A.username, "overage", five);
      assert(free.status === 409 && free.json?.code === "overage-needs-plan", `free overage ${free.status}: ${short(free.text)}`);
      const al0 = await Plan.loadAllowance(d1.deps());
      assert(al0 && typeof al0.remainingBytes === "number", `allowance ${short(al0)}`);
      const same = await redeemDirect(user, "overage", five);
      assert(same.status === 200 && same.json?.credited === 5 && same.json?.topUpBytes >= 100 * GB, `the refused five, now for R: ${same.status} ${short(same.text)}`);
      const low = { remainingBytes: 1 * GB };
      const spends: number[] = [];
      for (let i = 0; i < 3; i++) spends.push((await Plan.spendTick(d1.deps({ allowance: low }))).overageSpent);
      assert(spends[0] === 5 && spends[1] === 5 && spends[2] === 0, `overage spends ${spends.join(", ")} (cap 10 units)`);
      const w = (await Plan.loadWallet(cfg.config, d1.deps())).wallet;
      assert(w.overage.units === 10, `wallet records ${w.overage.units} overage units`);
      const al1 = await Plan.loadAllowance(d1.deps());
      const grew = al1.remainingBytes - al0.remainingBytes;
      assert(grew >= 299 * GB, `allowance grew ${(grew / GB).toFixed(1)} GB (3 blocks of 100 expected)`);
      return `Free 409; refused five accepted for R (+100 GB); ticks bought ${spends.join("/")} units; allowance +${(grew / GB).toFixed(0)} GB`;
    });
  },
};
