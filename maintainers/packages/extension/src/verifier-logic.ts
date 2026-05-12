/**
 * Wraps the @maintainers/protocol verifier into a UI-ready shape.
 *
 * Inputs: parsed RootPolicy + per-track TrackPolicy + per-track Mandates +
 * KeyFiles + ReleaseEndorsements.
 *
 * Outputs: per-track current holder card + named successors with display
 * info + recent activity timeline + derived alarms (takeover, email
 * rotation, chain gap).
 */
import {
  currentAuthority,
  lastExpiredMandate,
  verifyTrack,
  verifyChainOfEndorsements,
  type Mandate,
  type KeyFile,
  type ReleaseEndorsement,
  type RootPolicy,
  type TrackPolicy,
  type VerifiedTrack,
  type Pubkey,
  type TakeoverAlarm,
} from "@maintainers/protocol";

export type AlarmLevel = "red" | "yellow" | "info";

export interface Alarm {
  level: AlarmLevel;
  kind: "takeover" | "email-rotation" | "chain-gap" | "expiring-soon";
  track?: string;
  message: string;
  detail?: string;
  /** Best-effort emails for out-of-band confirmation. */
  contactEmails?: string[];
}

export interface PersonCard {
  pubkey: Pubkey;
  displayName: string;
  email: string;
  photo: string | null;
  github: string | null;
  role: string | null;
}

export interface TrackView {
  track: string;
  policy: TrackPolicy | null;
  current: { holder: PersonCard; mandate: Mandate; expiresAt: string; expiresInMs: number } | null;
  successors: PersonCard[];
  lastExpired: Mandate | null;
  recentMandates: Mandate[];
  rejections: VerifiedTrack["rejections"];
}

export interface OverlayState {
  projectName: string;
  policyPresent: boolean;
  tracks: TrackView[];
  recentEndorsements: ReleaseEndorsement[];
  endorsementRejections: ReturnType<typeof verifyChainOfEndorsements>["rejections"];
  alarms: Alarm[];
  computedAt: number;
}

const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export function computeOverlayState(input: {
  policy: RootPolicy | null;
  trackPolicies: Record<string, TrackPolicy>;
  mandates: Record<string, Mandate[]>;
  keys: KeyFile[];
  endorsements: ReleaseEndorsement[];
  now: Date;
}): OverlayState {
  const { policy, trackPolicies, mandates, keys, endorsements, now } = input;
  const projectName = policy?.project.name ?? "(unnamed project)";
  const alarms: Alarm[] = [];

  // Build a pubkey → PersonCard map; unknown pubkeys synthesize a card.
  const keyByPubkey = new Map<Pubkey, KeyFile>();
  for (const k of keys) keyByPubkey.set(k.pubkey, k);

  const tracks: TrackView[] = [];
  if (!policy) {
    return {
      projectName,
      policyPresent: false,
      tracks,
      recentEndorsements: [],
      endorsementRejections: [],
      alarms,
      computedAt: now.getTime(),
    };
  }

  for (const trackName of policy.tracks) {
    const trackPolicy = trackPolicies[trackName];
    const trackMandates = mandates[trackName] ?? [];
    if (!trackPolicy) {
      tracks.push({
        track: trackName,
        policy: null,
        current: null,
        successors: [],
        lastExpired: null,
        recentMandates: [],
        rejections: [],
      });
      alarms.push({
        level: "yellow",
        kind: "chain-gap",
        track: trackName,
        message: `Track "${trackName}" declared in root policy.json but its policy.json is missing`,
      });
      continue;
    }

    let verified: VerifiedTrack;
    try {
      verified = verifyTrack(trackName, trackPolicy, trackMandates);
    } catch (err) {
      alarms.push({
        level: "red",
        kind: "chain-gap",
        track: trackName,
        message: `verifyTrack threw on "${trackName}"`,
        detail: err instanceof Error ? err.message : String(err),
      });
      verified = { track: trackName, mandates: trackMandates, validMandates: [], rejections: [] };
    }

    const auth = currentAuthority(verified, now);
    const expired = lastExpiredMandate(verified, now);

    // Detect takeover: most recent valid mandate's predecessor is from a
    // different holder AND the new mandate was signed by a successor of
    // that predecessor (not by the predecessor's holder).
    const takeover = detectTakeover(verified.validMandates, keyByPubkey);
    if (takeover) {
      alarms.push({
        level: "red",
        kind: "takeover",
        track: trackName,
        message: `Track "${trackName}" was taken over by a successor.`,
        detail: `Previous holder: ${takeover.previousHolder.displayName} <${takeover.previousHolder.email}> → new holder: ${takeover.newHolder.displayName} <${takeover.newHolder.email}>`,
        contactEmails: [takeover.previousHolder.email, takeover.newHolder.email].filter(Boolean),
      });
    }

    if (auth) {
      const expiresInMs = Date.parse(auth.mandate.expiresAt) - now.getTime();
      if (expiresInMs < EXPIRY_SOON_MS) {
        const holderCard = personFromKey(auth.holder, keyByPubkey);
        alarms.push({
          level: "yellow",
          kind: "expiring-soon",
          track: trackName,
          message: `Track "${trackName}" mandate expires in ${formatDuration(expiresInMs)}`,
          contactEmails: holderCard.email ? [holderCard.email] : [],
        });
      }
    }

    for (const rej of verified.rejections) {
      alarms.push({
        level: "red",
        kind: "chain-gap",
        track: trackName,
        message: `Rejected mandate ${rej.mandate.mandateId.slice(0, 8)}…: ${rej.reason}`,
        detail: rej.detail,
      });
    }

    tracks.push({
      track: trackName,
      policy: trackPolicy,
      current: auth
        ? {
            holder: personFromKey(auth.holder, keyByPubkey),
            mandate: auth.mandate,
            expiresAt: auth.mandate.expiresAt,
            expiresInMs: Date.parse(auth.mandate.expiresAt) - now.getTime(),
          }
        : null,
      successors: auth
        ? auth.successors.map((pk) => personFromKey(pk, keyByPubkey))
        : (expired?.successors.map((pk) => personFromKey(pk, keyByPubkey)) ?? []),
      lastExpired: expired,
      recentMandates: verified.validMandates.slice(-5).reverse(),
      rejections: verified.rejections,
    });
  }

  // Email-rotation banner: any KeyFile whose emailHistory grew in the
  // last 14 days. The history is sorted by `from`; the latest "to:null"
  // entry should have a `from` newer than the threshold to trigger.
  const ROTATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  for (const k of keys) {
    const live = k.emailHistory.find((e) => e.to === null);
    if (!live) continue;
    const fromMs = Date.parse(live.from);
    if (!isFinite(fromMs)) continue;
    if (now.getTime() - fromMs < ROTATION_WINDOW_MS && k.emailHistory.length > 1) {
      const previous = k.emailHistory.filter((e) => e.to !== null).at(-1);
      alarms.push({
        level: "yellow",
        kind: "email-rotation",
        message: `Key for ${k.displayName} rotated email recently`,
        detail: `From ${previous?.email ?? "(unknown)"} → ${live.email} at ${live.from}`,
        contactEmails: previous?.email ? [previous.email, live.email] : [live.email],
      });
    }
  }

  // Endorsements chain (release track if it exists)
  const releaseTrack = tracks.find((t) => t.track === "release");
  let endorsementRejections: ReturnType<typeof verifyChainOfEndorsements>["rejections"] = [];
  let recentEndorsements: ReleaseEndorsement[] = [];
  if (releaseTrack?.policy && endorsements.length > 0) {
    const verifiedRelease: VerifiedTrack = {
      track: releaseTrack.track,
      mandates: mandates[releaseTrack.track] ?? [],
      validMandates: (mandates[releaseTrack.track] ?? []).filter((_m) => true),
      rejections: [],
    };
    // Use the actual verifyTrack result (rebuild from the same mandates)
    if (releaseTrack.policy) {
      const verifiedAgain = verifyTrack(releaseTrack.track, releaseTrack.policy, mandates[releaseTrack.track] ?? []);
      verifiedRelease.validMandates = verifiedAgain.validMandates;
      verifiedRelease.rejections = verifiedAgain.rejections;
    }
    const chain = verifyChainOfEndorsements(
      endorsements,
      verifiedRelease,
      releaseTrack.policy.approvalRule,
    );
    endorsementRejections = chain.rejections;
    recentEndorsements = chain.validEndorsements.slice(-5).reverse();
    for (const rej of chain.rejections) {
      alarms.push({
        level: "red",
        kind: "chain-gap",
        message: `Endorsement ${rej.endorsement.semverTag} rejected: ${rej.reason}`,
        detail: rej.detail,
      });
    }
  }

  return {
    projectName,
    policyPresent: true,
    tracks,
    recentEndorsements,
    endorsementRejections,
    alarms,
    computedAt: now.getTime(),
  };
}

function personFromKey(pubkey: Pubkey, keyByPubkey: Map<Pubkey, KeyFile>): PersonCard {
  const k = keyByPubkey.get(pubkey);
  if (!k) {
    return {
      pubkey,
      displayName: `(unknown key ${pubkey.slice(0, 8)}…)`,
      email: "",
      photo: null,
      github: null,
      role: null,
    };
  }
  return {
    pubkey,
    displayName: k.displayName,
    email: k.currentEmail,
    photo: k.metadata.photo ?? null,
    github: k.metadata.github ?? null,
    role: k.metadata.role ?? null,
  };
}

/**
 * Detect the most recent takeover event in a track's valid mandates.
 * A takeover is when mandate[i].signedBy !== mandate[i-1].holder.
 * Returns the synthetic TakeoverAlarm (NOT signed) for UI display.
 */
function detectTakeover(
  validMandates: Mandate[],
  keyByPubkey: Map<Pubkey, KeyFile>,
): TakeoverAlarm | null {
  for (let i = validMandates.length - 1; i >= 1; i--) {
    const m = validMandates[i]!;
    const pred = validMandates[i - 1]!;
    if (m.signedBy !== pred.holder && m.holder !== pred.holder) {
      const prevPerson = personFromKey(pred.holder, keyByPubkey);
      const newPerson = personFromKey(m.holder, keyByPubkey);
      return {
        kind: "TakeoverAlarm",
        project: "",
        track: m.track,
        previousMandate: pred.mandateId,
        newMandate: m.mandateId,
        previousHolder: {
          displayName: prevPerson.displayName,
          email: prevPerson.email,
          pubkey: pred.holder,
        },
        newHolder: {
          displayName: newPerson.displayName,
          email: newPerson.email,
          pubkey: m.holder,
        },
        detectedAt: new Date().toISOString(),
      };
    }
  }
  return null;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  const mins = Math.floor(seconds / 60);
  if (mins >= 1) return `${mins}m`;
  return `${seconds}s`;
}
