import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ed, verifyVoiciNameOrder } from "@flagship/protocol";
import {
  VoiciNameError,
  buildVoiciNameOrder,
  canonicalVoiciNameBytes,
  checkVoiciName,
  saveVoiciName,
  voiciNameKey,
  voiciNameProblem,
} from "../public/webapp/lib/voiciName.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/protocol/test-vectors/voici-name/vectors.json"), "utf8"),
);
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const seed = fromHex(V.keys.seedHex);
const sign = async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, seed);
const deps = (extra = {}) => ({ umk: new Uint8Array(32), sign, origin: "https://flagshipserver.com", ...extra });

describe("webapp voici-name (shared vectors)", () => {
  it("builds the canonical bytes the protocol pins", () => {
    for (const which of ["set", "clear"] as const) {
      expect(new TextDecoder().decode(canonicalVoiciNameBytes(V[which].fields))).toBe(V[which].canonical);
    }
  });

  it("the name rules give the pinned answers", () => {
    for (const n of V.names) {
      expect(voiciNameProblem(n.typed), n.typed).toBe(n.problem);
      if (n.problem === null) expect(voiciNameKey(n.typed), n.typed).toBe(n.key);
    }
  });

  it("signs an order the server's verifier accepts, lower-casing the name", async () => {
    const { order, signature } = await buildVoiciNameOrder(
      { username: "Plucky-Avocet", serviceId: "plucky-avocet--halloween-party", name: "HalloweenParty", op: "set" },
      deps({ now: () => 1760000000000, nonceHex: V.set.fields.nonce }),
    );
    expect(order).toEqual(V.set.fields);
    expect(signature).toBe(V.set.signatureHex);
    expect(verifyVoiciNameOrder(order, fromHex(signature), fromHex(V.keys.pubHex))).toBe(true);
  });

  it("a clear carries no name", async () => {
    const { order, signature } = await buildVoiciNameOrder(
      { username: "plucky-avocet", serviceId: "plucky-avocet--halloween-party", name: "ignored", op: "clear" },
      deps({ now: () => 1760000000000, nonceHex: V.clear.fields.nonce }),
    );
    expect(order).toEqual(V.clear.fields);
    expect(signature).toBe(V.clear.signatureHex);
  });
});

describe("webapp voici-name requests", () => {
  const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body });

  it("saveVoiciName posts the signed order and returns the new link state", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetch = async (url: string, init: any) => (calls.push({ url, init }), { ok: true, status: 200, json: async () => ({ ok: true, link: { name: "party", held: 1 } }) });
    const link = await saveVoiciName({ username: "alice", serviceId: "alice--party", name: "party-time" }, deps({ fetch }));
    expect(link).toEqual({ name: "party", held: 1 });
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/users/alice/apps/alice--party/voici-name");
    expect(JSON.parse(calls[0]!.init.body).order).toMatchObject({ user: "alice", name: "party-time", op: "set" });
  });

  it("a refusal throws with its code and data", async () => {
    const fetch = reply(409, { error: "x", code: "dibs", domain: "nike.com", until: 5 });
    await expect(saveVoiciName({ username: "alice", serviceId: "alice--party", name: "nike" }, deps({ fetch }))).rejects.toMatchObject({
      status: 409,
      code: "dibs",
      data: { domain: "nike.com", until: 5 },
    });
    expect(new VoiciNameError(429, { code: "change-limit", nextChangeAt: 9 }).data.nextChangeAt).toBe(9);
  });

  it("checkVoiciName asks the account's check route with the service and the lower-cased name", async () => {
    const seen: string[] = [];
    const accountReadFetch = async (url: string) => (seen.push(url), { ok: true, status: 200, json: async () => ({ status: "available" }) });
    expect(await checkVoiciName({ username: "alice", serviceId: "alice--party", name: "Party-Time" }, deps({ accountReadFetch }))).toEqual({ status: "available" });
    expect(seen[0]).toBe("https://flagshipserver.com/api/users/alice/voici-name-check?name=party-time&service=alice--party");
  });
});
