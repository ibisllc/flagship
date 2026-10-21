// One change to an app's environment variables, signed by the owner's IRK
// (@flagship/protocol serviceEnvChange.ts):
//
//   flagship/service-env-change/v1|<serverId>|<serviceId>|<op>|<name>|<valueSha256>|<issuedAt>|<nonce>
//
// The signed bytes name the one variable that changes and carry a fresh
// nonce the box spends once, so a captured order can't be replayed or pointed
// at another variable. A set signs the SHA-256 of its value, never the value.
import { tr } from "./i18n.js";

export const TAG_SERVICE_ENV_CHANGE = "flagship/service-env-change/v1";
export const SERVICE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_PREFIX = "FLAGSHIP_";

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Why a variable name can't be used, or null. */
export function envNameError(name) {
  if (!SERVICE_ENV_NAME_RE.test(name ?? "")) {
    return tr("Use letters, digits and _ only, not starting with a digit (like API_KEY).");
  }
  if (name.startsWith(RESERVED_PREFIX)) return tr("Names starting with FLAGSHIP_ are set by your server.");
  return null;
}

/** Lowercase hex SHA-256 of the value's UTF-8 bytes. */
export async function serviceEnvValueSha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

/** The canonical bytes; throws on a change no box would accept. */
export function canonicalServiceEnvChange(c) {
  if (!c.serverId || /[|\u0000-\u001f\u007f]/.test(c.serverId)) throw new Error("service-env-change: bad serverId");
  const parts = String(c.serviceId ?? "").split("--");
  if (parts.length !== 2 || !parts[0] || !parts[1] || /[|\u0000-\u001f\u007f]/.test(c.serviceId)) {
    throw new Error("service-env-change: bad serviceId");
  }
  if (c.op !== "set" && c.op !== "unset") throw new Error("service-env-change: bad op");
  if (envNameError(c.name)) throw new Error("service-env-change: bad name");
  if (c.op === "set" ? !/^[0-9a-f]{64}$/.test(c.valueSha256) : c.valueSha256 !== "") {
    throw new Error("service-env-change: valueSha256 is a SHA-256 for set and empty for unset");
  }
  if (!Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error("service-env-change: bad issuedAt");
  if (!/^[0-9a-f]{32}$/.test(c.nonce)) throw new Error("service-env-change: bad nonce");
  return new TextEncoder().encode(
    [TAG_SERVICE_ENV_CHANGE, c.serverId, c.serviceId, c.op, c.name, c.valueSha256, String(c.issuedAt), c.nonce].join("|"),
  );
}

/**
 * Build, sign and wrap one change as the request body for
 * `/api/screens/services/<serviceId>/env/<op>`: `{ change, value?, signature }`.
 * `sign(bytes)` returns the IRK signature.
 */
export async function signedEnvChangeBody({ serverId, serviceId, op, name, value }, sign, now = Date.now()) {
  const change = {
    serverId,
    serviceId,
    op,
    name,
    valueSha256: op === "set" ? await serviceEnvValueSha256(value) : "",
    issuedAt: now,
    nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
  };
  const signature = hex(await sign(canonicalServiceEnvChange(change)));
  return op === "set" ? { change, value, signature } : { change, signature };
}
