/**
 * One change to an app's environment variables, signed by the owner's IRK
 * (the same trust root as install / uninstall):
 *
 *   flagship/service-env-change/v1|<serverId>|<serviceId>|<op>|<name>|<valueSha256>|<issuedAt ms>|<nonce>
 *
 * op: "set" (valueSha256 = lowercase hex SHA-256 of the value's UTF-8) or
 * "unset" (valueSha256 empty). The signed bytes name exactly the variable that
 * changes, so a captured order can only ever repeat itself, and the box refuses
 * that too: each nonce (32 lowercase hex) is used once, and an order older than
 * the box's freshness window is refused. The value itself never enters the
 * signed bytes (it may hold any character), only its hash; the box checks the
 * value it receives against it. Values are SECRET: never logged or echoed.
 *
 * Replaces flagship/set-service-env/v1, whose unset signed an empty map and
 * left the name it removed unsigned.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import { parseServiceId } from "./serviceId.js";
import type { Bytes } from "./types.js";

export const TAG_SERVICE_ENV_CHANGE = "flagship/service-env-change/v1";
export const SERVICE_ENV_OPS = ["set", "unset"] as const;
export type ServiceEnvOp = (typeof SERVICE_ENV_OPS)[number];
/** A variable name: a shell identifier, at most 128 characters. */
export const SERVICE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the box sets itself; an owner can never set or unset them. */
export const SERVICE_ENV_RESERVED_PREFIX = "FLAGSHIP_";

export interface ServiceEnvChange {
  serverId: string;
  /** `<creator>--<slug>`. */
  serviceId: string;
  op: ServiceEnvOp;
  name: string;
  /** Lowercase hex SHA-256 of the value (set); "" (unset). */
  valueSha256: string;
  issuedAt: number;
  /** 32 lowercase hex characters, used once. */
  nonce: string;
}

/** Lowercase hex SHA-256 of a value's UTF-8 bytes. */
export function serviceEnvValueSha256(value: string): string {
  return hex(sha256(new TextEncoder().encode(value)));
}

export function serviceEnvChangeCanonicalBytes(c: ServiceEnvChange): Bytes {
  if (c.serverId.length === 0) throw new Error("service-env-change: empty serverId");
  legacyFieldGuard("serverId", c.serverId);
  if (!parseServiceId(c.serviceId)) throw new Error("service-env-change: bad serviceId");
  legacyFieldGuard("serviceId", c.serviceId);
  if (!(SERVICE_ENV_OPS as readonly string[]).includes(c.op)) throw new Error("service-env-change: bad op");
  if (!SERVICE_ENV_NAME_RE.test(c.name)) throw new Error("service-env-change: bad name");
  if (c.name.startsWith(SERVICE_ENV_RESERVED_PREFIX)) throw new Error("service-env-change: reserved FLAGSHIP_ name");
  if (c.op === "set" ? !/^[0-9a-f]{64}$/.test(c.valueSha256) : c.valueSha256 !== "") {
    throw new Error("service-env-change: valueSha256 is a SHA-256 for set and empty for unset");
  }
  if (!Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error("service-env-change: bad issuedAt");
  if (!/^[0-9a-f]{32}$/.test(c.nonce)) throw new Error("service-env-change: bad nonce");
  return new TextEncoder().encode(
    [TAG_SERVICE_ENV_CHANGE, c.serverId, c.serviceId, c.op, c.name, c.valueSha256, String(c.issuedAt), c.nonce].join("|"),
  );
}

export function signServiceEnvChange(c: ServiceEnvChange, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(serviceEnvChangeCanonicalBytes(c));
}

/** Never throws: a malformed change simply fails. */
export function verifyServiceEnvChange(c: ServiceEnvChange, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, serviceEnvChangeCanonicalBytes(c), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted change (no signature check). */
export function parseServiceEnvChange(v: unknown): ServiceEnvChange | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  for (const k of ["serverId", "serviceId", "op", "name", "valueSha256", "nonce"]) {
    if (typeof r[k] !== "string") return null;
  }
  if (typeof r.issuedAt !== "number") return null;
  const c: ServiceEnvChange = {
    serverId: r.serverId as string,
    serviceId: r.serviceId as string,
    op: r.op as ServiceEnvOp,
    name: r.name as string,
    valueSha256: r.valueSha256 as string,
    issuedAt: r.issuedAt,
    nonce: r.nonce as string,
  };
  try {
    serviceEnvChangeCanonicalBytes(c);
  } catch {
    return null;
  }
  return c;
}
