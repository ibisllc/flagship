/**
 * Shared mutable state for the UI.
 *
 * The UI is structured as one StateStore + a set of view functions
 * that read it and produce DOM. Every view re-renders on state
 * change; there is no virtual DOM and no per-node diff — these
 * pages are small enough that wholesale re-renders are cheaper than
 * the cognitive load of a diff engine.
 */

import type { Mandate } from "@maintainers/protocol";
import type { AdapterClient, LoadedProject } from "./adapter.js";
import type { MaintainerIdentity } from "./webauthn.js";

export type Route =
  | { kind: "home" }
  | { kind: "onboard"; step: OnboardStep }
  | { kind: "project"; repoUrl: string; view: ProjectView }
  | { kind: "renew"; repoUrl: string; track: string }
  | { kind: "takeover"; repoUrl: string; track: string };

export type OnboardStep =
  | "project"
  | "yubikey"
  | "name-key"
  | "cadence"
  | "successor"
  | "review"
  | "commit"
  | "done";

export type ProjectView = "health" | "roster" | "activity";

export interface OnboardDraft {
  repoUrl: string;
  projectName: string;
  identity: MaintainerIdentity | null;
  displayName: string;
  email: string;
  cadenceDays: 30 | 60 | 90 | 180;
  successorMode: "enroll" | "paste" | "skip";
  successor: {
    pubKey?: string;
    displayName?: string;
    email?: string;
    identity?: MaintainerIdentity | null;
  };
  committedSha?: string;
  downloadFilename?: string;
}

export interface AppState {
  adapter: AdapterClient;
  rpId: string;
  rpName: string;
  now: Date;
  route: Route;
  loaded: LoadedProject | null;
  loading: boolean;
  error: string | null;
  draft: OnboardDraft;
  /** Active mandate being acted on (for renew/takeover flows). */
  currentMandate?: Mandate;
}

export type Listener = (s: AppState) => void;

export class StateStore {
  private listeners = new Set<Listener>();
  constructor(private state: AppState) {}

  get(): AppState {
    return this.state;
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  patchDraft(patch: Partial<OnboardDraft>): void {
    this.update({ draft: { ...this.state.draft, ...patch } });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export function defaultDraft(): OnboardDraft {
  return {
    repoUrl: "",
    projectName: "",
    identity: null,
    displayName: "",
    email: "",
    cadenceDays: 60,
    successorMode: "skip",
    successor: {},
  };
}
