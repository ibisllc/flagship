import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalOrgConnector,
  canonicalOrgProposalDecision,
  canonicalOrgSeatInvite,
  hybridSigKeygen,
  openOrgProposal,
  orgConnectorKeyId,
  orgConnectorMappingSha256,
  orgKemKeyPair,
  orgSeatRolesHash,
  orgSha256Hex,
  parseOrgDirectoryEntryBody,
  sealOrgConnectorSetup,
  signOrgApproval,
  signOrgSeatKem,
  verifyOrgProposal,
  type OrgConnector,
  type OrgConnectorMapping,
  deriveOrgInviteKeys,
  orgInviteAcceptSignature,
} from "@flagship/protocol";
import { verifyOrgPin, type OrgPinFile } from "../src/orgAuthorityPin.js";
import { ConnectorRuntime } from "../src/directory/connector.js";
import { diffDirectory, emptyDirectoryState, rolesFor } from "../src/directory/engine.js";
import { createScimHandler, emptyScimData, parseScimFilter, scimSnapshot, type ScimData } from "../src/directory/scim.js";
import { collectSnapshot, StaticDirectorySource, type DirectoryUser } from "../src/directory/source.js";
import { LDAP_DEFAULTS, LdapDirectorySource, ldapConfigFrom } from "../src/directory/ldap.js";
import { fakeLdapServer } from "./support-fakeLdap.js";

// The invite key a fixed link key derives (test-vectors/org-invite-key).
const IK = deriveOrgInviteKeys(new Uint8Array(32).fill(0x33));
const fixtures = resolve(import.meta.dirname, "fixtures/scim");
const TOKEN = "scim-token-0123456789abcdef0123456789";
const TOKEN_SHA = createHash("sha256").update(TOKEN).digest("hex");
const HOST = "home.acme.flagship.services";

function scimWorld(tokenSha: string | null = TOKEN_SHA) {
  let data: ScimData = emptyScimData();
  const audit: Array<{ method: string; resource: string; status: number }> = [];
  let n = 0;
  const handle = createScimHandler({
    tokenSha256: () => tokenSha,
    load: () => data,
    save: async (d) => void (data = structuredClone(d)),
    audit: (l) => audit.push(l),
    newId: () => `id${String(++n).padStart(30, "0")}`,
    now: () => 1_790_000_000_000,
  });
  const call = (method: string, path: string, body?: unknown, token = TOKEN) =>
    handle({ method, path, headers: { host: HOST, authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
  return { call, data: () => data, audit };
}

/** Replays a recorded provider session, substituting the ids the server answered with. */
async function replay(file: string) {
  const fx = JSON.parse(readFileSync(join(fixtures, file), "utf8")) as { steps: Array<{ method: string; path: string; body?: unknown; status: number; save?: string; expect?: Record<string, unknown> }> };
  const w = scimWorld();
  const ids = new Map<string, string>();
  const sub = (s: string) => s.replace(/\{\{(?:user|group):([a-z]+)\}\}/g, (_, k) => ids.get(k) ?? "missing");
  for (const s of fx.steps) {
    const body = s.body === undefined ? undefined : JSON.parse(sub(JSON.stringify(s.body)));
    const r = (await w.call(s.method, sub(s.path), body))!;
    expect({ step: `${s.method} ${s.path}`, status: r.status }).toEqual({ step: `${s.method} ${s.path}`, status: s.status });
    if (r.status !== 204) expect(r.headers?.["content-type"]).toBe("application/scim+json");
    const json = r.body ? JSON.parse(String(r.body)) : null;
    if (s.save) ids.set(s.save, json.id);
    for (const [k, v] of Object.entries(s.expect ?? {})) expect(json[k]).toEqual(v);
  }
  return w;
}

const mapping: OrgConnectorMapping = {
  attributes: { email: "userName", displayName: "displayName", externalId: "externalId" },
  groups: { Finance: [{ role: "member" }], "Engineering EU": [{ role: "member" }, { role: "server-admin", servers: [HOST] }] },
};

describe("SCIM 2.0 on an org box", () => {
  it("replays Microsoft Entra ID's provisioning requests", async () => {
    const w = await replay("entra.json");
    const people = scimSnapshot(w.data());
    expect(people).toEqual([
      { externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef", userName: "ana.perez@acme.example", displayName: "Ana P. Pérez", active: false, groups: ["Finance"] },
      { externalId: "5c1f3d6e-0b1a-4c4d-9a8b-77c1d2e3f4a5", userName: "ben@acme.example", displayName: "Ben Okafor", active: true, groups: [] },
    ]);
    expect(Object.values(w.data().users)[0]!.emails).toEqual([{ value: "ana@acme.example", type: "work", primary: true }]);
    // Every request is audited by method, resource and status, never by name.
    expect(w.audit.length).toBeGreaterThan(10);
    expect(JSON.stringify(w.audit)).not.toMatch(/ana|Ben|acme/i);
  });

  it("replays Okta's provisioning requests", async () => {
    const w = await replay("okta.json");
    expect(Object.keys(w.data().users)).toHaveLength(0);
    expect(Object.values(w.data().groups).map((g) => [g.displayName, g.members])).toEqual([["Engineering EU", []]]);
  });

  it("PATCH applies all of its operations or none; PUT and PATCH keep userName unique (05c F7)", async () => {
    const w = scimWorld();
    const a = JSON.parse(String((await w.call("POST", "/scim/v2/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "a@acme.example" }))!.body));
    await w.call("POST", "/scim/v2/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "b@acme.example" });
    const patch = (ops: unknown[]) => w.call("PATCH", `/scim/v2/Users/${a.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: ops });
    expect((await patch([{ op: "replace", path: "displayName", value: "Changed" }, { op: "replace", path: "nonsense", value: 1 }]))!.status).toBe(400);
    expect((await patch([{ op: "replace", path: "active", value: "False" }]))!.status).toBe(200);
    expect(w.data().users[a.id]!.displayName).toBeUndefined();
    expect((await patch([{ op: "replace", path: "userName", value: "B@acme.example" }]))!.status).toBe(409);
    expect((await w.call("PUT", `/scim/v2/Users/${a.id}`, { userName: "b@acme.example" }))!.status).toBe(409);
    expect((await w.call("PUT", `/scim/v2/Users/${a.id}`, { userName: "a@acme.example", displayName: "Same name, own record" }))!.status).toBe(200);
    expect(w.data().users[a.id]!.userName).toBe("a@acme.example");
    // A file that already holds a duplicate (older code allowed it) still takes a PATCH that leaves the name alone.
    const b = Object.values(w.data().users).find((u) => u.userName === "b@acme.example")!;
    w.data().users[b.id]!.userName = "A@acme.example";
    expect((await patch([{ op: "replace", path: "active", value: "False" }]))!.status).toBe(200);
  });

  it("the audit line names a known resource kind or other (05c F9)", async () => {
    const w = scimWorld();
    await w.call("GET", "/scim/v2/ana@acme.example");
    await w.call("GET", "/scim/v2/Users");
    expect(w.audit.map((l) => l.resource)).toEqual(["other", "Users"]);
  });

  it("refuses a missing or wrong token, other filters, and too many requests", async () => {
    const w = scimWorld();
    expect((await w.call("GET", "/scim/v2/Users", undefined, "wrong-token-0123456789"))!.status).toBe(401);
    expect((await scimWorld(null).call("GET", "/scim/v2/Users"))!.status).toBe(401);
    expect((await w.call("GET", "/scim/v2/Users?filter=emails+co+%22x%22"))!.status).toBe(400);
    expect(await w.call("GET", "/api/health")).toBeNull();
    expect(parseScimFilter('userName eq "a\\"b"', ["userName"])).toEqual({ attr: "userName", value: 'a"b' });
    expect(parseScimFilter('displayName sw "a"', ["displayName"])).toBeNull();
    const limited = createScimHandler({ tokenSha256: () => TOKEN_SHA, load: emptyScimData, save: async () => {}, ratePerMinute: 2, now: () => 1 });
    const req = { method: "GET", path: "/scim/v2/Users", headers: { authorization: `Bearer ${TOKEN}` }, body: Buffer.alloc(0) };
    await limited(req);
    await limited(req);
    expect((await limited(req))!.status).toBe(429);
  });
});

describe("the directory engine", () => {
  const ana: DirectoryUser = { externalId: "ext-ana", userName: "ana@acme.example", displayName: "Ana Pérez", active: true, groups: ["Finance"] };
  const ben: DirectoryUser = { externalId: "ext-ben", userName: "ben@acme.example", displayName: "Ben", active: true, groups: [] };
  const ids = () => {
    let n = 0;
    return () => (++n).toString(16).padStart(32, "a");
  };

  it("proposes an invitation for a person in a mapped group once, and none for an unmapped person", () => {
    const one = diffDirectory(emptyDirectoryState(), [ana, ben], mapping, "scim", 1, ids());
    expect(one.intents.map((i) => [i.kind, i.externalId])).toEqual([["invite", "ext-ana"]]);
    expect(one.intents[0]!.rolesHash).toBe(orgSeatRolesHash([{ role: "member" }]));
    expect(one.intents[0]!.entry).toMatchObject({ pendingId: one.state.links["ext-ana"]!.pendingId, pseudonym: "Ana Pérez", email: "ana@acme.example", groups: ["Finance"] });
    expect(diffDirectory(one.state, [ana, ben], mapping, "scim", 2, ids()).intents).toEqual([]);
  });

  it("once linked to a seat: a role change, a rename, then offboarding when disabled or gone", () => {
    const seat = "5e".repeat(16);
    const s0 = diffDirectory(emptyDirectoryState(), [ana], mapping, "ldap", 1, ids()).state;
    const linked = { ...s0, links: { "ext-ana": { ...s0.links["ext-ana"]!, seatId: seat } } };
    const moved = { ...ana, groups: ["Engineering EU"], displayName: "Ana P." };
    const r1 = diffDirectory(linked, [moved], mapping, "ldap", 2, ids());
    expect(r1.intents.map((i) => [i.kind, i.subject])).toEqual([["role-change", seat], ["entry-update", seat]]);
    expect(r1.intents[0]!.roles).toEqual(rolesFor(moved, mapping));
    expect(diffDirectory(r1.state, [{ ...moved, active: false }], mapping, "ldap", 3, ids()).intents.map((i) => i.kind)).toEqual(["offboard"]);
    expect(diffDirectory(r1.state, [], mapping, "ldap", 3, ids()).intents.map((i) => [i.kind, i.subject])).toEqual([["offboard", seat]]);
  });

  it("an externalId of __proto__ or constructor is an ordinary key (05c F8)", () => {
    const odd = ["__proto__", "constructor", "prototype"].map((externalId) => ({ ...ana, externalId, userName: `${externalId}@acme.example` }));
    const one = diffDirectory(emptyDirectoryState(), odd, mapping, "scim", 1, ids());
    expect(one.intents.map((i) => [i.kind, i.externalId])).toEqual(odd.map((u) => ["invite", u.externalId]));
    expect(({} as Record<string, unknown>).pendingId).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(one.state));
    expect(diffDirectory(saved, odd, mapping, "scim", 2, ids()).intents).toEqual([]);
  });

  it("cleans what a directory sends before it becomes an entry (control characters, NFC, length)", () => {
    const odd = { ...ana, displayName: "A\u0000na\né" + "x".repeat(300) };
    const e = diffDirectory(emptyDirectoryState(), [odd], mapping, "scim", 1, ids()).intents[0]!.entry;
    expect(e.pseudonym.includes("\u0000")).toBe(false);
    expect(e.pseudonym.normalize("NFC")).toBe(e.pseudonym);
    expect(new TextEncoder().encode(e.pseudonym).length).toBeLessThanOrEqual(128);
  });

  it("the sample source reads a JSON file and refuses duplicates", async () => {
    const d = mkdtempSync(join(tmpdir(), "dir-src-"));
    writeFileSync(join(d, "people.json"), JSON.stringify([ana, ben]));
    expect(await collectSnapshot(new StaticDirectorySource("c1".repeat(16), join(d, "people.json")))).toHaveLength(2);
    writeFileSync(join(d, "dup.json"), JSON.stringify([ana, ana]));
    await expect(collectSnapshot(new StaticDirectorySource("c1".repeat(16), join(d, "dup.json")))).rejects.toThrow(/twice/);
  });
});

// ── the connector runtime against a fake `.com` ───────────────────────────
const dir = resolve(import.meta.dirname, "../../protocol/test-vectors");
const A = JSON.parse(readFileSync(resolve(dir, "org-authority/vectors.json"), "utf8"));
const R = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(R);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, R(x)]));
};
const chain = R(A.chains[0]);
const NOW = chain.entries[1].record.issuedAt + 4 * 3_600_000;
const key = (name: string) => {
  const k = A.keys[name];
  return { seatId: k.seatId as string, keyId: k.keyId as string, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};

function pinned() {
  const file: OrgPinFile = {
    v: 1,
    orgId: A.orgId,
    genesisHash: A.genesisHash,
    entries: chain.entries.slice(0, 2),
    freezes: [],
    overturns: [],
    vetoes: [],
    grants: R(A.seatBooks[0]).grants,
    revokes: [],
    rotationsPending: [],
    syncedAt: NOW,
  };
  return verifyOrgPin(file, { orgId: A.orgId, genesisHash: A.genesisHash }, NOW);
}

describe("the connector runtime", () => {
  it("opens its sealed setup, proposes sealed to the org admins, and links a seat once an admin carried out the invite", async () => {
    const pin = pinned();
    const B = key("B admin");
    const boxSeed = new Uint8Array(32).fill(0x35);
    const boxKem = orgKemKeyPair(boxSeed);
    const seeds = [new Uint8Array(32).fill(0x61), new Uint8Array(32).fill(0x62)] as const;
    const conn = hybridSigKeygen(seeds[0], seeds[1]);
    const connector: OrgConnector = {
      orgId: A.orgId,
      connectorId: "c1".repeat(16),
      kind: "scim",
      serverDomain: HOST,
      connectorKeyId: orgConnectorKeyId(conn.publicKey),
      scopes: ["propose-invite", "propose-offboard", "update-entry"],
      mappingSha256: orgConnectorMappingSha256(mapping),
      status: "active",
      issuedAt: NOW,
    };
    const setup = sealOrgConnectorSetup(connector, { recipient: `box:${HOST}`, kemPub: boxKem.kemPub, kemKeyId: boxKem.kemKeyId, issuedAt: NOW }, {
      connectorSeedsHex: Buffer.concat([seeds[0], seeds[1]]).toString("hex"),
      mapping,
      scimTokenSha256: TOKEN_SHA,
      scimTokenIssuedAt: NOW,
    }, NOW);
    // Approved "yesterday": the box checks a stored record as of the record it names.
    const approval = signOrgApproval({ orgId: A.orgId, oarVersion: 1, order: canonicalOrgConnector(connector), seatId: B.seatId, adminKeyId: B.keyId, issuedAt: NOW, notAfter: NOW + 86_400_000 }, B.secret);
    const bundle = { connector, connectorPubHex: Buffer.from(conn.publicKey).toString("hex"), approvals: [approval], setup };
    // B announces its seat KEM key (signed with its admin key, as an org admin does).
    const bKem = orgKemKeyPair(new Uint8Array(32).fill(0x72));
    const st = { orgId: A.orgId, seatId: B.seatId, kemKeyId: bKem.kemKeyId, issuedAt: NOW };
    const seatKems = [{ statement: st, kemPubHex: Buffer.from(bKem.kemPub).toString("hex"), signature: signOrgSeatKem(st, B.secret) }];
    const posted: any[] = [];
    let proposals: any[] = [];
    let invites: any[] = [];
    let accepts: any[] = [];
    let planLive = false;
    const notes: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace(`/api/orgs/${A.orgId}`, "");
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (init?.method === "POST" && path === "/proposals") {
        posted.push(JSON.parse(String(init.body)));
        return ok({});
      }
      if (path === "/connectors") return ok({ connectors: [bundle] });
      if (path === "/servers") return ok({ servers: [{ serverDomain: HOST }] });
      if (path === "/keys") return ok({ seatKems, boxKems: [], rings: [] });
      if (path === "/proposals") return ok({ proposals });
      if (path === "/seats") return ok({ invites, accepts });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const rt = new ConnectorRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "connector-")),
      orgId: A.orgId,
      serverDomain: HOST,
      controlPlaneBaseUrl: "https://flagshipserver.example",
      pin: () => pin,
      boxKemSeed: async () => boxSeed,
      fetchImpl,
      now: () => NOW + 2 * 86_400_000,
      newPeopleAllowed: () => planLive,
      note: (kind) => notes.push(kind),
    });
    expect((await rt.refresh()).map((c) => c.bundle.connector.connectorId)).toEqual([connector.connectorId]);
    expect(rt.connector(connector.connectorId)!.setup.scimTokenSha256).toBe(TOKEN_SHA);
    // While the org's Business plan has lapsed a new person waits; once it is paid they are proposed.
    const waiting: DirectoryUser = { externalId: "ext-ana", userName: "ana@acme.example", displayName: "Ana Pérez", active: true, groups: ["Finance"] };
    expect(await rt.sync(connector.connectorId, [waiting])).toEqual([]);
    expect(posted).toEqual([]);
    expect(notes).toContain("org.directory.waiting");
    planLive = true;

    const ana: DirectoryUser = { externalId: "ext-ana", userName: "ana@acme.example", displayName: "Ana Pérez", active: true, groups: ["Finance"] };
    const first = await rt.sync(connector.connectorId, [ana]);
    expect(first.map((i) => i.kind)).toEqual(["invite"]);
    const p = posted[0];
    verifyOrgProposal(bundle, p, { rolesHash: orgSeatRolesHash([{ role: "member" }]), now: NOW + 2 * 86_400_000 });
    expect(p.recipients.map((r: { recipient: string }) => r.recipient)).toEqual([`seat:${B.seatId}`]);
    const opened = parseOrgDirectoryEntryBody(openOrgProposal(p, `seat:${B.seatId}`, bKem.kemSecret));
    expect(opened).toMatchObject({ pseudonym: "Ana Pérez", email: "ana@acme.example", pendingId: p.proposal.subject, source: "scim" });
    expect(JSON.stringify(p)).not.toContain("Ana");

    // The admin invited her (seat M of the vectors, already granted in the pinned seat book) and recorded it.
    const seatM = A.keys["M member"].seatId as string;
    const invite = { orgId: A.orgId, seatId: seatM, labelSha256: "aa".repeat(32), rolesHash: orgSeatRolesHash([{ role: "member" }]), oarVersion: 1, issuedAt: NOW, expiresAt: NOW + 86_400_000, inviteKeyPub: IK.inviteKeyPub };
    const by = (order: Uint8Array) => [signOrgApproval({ orgId: A.orgId, oarVersion: 1, order, seatId: B.seatId, adminKeyId: B.keyId, issuedAt: NOW, notAfter: NOW + 86_400_000 }, B.secret)];
    const inviteOrder = canonicalOrgSeatInvite(invite);
    const statement = { orgId: A.orgId, proposalId: p.proposal.proposalId, decision: "done" as const, refSha256: orgSha256Hex(inviteOrder), issuedAt: NOW };
    const decisionApprovals = by(canonicalOrgProposalDecision(statement));
    const disabled = [{ ...ana, active: false }];

    // Each half alone is not enough (05c review F3): an approved decision with an unapproved invite, an approved
    // invite with an unapproved decision, or a decision whose approval names another proposal links nobody.
    invites = [{ invite }];
    proposals = [{ bundle: p, decision: { statement, approvals: decisionApprovals } }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    invites = [{ invite, approvals: by(inviteOrder) }];
    proposals = [{ bundle: p, decision: { statement } }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    const other = { ...statement, proposalId: "0f".repeat(16) };
    proposals = [{ bundle: p, decision: { statement: other, approvals: by(canonicalOrgProposalDecision(other)) } }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    // A proposal that is not this connector's own (its subject changed) links nobody either.
    proposals = [{ bundle: { ...p, proposal: { ...p.proposal, subject: "ee".repeat(16) } }, decision: { statement, approvals: decisionApprovals } }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);

    // The seat's accept must carry the invite key's signature (the person held the link), by the granted member key.
    invites = [{ invite, approvals: by(inviteOrder) }];
    proposals = [{ bundle: p, decision: { statement, approvals: decisionApprovals } }];
    const accept = { orgId: A.orgId, seatId: seatM, inviteSha256: orgSha256Hex(inviteOrder), memberKeyId: A.keys["M member"].keyId as string, adminKeyId: "", issuedAt: NOW };
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    accepts = [{ accept }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    accepts = [{ accept, inviteSignature: orgInviteAcceptSignature(deriveOrgInviteKeys(new Uint8Array(32).fill(0x34)).hybridSecret, accept) }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    const squatter = { ...accept, memberKeyId: "77".repeat(32) };
    accepts = [{ accept: squatter, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, squatter) }];
    expect(await rt.sync(connector.connectorId, disabled)).toEqual([]);
    accepts = [{ accept, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) }];
    const gone = await rt.sync(connector.connectorId, disabled);
    expect(gone.map((i) => [i.kind, i.subject])).toEqual([["offboard", seatM]]);
  });
});

describe("review-cloud: the connector runtime links a seat only on evidence it verifies", () => {
  it("review-cloud: an unapproved decision and invite served by .com do not link a pending person to an existing seat", async () => {
    const pin = pinned();
    const B = key("B admin");
    const boxSeed = new Uint8Array(32).fill(0x35);
    const boxKem = orgKemKeyPair(boxSeed);
    const seeds = [new Uint8Array(32).fill(0x61), new Uint8Array(32).fill(0x62)] as const;
    const conn = hybridSigKeygen(seeds[0], seeds[1]);
    const connector: OrgConnector = {
      orgId: A.orgId,
      connectorId: "c1".repeat(16),
      kind: "scim",
      serverDomain: HOST,
      connectorKeyId: orgConnectorKeyId(conn.publicKey),
      scopes: ["propose-invite", "propose-offboard", "update-entry"],
      mappingSha256: orgConnectorMappingSha256(mapping),
      status: "active",
      issuedAt: NOW,
    };
    const setup = sealOrgConnectorSetup(connector, { recipient: `box:${HOST}`, kemPub: boxKem.kemPub, kemKeyId: boxKem.kemKeyId, issuedAt: NOW }, {
      connectorSeedsHex: Buffer.concat([seeds[0], seeds[1]]).toString("hex"),
      mapping,
      scimTokenSha256: TOKEN_SHA,
      scimTokenIssuedAt: NOW,
    }, NOW);
    // Approved "yesterday": the box checks a stored record as of the record it names.
    const approval = signOrgApproval({ orgId: A.orgId, oarVersion: 1, order: canonicalOrgConnector(connector), seatId: B.seatId, adminKeyId: B.keyId, issuedAt: NOW, notAfter: NOW + 86_400_000 }, B.secret);
    const bundle = { connector, connectorPubHex: Buffer.from(conn.publicKey).toString("hex"), approvals: [approval], setup };
    // B announces its seat KEM key (signed with its admin key, as an org admin does).
    const bKem = orgKemKeyPair(new Uint8Array(32).fill(0x72));
    const st = { orgId: A.orgId, seatId: B.seatId, kemKeyId: bKem.kemKeyId, issuedAt: NOW };
    const seatKems = [{ statement: st, kemPubHex: Buffer.from(bKem.kemPub).toString("hex"), signature: signOrgSeatKem(st, B.secret) }];
    const posted: any[] = [];
    let proposals: any[] = [];
    let invites: any[] = [];
    let accepts: any[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace(`/api/orgs/${A.orgId}`, "");
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (init?.method === "POST" && path === "/proposals") {
        posted.push(JSON.parse(String(init.body)));
        return ok({});
      }
      if (path === "/connectors") return ok({ connectors: [bundle] });
      if (path === "/servers") return ok({ servers: [{ serverDomain: HOST }] });
      if (path === "/keys") return ok({ seatKems, boxKems: [], rings: [] });
      if (path === "/proposals") return ok({ proposals });
      if (path === "/seats") return ok({ invites, accepts });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const rt = new ConnectorRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "connector-")),
      orgId: A.orgId,
      serverDomain: HOST,
      controlPlaneBaseUrl: "https://flagshipserver.example",
      pin: () => pin,
      boxKemSeed: async () => boxSeed,
      fetchImpl,
      now: () => NOW + 2 * 86_400_000,
    });
    expect((await rt.refresh()).map((c) => c.bundle.connector.connectorId)).toEqual([connector.connectorId]);
    expect(rt.connector(connector.connectorId)!.setup.scimTokenSha256).toBe(TOKEN_SHA);

    const ana: DirectoryUser = { externalId: "ext-ana", userName: "ana@acme.example", displayName: "Ana Pérez", active: true, groups: ["Finance"] };
    const first = await rt.sync(connector.connectorId, [ana]);
    expect(first.map((i) => i.kind)).toEqual(["invite"]);
    const p = posted[0];
    verifyOrgProposal(bundle, p, { rolesHash: orgSeatRolesHash([{ role: "member" }]), now: NOW + 2 * 86_400_000 });
    expect(p.recipients.map((r: { recipient: string }) => r.recipient)).toEqual([`seat:${B.seatId}`]);
    const opened = parseOrgDirectoryEntryBody(openOrgProposal(p, `seat:${B.seatId}`, bKem.kemSecret));
    expect(opened).toMatchObject({ pseudonym: "Ana Pérez", email: "ana@acme.example", pendingId: p.proposal.subject, source: "scim" });
    expect(JSON.stringify(p)).not.toContain("Ana");

    // .com fabricates both halves: an invite naming an existing seat (M, someone else entirely) and a
    // "done" decision for Ana's proposal, neither carrying any org admin's approval.
    const target = A.keys["M member"].seatId as string;
    const invite = { orgId: A.orgId, seatId: target, labelSha256: "aa".repeat(32), rolesHash: orgSeatRolesHash([{ role: "member" }]), oarVersion: 1, issuedAt: NOW, expiresAt: NOW + 86_400_000, inviteKeyPub: IK.inviteKeyPub };
    invites = [{ invite }];
    proposals = [{ bundle: p, decision: { statement: { orgId: A.orgId, proposalId: p.proposal.proposalId, decision: "done", refSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), issuedAt: NOW } } }];
    // Disabling Ana in the IdP must not turn into "offboard <that seat>".
    const gone = await rt.sync(connector.connectorId, [{ ...ana, active: false }]);
    expect(gone.map((i) => [i.kind, i.subject])).toEqual([]);
  });
});

describe("LDAP pull", () => {
  const guid = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  it("reads Active Directory over the real client: objectGUID, UPN, memberOf, disabled accounts", async () => {
    const srv = await fakeLdapServer(
      [
        { dn: "CN=Ana,OU=Staff,DC=acme,DC=example", attrs: { objectGUID: [guid], userPrincipalName: ["ana@acme.example"], displayName: ["Ana Pérez"], memberOf: ["CN=Finance,OU=Groups,DC=acme,DC=example"], userAccountControl: ["512"] } },
        { dn: "CN=Old,OU=Staff,DC=acme,DC=example", attrs: { objectGUID: [Buffer.alloc(16, 1)], userPrincipalName: ["old@acme.example"], displayName: ["Old"], userAccountControl: ["514"] } },
        { dn: "CN=NoId,OU=Staff,DC=acme,DC=example", attrs: { displayName: ["No id"] } },
      ],
      { dn: "CN=svc-flagship,OU=Service,DC=acme,DC=example", password: "s3cret" },
    );
    try {
      const cfg = ldapConfigFrom({ url: srv.url, bindDn: "CN=svc-flagship,OU=Service,DC=acme,DC=example", bindPassword: "s3cret", baseDn: "DC=acme,DC=example", userFilter: "" }, "ad");
      const src = new LdapDirectorySource("c2".repeat(16), { ...cfg, allowPlaintextForTests: true });
      const people = await collectSnapshot(src);
      expect(people).toEqual([
        { externalId: "33221100-5544-7766-8899-aabbccddeeff", userName: "ana@acme.example", displayName: "Ana Pérez", active: true, groups: ["CN=Finance,OU=Groups,DC=acme,DC=example"] },
        { externalId: "01010101-0101-0101-0101-010101010101", userName: "old@acme.example", displayName: "Old", active: false, groups: [] },
      ]);
      expect(srv.seen.searches).toEqual(["DC=acme,DC=example"]);
      for (let i = 0; i < 50 && srv.seen.unbinds === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(srv.seen.unbinds).toBe(1);
      expect(cfg.userFilter).toBe(LDAP_DEFAULTS.ad.userFilter);
    } finally {
      await srv.close();
    }
  });

  it("reads OpenLDAP with its defaults, refuses a wrong password and a plain ldap:// URL in production", async () => {
    const srv = await fakeLdapServer(
      [{ dn: "uid=chen,ou=people,dc=acme,dc=example", attrs: { entryUUID: ["6b1f0a2e-1f0a-4c4d-9a8b-77c1d2e3f4a5"], mail: ["chen@acme.example"], cn: ["Chen Wei"], memberOf: ["cn=eng,ou=groups,dc=acme,dc=example"] } }],
      { dn: "cn=reader,dc=acme,dc=example", password: "pw" },
    );
    try {
      const cfg = ldapConfigFrom({ url: srv.url, bindDn: "cn=reader,dc=acme,dc=example", bindPassword: "pw", baseDn: "dc=acme,dc=example", userFilter: "" }, "openldap");
      const people = await collectSnapshot(new LdapDirectorySource("c3".repeat(16), { ...cfg, allowPlaintextForTests: true }));
      expect(people).toEqual([{ externalId: "6b1f0a2e-1f0a-4c4d-9a8b-77c1d2e3f4a5", userName: "chen@acme.example", displayName: "Chen Wei", active: true, groups: ["cn=eng,ou=groups,dc=acme,dc=example"] }]);
      await expect(collectSnapshot(new LdapDirectorySource("c3".repeat(16), { ...cfg, bindPassword: "wrong", allowPlaintextForTests: true }))).rejects.toThrow();
      expect(() => new LdapDirectorySource("c3".repeat(16), cfg)).toThrow(/ldaps/);
    } finally {
      await srv.close();
    }
  });
});

describe("a connector whose approver left", () => {
  it("keeps working for 7 days with an Activity note, then stops until re-approved; a later setup without seeds uses the kept ones", async () => {
    const C = key("C admin");
    const entries = chain.entries.slice(0, 3);
    const v2At: number = entries[2].record.issuedAt;
    const pinAt = (now: number) =>
      verifyOrgPin(
        { v: 1, orgId: A.orgId, genesisHash: A.genesisHash, entries, freezes: [], overturns: [], vetoes: [], grants: R(A.seatBooks[0]).grants, revokes: [], noticeOpenedAt: chain.noticeOpenedAt, rotationsPending: [], syncedAt: now },
        { orgId: A.orgId, genesisHash: A.genesisHash },
        now,
      );
    const boxSeed = new Uint8Array(32).fill(0x35);
    const boxKem = orgKemKeyPair(boxSeed);
    const seeds = [new Uint8Array(32).fill(0x61), new Uint8Array(32).fill(0x62)] as const;
    const conn = hybridSigKeygen(seeds[0], seeds[1]);
    const at = chain.entries[1].record.issuedAt + 3_600_000;
    const connector: OrgConnector = {
      orgId: A.orgId, connectorId: "c6".repeat(16), kind: "scim", serverDomain: HOST, connectorKeyId: orgConnectorKeyId(conn.publicKey),
      scopes: ["propose-invite", "propose-offboard", "update-entry"], mappingSha256: orgConnectorMappingSha256(mapping), status: "active", issuedAt: at,
    };
    const kemKey = { recipient: `box:${HOST}`, kemPub: boxKem.kemPub, kemKeyId: boxKem.kemKeyId, issuedAt: at };
    const approval = signOrgApproval({ orgId: A.orgId, oarVersion: 1, order: canonicalOrgConnector(connector), seatId: C.seatId, adminKeyId: C.keyId, issuedAt: at, notAfter: at + 86_400_000 }, C.secret);
    let bundle: any = {
      connector, connectorPubHex: Buffer.from(conn.publicKey).toString("hex"), approvals: [approval],
      setup: sealOrgConnectorSetup(connector, kemKey, { connectorSeedsHex: Buffer.concat([seeds[0], seeds[1]]).toString("hex"), mapping, scimTokenSha256: TOKEN_SHA }, at),
    };
    let now = v2At + 3_600_000;
    let pin = pinAt(now);
    const notes: Array<[string, string]> = [];
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname.replace(`/api/orgs/${A.orgId}`, "");
      if (path === "/connectors") return new Response(JSON.stringify({ connectors: [bundle] }));
      if (path === "/servers") return new Response(JSON.stringify({ servers: [{ serverDomain: HOST }] }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const rt = new ConnectorRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "connector-standing-")), orgId: A.orgId, serverDomain: HOST, controlPlaneBaseUrl: "https://flagshipserver.example",
      pin: () => pin, boxKemSeed: async () => boxSeed, fetchImpl, now: () => now, note: (k, t) => notes.push([k, t]),
    });
    const first = await rt.refresh();
    expect(first.map((c) => c.standing.state)).toEqual(["needs-reapproval"]);
    expect(notes.map(([k]) => k)).toEqual(["org.directory.reapprove"]);
    expect(notes[0]![1]).not.toMatch(/@/);

    now = v2At + 8 * 86_400_000;
    pin = pinAt(now);
    expect(await rt.refresh()).toEqual([]);
    expect(notes.map(([k]) => k)).toEqual(["org.directory.reapprove", "org.directory.suspended"]);

    // B re-approves under v2, with a later setup that carries a new token but no seeds.
    const B = key("B admin");
    const re: OrgConnector = { ...connector, issuedAt: now - 60_000 };
    const newTokenSha = createHash("sha256").update("a-new-scim-token-0123456789").digest("hex");
    bundle = {
      connector: re, connectorPubHex: bundle.connectorPubHex,
      approvals: [signOrgApproval({ orgId: A.orgId, oarVersion: 2, order: canonicalOrgConnector(re), seatId: B.seatId, adminKeyId: B.keyId, issuedAt: now - 60_000, notAfter: now + 86_400_000 }, B.secret)],
      setup: sealOrgConnectorSetup(re, kemKey, { mapping, scimTokenSha256: newTokenSha }, now),
    };
    const back = await rt.refresh();
    expect(back.map((c) => c.standing.state)).toEqual(["ok"]);
    expect(back[0]!.setup.scimTokenSha256).toBe(newTokenSha);
  });
});

describe("review-cloud: SCIM resource ids are not object keys", () => {
  it("review-cloud: PUT/PATCH /scim/v2/Users/__proto__ and /Groups/__proto__ are 404 and pollute nothing", async () => {
    const polluted = ["userName", "active", "displayName", "externalId", "givenName", "familyName", "emails", "lastModified", "members"];
    const w = scimWorld();
    try {
      const status = async (p: Promise<{ status: number } | null>) => p.then((r) => r?.status, (e: Error) => `threw ${e.message}`);
      const put = await status(w.call("PUT", "/scim/v2/Users/__proto__", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "x@acme.example", active: true }));
      const patch = await status(w.call("PATCH", "/scim/v2/Groups/__proto__", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "displayName", value: "g" }] }));
      const leaked = polluted.filter((k) => k in {});
      expect({ put, patch, leaked }).toEqual({ put: 404, patch: 404, leaked: [] });
    } finally {
      for (const k of polluted) delete (Object.prototype as Record<string, unknown>)[k];
    }
  });
});
