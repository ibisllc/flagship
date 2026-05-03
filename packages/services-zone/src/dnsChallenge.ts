import type { TxtRecord, ZoneApi } from "./types.js";

/**
 * Bridges the ACME issuer's DnsChallengeWriter contract (server-daemon owns
 * that interface) with this package's ZoneApi. The Flagship server sends a
 * challenge instruction over the tunnel; this service publishes the TXT and
 * returns a disposer the caller invokes once Let's Encrypt has validated.
 *
 * Cleans up stale records of the same name before publishing so a previous
 * failed issuance can't leave a poisoned challenge record behind.
 */
export class DnsChallengeService {
  constructor(private readonly zone: ZoneApi) {}

  async publishTxt(host: string, value: string): Promise<() => Promise<void>> {
    await this.cleanupExisting(host);
    const record = await this.zone.createTxt({ name: host, value, ttl: 60 });
    if (!record.id) {
      throw new Error("createTxt did not return a record id; cannot dispose later");
    }
    const id = record.id;
    return async () => {
      await this.zone.deleteTxt(id).catch(() => {
        /* tolerate already-gone */
      });
    };
  }

  private async cleanupExisting(name: string): Promise<void> {
    const existing: TxtRecord[] = await this.zone.listTxtByName(name).catch(() => []);
    for (const r of existing) {
      if (r.id) {
        await this.zone.deleteTxt(r.id).catch(() => {
          /* best-effort */
        });
      }
    }
  }
}
