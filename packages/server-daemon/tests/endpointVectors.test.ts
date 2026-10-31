import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AddressPool,
  EndpointTable,
  matchesExpected,
  parseObservation,
  type Endpoint,
  type EndpointEnv,
  type EndpointKey,
  type EndpointLease,
  type EndpointRole,
} from "../src/endpoints.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/endpoints.json", import.meta.url), "utf8")) as {
  pool: Array<{ name: string; subnet: string; reserved: string[]; quarantineMs: number; constructError?: boolean; steps: Array<Record<string, unknown>> }>;
  match: Array<{ name: string; observation: Record<string, unknown>; want: Record<string, unknown>; expect: string | null }>;
  inspect: Array<{ name: string; json: string; expect: unknown }>;
  table: Array<{ name: string; steps: Array<Record<string, unknown>> }>;
};

function keyOf(s: string): EndpointKey {
  const [env, serviceId, component, role] = s.split("/");
  return { env: env as EndpointEnv, serviceId: serviceId!, component: component!, role: role as EndpointRole };
}

describe("endpoint vectors (shared with flagship-core)", () => {
  for (const c of V.pool) {
    it(`pool: ${c.name}`, () => {
      let clock = 0;
      if (c.constructError) {
        expect(() => new AddressPool(c.subnet, { reserved: c.reserved, quarantineMs: c.quarantineMs, now: () => clock })).toThrow();
        return;
      }
      const pool = new AddressPool(c.subnet, { reserved: c.reserved, quarantineMs: c.quarantineMs, now: () => clock });
      for (const s of c.steps) {
        if (typeof s.now === "number") clock = s.now;
        switch (s.op) {
          case "assign":
            if (s.expectError) expect(() => pool.assign(s.owner as string)).toThrow();
            else expect(pool.assign(s.owner as string)).toBe(s.expect);
            break;
          case "release":
            pool.release(s.owner as string);
            break;
          case "releasePrefix":
            pool.releasePrefix(s.prefix as string);
            break;
          case "occupy":
            pool.occupy(s.ip as string, s.tag as string);
            break;
          case "adopt":
            pool.adopt(s.owner as string, s.ip as string);
            break;
          case "vacate":
            pool.vacate(s.ip as string);
            break;
          case "ownerOf":
            expect(pool.ownerOf(s.ip as string) ?? null).toBe(s.expect);
            break;
          case "addressOf":
            expect(pool.addressOf(s.owner as string) ?? null).toBe(s.expect);
            break;
          default:
            throw new Error(`unknown pool op ${String(s.op)}`);
        }
      }
    });
  }

  for (const c of V.match) {
    it(`match: ${c.name}`, () => {
      expect(matchesExpected(c.observation as never, c.want as never)).toBe(c.expect);
    });
  }

  for (const c of V.inspect) {
    it(`inspect: ${c.name}`, () => {
      expect(parseObservation(c.json)).toEqual(c.expect);
    });
  }

  for (const c of V.table) {
    it(`table: ${c.name}`, () => {
      const table = new EndpointTable();
      const leases = new Map<string, EndpointLease>();
      const cancelled = new Set<string>();
      for (const s of c.steps) {
        switch (s.op) {
          case "publish":
            table.publish(keyOf(s.key as string), s.endpoint as Endpoint);
            break;
          case "lookup":
            expect(table.lookup(keyOf(s.key as string))).toEqual(s.expect);
            break;
          case "acquire": {
            const l = table.acquire(keyOf(s.key as string));
            expect(l !== null).toBe(s.expect);
            if (l) {
              const name = s.lease as string;
              leases.set(name, l);
              l.bind({ destroy: () => void cancelled.add(name) });
            }
            break;
          }
          case "current":
            expect(leases.get(s.lease as string)!.current()).toBe(s.expect);
            break;
          case "cancelled":
            expect(cancelled.has(s.lease as string)).toBe(s.expect);
            break;
          case "openLeases":
            expect(table.openLeases(s.service as string)).toBe(s.expect);
            break;
          case "invalidate":
            table.invalidate(s.service as string, s.env as EndpointEnv | undefined, s.component as string | undefined);
            break;
          case "beginStop":
            table.beginStop(s.service as string, s.env as EndpointEnv, s.component as string | undefined);
            break;
          default:
            throw new Error(`unknown table op ${String(s.op)}`);
        }
      }
    });
  }
});
