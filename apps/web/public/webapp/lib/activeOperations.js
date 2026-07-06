// App-wide registry of in-progress operations — the data half of the
// global "operations" sliver (the teal strip the whole shell slides down to
// reveal, modelled on WhatsApp's active-call bar). Pure + framework-free so
// it's unit-testable without a DOM; the bar (lib/operationsBar.js) is the
// only thing that renders it.
//
// Mirrors the iOS `ActiveOperationsCenter` (FlagshipCore) one-for-one — the
// label shapes, the seq ordering, the namespaced ids, and the churn-free
// reconciliation are all identical so both surfaces behave the same.
//
// Two feeders, deliberately different in shape:
//   - Deploy operations are DERIVED from the pending-pod list via
//     `syncDeployOperations` — pods are already global + polled, so a
//     deploying server stays in the sliver across navigation for free.
//   - Build operations are REGISTERED imperatively (`upsertBuild` /
//     `removeBuild`) by the vibe-code build lifecycle, which has no global
//     signal today.
//
// A deploy op is only emitted once a box has GENUINELY started provisioning
// (it has a real install phase, or it has registered): a freshly-created
// server that is merely AWAITING A BURN is not yet doing anything, so it must
// NOT show a spinning op (the Home status pill already shows "Pending"). The
// label is "preparing <name>" — the box is preparing itself, not a remote
// "deploy". (NOTE: this diverges from the iOS "deploying server <name>" copy;
// the webapp gates + relabels here only — keep in mind for cross-surface copy.)

import { PROVISION_LADDER } from "./provisionProgress.js";

/**
 * Whether a pending pod has genuinely started provisioning (so it deserves a
 * spinning sliver op) vs. merely awaiting a burn. Started when it carries a
 * real install-ladder `phase`, or when the caller flags it `started` (a
 * registered-but-not-yet-live server has already booted + registered). A pod
 * with no phase (recipe minted, USB not yet burned/booted) is NOT started.
 * @param {{phase?:string|null, started?:boolean}} pod
 */
function deployStarted(pod) {
  if (pod && pod.started === true) return true;
  const phase = pod && pod.phase;
  return phase != null && PROVISION_LADDER.includes(phase) && phase !== "live";
}

/**
 * The sentence shown in the sliver. The two canonical shapes are
 * "preparing <name>" (a server provisioning itself) and
 * "building <service> on <server>"; a build with no known server collapses to
 * "building <service>".
 * @param {{kind:"deploy"|"build", subject:string, onServer?:string|null}} op
 */
export function operationLabel(op) {
  if (op.kind === "deploy") return `preparing ${op.subject}`;
  if (op.onServer) return `building ${op.subject} on ${op.onServer}`;
  return `building ${op.subject}`;
}

/** Namespaced ids keep the two feeders from ever colliding (a pod and a
 *  build session could share a raw string). */
function deployId(podId) {
  return `deploy:${podId}`;
}
function buildOpId(id) {
  return `build:${id}`;
}

/** Structural equality of two ops — used to keep reconciliation churn-free
 *  (an identical upsert/sync must not reassign `operations`, so steady
 *  polling never spams subscribers). `seq` is included: a re-sync that
 *  preserved the seq is a no-op, one that changed it is a real change. */
function sameOp(a, b) {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.subject === b.subject &&
    (a.onServer ?? null) === (b.onServer ?? null) &&
    targetEq(a.target, b.target) &&
    a.seq === b.seq
  );
}

/** Targets are `{ view, params? }` deep-links into the webapp router; compare
 *  by view + a shallow params match (the params we use are flat scalars). */
function targetEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.view !== b.view) return false;
  const pa = a.params ?? {};
  const pb = b.params ?? {};
  const ka = Object.keys(pa);
  const kb = Object.keys(pb);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => pa[k] === pb[k]);
}

function listsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameOp(a[i], b[i])) return false;
  }
  return true;
}

export class ActiveOperationsCenter {
  constructor() {
    this._operations = [];
    this._nextSeq = 0;
    this._subscribers = new Set();
  }

  /** The current operations, newest-registered last (insertion order). */
  get operations() {
    return this._operations;
  }

  /** The single operation the sliver shows: the most recently started
   *  (highest `seq`). null when nothing is running. */
  get primary() {
    let best = null;
    for (const op of this._operations) {
      if (!best || op.seq > best.seq) best = op;
    }
    return best;
  }

  /** Operations running beyond the primary, for the sliver's "+N" hint. */
  get additionalCount() {
    return Math.max(0, this._operations.length - 1);
  }

  /**
   * Subscribe to changes. The callback fires on every real mutation (never
   * on a churn-free no-op). Returns an unsubscribe fn. Mirrors the webapp's
   * other observable seams (a Set of listeners, fan-out on notify).
   */
  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _emit() {
    for (const fn of this._subscribers) {
      try {
        fn(this);
      } catch {
        /* a bad subscriber must not wedge the others */
      }
    }
  }

  _bump() {
    this._nextSeq += 1;
    return this._nextSeq;
  }

  // ---- Build operations (imperative) -------------------------------------

  /**
   * Register or refresh a build operation. An existing id keeps its `seq`
   * so a mid-build label refresh (the service name arriving, say) doesn't
   * jump it to the front of the sliver. Churn-free: an identical upsert
   * doesn't touch `operations`, so steady polling never spams subscribers.
   * @param {string} id  the build/session id (namespaced internally)
   * @param {string} subject  the service name
   * @param {string|null} onServer  the server it's building on, or null
   * @param {{view:string, params?:object}} target  where a tap navigates
   */
  upsertBuild(id, subject, onServer, target) {
    const opId = buildOpId(id);
    const idx = this._operations.findIndex((o) => o.id === opId);
    if (idx >= 0) {
      const updated = {
        id: opId,
        kind: "build",
        subject,
        onServer: onServer ?? null,
        target,
        seq: this._operations[idx].seq,
      };
      if (sameOp(this._operations[idx], updated)) return;
      this._operations = this._operations.slice();
      this._operations[idx] = updated;
      this._emit();
    } else {
      this._operations = this._operations.concat({
        id: opId,
        kind: "build",
        subject,
        onServer: onServer ?? null,
        target,
        seq: this._bump(),
      });
      this._emit();
    }
  }

  /** Drop a build operation. No-op (and no emit) when it isn't present. */
  removeBuild(id) {
    const opId = buildOpId(id);
    if (!this._operations.some((o) => o.id === opId)) return;
    this._operations = this._operations.filter((o) => o.id !== opId);
    this._emit();
  }

  // ---- Deploy operations (derived from pending pods) ---------------------

  /**
   * Reconcile deploy operations against the current pods. A pod whose
   * `status === "pending"` AND which has genuinely started provisioning (see
   * {@link deployStarted}) gets (or keeps) a deploy op; a pod that has left
   * pending — went live, was cancelled, was removed — OR is merely awaiting a
   * burn drops/never-gets its op. Existing ops keep their `seq` so a steady
   * re-sync never reorders the sliver, and the whole list is only reassigned
   * when something actually changed (so calling this on every pod-list tick is
   * free). Build operations are untouched.
   *
   * @param {Array<{podId:string, name:string, status:string, phase?:string|null, started?:boolean}>} pods
   */
  syncDeployOperations(pods) {
    const pending = (pods ?? []).filter(
      (p) => p && p.status === "pending" && deployStarted(p),
    );
    const desiredIds = new Set(pending.map((p) => deployId(p.podId)));

    // Start from everything that isn't a now-defunct deploy op (keeps all
    // build ops + still-pending deploy ops, drops deploy ops that left).
    const next = this._operations.filter(
      (o) => o.kind !== "deploy" || desiredIds.has(o.id),
    );

    for (const pod of pending) {
      const opId = deployId(pod.podId);
      const existing = next.find((o) => o.id === opId);
      const op = {
        id: opId,
        kind: "deploy",
        subject: pod.name,
        onServer: null,
        target: { view: "view-server-detail", params: { podId: pod.podId } },
        seq: existing ? existing.seq : this._bump(),
      };
      const idx = next.findIndex((o) => o.id === opId);
      if (idx >= 0) next[idx] = op;
      else next.push(op);
    }

    if (!listsEqual(next, this._operations)) {
      this._operations = next;
      this._emit();
    }
  }
}

// One app-wide instance — the single source of truth the sliver reads,
// mirroring the iOS singleton injected at the App scope.
export const activeOperations = new ActiveOperationsCenter();
