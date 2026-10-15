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
  signAuthCode,
  signInstallBlob,
  signPhoneOrder,
  type AuthCode,
  type InstallBlob,
  type Keypair,
  type PhoneOrder,
} from "@flagship/protocol";
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
  constructor(readonly username: string) {
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

/** Adds another box to a demo account via /api/gym/provision. */
export async function addBox(acct: Account, serverName: string): Promise<Box> {
  const { irk, aid, adminRoot, delegated, rck } = acct.keys;
  const serverDomain = `${serverName}.${acct.username}.${SERVICES}`;
  const issuedAt = Date.now();
  const authCode: AuthCode = {
    version: 1,
    serial: bytesToHex(randomBytes(16)),
    username: acct.username,
    serverName,
    serverDomain,
    delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 23 * 3_600_000,
    adminRootPubKey: adminRoot.publicKey,
  };
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
      installBlob: JSON.parse(installBlobJsonShortString(blob, blobSignature)),
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
  const r = await tryHttp(`https://${CONTROL}/api/users/${encodeURIComponent(username)}/pods`);
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
