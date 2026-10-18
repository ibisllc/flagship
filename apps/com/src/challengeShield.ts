import type { RelayAddress } from "@flagship/control-plane";

/**
 * Whether a DNS-01 challenge TXT gets a shield (A/AAAA at the challenged name,
 * written first) beside it. OFF unless `DNS_CHALLENGE_SHIELD` is "1".
 *
 * Measured live on Cloudflare (docs/wildcard-dns.md "Live verification"): a TXT
 * under a name does NOT make that name stop answering from the account
 * wildcard, and the shield is what opened a window: its record at the box name
 * showed on the name servers seconds before its `*.<box>` sibling, and in that
 * gap every name under the box answered NXDOMAIN (cached for 30 minutes). The
 * code stays so it can come back if Cloudflare ever applies the RFC 4592
 * empty-non-terminal rule; the gym's issuance check (`--dns-probe`) is what
 * would notice.
 */
export function challengeShieldFor(
  env: { DNS_CHALLENGE_SHIELD?: string },
  relay: RelayAddress | undefined,
): { shield: RelayAddress } | Record<string, never> {
  return env.DNS_CHALLENGE_SHIELD === "1" && relay ? { shield: relay } : {};
}
