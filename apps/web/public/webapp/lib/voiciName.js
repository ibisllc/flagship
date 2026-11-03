// Custom voi.ci names for services (docs/named-links.md).
//
// A service keeps its random code; an admin may give it one readable name on
// top. The name rules live in nameRules.js (the one format usernames share,
// docs/voici-namespace-spec.md); `.com` stays the authority on what is taken
// or held for a .com owner.
// Setting or clearing a name is a sensitive order: signed with the admin root
// when this device holds it, else the account key.

import { controlApex } from "./apex.js";
import { accountReadFetch } from "./accountRead.js";
import { getSession } from "./state.js";
import { sensitiveSigner } from "./adminRoot.js";

const TAG = "flagship/voici-name/v1";
const enc = (s) => new TextEncoder().encode(s);

export { VOICI_NAME_MIN, VOICI_NAME_MAX, voiciNameProblem, voiciNameKey } from "./nameRules.js";

/** @param {{user:string,serviceId:string,name:string,op:"set"|"clear",issuedAt:number,nonce:string}} o */
export function canonicalVoiciNameBytes(o) {
  return enc([TAG, o.user, o.serviceId, o.name, o.op, o.issuedAt, o.nonce].join("|"));
}

function toHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A refusal from `.com`: `code` says why (taken, reserved, dibs, change-limit, name-limit, ...), the rest is its data. */
export class VoiciNameError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code ?? null;
    this.data = body ?? {};
  }
}

/** Build and sign one order. `name` is "" for a clear. */
export async function buildVoiciNameOrder({ username, serviceId, name, op }, deps = {}) {
  const session = deps.session ?? getSession();
  const umk = deps.umk ?? session?.umk;
  if (!umk) throw new Error("unlock the webapp first");
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const order = {
    user: String(username).toLowerCase(),
    serviceId,
    name: op === "clear" ? "" : String(name).toLowerCase(),
    op,
    issuedAt: (deps.now ?? Date.now)(),
    nonce: deps.nonceHex ?? toHex(nonce),
  };
  const sign = deps.sign ?? sensitiveSigner();
  const sig = await sign(umk, canonicalVoiciNameBytes(order));
  return { order, signature: toHex(sig) };
}

async function asBody(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

/** `GET .../voici-name-check` → `{status, ...}` (available, current, invalid, reserved, taken, dibs, dibs-unchecked). */
export async function checkVoiciName({ username, serviceId, name }, deps = {}) {
  const origin = deps.origin ?? controlApex();
  const q = new URLSearchParams({ name: String(name).toLowerCase() });
  if (serviceId) q.set("service", serviceId);
  const read = deps.accountReadFetch ?? accountReadFetch;
  const r = await read(`${origin}/api/users/${encodeURIComponent(username)}/voici-name-check?${q}`, { cache: "no-store" });
  const body = await asBody(r);
  if (!r.ok) throw new VoiciNameError(r.status, body);
  return body;
}

/** `GET .../voici-names` → `[{serviceId, name, setAt}]`, the account's live names. */
export async function listVoiciNames(username, deps = {}) {
  const origin = deps.origin ?? controlApex();
  const read = deps.accountReadFetch ?? accountReadFetch;
  const r = await read(`${origin}/api/users/${encodeURIComponent(username)}/voici-names`, { cache: "no-store" });
  const body = await asBody(r);
  if (!r.ok) throw new VoiciNameError(r.status, body);
  return body.names ?? [];
}

/** Set (`name` given) or clear (`name` ""): resolves to the service's new link state, or throws a {@link VoiciNameError}. */
export async function saveVoiciName({ username, serviceId, name }, deps = {}) {
  const origin = deps.origin ?? controlApex();
  const op = name ? "set" : "clear";
  const signed = await buildVoiciNameOrder({ username, serviceId, name: name ?? "", op }, deps);
  const f = deps.fetch ?? fetch;
  const r = await f(`${origin}/api/users/${encodeURIComponent(username)}/apps/${encodeURIComponent(serviceId)}/voici-name`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  const body = await asBody(r);
  if (!r.ok) throw new VoiciNameError(r.status, body);
  return body.link;
}
