import type { NameRegistration, NameRegistry } from "./types.js";
import { validateUserLabel } from "./validation.js";

export class InMemoryNameRegistry implements NameRegistry {
  private byName = new Map<string, NameRegistration>();

  claim(reg: NameRegistration): { ok: true } | { ok: false; reason: string } {
    const v = validateUserLabel(reg.username);
    if (!v.ok) return { ok: false, reason: v.reason };
    const norm = v.label;
    const existing = this.byName.get(norm);
    if (existing) {
      // Same IRK pubkey re-claiming is fine (idempotent registration; e.g.
      // user re-runs image-build flow). Different IRK → reject.
      if (!equalBytes(existing.irkPub, reg.irkPub)) {
        return { ok: false, reason: "username already claimed" };
      }
      existing.claimedAt = reg.claimedAt;
      return { ok: true };
    }
    this.byName.set(norm, { ...reg, username: norm });
    return { ok: true };
  }

  release(username: string): boolean {
    return this.byName.delete(username.toLowerCase());
  }

  ownerOf(username: string): NameRegistration | undefined {
    const r = this.byName.get(username.toLowerCase());
    return r ? { ...r, irkPub: r.irkPub.slice() } : undefined;
  }

  list(): NameRegistration[] {
    return [...this.byName.values()].map((r) => ({ ...r, irkPub: r.irkPub.slice() }));
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
