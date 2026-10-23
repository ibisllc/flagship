// The signed release catalog on the gym (N13, 0.3). A box whose release pins `release/catalog-root.json`
// fetches <artifact base>/catalog-*.json and every update path asks it first. The gym needs its own root pinned
// on the gym branch and a catalog signed with the gym key, published to flagship-iso-gym as catalog-<name>.json; until
// then the group skips and says so. When it is there: the published catalog verifies against the pinned
// root as a box checks it, and a box's journal says it accepted it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_TRUST_STATE, verifyReleaseCatalog, type RootMeta } from "@flagship/protocol";
import { CONTROL, SkipError, assert, tryHttp } from "../../lib/harness.js";
import type { Group } from "../types.js";
import { journal } from "./util.js";

const ROOT = join(import.meta.dirname, "../../../../release/catalog-root.json");

export const releaseCatalog: Group = {
  name: "release-catalog",
  title: "the gym's signed release catalog verifies against the pinned root, and a box accepted it",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, box }) {
    const base = `https://${CONTROL}/build/iso/catalog`;
    await rec.check("the published catalog verifies against the root this release pins", async () => {
      if (!existsSync(ROOT)) throw new SkipError("no release/catalog-root.json in this checkout (the gym branch pins none yet)");
      const [timestamp, snapshot, targets] = await Promise.all(["timestamp", "snapshot", "targets"].map(async (f) => (await tryHttp(`${base}-${f}.json`)).json));
      if (!timestamp || !snapshot || !targets) throw new SkipError("no catalog published at /build/iso/catalog-*.json on the gym");
      const root = JSON.parse(readFileSync(ROOT, "utf8")) as RootMeta;
      const v = verifyReleaseCatalog({ root, timestamp, snapshot, targets, now: Date.now(), state: EMPTY_TRUST_STATE });
      assert(v.ok, `refused: ${v.ok ? "" : v.reason}`);
      assert(!v.value.stale, "the catalog is stale: re-sign the timestamp");
      return `targets v${v.value.targets.version}, floor ${v.value.securityFloor}, ${v.value.targets.releases.length} releases`;
    });
    await rec.check("a box's journal says it accepted the catalog", async () => {
      if (!existsSync(ROOT)) throw new SkipError("no pinned root");
      const lines = await journal(A, box("A1"));
      const hit = lines.find((l) => l.includes("[release-catalog]"));
      if (!hit) throw new SkipError("the box logged nothing about the catalog (its release pins no root)");
      assert(/accepted/.test(hit), hit);
      return hit;
    });
  },
};
