/**
 * The /boot files a box with a boot key (packages/protocol/src/bootKey.ts)
 * keeps for its initramfs premount, and the daemon's two jobs on them:
 *
 * - the owner key a lease must be signed by (`flagship-owner-key.pub`): the
 *   premount reads the live partition's copy first, so the daemon rewrites it
 *   whenever the account key (IRK) changes, and auto-unlock keeps working
 *   after a re-pair;
 * - the binding: when the STK changes, the new STK must vouch for the same
 *   boot key again, or the boot worker stops accepting it.
 *
 * Nothing here ever writes the STK to /boot.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { bootKeyBindingToWire, signBootKeyBinding, signBootKeyBindingV2, verifiedBootKey, type HybridMsgSigner, type MsgSigner } from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";

export const BOOT_KEY_PUB_PATH = "/boot/flagship-boot-key.pub";
export const OWNER_KEY_PATH = "/boot/flagship-owner-key.pub";

const HEX32 = /^[0-9a-f]{64}$/;

export interface BootKeyFileDeps {
  bootKeyPubPath?: string;
  ownerKeyPath?: string;
  exists?: (p: string) => boolean;
  read?: (p: string) => Promise<string>;
  write?: (p: string, data: string) => Promise<void>;
}

/** True when this box unlocks with a boot key (the new premount). */
export function hasBootKey(deps: BootKeyFileDeps = {}): boolean {
  return (deps.exists ?? existsSync)(deps.bootKeyPubPath ?? BOOT_KEY_PUB_PATH);
}

/** Keep the owner key file equal to `irkPubHex`. Returns true when it changed. */
export async function syncOwnerKeyFile(irkPubHex: string, deps: BootKeyFileDeps = {}): Promise<boolean> {
  const want = irkPubHex.toLowerCase();
  if (!HEX32.test(want) || !hasBootKey(deps)) return false;
  const path = deps.ownerKeyPath ?? OWNER_KEY_PATH;
  const read = deps.read ?? ((p: string) => readFile(p, "utf8"));
  const cur = await read(path).then((s) => s.trim().toLowerCase(), () => "");
  if (cur === want) return false;
  await (deps.write ?? ((p: string, d: string) => writeFileDurable(p, d, 0o644)))(path, `${want}\n`);
  return true;
}

/** The boot key pub of this box, or null without one. */
export async function readBootKeyPub(deps: BootKeyFileDeps = {}): Promise<string | null> {
  if (!hasBootKey(deps)) return null;
  const read = deps.read ?? ((p: string) => readFile(p, "utf8"));
  const pub = (await read(deps.bootKeyPubPath ?? BOOT_KEY_PUB_PATH).catch(() => "")).trim().toLowerCase();
  return HEX32.test(pub) ? pub : null;
}

/** Sign the binding for this box's boot key with `stk` and hand it to `.com`. */
export async function rebindBootKey(args: {
  serverDomain: string;
  stk: MsgSigner;
  /** The STK's hybrid key (keyd `sign.hybrid`); adds the v2 hybrid signature. Use only once
   *  `.com` holds the STK's key binding, or `.com` refuses the hybrid signature. */
  stkHybrid?: HybridMsgSigner;
  controlPlaneBaseUrl: string;
  now?: () => number;
  fetch?: typeof fetch;
  files?: BootKeyFileDeps;
}): Promise<"bound" | "no-boot-key"> {
  const bootPubHex = await readBootKeyPub(args.files);
  if (!bootPubHex) return "no-boot-key";
  const binding = { serverDomain: args.serverDomain.toLowerCase(), bootPubHex, issuedAt: (args.now ?? Date.now)() };
  const body = bootKeyBindingToWire(
    binding,
    signBootKeyBinding(binding, args.stk),
    args.stkHybrid ? signBootKeyBindingV2(binding, args.stkHybrid) : undefined,
  );
  const base = args.controlPlaneBaseUrl.replace(/\/+$/, "");
  const res = await (args.fetch ?? fetch)(`${base}/api/server/${encodeURIComponent(binding.serverDomain)}/boot-key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`boot key binding refused: HTTP ${res.status}`);
  return "bound";
}

/**
 * Make sure `.com` holds a binding for this box's boot key that the current STK
 * signed (after an STK change, or an install whose upload was lost). Without it
 * the boot worker refuses the boot key and the box cannot unlock on its own.
 */
export async function ensureBootKeyBinding(args: {
  serverDomain: string;
  stkPub: Uint8Array;
  signer: MsgSigner;
  stkHybrid?: HybridMsgSigner;
  controlPlaneBaseUrl: string;
  fetch?: typeof fetch;
  files?: BootKeyFileDeps;
}): Promise<"ok" | "bound" | "no-boot-key"> {
  const bootPubHex = await readBootKeyPub(args.files);
  if (!bootPubHex) return "no-boot-key";
  const f = args.fetch ?? fetch;
  const base = args.controlPlaneBaseUrl.replace(/\/+$/, "");
  const domain = args.serverDomain.toLowerCase();
  const res = await f(`${base}/api/server/${encodeURIComponent(domain)}/boot-key`, { headers: { accept: "application/json" } });
  if (res.ok) {
    const stkHex = Buffer.from(args.stkPub).toString("hex");
    const wire: unknown = await res.json().catch(() => null);
    const hasHybrid = typeof (wire as { hybridSignature?: unknown } | null)?.hybridSignature === "string";
    if (verifiedBootKey(wire, { serverDomain: domain, stkPubHex: stkHex }) === bootPubHex && (hasHybrid || !args.stkHybrid)) return "ok";
  } else if (res.status !== 404) {
    throw new Error(`boot key binding check failed: HTTP ${res.status}`);
  }
  await rebindBootKey({
    serverDomain: domain,
    stk: args.signer,
    ...(args.stkHybrid ? { stkHybrid: args.stkHybrid } : {}),
    controlPlaneBaseUrl: base,
    fetch: f,
    ...(args.files ? { files: args.files } : {}),
  });
  return "bound";
}
