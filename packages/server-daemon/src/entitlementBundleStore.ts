import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RootEntitlement, ServiceEntitlement } from "@flagship/protocol";
import type { EntitlementBundle } from "./tunnel/tunnelClient.js";

/**
 * On-disk entitlement-bundle cache.
 *
 * N12b made `DaemonRuntimeOptions.entitlements` required: the tunnel
 * client now sends IRK-signed entitlement certs (RootEntitlement +
 * optional ServiceEntitlement) on every HELLO instead of a raw
 * controlledDomains list. Production daemons load that bundle from
 * disk; the file is written at install time by whoever provisions the
 * box (the demo cloud-init bootstrap mints + writes it; a real phone
 * delivers + persists it via PhoneOrders).
 *
 * The wire form mirrors the HELLO payload: byte fields are hex-encoded
 * so the file is plain JSON. We re-decode to the in-memory
 * `EntitlementBundle` the runtime expects.
 */

export interface EntitlementBundleFile {
  rootEntitlement: {
    username: string;
    podPubKey: string;
    podCanonical: string;
    issuedAt: number;
  };
  rootEntitlementSig: string;
  serviceEntitlement?: {
    username: string;
    podPubKey: string;
    canonicals: string[];
    issuedAt: number;
    expiresAt: number;
  } | null;
  serviceEntitlementSig?: string | null;
}

/** Default on-disk path for the bundle, relative to the daemon's dataDir. */
export function defaultEntitlementBundlePath(dataDir: string): string {
  return join(dataDir, "entitlements.json");
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Parse the on-disk JSON into the in-memory bundle. Throws with a
 * specific reason on any structural defect so a malformed file surfaces
 * a clear `failed{}` to the phone rather than a generic stack.
 */
export function parseEntitlementBundle(json: unknown): EntitlementBundle {
  if (typeof json !== "object" || json === null) {
    throw new Error("entitlement bundle is not an object");
  }
  const o = json as Record<string, unknown>;
  const re = o.rootEntitlement;
  if (typeof re !== "object" || re === null) {
    throw new Error("entitlement bundle: rootEntitlement missing");
  }
  const r = re as Record<string, unknown>;
  if (typeof r.username !== "string" || !r.username) {
    throw new Error("entitlement bundle: rootEntitlement.username missing");
  }
  if (typeof r.podPubKey !== "string" || !HEX32.test(r.podPubKey)) {
    throw new Error("entitlement bundle: rootEntitlement.podPubKey must be 32-byte hex");
  }
  if (typeof r.podCanonical !== "string" || !r.podCanonical) {
    throw new Error("entitlement bundle: rootEntitlement.podCanonical missing");
  }
  if (typeof r.issuedAt !== "number") {
    throw new Error("entitlement bundle: rootEntitlement.issuedAt must be a number");
  }
  if (typeof o.rootEntitlementSig !== "string" || !HEX64.test(o.rootEntitlementSig)) {
    throw new Error("entitlement bundle: rootEntitlementSig must be 64-byte hex");
  }

  const rootEntitlement: RootEntitlement = {
    username: r.username,
    podPubKey: hexToBytes(r.podPubKey),
    podCanonical: r.podCanonical.toLowerCase(),
    issuedAt: r.issuedAt,
  };

  const bundle: EntitlementBundle = {
    rootEntitlement,
    rootEntitlementSig: hexToBytes(o.rootEntitlementSig),
  };

  const se = o.serviceEntitlement;
  if (se !== undefined && se !== null) {
    if (typeof se !== "object") {
      throw new Error("entitlement bundle: serviceEntitlement not an object");
    }
    const s = se as Record<string, unknown>;
    if (typeof s.username !== "string") {
      throw new Error("entitlement bundle: serviceEntitlement.username missing");
    }
    if (typeof s.podPubKey !== "string" || !HEX32.test(s.podPubKey)) {
      throw new Error("entitlement bundle: serviceEntitlement.podPubKey must be 32-byte hex");
    }
    if (!Array.isArray(s.canonicals) || !s.canonicals.every((c) => typeof c === "string")) {
      throw new Error("entitlement bundle: serviceEntitlement.canonicals must be a string array");
    }
    if (typeof s.issuedAt !== "number") {
      throw new Error("entitlement bundle: serviceEntitlement.issuedAt must be a number");
    }
    if (typeof s.expiresAt !== "number") {
      throw new Error("entitlement bundle: serviceEntitlement.expiresAt must be a number");
    }
    if (typeof o.serviceEntitlementSig !== "string" || !HEX64.test(o.serviceEntitlementSig)) {
      throw new Error("entitlement bundle: serviceEntitlementSig must be 64-byte hex");
    }
    const serviceEntitlement: ServiceEntitlement = {
      username: s.username,
      podPubKey: hexToBytes(s.podPubKey),
      canonicals: (s.canonicals as string[]).map((c) => c.toLowerCase()),
      issuedAt: s.issuedAt,
      expiresAt: s.expiresAt,
    };
    bundle.serviceEntitlement = serviceEntitlement;
    bundle.serviceEntitlementSig = hexToBytes(o.serviceEntitlementSig);
  }

  return bundle;
}

/** Serialize an in-memory bundle to the on-disk JSON shape. */
export function serializeEntitlementBundle(bundle: EntitlementBundle): string {
  const file: EntitlementBundleFile = {
    rootEntitlement: {
      username: bundle.rootEntitlement.username,
      podPubKey: bytesToHex(bundle.rootEntitlement.podPubKey),
      podCanonical: bundle.rootEntitlement.podCanonical,
      issuedAt: bundle.rootEntitlement.issuedAt,
    },
    rootEntitlementSig: bytesToHex(bundle.rootEntitlementSig),
    serviceEntitlement: bundle.serviceEntitlement
      ? {
          username: bundle.serviceEntitlement.username,
          podPubKey: bytesToHex(bundle.serviceEntitlement.podPubKey),
          canonicals: bundle.serviceEntitlement.canonicals,
          issuedAt: bundle.serviceEntitlement.issuedAt,
          expiresAt: bundle.serviceEntitlement.expiresAt,
        }
      : null,
    serviceEntitlementSig: bundle.serviceEntitlementSig
      ? bytesToHex(bundle.serviceEntitlementSig)
      : null,
  };
  return JSON.stringify(file, null, 2);
}

/** Atomically persist a bundle (write tmp → rename, 0600). */
export async function writeEntitlementBundle(
  path: string,
  bundle: EntitlementBundle,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serializeEntitlementBundle(bundle), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Load + parse the bundle from disk. Returns null if the file does not
 * exist (the caller decides whether that's fatal); throws on a present
 * but malformed file so the defect is loud.
 */
export async function loadEntitlementBundle(
  path: string,
): Promise<EntitlementBundle | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`entitlement bundle at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseEntitlementBundle(json);
}
