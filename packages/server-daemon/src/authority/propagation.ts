/**
 * Propagation lights for replicated security documents (SECURITY-HARDENING-PLAN.md 18.7, N07).
 *
 * Each light is bound to one document digest and one replica. A new edit is a new digest and
 * starts dark: it never inherits an acknowledgement for an older digest. Dark means "not yet
 * acknowledged", never "safe"; bright means that replica confirmed that digest, never "revoked
 * everywhere". History is kept so the operator can see what each replica last confirmed.
 */
export type ReplicaKind = "device" | "server";
export type LightState = "dark" | "bright" | "offline" | "failed";

export interface Replica {
  id: string;
  kind: ReplicaKind;
}

export interface Light {
  replica: Replica;
  state: LightState;
  /** The newest digest this replica has confirmed, which may be older than the current one. */
  lastConfirmedDigest: string | null;
  lastConfirmedAt: number | null;
  detail?: string;
}

interface DocRecord {
  history: string[];
  acks: Map<string, { digest: string; at: number }>;
  marks: Map<string, { state: "offline" | "failed"; digest: string; detail?: string }>;
}

export class PropagationBoard {
  private docs = new Map<string, DocRecord>();

  constructor(private readonly replicas: () => Replica[]) {}

  /** A new version of a document. Returns the digest that is now current. */
  publish(doc: string, digest: string): void {
    const d: DocRecord = this.docs.get(doc) ?? { history: [], acks: new Map(), marks: new Map() };
    if (d.history[d.history.length - 1] !== digest) d.history.push(digest);
    d.marks.clear();
    this.docs.set(doc, d);
  }

  acknowledge(doc: string, replica: string, digest: string, at: number): void {
    const d = this.docs.get(doc);
    if (!d || !d.history.includes(digest)) return;
    const prior = d.acks.get(replica);
    // An acknowledgement of an older digest never replaces a newer one.
    if (prior && d.history.indexOf(prior.digest) > d.history.indexOf(digest)) return;
    d.acks.set(replica, { digest, at });
    d.marks.delete(replica);
  }

  mark(doc: string, replica: string, state: "offline" | "failed", detail?: string): void {
    const d = this.docs.get(doc);
    if (!d) return;
    d.marks.set(replica, { state, digest: d.history[d.history.length - 1]!, ...(detail ? { detail } : {}) });
  }

  current(doc: string): string | null {
    const d = this.docs.get(doc);
    return d ? d.history[d.history.length - 1] ?? null : null;
  }

  lights(doc: string): Light[] {
    const d = this.docs.get(doc);
    const cur = this.current(doc);
    return this.replicas().map((replica) => {
      const ack = d?.acks.get(replica.id);
      const mark = d?.marks.get(replica.id);
      const confirmedCurrent = ack !== undefined && ack.digest === cur;
      const state: LightState = confirmedCurrent ? "bright" : mark ? mark.state : "dark";
      return {
        replica,
        state,
        lastConfirmedDigest: ack?.digest ?? null,
        lastConfirmedAt: ack?.at ?? null,
        ...(mark?.detail && !confirmedCurrent ? { detail: mark.detail } : {}),
      };
    });
  }

  /** The plain sentence for the operator: never "revoked everywhere". */
  summary(doc: string): string {
    const lights = this.lights(doc);
    const bright = lights.filter((l) => l.state === "bright").length;
    const offline = lights.filter((l) => l.state === "offline");
    const failed = lights.filter((l) => l.state === "failed");
    const waiting = lights.length - bright;
    if (waiting === 0) return `Confirmed by all ${lights.length} replicas.`;
    const parts = [`Confirmed by ${bright} of ${lights.length}.`];
    if (offline.length) parts.push(`Pending on ${offline.length} offline ${offline.length === 1 ? "replica" : "replicas"}.`);
    if (failed.length) parts.push(`${failed.length} failed.`);
    const silent = waiting - offline.length - failed.length;
    if (silent > 0) parts.push(`${silent} not yet confirmed.`);
    return parts.join(" ");
  }
}
