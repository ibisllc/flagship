// Provisioning for the live gym: demo accounts (one `home` box each, through
// the admin demo flow) plus extra boxes for the same account (through the
// gym-only /api/gym/provision, signed with the account's demo keys). Every
// server is an UpCloud server labelled flagship-env=gym; teardown goes through
// the Worker, never a cloud API.
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  deriveDemoAdminRoot,
  deriveDemoDelegatedKey,
  deriveDemoPrimaryDeviceKey,
  deriveDemoRckKey,
  deriveDemoUmk,
  deriveDemoUserAid,
  deriveDemoUserIrk,
  installBlobJsonShortString,
} from "@flagship/control-plane";
import {
  deriveAccountDeviceKeySeed,
  ed,
  signAuthCode,
  signAuthCodeAdmin,
  signClaimUsername,
  signDeviceCapabilityGrant,
  signInstallBlob,
  signPhoneOrder,
  type AuthCode,
  type DeviceCapabilityGrant,
  type InstallBlob,
  type Keypair,
  type PhoneOrder,
} from "@flagship/protocol";
import { accountReadHeaders } from "../readToken.js";
import { ADMIN, CONTROL, KEK, SERVICES, adminHeaders, assert, http, postJson, short, sleep, tryHttp } from "./harness.js";

export interface Box {
  account: string;
  serverName: string;
  fqdn: string;
  /** UpCloud server id when known (gym-provisioned boxes always; demo boxes once the Worker reports it). */
  serverId: string | null;
  via: "demo" | "gym-provision";
  online: boolean;
  session?: string;
}

export interface DemoKeys {
  umk: Uint8Array;
  irk: Keypair;
  aid: Keypair;
  adminRoot: Keypair;
  delegated: Keypair;
  rck: Keypair;
  primaryDevice: Keypair;
}

export class Account {
  readonly keys: DemoKeys;
  readonly boxes: Box[] = [];
  /** A demo account derives its keys from the KEK; a real one (`demo: false`) holds random keys and needs read tokens. */
  constructor(readonly username: string, keys?: DemoKeys, readonly demo = true) {
    if (keys) {
      this.keys = keys;
      return;
    }
    assert(KEK, "GYM_DEMO_IRK_KEK is required");
    const kek = hexToBytes(KEK);
    this.keys = {
      umk: deriveDemoUmk(kek, username),
      irk: deriveDemoUserIrk(kek, username),
      aid: deriveDemoUserAid(kek, username),
      adminRoot: deriveDemoAdminRoot(kek, username),
      delegated: deriveDemoDelegatedKey(kek, username),
      rck: deriveDemoRckKey(kek, username),
      primaryDevice: deriveDemoPrimaryDeviceKey(kek, username),
    };
  }
  box(serverName: string): Box {
    const b = this.boxes.find((x) => x.serverName === serverName);
    assert(b, `no box ${serverName} on ${this.username}`);
    return b;
  }
}

export function idempotencyKey(username: string): string {
  return `sample-user-create:${username}`;
}

export function freshUsername(prefix: string): string {
  return `${prefix}${Date.now().toString(36).slice(-6)}${randomBytes(1).toString("hex")}`;
}

/** Kicks off a demo account + its `home` box. Returns once the Worker accepted it. */
export async function createDemoAccount(username: string): Promise<Account> {
  assert(ADMIN, "GYM_ADMIN_SECRET is required");
  const r = await postJson(
    `https://${CONTROL}/api/dev/sample-user/create`,
    { username, accountName: `Gym ${username}`, idempotencyKey: idempotencyKey(username) },
    adminHeaders(),
    120_000,
  );
  assert(r.status === 200 || r.status === 202, `demo create ${r.status}: ${short(r.text)}`);
  const acct = new Account(username);
  acct.boxes.push({
    account: username,
    serverName: "home",
    fqdn: `home.${username}.${SERVICES}`,
    serverId: typeof r.json?.activeServerId === "string" ? r.json.activeServerId : null,
    via: "demo",
    online: false,
  });
  return acct;
}

/** Real (non-demo) accounts in this run: `.com` lists their servers only to a read-token bearer. */
const realAccounts = new Map<string, Keypair>();

function keypair(seed: Uint8Array): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

/** A real account's primary (admin) device id, registered by createRealAccount. */
export const REAL_PRIMARY_DEVICE_ID = `${"0".repeat(31)}1`;

/** Mints a device grant on `.com` for `deviceId`; `signer` is the IRK (member device) or the admin root (admin device). */
export function mintDeviceGrant(acct: Account, deviceId: string, device: Keypair, scopes: string[], signer: Keypair) {
  const issuedAt = Date.now();
  const g: DeviceCapabilityGrant = {
    grantId: randomBytes(16).toString("hex"),
    username: acct.username,
    deviceId,
    devicePubKey: device.publicKey,
    scopes: scopes as DeviceCapabilityGrant["scopes"],
    issuedAt,
    expiresAt: issuedAt + 7 * 24 * 3_600_000,
  };
  return postJson(`https://${CONTROL}/api/users/${acct.username}/device-grants`, {
    grant: { ...g, devicePubKey: bytesToHex(device.publicKey) },
    signature: bytesToHex(signDeviceCapabilityGrant(g, signer)),
  });
}

/**
 * A fresh REAL account (not `isDemo`), as an app opens one: a suggested name
 * claimed under a random IRK with an admin root pinned, and its primary device
 * registered under an admin-root-signed `admin` grant. No box yet.
 */
export async function createRealAccount(): Promise<Account> {
  const umk = new Uint8Array(randomBytes(32));
  const sug = await postJson(`https://${CONTROL}/api/username/suggest`, { deviceKey: bytesToHex(randomBytes(32)) });
  const username: string = sug.json?.name;
  assert(username, `username suggest ${sug.status}: ${short(sug.text)}`);
  const keys: DemoKeys = {
    umk,
    irk: keypair(randomBytes(32)),
    aid: keypair(randomBytes(32)),
    adminRoot: keypair(randomBytes(32)),
    delegated: keypair(randomBytes(32)),
    rck: keypair(randomBytes(32)),
    primaryDevice: keypair(deriveAccountDeviceKeySeed(umk, username, REAL_PRIMARY_DEVICE_ID)),
  };
  const issuedAt = Date.now();
  const c = await postJson(`https://${CONTROL}/api/username/claim`, {
    request: { username, irkPub: bytesToHex(keys.irk.publicKey), issuedAt },
    signature: bytesToHex(signClaimUsername({ username, irkPub: keys.irk.publicKey, issuedAt }, keys.irk)),
    adminRootPub: bytesToHex(keys.adminRoot.publicKey),
    aidPub: bytesToHex(keys.aid.publicKey),
  });
  assert(c.status === 200, `claim ${c.status}: ${short(c.text)}`);
  const acct = new Account(username, keys, false);
  const d = await mintDeviceGrant(acct, REAL_PRIMARY_DEVICE_ID, keys.primaryDevice, ["admin", "view-directory", "browse", "install-service", "vibe-code"], keys.adminRoot);
  assert(d.status === 200, `primary device grant ${d.status}: ${short(d.text)}`);
  realAccounts.set(username, keys.irk);
  return acct;
}

/** Registers a loaded real account again (`--reuse`). */
export function rememberRealAccount(acct: Account): void {
  if (!acct.demo) realAccounts.set(acct.username, acct.keys.irk);
}

/** The AuthCode on the wire (hex keys), as `/api/auth-code/issue` takes it. */
export function authCodeWire(c: AuthCode): Record<string, unknown> {
  return {
    version: c.version,
    serial: c.serial,
    username: c.username,
    serverName: c.serverName,
    serverDomain: c.serverDomain,
    delegatedPubKey: bytesToHex(c.delegatedPubKey),
    userPubKey: bytesToHex(c.userPubKey),
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    ...(c.adminRootPubKey ? { adminRootPubKey: bytesToHex(c.adminRootPubKey) } : {}),
  };
}

export function newAuthCode(acct: Account, serverName: string): AuthCode {
  const issuedAt = Date.now();
  return {
    version: 1,
    serial: bytesToHex(randomBytes(16)),
    username: acct.username,
    serverName,
    serverDomain: `${serverName}.${acct.username}.${SERVICES}`,
    delegatedPubKey: acct.keys.delegated.publicKey,
    userPubKey: acct.keys.irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 23 * 3_600_000,
    adminRootPubKey: acct.keys.adminRoot.publicKey,
  };
}

/** POST /api/auth-code/issue: the IRK signs the code; `approver` (when given) is the admin approval. */
export function issueAuthCode(c: AuthCode, irk: Keypair, approver?: Keypair) {
  return postJson(`https://${CONTROL}/api/auth-code/issue`, {
    code: authCodeWire(c),
    signature: bytesToHex(signAuthCode(c, irk)),
    ...(approver ? { adminSignature: bytesToHex(signAuthCodeAdmin(c, approver)) } : {}),
  });
}

export interface AddBoxOptions {
  /** Extra fields written verbatim into the box's install-blob.json (e.g. an embedded `pairingOrder`). */
  blobExtras?: Record<string, unknown>;
}

/**
 * Adds another box to an account via /api/gym/provision. A real account's
 * AuthCode first goes through `/api/auth-code/issue` with the admin root's
 * approval (adding a server is admin-only), as an app does.
 */
export async function addBox(acct: Account, serverName: string, opts: AddBoxOptions = {}): Promise<Box> {
  const { irk, aid, adminRoot, delegated, rck } = acct.keys;
  const serverDomain = `${serverName}.${acct.username}.${SERVICES}`;
  const authCode = newAuthCode(acct, serverName);
  if (!acct.demo) {
    const i = await issueAuthCode(authCode, irk, adminRoot);
    assert(i.status === 200, `auth-code issue ${i.status}: ${short(i.text)}`);
  }
  const blob: InstallBlob = {
    version: 2,
    serverDomain,
    username: acct.username,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: `https://${CONTROL}/api/server/register`,
    authCode,
    authCodeUserSignature: signAuthCode(authCode, irk),
    installerGitRef: process.env.GYM_INSTALLER_GIT_REF || "main",
    rckPubKey: rck.publicKey,
  };
  const blobSignature = signInstallBlob(blob, irk);
  const r = await postJson(
    `https://${CONTROL}/api/gym/provision`,
    {
      installBlob: { ...JSON.parse(installBlobJsonShortString(blob, blobSignature)), ...(opts.blobExtras ?? {}) },
      blobSignature: bytesToHex(blobSignature),
      irkPrivHex: bytesToHex(irk.privateKey),
      adminRootPrivHex: bytesToHex(adminRoot.privateKey),
      ownerAidPubHex: bytesToHex(aid.publicKey),
    },
    adminHeaders(),
    120_000,
  );
  assert(r.status === 200, `gym provision ${r.status}: ${short(r.text, 300)}`);
  const box: Box = { account: acct.username, serverName, fqdn: serverDomain, serverId: r.json.serverId, via: "gym-provision", online: false };
  acct.boxes.push(box);
  return box;
}

export async function pods(username: string): Promise<any[]> {
  const irk = realAccounts.get(username);
  const headers = irk ? await accountReadHeaders(CONTROL, username, irk).catch((): Record<string, string> => ({})) : {};
  const r = await tryHttp(`https://${CONTROL}/api/users/${encodeURIComponent(username)}/pods`, { headers });
  return Array.isArray(r.json?.pods) ? r.json.pods : [];
}

/** Polls until the box is in /pods and serves HTTPS 200 (≤ minutes). */
export async function waitOnline(box: Box, minutes = 20, log?: (s: string) => void): Promise<string> {
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  let lastLogged = 0;
  while (Date.now() < deadline) {
    const p = (await pods(box.account)).find((x) => x.serverDomain === box.fqdn);
    const serve = await tryHttp(`https://${box.fqdn}/`, {}, 12_000);
    last = `registered=${p ? "y" : "n"} cert=${p?.currentCert ? "y" : "n"} http=${serve.status}`;
    if (p && serve.status === 200) {
      box.online = true;
      return last;
    }
    if (log && Date.now() - lastLogged > 120_000) {
      log(`${box.fqdn}: ${last}`);
      lastLogged = Date.now();
    }
    await sleep(20_000);
  }
  throw new Error(`${box.fqdn} not online+serving in ${minutes} min (last: ${last})`);
}

/** The demo box's UpCloud id, once the Worker has recorded it. */
export async function demoServerId(username: string): Promise<string | null> {
  const r = await tryHttp(`https://${CONTROL}/api/dev/sample-user/${encodeURIComponent(username)}`, { headers: adminHeaders() });
  return typeof r.json?.activeServerId === "string" ? r.json.activeServerId : null;
}

/** Mints a paired session on the box (add-paired-session, demo delegated key). */
export async function pair(acct: Account, box: Box): Promise<string> {
  if (box.session) return box.session;
  const token = bytesToHex(randomBytes(24));
  const order: PhoneOrder = { type: "add-paired-session", serverId: box.fqdn, token, issuedAt: Date.now() };
  const sig = bytesToHex(signPhoneOrder(order, acct.keys.delegated));
  const r = await postJson(`https://${box.fqdn}/api/orders-from-user`, { request: order, signature: sig });
  assert(r.status === 200 || r.status === 204, `add-paired-session ${r.status}: ${short(r.text)}`);
  box.session = token;
  return token;
}

export interface TeardownReport {
  demoCleanup: Record<string, string>;
  teardown: unknown;
}

/** Removes every account's demo row (and its server), then every gym-provisioned server + DNS. */
export async function teardown(accounts: Account[]): Promise<TeardownReport> {
  const demoCleanup: Record<string, string> = {};
  const serverIds: string[] = [];
  const serverDomains: string[] = [];
  for (const acct of accounts) {
    for (const b of acct.boxes) {
      if (b.via === "gym-provision") {
        if (b.serverId) serverIds.push(b.serverId);
        serverDomains.push(b.fqdn);
      } else if (!b.serverId) {
        b.serverId = await demoServerId(acct.username).catch(() => null);
      }
    }
    if (!acct.demo) continue;
    const r = await tryHttp(`https://${CONTROL}/api/dev/sample-user/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ username: acct.username, idempotencyKey: idempotencyKey(acct.username), force: true }),
    }, 180_000);
    demoCleanup[acct.username] = `${r.status} ${short(r.json ?? r.text, 200)}`;
    const demoBox = acct.boxes.find((b) => b.via === "demo");
    if (r.status !== 200 && demoBox?.serverId) serverIds.push(demoBox.serverId);
  }
  let teardownBody: unknown = null;
  if (accounts.length) {
    const t = await tryHttp(`https://${CONTROL}/api/gym/teardown`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ serverIds, serverDomains, usernames: accounts.map((a) => a.username) }),
    }, 300_000);
    teardownBody = { status: t.status, body: t.json ?? short(t.text) };
  }
  return { demoCleanup, teardown: teardownBody };
}

/** Lists (dryRun) or destroys every gym-labelled server still on the provider. */
export async function sweep(destroy: boolean): Promise<{ status: number; body: any }> {
  const r = await http(`https://${CONTROL}/api/gym/teardown`, {
    method: "POST",
    headers: { "content-type": "application/json", ...adminHeaders() },
    body: JSON.stringify(destroy ? { all: true } : { all: true, dryRun: true }),
  }, 300_000);
  return { status: r.status, body: r.json ?? r.text };
}
