import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OrgAuthorityError,
  canonicalOrgDirectoryEntryBody,
  canonicalOrgDirectoryWrite,
  openOrgDirectory,
  openOrgDirectoryEntry,
  orgDirectoryEntryKey,
  parseOrgDirectoryEntryBody,
  sealOrgDirectoryEntry,
  type OrgDirectoryEntry,
  buildOrgSeatBook,
  canonicalOrgConnector,
  canonicalOrgProposal,
  canonicalOrgProposalDecision,
  openOrgProposal,
  orgConnectorKeyId,
  orgConnectorMappingSha256,
  orgKemKeyPair,
  verifyOrgAuthorityChain,
  verifyOrgConnector,
  verifyOrgProposal,
  orgConnectorStanding,
  orgConnectorsToReapprove,
  canonicalOrgDirectorySlicePayload,
  canonicalOrgDirectorySliceWrite,
  openOrgDirectorySlice,
  orgDirectoryShares,
  orgDirectorySliceContent,
  orgDirectorySliceTag,
  openOrgConnectorMapping,
  sealOrgConnectorMapping,
} from "../src/index.js";

// Reads test-vectors/org-directory (tools/org-directory-vectors.ts).
const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/org-directory/vectors.json"), "utf8"));
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const codeOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof OrgAuthorityError ? e.code : String(e);
  }
};

describe("org directory vectors", () => {
  for (const c of V.entries) {
    it(`seals and opens: ${c.name}`, () => {
      expect(text(canonicalOrgDirectoryEntryBody(c.entry))).toBe(c.body);
      expect(Buffer.from(orgDirectoryEntryKey(bytes(c.directoryKeyHex), V.orgId, c.entryId, c.keyVersion)).toString("hex")).toBe(c.entryKeyHex);
      const s = sealOrgDirectoryEntry({
        orgId: V.orgId,
        entryId: c.entryId,
        keyVersion: c.keyVersion,
        directoryKey: bytes(c.directoryKeyHex),
        entry: c.entry,
        issuedAt: c.sealed.issuedAt,
        nonce: bytes(c.sealed.sealedHex.slice(0, 24)),
      });
      expect(s).toEqual(c.sealed);
      expect(text(canonicalOrgDirectoryWrite(c.sealed))).toBe(c.write);
      expect(openOrgDirectoryEntry(c.sealed, bytes(c.directoryKeyHex))).toEqual(c.entry);
      expect(parseOrgDirectoryEntryBody(new TextEncoder().encode(c.body))).toEqual(c.entry);
    });
  }
  for (const c of V.opens) it(`refuses to open: ${c.name}`, () => expect(codeOf(() => openOrgDirectoryEntry(c.sealed, bytes(c.directoryKeyHex)))).toBe(c.error));
  for (const c of V.badBodies) it(`refuses the body: ${c.name}`, () => expect(codeOf(() => parseOrgDirectoryEntryBody(new TextEncoder().encode(c.body)))).not.toBe("ok"));
  it(V.newest.name, () => {
    const keys = new Map(Object.entries(V.newest.keys as Record<string, string>).map(([k, v]) => [Number(k), bytes(v)]));
    for (const order of [V.newest.sealed, [...V.newest.sealed].reverse()]) {
      const view = openOrgDirectory(V.orgId, order, keys);
      expect(view.bySeat.get(V.newest.expect.seat)?.pseudonym).toBe(V.newest.expect.pseudonym);
    }
  });
});

describe("org directory entries", () => {
  const base: OrgDirectoryEntry = V.entries[0].entry;
  it("no text field can shift a field boundary", () => {
    const e = { ...base, pseudonym: "a|b", displayName: "x|y|z", groups: ["g|1", "g,2"].sort() };
    const body = text(canonicalOrgDirectoryEntryBody(e));
    expect(body.split("|")).toHaveLength(11);
    expect(parseOrgDirectoryEntryBody(new TextEncoder().encode(body))).toEqual(e);
  });
  it("refuses entries over the limits and non-NFC text", () => {
    expect(codeOf(() => canonicalOrgDirectoryEntryBody({ ...base, pseudonym: "x".repeat(129) }))).toBe("malformed");
    expect(codeOf(() => canonicalOrgDirectoryEntryBody({ ...base, pseudonym: "é" }))).toBe("malformed");
    expect(codeOf(() => canonicalOrgDirectoryEntryBody({ ...base, groups: Array.from({ length: 33 }, (_, i) => `g${String(i).padStart(2, "0")}`) }))).toBe("malformed");
  });
  it("hides the length inside its bucket and refuses a body that will not fit", () => {
    const k = new Uint8Array(32).fill(7);
    const a = sealOrgDirectoryEntry({ orgId: V.orgId, entryId: "e1".repeat(16), keyVersion: 1, directoryKey: k, entry: { ...base, pseudonym: "A" }, issuedAt: 1 });
    const b = sealOrgDirectoryEntry({ orgId: V.orgId, entryId: "e1".repeat(16), keyVersion: 1, directoryKey: k, entry: { ...base, pseudonym: "A much longer pseudonym" }, issuedAt: 1 });
    expect(a.sealedHex.length).toBe(b.sealedHex.length);
    const huge = { ...base, groups: Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, "0")}${"g".repeat(250)}`) };
    expect(codeOf(() => sealOrgDirectoryEntry({ orgId: V.orgId, entryId: "e1".repeat(16), keyVersion: 1, directoryKey: k, entry: huge, issuedAt: 1 }))).toBe("malformed");
  });
});

describe("org connectors and proposals vectors", () => {
  const C = V.connectors;
  const A = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/org-authority/vectors.json"), "utf8"));
  const refs = (v: unknown): any => {
    if (Array.isArray(v)) return v.map(refs);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$key === "string") return A.keys[o.$key].binding;
    if (typeof o.$approval === "number") return A.approvals[o.$approval];
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
  };
  const entries = refs(A.chains[0]).entries.slice(0, 2);
  const grants = refs(A.seatBooks[0]).grants;
  const ctx = (now: number) => {
    const state = verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now });
    return { state, book: buildOrgSeatBook(state, { grants, revokes: [], now }), servers: new Set(["home.acme.flagship.services"]), now };
  };
  it("the connector record verifies under one org admin's approval", () => {
    expect(text(canonicalOrgConnector(C.connector.connector))).toBe(C.connectorBytes);
    expect(orgConnectorKeyId(bytes(C.connector.connectorPubHex))).toBe(C.connector.connector.connectorKeyId);
    expect(orgConnectorMappingSha256(C.mapping)).toBe(C.connector.connector.mappingSha256);
    expect(() => verifyOrgConnector(ctx(C.now), C.connector, null)).not.toThrow();
    expect(codeOf(() => verifyOrgConnector({ ...ctx(C.now), servers: new Set() }, C.connector, null))).toBe("scope");
    const swapped = { ...C.connector, connector: { ...C.connector.connector, scopes: ["propose-invite"] } };
    expect(codeOf(() => verifyOrgConnector(ctx(C.now), swapped, null))).toBe("order-mismatch");
  });
  for (const p of C.proposals) {
    it(`proposal: ${p.name}`, () => {
      expect(text(canonicalOrgProposal(p.bundle.proposal))).toBe(p.bytes);
      expect(() => verifyOrgProposal(C.connector, p.bundle, { rolesHash: p.rolesHash, now: C.now })).not.toThrow();
      for (const a of C.admins) {
        const kp = orgKemKeyPair(bytes(a.kemSeedHex));
        expect(text(openOrgProposal(p.bundle, a.recipient, kp.kemSecret))).toBe(p.payload);
      }
    });
  }
  it("a proposal the connector may not make, or that changed after signing, is refused", () => {
    const p = C.proposals[1];
    const narrow = { ...C.connector, connector: { ...C.connector.connector, scopes: ["propose-invite"] } };
    expect(codeOf(() => verifyOrgProposal(narrow, p.bundle, { rolesHash: "", now: C.now }))).toBe("scope");
    const paused = { ...C.connector, connector: { ...C.connector.connector, status: "paused" } };
    expect(codeOf(() => verifyOrgProposal(paused, p.bundle, { rolesHash: "", now: C.now }))).toBe("seat-revoked");
    const moved = { ...p.bundle, proposal: { ...p.bundle.proposal, subject: "ff".repeat(16) } };
    expect(codeOf(() => verifyOrgProposal(C.connector, moved, { rolesHash: "", now: C.now }))).toBe("bad-signature");
    const dropped = { ...p.bundle, recipients: p.bundle.recipients.slice(0, 1) };
    expect(codeOf(() => verifyOrgProposal(C.connector, dropped, { rolesHash: "", now: C.now }))).toBe("order-mismatch");
    const inv = C.proposals[0];
    expect(codeOf(() => verifyOrgProposal(C.connector, inv.bundle, { rolesHash: "ee".repeat(32), now: C.now }))).toBe("order-mismatch");
  });
  it("the decision form", () => {
    expect(text(canonicalOrgProposalDecision(C.decision.statement))).toBe(C.decision.bytes);
    expect(codeOf(() => canonicalOrgProposalDecision({ ...C.decision.statement, decision: "declined" }))).toBe("malformed");
  });
});

describe("connector standing vectors (an approver who left)", () => {
  const A = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/org-authority/vectors.json"), "utf8"));
  const refs = (v: unknown): any => {
    if (Array.isArray(v)) return v.map(refs);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$key === "string") return A.keys[o.$key].binding;
    if (typeof o.$approval === "number") return A.approvals[o.$approval];
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
  };
  const all = refs(A.chains[0]).entries;
  const grants = refs(A.seatBooks[0]).grants;
  for (const c of V.standing.cases) {
    it(c.name, () => {
      const state = verifyOrgAuthorityChain(all.slice(0, c.entries), { genesisHash: A.genesisHash, now: c.now, noticeOpenedAt: A.chains[0].noticeOpenedAt });
      const book = buildOrgSeatBook(state, { grants, revokes: [], now: c.now });
      const s = orgConnectorStanding(state, book, c.bundle, c.now);
      expect({ state: s.state, leftAt: s.leftAt, ...(c.expect.suspendAt ? { suspendAt: s.suspendAt } : {}) }).toEqual(c.expect);
      const servers = new Set(["home.acme.flagship.services"]);
      if (c.expect.state === "suspended") expect(codeOf(() => verifyOrgConnector({ state, book, servers, now: c.now }, c.bundle, null, { stored: true }))).toBe("seat-revoked");
      else expect(verifyOrgConnector({ state, book, servers, now: c.now }, c.bundle, null, { stored: true })?.state).toBe(c.expect.state);
      expect(orgConnectorsToReapprove(state, book, [c.bundle], c.now).length).toBe(c.expect.state === "ok" ? 0 : 1);
    });
  }
});

describe("members' directory slices vectors", () => {
  const A = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/org-authority/vectors.json"), "utf8"));
  const refs = (v: unknown): any => {
    if (Array.isArray(v)) return v.map(refs);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$key === "string") return A.keys[o.$key].binding;
    if (typeof o.$approval === "number") return A.approvals[o.$approval];
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
  };
  const S = V.slices;
  const state = verifyOrgAuthorityChain(refs(A.chains[0]).entries.slice(0, 2), { genesisHash: A.genesisHash, now: S.now });
  const book = buildOrgSeatBook(state, { grants: refs(A.seatBooks[0]).grants, revokes: [], now: S.now });
  const dir = new Map<string, OrgDirectoryEntry>(S.directory.map((e: OrgDirectoryEntry) => [e.seatId, e]));
  for (const c of S.seats) {
    it(`builds and opens the slice of ${c.name}`, () => {
      expect(orgDirectoryShares(state, book, c.seatId, S.servers, S.now)).toEqual(c.shares);
      const content = orgDirectorySliceContent(state, book, c.seatId, dir, S.servers, S.now);
      expect(content).toEqual(c.content);
      const payload = canonicalOrgDirectorySlicePayload(V.orgId, c.seatId, content);
      expect(text(payload)).toBe(c.payload);
      expect(orgDirectorySliceTag(bytes(S.directoryKeyHex), payload)).toBe(c.contentTag);
      expect(text(canonicalOrgDirectorySliceWrite(c.slice))).toBe(c.write);
      const kp = orgKemKeyPair(bytes(c.kemSeedHex));
      expect(openOrgDirectorySlice(c.slice, kp.kemSecret)).toEqual(c.content);
      // A member's slice carries no email or external id.
      expect(JSON.stringify(c.content)).not.toMatch(/@acme|ext-/);
      expect(codeOf(() => openOrgDirectorySlice({ ...c.slice, seatId: S.seats.find((x: { seatId: string }) => x.seatId !== c.seatId).seatId }, kp.kemSecret))).toBe("malformed");
    });
  }
});

describe("the connector mapping sealed for the admins", () => {
  it("opens with the directory key and only with it", () => {
    const m = V.connectors.mappingSealed;
    const id = V.connectors.connector.connector.connectorId;
    expect(openOrgConnectorMapping(V.orgId, id, bytes(m.directoryKeyHex), m.sealed)).toEqual(V.connectors.mapping);
    expect(sealOrgConnectorMapping(V.orgId, id, bytes(m.directoryKeyHex), 1, V.connectors.mapping, bytes(m.sealed.sealedHex.slice(0, 24)))).toEqual(m.sealed);
    expect(codeOf(() => openOrgConnectorMapping(V.orgId, "ee".repeat(16), bytes(m.directoryKeyHex), m.sealed))).toBe("malformed");
  });
});
