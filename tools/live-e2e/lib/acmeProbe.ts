// Every gym box gets a Let's Encrypt certificate under `flagship.services`,
// which is not on the Public Suffix List: gym and prod certificates share ONE
// "new certificates per registered domain" budget (50 per 7 days, refilling
// about one every 3.4 hours). Let's Encrypt checks it when an order is
// created, so a throwaway account opening (and never finalising) an order
// for a gym name tells whether the budget has room, at no cost.
import { randomBytes } from "node:crypto";
import acme from "acme-client";

export interface AcmeBudget {
  ok: boolean;
  detail: string;
}

export async function acmeBudget(servicesApex: string): Promise<AcmeBudget> {
  const client = new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey: await acme.crypto.createPrivateKey(),
  });
  try {
    await client.createAccount({ termsOfServiceAgreed: true });
    const name = `budget-probe-${randomBytes(4).toString("hex")}.${servicesApex}`;
    const order = await client.createOrder({ identifiers: [{ type: "dns", value: name }] });
    return { ok: true, detail: `an order for ${name} was accepted (${order.status}); left unfinalised` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/rateLimited|too many certificates|rate limit/i.test(msg)) return { ok: false, detail: msg.slice(0, 400) };
    return { ok: true, detail: `probe inconclusive: ${msg.slice(0, 200)}` };
  }
}
